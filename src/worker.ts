/**
 * 执行端 (Worker) 核心实现：
 * 环境变量激活、命名管道双向通信、worker_report 工具、候选/正式回执流转、本地人工输入干预与消息排队
 */

import * as net from "node:net";
import * as crypto from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  InputEvent,
  ToolExecutionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  PROTOCOL_VERSION,
  MAX_FOLLOWUP_QUEUE_SIZE,
  MAX_FOLLOWUP_QUEUE_BYTES,
  MAX_REPORT_SIZE,
  MAX_ERROR_MESSAGE_SIZE,
  jsonByteLength,
  ProtocolErrorCode,
  ProtocolValidationError,
  validateWorkerReport,
  type Envelope,
  type AckPayload,
  type TaskPayload,
  type FollowupPayload,
  type AbortPayload,
  type ClosePayload,
  type WorkerReportPayload,
  type WorkerReadyPayload,
  type ModelChangedPayload,
} from "./protocol.js";
import { JsonlConnection } from "./transport.js";
import { SessionGenerationManager } from "./lifecycle.js";

const FORBIDDEN_WORKER_TOOLS = new Set([
  "subagent",
  "subagent_stop",
  "subagent_wait",
]);

/** followup 队列条目：sessionGeneration 绑定入队时的会话代际，绝不跨会话派发 */
interface FollowupQueueItem {
  taskId: string;
  revision: number;
  runId: number;
  message: string;
  sessionGeneration: number;
}

export class WorkerManager {
  private conn: JsonlConnection | null = null;
  private isDetached = false;
  private currentContext: ExtensionContext | null = null;

  /** 会话代际追踪：session_start / session_shutdown 时推进，使旧异步回调立即失效 */
  private readonly sessionGen = new SessionGenerationManager();
  /** 当前活动代际，初值与 sessionGen.generation (0) 一致 */
  private activeGeneration = 0;
  /** 被 generation 校验拦截的失效回调计数 (仅用于诊断) */
  private staleCallbacksIgnored = 0;

  /** worker_ready 双条件门控：hello_ok 认证确认 + currentContext 就绪，两者谁先到均在齐备后发送且只发一次 */
  private helloOkReceived = false;
  private workerReadySent = false;

  private controllerId: string;
  private workerId: string;
  private pipePath: string;
  private token: string;

  private currentTaskId: string | null = null;
  private currentRevision = 1;
  private currentRunId = 1;

  private currentCandidate: WorkerReportPayload | null = null;
  private candidateInvalidated = false;
  private taskHasReported = false;

  private followupQueue: FollowupQueueItem[] = [];
  /** followup 队列总字节数 (与 8 条上限共同生效) */
  private followupQueueBytes = 0;

  private readonly strictProtocol: boolean;

  constructor(private pi: ExtensionAPI, strictProtocol = false) {
    this.strictProtocol = strictProtocol;
    this.controllerId = process.env.PI_TERMINAL_WORKER_CONTROLLER_ID || "";
    this.workerId = process.env.PI_TERMINAL_WORKER_WORKER_ID || "";
    this.pipePath = process.env.PI_TERMINAL_WORKER_PIPE_PATH || "";
    this.token = process.env.PI_TERMINAL_WORKER_TOKEN || "";
  }

  public async init(): Promise<void> {
    if (!this.pipePath || !this.token) {
      console.warn("[Worker] 缺少管道配置或 Token，跳过 Worker 初始化");
      return;
    }

    this.registerWorkerReportTool();
    this.registerWorkerCommands();
    this.setupPiEventListeners();

    // 建立与主控的连接
    await this.connectToController();
  }

  private async connectToController(): Promise<void> {
    const socket = net.createConnection(this.pipePath);
    this.conn = new JsonlConnection(socket, "worker", this.strictProtocol);
    const connAtConnect = this.conn;

    socket.on("connect", () => {
      // session_shutdown / detach 可能已销毁并置空连接：晚到的 connect 不得再用旧连接发 hello
      if (this.conn !== connAtConnect) {
        return;
      }
      // 发送 hello 认证
      connAtConnect.sendEnvelope({
        version: PROTOCOL_VERSION,
        controllerId: this.controllerId,
        workerId: this.workerId,
        id: crypto.randomUUID(),
        seq: connAtConnect.nextSeq,
        type: "hello",
        payload: {
          role: "worker",
          token: this.token,
          controllerId: this.controllerId,
          workerId: this.workerId,
        },
      }).catch((err) => {
        console.error("[Worker] 发送 hello 失败:", err);
      });
    });

    this.conn.on("message", (env: Envelope) => {
      this.handleControllerEnvelope(env);
    });

    this.conn.on("close", () => {
      if (!this.isDetached) {
        console.warn("[Worker] 与 Controller 管道断开，继续保持本地 TUI 会话运行");
      }
      this.conn = null;
    });

    this.conn.on("error", (err: Error) => {
      console.error("[Worker] 管道通信异常:", err.message);
    });
  }

  /**
   * 校验 Controller 发来的任务迁移，避免延迟/重放消息重绑当前任务。
   * 首个 task 可建立绑定；之后只能接收同一 task 的更高 revision/runId followup。
   */
  private validateTaskTransition(
    type: "task" | "followup",
    payload: TaskPayload | FollowupPayload,
  ): void {
    if (!this.currentTaskId) {
      if (type === "followup") {
        throw new ProtocolValidationError(
          ProtocolErrorCode.INVALID_STATE,
          `没有当前任务，不能接收 followup: ${ProtocolErrorCode.INVALID_STATE}`,
        );
      }
      return;
    }
    if (payload.taskId !== this.currentTaskId) {
      throw new ProtocolValidationError(
        ProtocolErrorCode.IDENTITY_MISMATCH,
        `任务 ID 与当前 Worker 任务不匹配 (${payload.taskId} !== ${this.currentTaskId}): ${ProtocolErrorCode.IDENTITY_MISMATCH}`,
      );
    }
    if (type === "task") {
      throw new ProtocolValidationError(
        ProtocolErrorCode.INVALID_STATE,
        `当前任务已绑定，不能再次接收初始 task: ${ProtocolErrorCode.INVALID_STATE}`,
      );
    }
    if (
      payload.revision < this.currentRevision ||
      (payload.revision === this.currentRevision && payload.runId <= this.currentRunId)
    ) {
      throw new ProtocolValidationError(
        ProtocolErrorCode.INVALID_STATE,
        `过时的任务迁移 (revision=${payload.revision}, runId=${payload.runId}; 当前 revision=${this.currentRevision}, runId=${this.currentRunId}): ${ProtocolErrorCode.INVALID_STATE}`,
      );
    }
  }
  private handleControllerEnvelope(env: Envelope): void {
    // 连接或会话已失效 (session_shutdown / detach / socket close) 后晚到的消息：
    // 不得再改状态、不得回 ACK，直接忽略并计数
    const entryGen = this.activeGeneration;
    if (!this.isCurrentGeneration(entryGen) || !this.conn) {
      this.staleCallbacksIgnored++;
      return;
    }

    const { id, type, payload } = env;

    // 身份校验：controllerId/workerId 与自身环境变量不一致的消息一律丢弃，
    // 不改状态、不派发、不回 ACK，仅回发一条 error
    if (env.controllerId !== this.controllerId || env.workerId !== this.workerId) {
      console.warn(
        `[Worker] 身份不匹配的消息已丢弃: type=${type} id=${id} ` +
        `(期望 controllerId=${this.controllerId} workerId=${this.workerId}，实际 ${env.controllerId}/${env.workerId})`,
      );
      this.sendPeerError(
        id,
        ProtocolErrorCode.PROTOCOL_ERROR,
        `身份不匹配: workerId 应为 ${this.workerId}，请求 ${id} 已被忽略`,
      );
      return;
    }

    if (type === "hello_ok") {
      this.helloOkReceived = true;
      // session_start 可能早于认证完成；齐备后补发 worker_ready
      this.trySendWorkerReady();
      return;
    }

    if (type === "ping") {
      this.conn?.sendEnvelope({
        version: PROTOCOL_VERSION,
        controllerId: this.controllerId,
        workerId: this.workerId,
        id: crypto.randomUUID(),
        replyTo: id,
        seq: this.conn.nextSeq,
        type: "pong",
        payload: { timestamp: Date.now(), replyTimestamp: (payload as any).timestamp },
      });
      return;
    }

    if (type === "task") {
      const hit = this.dedupGate(id, payload, false);
      if (hit) return; // 重复请求：已回发缓存 ACK，不重复派发
      try {
        const p = payload as TaskPayload;
        this.validateTaskTransition("task", p);
        this.currentTaskId = p.taskId;
        this.currentRevision = p.revision;
        this.currentRunId = p.runId;
        this.currentCandidate = null;
        this.candidateInvalidated = false;
        this.taskHasReported = false;

        const formattedPrompt = this.buildTaskPrompt(p);

        // 先排队或直接派发，成功后才发送 ACK；队列满/超字节时由 catch 回发失败 ACK
        // 显式传入入口处捕获并校验过的 ctx 与 generation，不隐式读取可能已过期的状态
        this.enqueueOrDispatchMessage(
          {
            taskId: p.taskId,
            revision: p.revision,
            runId: p.runId,
            message: formattedPrompt,
          },
          this.currentContext,
          entryGen,
        );

        // 发送 ACK，并把完全相同的 payload 对象记入去重缓存
        const ackPayload = this.sendAck(id, true);
        this.conn?.recordDedup(id, payload, ackPayload, false);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof ProtocolValidationError ? err.code : undefined;
        const ackPayload = this.sendAck(id, false, message, code);
        this.conn?.recordDedup(id, payload, ackPayload, false);
      }
      return;
    }

    if (type === "followup") {
      const hit = this.dedupGate(id, payload, false);
      if (hit) return; // 重复请求：已回发缓存 ACK，不重复入队/派发
      try {
        const p = payload as FollowupPayload;
        this.validateTaskTransition("followup", p);
        this.currentRevision = p.revision;
        this.currentRunId = p.runId;
        this.currentCandidate = null;
        this.candidateInvalidated = false;
        this.taskHasReported = false;

        const formattedPrompt = `【来自主控端的 ${p.kind === "revision" ? "返修任务" : "补充说明"} (Revision ${p.revision})】\n${p.message}\n\n请在实施完毕或遇到问题时，通过 worker_report 工具提交新的回执。`;

        // 先排队或直接派发，成功后才发送 ACK；队列满/超字节时由 catch 回发失败 ACK
        this.enqueueOrDispatchMessage(
          {
            taskId: p.taskId,
            revision: p.revision,
            runId: p.runId,
            message: formattedPrompt,
          },
          this.currentContext,
          entryGen,
        );

        const ackPayload = this.sendAck(id, true);
        this.conn?.recordDedup(id, payload, ackPayload, false);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof ProtocolValidationError ? err.code : undefined;
        const ackPayload = this.sendAck(id, false, message, code);
        this.conn?.recordDedup(id, payload, ackPayload, false);
      }
      return;
    }

    if (type === "abort") {
      const hit = this.dedupGate(id, payload, true);
      if (hit) return; // 重复 abort：幂等，走缓存 ACK
      this.clearQueue();
      this.currentCandidate = null;
      if (this.currentContext) {
        this.currentContext.abort();
      }
      const ackPayload = this.sendAck(id, true);
      this.conn?.recordDedup(id, payload, ackPayload, true);
      return;
    }

    if (type === "close") {
      const hit = this.dedupGate(id, payload, true);
      if (hit) return; // 重复 close：幂等，走缓存 ACK
      const ackPayload = this.sendAck(id, true);
      this.conn?.recordDedup(id, payload, ackPayload, true);
      // 延迟 shutdown 跨越定时器：回调内重新校验代际与当前上下文；
      // 不比较 ctx 身份 (Pi 每个事件新建 ctx，跨事件身份比较恒为真)
      const closeGen = this.activeGeneration;
      setTimeout(() => {
        if (!this.isCurrentGeneration(closeGen) || !this.currentContext) {
          this.staleCallbacksIgnored++;
          return;
        }
        this.currentContext.shutdown();
      }, 200);
      return;
    }
  }

  /**
   * 去重网关：命中缓存则回发缓存 ACK 并返回它；
   * DUPLICATE_REQUEST_MISMATCH / DEDUP_FULL 则回发失败 ACK 并返回；正常返回 null。
   */
  private dedupGate(id: string, payload: unknown, isControl: boolean): AckPayload | null {
    const conn = this.conn;
    if (!conn) return null;
    try {
      const cached = conn.checkDedup(id, payload, isControl);
      if (cached) {
        this.emitAck(cached.ack);
        return cached.ack;
      }
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      if (
        e?.code === ProtocolErrorCode.DUPLICATE_REQUEST_MISMATCH ||
        e?.code === ProtocolErrorCode.DEDUP_FULL
      ) {
        const ackPayload = this.sendAck(id, false, e.message ?? String(err), e.code);
        // 注意：这两个分支不 recordDedup ——
        // MISMATCH：原有缓存条目 (同 ID 同正文 → 缓存 ACK) 必须保留，
        //   若用冲突正文覆盖，之后重发原始正文会再也查不回缓存 ACK (设计文档 5.4 节语义)；
        // DEDUP_FULL：普通表已满，recordDedup 只会丢弃并 warn，无意义。
        return ackPayload;
      }
      throw err;
    }
    return null;
  }

  private sendAck(replyTo: string, ok: boolean, error?: string, code?: string): AckPayload {
    const ackPayload: AckPayload = { id: replyTo, ok };
    if (error !== undefined) {
      ackPayload.error = error.slice(0, MAX_ERROR_MESSAGE_SIZE);
    }
    if (code !== undefined) {
      ackPayload.code = code;
    }
    this.emitAck(ackPayload);
    return ackPayload;
  }

  /**
   * 回发 ACK envelope；payload 对象与传入引用完全一致 (去重缓存一致性)
   */
  private emitAck(ackPayload: AckPayload): void {
    if (!this.conn || this.conn.socket.destroyed) return;
    this.conn.sendEnvelope({
      version: PROTOCOL_VERSION,
      controllerId: this.controllerId,
      workerId: this.workerId,
      id: crypto.randomUUID(),
      replyTo: ackPayload.id,
      seq: this.conn.nextSeq,
      type: "ack",
      payload: ackPayload,
    }).catch(() => {});
  }

  /**
   * 尽力向主控回发一条 error envelope
   */
  private sendPeerError(replyTo: string, code: string, message: string): void {
    if (!this.conn || this.conn.socket.destroyed) return;
    this.conn.sendEnvelope({
      version: PROTOCOL_VERSION,
      controllerId: this.controllerId,
      workerId: this.workerId,
      id: crypto.randomUUID(),
      replyTo,
      seq: this.conn.nextSeq,
      type: "error",
      payload: { code, message: message.slice(0, MAX_ERROR_MESSAGE_SIZE) },
    }).catch(() => {});
  }

  /**
   * 发送 worker_ready：必须等 hello_ok 认证确认且 currentContext 存在后发送，
   * 两者无论谁先到均保证发送一次 (认证前发送会被主控丢弃，造成永久等待)
   */
  private trySendWorkerReady(): void {
    if (this.workerReadySent) return;
    if (!this.helloOkReceived) return;
    const gen = this.activeGeneration;
    const ctx = this.currentContext;
    if (!ctx || !this.isCurrentGeneration(gen)) return;
    if (!this.conn || this.conn.socket.destroyed) return;

    this.workerReadySent = true;
    const readyPayload: WorkerReadyPayload = {
      cwd: ctx.cwd,
      tools: this.pi.getActiveTools().filter((name) => !FORBIDDEN_WORKER_TOOLS.has(name)),
      version: PROTOCOL_VERSION.toString(),
      ...this.collectModelInfo(ctx),
    };
    this.conn.sendEnvelope({
      version: PROTOCOL_VERSION,
      controllerId: this.controllerId,
      workerId: this.workerId,
      id: crypto.randomUUID(),
      seq: this.conn.nextSeq,
      type: "worker_ready",
      payload: readyPayload,
    }).catch(() => {});
  }

  /**
   * 采集 Worker 会话实际的模型信息 (不猜测、不硬编码)
   */
  private collectModelInfo(ctx: ExtensionContext): { provider?: string; modelId?: string; thinkingLevel?: string } {
    const info: { provider?: string; modelId?: string; thinkingLevel?: string } = {};
    const model = (ctx as { model?: { provider?: string; id?: string } }).model;
    if (model?.provider) info.provider = model.provider;
    if (model?.id) info.modelId = model.id;
    try {
      const level = (this.pi as ExtensionAPI).getThinkingLevel?.();
      if (level) info.thinkingLevel = level;
    } catch {
      // 获取 thinking 级别失败不影响主流程
    }
    return info;
  }

  /**
   * 会话中模型/思考级别变化后向主控刷新上报
   */
  private sendModelChanged(): void {
    const gen = this.activeGeneration;
    const ctx = this.currentContext;
    if (!ctx || !this.isCurrentGeneration(gen)) return;
    if (!this.conn || this.conn.socket.destroyed) return;
    this.conn.sendEnvelope({
      version: PROTOCOL_VERSION,
      controllerId: this.controllerId,
      workerId: this.workerId,
      id: crypto.randomUUID(),
      seq: this.conn.nextSeq,
      type: "model_changed",
      payload: this.collectModelInfo(ctx) as ModelChangedPayload,
    }).catch(() => {});
  }

  private buildTaskPrompt(p: TaskPayload): string {
    const parts: string[] = [
      `【来自主控端的指派任务 - Task ID: ${p.taskId} (Revision ${p.revision})】`,
      `目标需求:\n${p.task}`,
    ];

    if (p.context) {
      parts.push(`背景上下文:\n${p.context}`);
    }

    if (p.allowedPaths && p.allowedPaths.length > 0) {
      parts.push(`允许修改的路径范围契约:\n${p.allowedPaths.map((x) => `- ${x}`).join("\n")}`);
    }

    if (p.acceptanceCriteria && p.acceptanceCriteria.length > 0) {
      parts.push(`验收指标与测试要求:\n${p.acceptanceCriteria.map((x) => `- ${x}`).join("\n")}`);
    }

    parts.push(
      `执行与回执要求:`,
      `1. 按照方案在指定工作目录内修改代码并进行本地验证。`,
      `2. 不得再派发子代理或启动新终端；超出允许范围或需要改变设计时，调用 worker_report(kind="blocked") 说明原因。`,
      `3. 任务完成、遇到提问或出现阻碍时，必须调用 worker_report 工具提交回执。`,
    );

    return parts.join("\n\n");
  }

  private isCurrentGeneration(gen: number): boolean {
    return this.sessionGen.isValid(gen);
  }

  /**
   * 入队或立即派发。sessionGeneration 写入入队当时的 generation；
   * ctx/gen 可显式传入（跨 await/tick 的调用点必须传当时捕获的值）。
   */
  private enqueueOrDispatchMessage(
    item: {
      taskId: string;
      revision: number;
      runId: number;
      message: string;
      sessionGeneration?: number;
    },
    ctx: ExtensionContext | null = this.currentContext,
    gen: number = this.activeGeneration,
  ): void {
    item.sessionGeneration = gen;
    const queueItem = item as FollowupQueueItem;

    if (ctx && ctx.isIdle() && !ctx.hasPendingMessages()) {
      // 立即派发分支同样校验代际：绝不把消息交给已失效的会话
      if (!this.isCurrentGeneration(queueItem.sessionGeneration)) {
        this.staleCallbacksIgnored++;
        return;
      }
      this.dispatchUserMessage(queueItem.message, ctx, queueItem.sessionGeneration);
      return;
    }

    const itemBytes = jsonByteLength(queueItem);
    if (this.followupQueue.length >= MAX_FOLLOWUP_QUEUE_SIZE) {
      throw new Error(
        `Worker 内部消息队列已满 (${MAX_FOLLOWUP_QUEUE_SIZE} 条): ${ProtocolErrorCode.QUEUE_FULL}`,
      );
    }
    if (this.followupQueueBytes + itemBytes > MAX_FOLLOWUP_QUEUE_BYTES) {
      throw new Error(
        `Worker 内部消息队列总字节超限 (上限 1 MiB=${MAX_FOLLOWUP_QUEUE_BYTES} 字节，` +
        `当前 ${this.followupQueueBytes} 字节，新增 ${itemBytes} 字节): ${ProtocolErrorCode.QUEUE_BYTES_EXCEEDED}`,
      );
    }
    this.followupQueue.push(queueItem);
    this.followupQueueBytes += itemBytes;
  }

  /**
   * 出队并扣减字节；丢弃所有 sessionGeneration 与目标 gen 不符的旧条目
   * (逐条计入 staleCallbacksIgnored)，绝不派发到新会话。队列为空时返回 undefined。
   */
  private shiftQueueItem(gen: number = this.activeGeneration): FollowupQueueItem | undefined {
    while (this.followupQueue.length > 0) {
      const item = this.followupQueue.shift()!;
      this.followupQueueBytes -= jsonByteLength(item);
      if (item.sessionGeneration === gen && this.isCurrentGeneration(gen)) {
        return item;
      }
      this.staleCallbacksIgnored++;
    }
    return undefined;
  }

  /** 清空队列并归零字节计数 */
  private clearQueue(): void {
    this.followupQueue = [];
    this.followupQueueBytes = 0;
  }

  /**
   * 派发用户消息。必须显式传入捕获的 ctx 与 gen；
   * ctx 非空、代际有效且当前存在会话上下文时才调用 Pi API；
   * 绝不比较 ctx 身份 (Pi 每个事件新建 ctx，跨事件身份比较恒为真)。
   */
  private dispatchUserMessage(text: string, ctx: ExtensionContext | null, gen: number): boolean {
    if (!ctx || !this.isCurrentGeneration(gen) || !this.currentContext) {
      this.staleCallbacksIgnored++;
      return false;
    }
    this.pi.sendUserMessage(text, {
      expandPromptTemplates: false,
    });
    return true;
  }

  private setupPiEventListeners(): void {
    // 监听 session_start
    this.pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
      const previousContext = this.currentContext;
      // 每次 session_start 都推进代际：旧会话的异步回调随即失效
      this.activeGeneration = this.sessionGen.nextGeneration();
      this.currentContext = ctx;

      if (previousContext === null) {
        // 启动竞态：首个 session_start 之前入队的早到任务仍属于本次会话，
        // 把它们的 generation 改写为新代际（adopt），随后可正常补派发
        for (const item of this.followupQueue) {
          item.sessionGeneration = this.activeGeneration;
        }
      } else {
        // 真实会话切换（用户切换/重开 session）：绝不把旧会话消息注入新 session。
        // 旧队列、旧候选与旧任务绑定一律作废：
        // currentTaskId 置空后，旧会话晚到的 agent_settled 既无候选也无任务，
        // 不会向新会话发出 report_missing。
        this.clearQueue();
        this.currentCandidate = null;
        this.candidateInvalidated = true;
        this.taskHasReported = false;
        this.currentTaskId = null;
      }

      this.pi.setActiveTools(
        this.pi.getActiveTools().filter((name) => !FORBIDDEN_WORKER_TOOLS.has(name)),
      );
      // hello_ok 可能尚未到达或已到达；两种时序下均由双条件门控发送 worker_ready
      this.trySendWorkerReady();

      // 启动竞态修复：会话就绪后立即补派发队列首条，避免队列永久卡住
      if (
        this.followupQueue.length > 0 &&
        ctx.isIdle() &&
        !ctx.hasPendingMessages()
      ) {
        const next = this.shiftQueueItem(this.activeGeneration);
        if (next) {
          this.dispatchUserMessage(next.message, ctx, this.activeGeneration);
        }
      }
    });

    // 监听 session_shutdown
    this.pi.on("session_shutdown", async () => {
      // 幂等：重复触发不得再次 destroy / 抛错；先推进代际使所有旧回调立即失效，
      // 之后旧回调不得再调用 sendUserMessage / abort / shutdown / setActiveTools
      this.sessionGen.nextGeneration();
      this.activeGeneration = this.sessionGen.generation;
      this.currentContext = null;
      this.clearQueue();
      this.currentCandidate = null;
      this.candidateInvalidated = true;

      const conn = this.conn;
      if (conn) {
        this.conn = null;
        conn.destroy();
      }
    });

    // 监听 input 事件：识别本地用户在终端窗口键盘输入干预
    this.pi.on("input", async (event: InputEvent) => {
      const gen = this.activeGeneration;
      if (!this.isCurrentGeneration(gen) || !this.currentContext) {
        // 会话已切换/已关闭：不得再改状态、不得发 local_input
        this.staleCallbacksIgnored++;
        return { action: "continue" };
      }
      if (event.source === "interactive") {
        // 用户敲键盘干预！
        this.candidateInvalidated = true;
        this.currentCandidate = null;
        this.clearQueue(); // 暂停自动派发旧队列

        if (this.conn && !this.conn.socket.destroyed) {
          this.conn.sendEnvelope({
            version: PROTOCOL_VERSION,
            controllerId: this.controllerId,
            workerId: this.workerId,
            id: crypto.randomUUID(),
            seq: this.conn.nextSeq,
            type: "local_input",
            payload: {
              taskId: this.currentTaskId ?? undefined,
              textSummary: event.text.slice(0, 100),
            },
          }).catch(() => {});
        }
      }
      return { action: "continue" };
    });

    // 监听 model_select / thinking_level_select：会话内切换模型/思考级别后刷新主控状态
    this.pi.on("model_select", async () => {
      this.sendModelChanged();
    });

    this.pi.on("thinking_level_select", async () => {
      this.sendModelChanged();
    });

    this.pi.on("tool_call", async (event) => {
      const gen = this.activeGeneration;
      if (!this.isCurrentGeneration(gen) || !this.currentContext) {
        this.staleCallbacksIgnored++;
        return undefined;
      }
      if (FORBIDDEN_WORKER_TOOLS.has(event.toolName)) {
        return { block: true, reason: "Worker 不允许递归派发子代理" };
      }
      return undefined;
    });

    // 监听 tool_execution_start
    this.pi.on("tool_execution_start", async (event: ToolExecutionStartEvent) => {
      const gen = this.activeGeneration;
      if (!this.isCurrentGeneration(gen) || !this.currentContext) {
        this.staleCallbacksIgnored++;
        return;
      }
      // 如果此前记录了 candidate，但模型又调用了其他工具，则候选失效
      if (event.toolName !== "worker_report" && this.currentCandidate) {
        this.candidateInvalidated = true;
        this.currentCandidate = null;
      }

      // 上报活动状态
      if (this.conn && !this.conn.socket.destroyed) {
        this.conn.sendEnvelope({
          version: PROTOCOL_VERSION,
          controllerId: this.controllerId,
          workerId: this.workerId,
          id: crypto.randomUUID(),
          seq: this.conn.nextSeq,
          type: "activity",
          payload: {
            state: "busy",
            toolName: String(event.toolName).slice(0, 256),
          },
        }).catch(() => {});
      }
    });

    // 监听 agent_settled：回执最终确认与后续消息触发
    this.pi.on("agent_settled", async (_event: any, ctx: ExtensionContext) => {
      const gen = this.activeGeneration;
      // 旧会话晚到的 settled：代际失效或不存在当前上下文 → 直接忽略。
      // 绝不比较 ctx 身份：Pi 每个事件都新建 ctx 对象，跨事件身份比较恒为真，
      // 若用身份比较会把真实回执静默丢弃。
      if (!this.isCurrentGeneration(gen) || !this.currentContext) {
        this.staleCallbacksIgnored++;
        return;
      }
      // 本事件的 ctx 就是当前会话上下文：记录下来，供后续路径继续使用
      this.currentContext = ctx;

      // 1. 确认候选回执
      if (this.currentCandidate && !this.candidateInvalidated) {
        this.taskHasReported = true;
        if (this.conn && !this.conn.socket.destroyed) {
          this.conn.sendEnvelope({
            version: PROTOCOL_VERSION,
            controllerId: this.controllerId,
            workerId: this.workerId,
            taskId: this.currentTaskId ?? undefined,
            revision: this.currentRevision,
            id: crypto.randomUUID(),
            seq: this.conn.nextSeq,
            type: "report_committed",
            payload: {
              taskId: this.currentTaskId ?? "",
              revision: this.currentRevision,
              runId: this.currentRunId,
              report: this.currentCandidate,
            },
          }).catch(() => {});
        }
        this.currentCandidate = null;
      } else if (!this.taskHasReported && this.currentTaskId) {
        // 模型结束了但没有提交过回执
        if (this.conn && !this.conn.socket.destroyed) {
          this.conn.sendEnvelope({
            version: PROTOCOL_VERSION,
            controllerId: this.controllerId,
            workerId: this.workerId,
            taskId: this.currentTaskId,
            revision: this.currentRevision,
            id: crypto.randomUUID(),
            seq: this.conn.nextSeq,
            type: "report_missing",
            payload: {
              taskId: this.currentTaskId,
              revision: this.currentRevision,
              runId: this.currentRunId,
            },
          }).catch(() => {});
        }
      }

      // 2. 检查是否有排队消息在独立 tick 派发
      setImmediate(() => {
        // 续段跨越 tick：重新校验代际与当前上下文是否存在，
        // 绝不比较 ctx 身份，也绝不把旧会话消息注入新会话
        if (!this.isCurrentGeneration(gen) || !this.currentContext) {
          this.staleCallbacksIgnored++;
          return;
        }
        if (
          this.followupQueue.length > 0 &&
          this.currentContext &&
          this.currentContext.isIdle() &&
          !this.currentContext.hasPendingMessages()
        ) {
          const next = this.shiftQueueItem(gen);
          if (next) {
            this.dispatchUserMessage(next.message, ctx, gen);
          }
        } else if (
          this.followupQueue.length === 0 &&
          this.currentContext?.isIdle() &&
          !this.currentContext.hasPendingMessages() &&
          this.conn && !this.conn.socket.destroyed
        ) {
          this.conn.sendEnvelope({
            version: PROTOCOL_VERSION,
            controllerId: this.controllerId,
            workerId: this.workerId,
            taskId: this.currentTaskId ?? undefined,
            revision: this.currentRevision,
            id: crypto.randomUUID(),
            seq: this.conn.nextSeq,
            type: "activity",
            payload: { state: "idle" },
          }).catch(() => {});
        }
      });
    });
  }

  private registerWorkerReportTool(): void {
    this.pi.registerTool({
      name: "worker_report",
      label: "Worker Report",
      description: "向主控端提交进度进展、提问、阻碍问题或最终交付报告。当完成任务时调用此工具。",
      executionMode: "sequential",
      parameters: Type.Object({
        kind: Type.Union([
          Type.Literal("progress"),
          Type.Literal("question"),
          Type.Literal("blocked"),
          Type.Literal("result"),
          Type.Literal("failed"),
        ], { description: "回执种类：progress(进展), question(向主控提问), blocked(遇到阻碍无法继续), result(任务完成交付), failed(执行失败)" }),
        summary: Type.String({ description: "简短明了的任务进展、结论或原因摘要" }),
        changedFiles: Type.Optional(Type.Array(Type.String(), { description: "本次任务修改或创建的文件列表" })),
        validation: Type.Optional(Type.Array(Type.Object({
          command: Type.String({ description: "执行的验证命令" }),
          outcome: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not_run")]),
          note: Type.Optional(Type.String()),
        }), { description: "运行过的测试与验证记录" })),
        unresolved: Type.Optional(Type.Array(Type.String(), { description: "尚未解决的遗留问题" })),
        question: Type.Optional(Type.String({ description: "如果向主控提问，写明具体问题" })),
      }),
      execute: async (_toolCallId: string, params: any) => {
        const gen = this.activeGeneration;
        // 会话已切换/已关闭：不得写候选、不得向连接发送任何信封
        if (!this.isCurrentGeneration(gen) || !this.currentContext) {
          this.staleCallbacksIgnored++;
          return {
            content: [{ type: "text", text: "会话已切换，回执已作废" }],
            details: params,
          };
        }
        if (jsonByteLength(params) > MAX_REPORT_SIZE) {
          throw new Error(`回执超过 64 KiB 限制: ${ProtocolErrorCode.PAYLOAD_TOO_LARGE}`);
        }
        let report: WorkerReportPayload;
        try {
          report = validateWorkerReport(params);
        } catch (err: unknown) {
          if (
            err instanceof ProtocolValidationError &&
            err.code === ProtocolErrorCode.PAYLOAD_TOO_LARGE
          ) {
            throw new Error(`回执超过 64 KiB 限制: ${ProtocolErrorCode.PAYLOAD_TOO_LARGE}`);
          }
          throw err;
        }

        if (report.kind === "progress") {
          if (this.conn && !this.conn.socket.destroyed) {
            this.conn.sendEnvelope({
              version: PROTOCOL_VERSION,
              controllerId: this.controllerId,
              workerId: this.workerId,
              taskId: this.currentTaskId ?? undefined,
              revision: this.currentRevision,
              id: crypto.randomUUID(),
              seq: this.conn.nextSeq,
              type: "activity",
              payload: {
                state: "busy",
                toolName: `worker_report [progress: ${report.summary}]`.slice(0, 256),
              },
            }).catch(() => {});
          }
          return {
            content: [{ type: "text", text: `已记录阶段进展: ${report.summary}` }],
            details: report,
          };
        }

        // 终结类报告：提交候选前再次校验代际；失效则绝不写 currentCandidate、绝不发信封
        if (!this.isCurrentGeneration(gen) || !this.currentContext) {
          this.staleCallbacksIgnored++;
          return {
            content: [{ type: "text", text: "会话已切换，回执已作废" }],
            details: params,
          };
        }
        this.currentCandidate = report;
        this.candidateInvalidated = false;

        if (this.conn && !this.conn.socket.destroyed) {
          this.conn.sendEnvelope({
            version: PROTOCOL_VERSION,
            controllerId: this.controllerId,
            workerId: this.workerId,
            taskId: this.currentTaskId ?? undefined,
            revision: this.currentRevision,
            id: crypto.randomUUID(),
            seq: this.conn.nextSeq,
            type: "report_candidate",
            payload: {
              taskId: this.currentTaskId ?? "",
              revision: this.currentRevision,
              runId: this.currentRunId,
              report,
            },
          }).catch(() => {});
        }

        return {
          content: [
            {
              type: "text",
              text: `回执候选 (${report.kind}) 已记录。本轮不要继续调用其他工具，等待主控端审核。`,
            },
          ],
          details: report,
        };
      },
    });
  }

  private registerWorkerCommands(): void {
    this.pi.registerCommand("worker-status", {
      description: "查看当前 Worker 受控状态",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        const status = this.conn ? "已连接到 Controller" : "未连接 / 已脱钩";
        ctx.ui.notify(
          `Worker ID: ${this.workerId} | 任务: ${this.currentTaskId || "无"} | 管道: ${status}`,
          "info",
        );
      },
    });

    this.pi.registerCommand("worker-detach", {
      description: "脱离主控端管理，转为本地独立执行",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        const confirmed = await ctx.ui.confirm(
          "脱钩确认",
          "脱离主控后，主控将无法再自动派发或验收，当前窗口转为完全独立运行。是否确认？",
        );
        if (confirmed) {
          this.isDetached = true;
          if (this.conn) {
            this.conn.destroy();
            this.conn = null;
          }
          ctx.ui.notify("已脱钩主控，当前终端为独立会话", "warning");
        }
      },
    });
  }
}
