/**
 * 传输层实现：Windows 命名管道、流式 UTF-8 JSONL 解析、背压、认证与去重
 */

import * as net from "node:net";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { EventEmitter } from "node:events";
import {
  type Envelope,
  type AckPayload,
  type ErrorPayload,
  MAX_FRAME_SIZE,
  MAX_DEDUP_CACHE_SIZE,
  DEFAULT_ACK_TIMEOUT_MS,
  ProtocolErrorCode,
  validateEnvelope,
} from "./protocol.js";

/**
 * 生成平台相关的管道地址
 */
export function getPipePath(id: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\pi-terminal-worker-${id}`;
  }
  return path.join(os.tmpdir(), `pi-worker-${id}.sock`);
}

/**
 * 常数时间比较两个 Token (防时序侧信道反推)
 */
export function timingSafeCompare(tokenA: string, tokenB: string): boolean {
  if (typeof tokenA !== "string" || typeof tokenB !== "string") {
    return false;
  }
  const bufA = Buffer.from(tokenA, "utf8");
  const bufB = Buffer.from(tokenB, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 快速计算载荷哈希，用于检测同一 ID 是否包含不同载荷
 */
function hashPayload(payload: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload ?? null))
    .digest("hex");
}

interface PendingRequest {
  resolve: (ack: AckPayload) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface CachedResponse {
  payloadHash: string;
  ack: AckPayload;
  isControl: boolean;
}

/**
 * JsonlConnection 包装单个 Socket，负责分帧、发送背压、去重与 ACK 匹配
 */
export class JsonlConnection extends EventEmitter {
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private pendingRequests = new Map<string, PendingRequest>();
  private dedupCache = new Map<string, CachedResponse>();
  private isDestroyed = false;
  private seqCounter = 0;

  constructor(
    public readonly socket: net.Socket,
    public readonly role: "controller" | "supervisor" | "worker",
  ) {
    super();

    this.socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    this.socket.on("error", (err: Error) => {
      this.emit("error", err);
    });
    this.socket.on("close", (hadError: boolean) => {
      this.handleClose(hadError);
    });
    this.socket.on("end", () => {
      this.emit("end");
    });
  }

  public get nextSeq(): number {
    return ++this.seqCounter;
  }

  private handleData(chunk: Buffer): void {
    if (this.isDestroyed) return;

    this.buffer += this.decoder.write(chunk);

    // 检查缓冲区未分帧时累计长度是否超过单帧上限
    if (this.buffer.length > MAX_FRAME_SIZE * 2) {
      this.emit(
        "error",
        new Error(`接收到的帧长度超过上限: ${ProtocolErrorCode.PAYLOAD_TOO_LARGE}`),
      );
      this.destroy();
      return;
    }

    let lineEndIndex: number;
    while ((lineEndIndex = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, lineEndIndex);
      this.buffer = this.buffer.slice(lineEndIndex + 1);

      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }

      if (line.trim().length === 0) {
        continue;
      }

      if (Buffer.byteLength(line, "utf8") > MAX_FRAME_SIZE) {
        this.emit(
          "error",
          new Error(`帧字节数超过 1 MiB 限制: ${ProtocolErrorCode.PAYLOAD_TOO_LARGE}`),
        );
        this.destroy();
        return;
      }

      try {
        const rawObj = JSON.parse(line);
        const envelope = validateEnvelope(rawObj);
        this.handleEnvelope(envelope);
      } catch (err: unknown) {
        this.emit(
          "error",
          new Error(`协议解码错误: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    }
  }

  private handleEnvelope(envelope: Envelope): void {
    // 如果是 ACK 响应，核对正在等待的 PendingRequest
    if (envelope.type === "ack" && envelope.replyTo) {
      const pending = this.pendingRequests.get(envelope.replyTo);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(envelope.replyTo);
        pending.resolve(envelope.payload as AckPayload);
        return;
      }
    }

    // 如果是对端回复的 Error
    if (envelope.type === "error" && envelope.replyTo) {
      const pending = this.pendingRequests.get(envelope.replyTo);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(envelope.replyTo);
        const errPayload = envelope.payload as ErrorPayload;
        pending.reject(
          new Error(`[${errPayload.code}] ${errPayload.message}`),
        );
        return;
      }
    }

    // 触发普通消息事件
    this.emit("message", envelope);
  }

  private handleClose(hadError: boolean): void {
    this.isDestroyed = true;
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error(
          `连接已断开: ${ProtocolErrorCode.PEER_DISCONNECTED} (req: ${id})`,
        ),
      );
    }
    this.pendingRequests.clear();
    this.emit("close", hadError);
  }

  /**
   * 发送原始字符串，附带背压处理
   */
  public async writeRaw(data: string): Promise<void> {
    if (this.isDestroyed || this.socket.destroyed) {
      throw new Error(`无法发送数据: 连接已关闭 (${ProtocolErrorCode.PEER_DISCONNECTED})`);
    }

    return new Promise<void>((resolve, reject) => {
      const flushed = this.socket.write(data, "utf8", (err) => {
        if (err) {
          reject(err);
        } else if (flushed) {
          resolve();
        }
      });

      if (!flushed) {
        this.socket.once("drain", () => {
          resolve();
        });
      }
    });
  }

  /**
   * 发送 Envelope 消息 (带换行符)
   */
  public async sendEnvelope(envelope: Envelope): Promise<void> {
    const json = JSON.stringify(envelope);
    if (Buffer.byteLength(json, "utf8") > MAX_FRAME_SIZE) {
      throw new Error(`发送帧超过 1 MiB 限制: ${ProtocolErrorCode.PAYLOAD_TOO_LARGE}`);
    }
    await this.writeRaw(json + "\n");
  }

  /**
   * 发送单向请求并等待 ACK
   */
  public async sendRequest(
    envelope: Envelope,
    timeoutMs: number = DEFAULT_ACK_TIMEOUT_MS,
  ): Promise<AckPayload> {
    if (this.isDestroyed) {
      throw new Error(`连接已断开: ${ProtocolErrorCode.PEER_DISCONNECTED}`);
    }

    return new Promise<AckPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(envelope.id);
        reject(
          new Error(
            `请求超时 (${timeoutMs}ms): ${ProtocolErrorCode.TIMEOUT} (req: ${envelope.id})`,
          ),
        );
      }, timeoutMs);

      this.pendingRequests.set(envelope.id, { resolve, reject, timer });

      this.sendEnvelope(envelope).catch((err) => {
        clearTimeout(timer);
        this.pendingRequests.delete(envelope.id);
        reject(err);
      });
    });
  }

  /**
   * 检查并记录请求去重；如果是重复请求，返回已缓存的 ACK；如果不匹配，抛出错误
   */
  public checkDedup(
    requestId: string,
    payload: unknown,
    isControl: boolean = false,
  ): CachedResponse | null {
    const currentHash = hashPayload(payload);
    const existing = this.dedupCache.get(requestId);
    if (existing) {
      if (existing.payloadHash !== currentHash) {
        throw new Error(
          `相同 ID 的重复请求包含不同内容: ${ProtocolErrorCode.DUPLICATE_REQUEST_MISMATCH}`,
        );
      }
      return existing;
    }

    // 容量保护：控制类请求始终保留独立通道
    if (this.dedupCache.size >= MAX_DEDUP_CACHE_SIZE && !isControl) {
      throw new Error(`去重缓存已满: ${ProtocolErrorCode.DEDUP_FULL}`);
    }

    return null;
  }

  /**
   * 缓存处理完成的 ACK 结果
   */
  public recordDedup(
    requestId: string,
    payload: unknown,
    ack: AckPayload,
    isControl: boolean = false,
  ): void {
    if (this.dedupCache.size >= MAX_DEDUP_CACHE_SIZE && !isControl) {
      return;
    }
    this.dedupCache.set(requestId, {
      payloadHash: hashPayload(payload),
      ack,
      isControl,
    });
  }

  public destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    try {
      this.socket.destroy();
    } catch {
      // 忽略关闭时的错误
    }
  }
}
