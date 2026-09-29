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
  MAX_CONTROL_DEDUP_SIZE,
  MAX_SEND_BUFFER_BYTES,
  MAX_ERROR_MESSAGE_SIZE,
  MAX_ID_LENGTH,
  DEFAULT_ACK_TIMEOUT_MS,
  ProtocolErrorCode,
  ProtocolValidationError,
  validateEnvelope,
  validatePayload,
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
 * 发送队列字节超限：并发写排队总字节超过 MAX_SEND_BUFFER_BYTES
 */
export class SendBufferFullError extends Error {
  public readonly code: ProtocolErrorCode = ProtocolErrorCode.QUEUE_BYTES_EXCEEDED;

  constructor(
    public readonly queuedBytes: number,
    public readonly limitBytes: number,
  ) {
    super(
      `发送队列字节超限: 已排队 ${queuedBytes} 字节，本次写入后超过上限 ${limitBytes} 字节: ${ProtocolErrorCode.QUEUE_BYTES_EXCEEDED}`,
    );
    this.name = "SendBufferFullError";
  }
}

/**
 * ACK 等待超时：投递结果未知 (不自动重发)
 */
export class AckTimeoutError extends Error {
  public readonly code: ProtocolErrorCode = ProtocolErrorCode.TIMEOUT;
  public readonly deliveryUnknown = true;

  constructor(
    public readonly requestId: string,
    timeoutMs: number,
  ) {
    super(`请求超时 (${timeoutMs}ms): ${ProtocolErrorCode.TIMEOUT} (req: ${requestId})`);
    this.name = "AckTimeoutError";
  }
}

/**
 * 相同 ID 的重复请求包含不同内容
 */
export class DuplicateRequestMismatchError extends Error {
  public readonly code: ProtocolErrorCode = ProtocolErrorCode.DUPLICATE_REQUEST_MISMATCH;

  constructor(requestId: string) {
    super(`相同 ID 的重复请求包含不同内容: ${ProtocolErrorCode.DUPLICATE_REQUEST_MISMATCH} (req: ${requestId})`);
    this.name = "DuplicateRequestMismatchError";
  }
}

/**
 * 普通去重缓存已满 (控制类请求不受此限)
 */
export class DedupFullError extends Error {
  public readonly code: ProtocolErrorCode = ProtocolErrorCode.DEDUP_FULL;

  constructor(requestId: string) {
    super(`普通去重缓存已满 (${MAX_DEDUP_CACHE_SIZE} 条): ${ProtocolErrorCode.DEDUP_FULL} (req: ${requestId})`);
    this.name = "DedupFullError";
  }
}

/**
 * JsonlConnection 包装单个 Socket，负责分帧、发送背压、去重与 ACK 匹配
 */
export class JsonlConnection extends EventEmitter {
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private pendingRequests = new Map<string, PendingRequest>();
  /** 普通请求去重缓存 (容量 MAX_DEDUP_CACHE_SIZE，满则丢弃新缓存) */
  private dedupCache = new Map<string, CachedResponse>();
  /** 控制类请求 (abort/close/terminate 等) 独立去重额度 (容量 MAX_CONTROL_DEDUP_SIZE，FIFO 淘汰) */
  private controlDedupCache = new Map<string, CachedResponse>();
  private isDestroyed = false;
  /** 协议校验失败后置位：立即停止处理后续数据帧 */
  private protocolFailed = false;
  private seqCounter = 0;
  /** 最近收到的入站序号；生产连接启用后拒绝重复/倒退序号 */
  private lastReceivedSeq = 0;
  /** 串行化写链：保证 socket.write 按序执行 */
  private writeChain: Promise<void> = Promise.resolve();
  /** 当前排队中的发送字节数 (入队记账，写完成 finally 扣减) */
  private queuedWriteBytes = 0;

  constructor(
    public readonly socket: net.Socket,
    public readonly role: "controller" | "supervisor" | "worker",
    private readonly enforceInboundSequence = false,
  ) {
    super();

    this.socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    this.socket.on("error", (err: Error) => {
      this.emitError(err);
    });
    this.socket.on("close", (hadError: boolean) => {
      this.handleClose(hadError);
    });
    this.socket.on("end", () => {
      this.emit("end");
    });
  }

  /**
   * emit error 的安全包装：EventEmitter 对未监听的 'error' 事件会直接抛出，
   * 在无监听方时降级为 warn，避免协议违规/对端错误击穿主进程 (uncaughtException)。
   * 有监听方时行为与直接 emit 完全一致。
   */
  private emitError(err: Error): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
    } else {
      console.warn(`[Transport] 未处理的连接错误 (无 error 监听): ${err.message}`);
    }
  }

  public get nextSeq(): number {
    return ++this.seqCounter;
  }

  private handleData(chunk: Buffer): void {
    if (this.isDestroyed || this.protocolFailed) return;

    this.buffer += this.decoder.write(chunk);

    // 检查缓冲区未分帧时累计长度是否超过单帧上限
    if (this.buffer.length > MAX_FRAME_SIZE * 2) {
      this.failProtocol(
        new Error(`接收缓冲未分帧长度超过上限: ${ProtocolErrorCode.PAYLOAD_TOO_LARGE}`),
        undefined,
      );
      return;
    }

    let lineEndIndex: number;
    while ((lineEndIndex = this.buffer.indexOf("\n")) !== -1) {
      if (this.protocolFailed) return;

      let line = this.buffer.slice(0, lineEndIndex);
      this.buffer = this.buffer.slice(lineEndIndex + 1);

      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }

      if (line.trim().length === 0) {
        continue;
      }

      if (Buffer.byteLength(line, "utf8") > MAX_FRAME_SIZE) {
        this.failProtocol(
          new Error(`帧字节数超过 1 MiB 限制: ${ProtocolErrorCode.PAYLOAD_TOO_LARGE}`),
          undefined,
        );
        return;
      }

      // 先尽力从原始行提取 id/controllerId/workerId，校验失败时用于回送 error envelope
      let parsedId: string | undefined;
      let remoteControllerId = "unknown";
      let remoteWorkerId = "unknown";
      try {
        const rawObj = JSON.parse(line);
        if (rawObj && typeof rawObj === "object") {
          const ro = rawObj as Record<string, unknown>;
          if (typeof ro.id === "string" && ro.id.length > 0) parsedId = ro.id.slice(0, MAX_ID_LENGTH);
          if (typeof ro.controllerId === "string" && ro.controllerId.length > 0) {
            remoteControllerId = ro.controllerId.slice(0, MAX_ID_LENGTH);
          }
          if (typeof ro.workerId === "string" && ro.workerId.length > 0) {
            remoteWorkerId = ro.workerId.slice(0, MAX_ID_LENGTH);
          }
        }
      } catch {
        // 解析失败由下方统一处理
      }

      try {
        const rawObj = JSON.parse(line);
        const envelope = validateEnvelope(rawObj);
        if (this.enforceInboundSequence) {
          if (envelope.seq <= this.lastReceivedSeq) {
            throw new ProtocolValidationError(
              ProtocolErrorCode.PROTOCOL_ERROR,
              `入站 seq 必须严格递增: 当前 ${envelope.seq}，上一条 ${this.lastReceivedSeq}: ${ProtocolErrorCode.PROTOCOL_ERROR}`,
            );
          }
          this.lastReceivedSeq = envelope.seq;
        }
        envelope.payload = validatePayload(envelope.type, envelope.payload);
        this.handleEnvelope(envelope);
      } catch (err: unknown) {
        const error =
          err instanceof ProtocolValidationError
            ? err
            : new Error(
                `协议解码错误: ${err instanceof Error ? err.message : String(err)}: ${ProtocolErrorCode.PROTOCOL_ERROR}`,
              );
        this.failProtocol(error, parsedId, remoteControllerId, remoteWorkerId);
        return;
      }
    }
  }

  /**
   * 协议失败统一出口：尽力向对端回送 error envelope，随后销毁连接并 emit error。
   * 后续数据帧不再处理 (protocolFailed 立即置位)。
   */
  private failProtocol(
    err: Error,
    replyTo?: string,
    remoteControllerId = "unknown",
    remoteWorkerId = "unknown",
  ): void {
    if (this.protocolFailed) return;
    this.protocolFailed = true;

    const code: string =
      err instanceof ProtocolValidationError ? err.code : ProtocolErrorCode.PROTOCOL_ERROR;
    console.warn(`[Transport] 协议校验失败，连接将被销毁 (${code}): ${err.message}`);

    const sendPromise: Promise<void> = replyTo
      ? this.sendEnvelope({
          version: 1,
          controllerId: remoteControllerId,
          workerId: remoteWorkerId,
          id: crypto.randomUUID(),
          replyTo: replyTo.slice(0, MAX_ID_LENGTH),
          seq: this.nextSeq,
          type: "error",
          payload: {
            code,
            message: err.message.slice(0, MAX_ERROR_MESSAGE_SIZE),
          },
        } as Envelope).catch(() => {})
      : Promise.resolve();

    void sendPromise.finally(() => {
      try {
        this.socket.destroy();
      } catch {
        // 忽略关闭时的错误
      }
    });

    this.emitError(err);
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
   * 发送原始字符串，带背压保护：
   * - 排队字节超过 MAX_SEND_BUFFER_BYTES 时抛 SendBufferFullError
   * - 写串行化到 writeChain，settle-once，对端关闭时以 PEER_DISCONNECTED reject
   */
  public async writeRaw(data: string): Promise<void> {
    if (this.isDestroyed || this.socket.destroyed) {
      throw new Error(`无法发送数据: 连接已关闭 (${ProtocolErrorCode.PEER_DISCONNECTED})`);
    }

    const bytes = Buffer.byteLength(data, "utf8");
    if (this.queuedWriteBytes + bytes > MAX_SEND_BUFFER_BYTES) {
      throw new SendBufferFullError(this.queuedWriteBytes, MAX_SEND_BUFFER_BYTES);
    }

    this.queuedWriteBytes += bytes;
    const task = this.writeChain.then(() => this.doWrite(data));
    // 链本身吞掉错误，保证后续写不被前一个失败阻塞
    this.writeChain = task.catch(() => {});
    try {
      await task;
    } finally {
      this.queuedWriteBytes -= bytes;
    }
  }

  /**
   * 单次实际写：settle-once，等待 drain 期间若 socket close/error 则以 PEER_DISCONNECTED reject，
   * 并移除自己注册的监听，绝不永久挂起、不泄漏 listener
   */
  private doWrite(data: string): Promise<void> {
    const socket = this.socket;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        socket.off("drain", onDrain);
        socket.off("close", onClose);
        socket.off("error", onError);
      };
      const onDrain = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onClose = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`对端连接已关闭: ${ProtocolErrorCode.PEER_DISCONNECTED}`));
      };
      const onError = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const flushed = socket.write(data, "utf8", (err) => {
        if (settled) return;
        if (err) {
          settled = true;
          cleanup();
          reject(err);
        } else if (flushed) {
          settled = true;
          cleanup();
          resolve();
        }
      });
      if (!flushed) {
        socket.on("drain", onDrain);
        socket.on("close", onClose);
        socket.on("error", onError);
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
        reject(new AckTimeoutError(envelope.id, timeoutMs));
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
   * 检查请求去重：查表顺序普通表 → 控制表。
   * 命中且正文哈希一致则返回缓存；不一致抛 DuplicateRequestMismatchError；
   * 未命中且普通表已满时抛 DedupFullError (控制请求永不因容量被拒绝)。
   */
  public checkDedup(
    requestId: string,
    payload: unknown,
    isControl: boolean = false,
  ): CachedResponse | null {
    const currentHash = hashPayload(payload);
    const existing = this.dedupCache.get(requestId) ?? this.controlDedupCache.get(requestId);
    if (existing) {
      if (existing.payloadHash !== currentHash) {
        throw new DuplicateRequestMismatchError(requestId);
      }
      return existing;
    }

    if (!isControl && this.dedupCache.size >= MAX_DEDUP_CACHE_SIZE) {
      throw new DedupFullError(requestId);
    }

    return null;
  }

  /**
   * 缓存处理完成的 ACK 结果。
   * 控制请求写入独立控制表 (FIFO 淘汰最旧控制条目，保证 abort/close/terminate 永远有额度)；
   * 普通请求写普通表，满则丢弃缓存并 warn。
   */
  public recordDedup(
    requestId: string,
    payload: unknown,
    ack: AckPayload,
    isControl: boolean = false,
  ): void {
    const entry: CachedResponse = {
      payloadHash: hashPayload(payload),
      ack,
      isControl,
    };

    if (isControl) {
      if (this.controlDedupCache.size >= MAX_CONTROL_DEDUP_SIZE && !this.controlDedupCache.has(requestId)) {
        const oldest = this.controlDedupCache.keys().next().value;
        if (oldest !== undefined) {
          this.controlDedupCache.delete(oldest);
        }
      }
      this.controlDedupCache.set(requestId, entry);
      return;
    }

    if (this.dedupCache.size >= MAX_DEDUP_CACHE_SIZE && !this.dedupCache.has(requestId)) {
      console.warn(
        `[Transport] 普通去重缓存已满 (${MAX_DEDUP_CACHE_SIZE} 条)，丢弃新缓存: ${requestId}`,
      );
      return;
    }
    this.dedupCache.set(requestId, entry);
  }

  /**
   * 去重容量统计 (便于测试与诊断)
   */
  public getDedupStats(): { normal: number; control: number; maxNormal: number; maxControl: number } {
    return {
      normal: this.dedupCache.size,
      control: this.controlDedupCache.size,
      maxNormal: MAX_DEDUP_CACHE_SIZE,
      maxControl: MAX_CONTROL_DEDUP_SIZE,
    };
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
