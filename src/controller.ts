/**
 * 主控端核心：状态机、单实例管理、命名管道服务、收件箱与工具/命令注册
 */

import * as net from "node:net";
import * as crypto from "node:crypto";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  PROTOCOL_VERSION,
  MAX_INBOX_EVENTS,
  MAX_INBOX_BYTES,
  MAX_REPORT_CACHE_SIZE,
  MAX_REPORT_CACHE_BYTES,
  MAX_WAIT_RESULT_SIZE,
  MAX_TASK_TEXT_SIZE,
  MAX_UNKNOWN_DELIVERIES,
  jsonByteLength,
  AUTH_TIMEOUT_MS,
  LAUNCH_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  ProtocolErrorCode,
  type Envelope,
  type HelloPayload,
  type LaunchPayload,
  type TaskPayload,
  type FollowupPayload,
  type AbortPayload,
  type ClosePayload,
  type TerminatePayload,
  type WorkerReportPayload,
  type ChildSpawnedPayload,
  type ChildExitPayload,
  type LaunchFailedPayload,
  type WorkerReadyPayload,
  type ActivityPayload,
  type ReportCandidatePayload,
  type ReportCommittedPayload,
  type StoppedPayload,
  type ReportMissingPayload,
  type LocalInputPayload,
  type ModelChangedPayload,
  THINKING_LEVELS,
} from "./protocol.js";

/**
 * 可静默淘汰的收件箱事件类型：只含高频、可重发的过程性事件。
 * 其余事件类型均视为关键事件，不得静默淘汰或丢弃，容量不足时必须显式拒绝。
 */
const EVICTABLE_INBOX_EVENT_TYPES = new Set([
  "activity",
  "model_changed",
  "task_accepted",
  "followup_accepted",
  "inbox_rejected",
  "report_rejected",
]);

/**
 * 可操作关键事件白名单（审慎收敛）。
 *
 * 只有这些事件才会：
 * 1. 写入收件箱后主动用 `pi.sendMessage` 唤醒主代理（空闲开新轮 / 忙碌 followUp 排队）；
 * 2. 作为 `worker_wait` 的匹配目标。
 *
 * 其余过程性事件（activity / model_changed / report_candidate / task_accepted /
 * followup_accepted / local_input / worker_ready / child_spawned 等）绝不触发推送，
 * 也不会让 `worker_wait` 提前返回，避免高频轮询噪声。
 */
export const ACTIONABLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  // 交付/提问/阻塞/失败回执：需要主代理验收或回复
  "report_committed",
  // 回执缺失：任务结束但没有有效交付，需要人工判断
  "report_missing",
  // Worker 合作式中止
  "stopped",
  // 连接断开 / 心跳失联：需要主代理介入
  "disconnected",
  "unresponsive",
  // 子进程退出 / 启动明确失败
  "child_exit",
  "launch_failed",
  // 关闭但未确认进程退出：占位可能残留，需要人工处理
  "child_exit_unconfirmed",
  // 关键回执被拒（缓存满）：需要主代理知情并采取措施
  "report_rejected",
  "inbox_rejected",
]);

/** 主动通知使用 custom message 的 customType（便于 UI 渲染与检索） */
export const WORKER_NOTIFICATION_CUSTOM_TYPE = "pi-terminal-worker:event";

/** 主动通知中事件摘要的最大字符数；超出截断，完整内容始终可用 worker_status 拉取 */
export const MAX_NOTIFICATION_SUMMARY_CHARS = 1500;

/** `worker_wait` 默认等待时长（5 分钟），避免默认长挂起 */
export const DEFAULT_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
/** `worker_wait` 允许的最大等待时长（10 分钟） */
export const MAX_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
/** `worker_wait` 允许的最小等待时长（保留显式短 timeout 兼容） */
export const MIN_WAIT_TIMEOUT_MS = 1000;

/**
 * Supervisor (bootstrap) 连接允许处理的消息类型白名单。
 * ack / error (带 replyTo) 通常已被传输层消费，此处仍纳入以防未匹配的残余消息。
 */
const SUPERVISOR_ALLOWED_MESSAGE_TYPES = new Set([
  "ack",
  "pong",
  "child_spawned",
  "child_exit",
  "launch_failed",
  "error",
]);

/**
 * Worker 连接允许处理的消息类型白名单。
 */
const WORKER_ALLOWED_MESSAGE_TYPES = new Set([
  "ack",
  "pong",
  "worker_ready",
  "model_changed",
  "activity",
  "report_candidate",
  "report_committed",
  "report_missing",
  "stopped",
  "local_input",
  "error",
]);

export interface CachedReportEntry {
  entryId: string;
  stage: "candidate" | "committed";
  taskId: string;
  revision: number;
  runId: number;
  kind: string;
  report: WorkerReportPayload;
  timestamp: number;
}

export class InboxCapacityError extends Error {
  public readonly code = ProtocolErrorCode.INBOX_FULL;
  constructor(
    public readonly limitType: "events" | "bytes",
    message: string,
  ) {
    super(message);
    this.name = "InboxCapacityError";
  }
}

export class ReportCacheFullError extends Error {
  public readonly code = ProtocolErrorCode.REPORT_CACHE_FULL;
  constructor(message: string) {
    super(message);
    this.name = "ReportCacheFullError";
  }
}

/**
 * 投递结果未知的登记项：ACK 超时表示“投递结果未知”，不是“对方没收到”。
 * 绝不据此自动重发或新建任务，仅保留请求 ID 供后续诊断/查询。
 */
export interface UnknownDeliveryEntry {
  requestId: string;
  kind: "launch" | "task" | "followup" | "abort" | "close";
  taskId?: string;
  revision?: number;
  runId?: number;
  at: number;
}

/**
 * 投递结果未知错误：请求可能已被对端接收并执行，严禁据此重发。
 */
export class DeliveryUnknownError extends Error {
  public readonly code = ProtocolErrorCode.DELIVERY_UNKNOWN;

  constructor(
    message: string,
    public readonly requestId: string,
  ) {
    super(message);
    this.name = "DeliveryUnknownError";
  }
}

/**
 * 判定一个异常是否代表“投递结果未知”(ACK 超时)
 */
function isDeliveryUnknownError(err: unknown): boolean {
  return err instanceof AckTimeoutError || (err as { deliveryUnknown?: boolean } | null)?.deliveryUnknown === true;
}
import {
  JsonlConnection,
  AckTimeoutError,
  getPipePath,
  timingSafeCompare,
} from "./transport.js";
import {
  SingleWorkerManager,
  SessionGenerationManager,
  CleanupRegistry,
  type WorkerInstanceMetadata,
} from "./lifecycle.js";
import {
  validateAndPrepareLaunch,
  detectTerminalBackends,
  encodeDescriptor,
  buildTerminalLaunch,
  launchWorkerWindow,
  type WorkerDescriptor,
  type TerminalProbes,
} from "./launcher.js";
import { updateWorkerUiStatus, notifyWorker } from "./ui.js";

class TerminalSpawnError extends Error {
  public readonly cause: Error;

  constructor(public readonly backend: string, cause: Error) {
    super(`终端后端 ${backend} 启动失败: ${cause.message}`);
    this.name = "TerminalSpawnError";
    this.cause = cause;
  }
}

/**
 * Worker (子代理) 默认模型配置：`worker_start` 未显式指定 provider/model/thinkingLevel 时使用。
 * 只影响新拉起的 Worker，不影响主 Pi 会话自身的默认模型，也不改动全局 Pi 设置。
 * 可用环境变量覆盖：PI_TERMINAL_WORKER_DEFAULT_PROVIDER / _DEFAULT_MODEL / _DEFAULT_THINKING
 */
export const DEFAULT_WORKER_PROVIDER = "deepseek";
export const DEFAULT_WORKER_MODEL = "deepseek-flash";
export const DEFAULT_WORKER_THINKING_LEVEL = "high";

export interface WorkerModelDefaults {
  provider: string;
  model: string;
  thinkingLevel: string;
}

/**
 * 合并调用方显式参数与默认配置：显式值优先，空白字符串视为未指定。
 * 显式 thinkingLevel 非法时直接报错（不静默回落到默认值）。
 */
export function resolveWorkerModelParams(
  params: { provider?: string; model?: string; thinkingLevel?: string },
  defaults: WorkerModelDefaults = resolveWorkerModelDefaults(),
): WorkerModelDefaults {
  let thinkingLevel = defaults.thinkingLevel;
  if (params.thinkingLevel !== undefined) {
    if (!(THINKING_LEVELS as readonly string[]).includes(params.thinkingLevel)) {
      throw new Error(
        `无效的 thinkingLevel: ${String(params.thinkingLevel)} (可选: ${THINKING_LEVELS.join("/")})`,
      );
    }
    thinkingLevel = params.thinkingLevel;
  }
  return {
    provider: params.provider?.trim() || defaults.provider,
    model: params.model?.trim() || defaults.model,
    thinkingLevel,
  };
}

/**
 * 解析 Worker 默认模型配置（环境变量优先，缺省回落常量），并校验 thinkingLevel 合法。
 */
export function resolveWorkerModelDefaults(
  env: NodeJS.ProcessEnv = process.env,
): WorkerModelDefaults {
  const thinkingLevel =
    (env.PI_TERMINAL_WORKER_DEFAULT_THINKING ?? "").trim() || DEFAULT_WORKER_THINKING_LEVEL;
  if (!(THINKING_LEVELS as readonly string[]).includes(thinkingLevel)) {
    throw new Error(
      `无效的 Worker 默认 thinkingLevel: ${thinkingLevel} (可选: ${THINKING_LEVELS.join("/")})`,
    );
  }
  return {
    provider: (env.PI_TERMINAL_WORKER_DEFAULT_PROVIDER ?? "").trim() || DEFAULT_WORKER_PROVIDER,
    model: (env.PI_TERMINAL_WORKER_DEFAULT_MODEL ?? "").trim() || DEFAULT_WORKER_MODEL,
    thinkingLevel,
  };
}

export interface InboxEvent {
  cursor: number;
  eventId: string;
  timestamp: number;
  type: string;
  workerId: string;
  taskId?: string;
  revision?: number;
  runId?: number;
  payload: unknown;
}

interface Waiter {
  afterCursor: number;
  workerId: string;
  taskId: string;
  resolve: (res: { event: InboxEvent; cursor: number }) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  /** 可选的取消信号（AbortSignal），取消时必须移除 waiter 并拒绝 promise */
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class ControllerManager {
  public readonly workerManager = new SingleWorkerManager();
  public readonly sessionGen = new SessionGenerationManager();
  public readonly cleanupRegistry = new CleanupRegistry();

  private server: net.Server | null = null;
  private pipePath: string | null = null;
  private supervisorConn: JsonlConnection | null = null;
  private workerConn: JsonlConnection | null = null;

  private expectedBootstrapToken: string | null = null;
  private expectedWorkerToken: string | null = null;

  private currentCommittedReport: WorkerReportPayload | null = null;
  private currentCandidateReport: WorkerReportPayload | null = null;

  private inbox: InboxEvent[] = [];
  private cursorCounter = 0;
  private inboxBytes = 0;
  private waiters: Waiter[] = [];
  /**
   * 默认 worker_wait 的消费游标（按实例隔离）。
   * 未显式传 afterCursor 时从该游标之后开始，保证默认调用不会重复返回同一事件；
   * 显式传 afterCursor 仍可重放历史事件。
   */
  private lastWaitCursor = 0;

  /** 可淘汰事件被静默丢弃的累计计数（仅过程性事件） */
  private droppedInboxEvents = 0;
  /** 关键事件因收件箱容量不足被显式拒绝的累计计数 */
  private inboxRejectedEvents = 0;
  /** 关键报告因缓存容量不足被显式拒绝的累计计数 */
  private reportCacheRejected = 0;
  /** 信封 controllerId/workerId 与当前实例不符被忽略的累计计数 */
  private identityRejectedEvents = 0;
  /** 过时任务（taskId/revision/runId 不匹配）被忽略的累计计数 */
  private staleIgnoredEvents = 0;
  /** 角色白名单不允许的消息类型被忽略的累计计数 */
  private roleRejectedEvents = 0;

  /** 投递结果未知的请求登记 (FIFO，容量 MAX_UNKNOWN_DELIVERIES) */
  private unknownDeliveries: UnknownDeliveryEntry[] = [];
  /** 因超限被 FIFO 淘汰的未知投递累计计数 (淘汰数量必须可查) */
  private unknownDeliveriesDropped = 0;

  /** 单连接认证超时，可被测试覆盖 */
  public authTimeoutMs = AUTH_TIMEOUT_MS;
  /** 启动握手超时，可被测试覆盖 */
  public launchTimeoutMs = LAUNCH_TIMEOUT_MS;
  /** worker_close 等待 child_exit 确认退出超时，可被测试覆盖 */
  public closeWaitTimeoutMs = 5000;

  /** 关键报告缓存（candidate/committed），受 128 条 / 8 MiB 双重上限约束 */
  private reportHistory: CachedReportEntry[] = [];
  private reportHistoryBytes = 0;

  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastActivityTime = Date.now();

  /** 真实 worker_ready 握手标志，每次启动前重置 */
  private workerReadyReceived = false;

  /** 当前会话代际 (与 sessionGen.generation 在 handleSessionStart 后保持一致) */
  private activeGeneration = 0;
  /** 因会话代际失效而被忽略的晚到回调累计计数 */
  private staleCallbacksIgnored = 0;
  /** 是否已确认子进程退出 (child_exit / launch_failed)，用于区分“closing 但无退出确认” */
  private childExitConfirmed = false;

  /** dispose() 幂等守卫 */
  private isDisposed = false;

  /** 正在进行中的关闭流程 (保证同一次关闭只执行一遍) */
  private closeInFlight: {
    workerId: string;
    disposition: string;
    promise: Promise<{ ok: boolean; disposition: string; message: string }>;
  } | null = null;

  /** 心跳间隔，可被测试覆盖 */
  public heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS;

  /** server / 连接 disposer 的反注册句柄 (资源被单独销毁时及时摘除，避免重复 destroy) */
  private serverCleanup: (() => void) | null = null;
  private supervisorConnCleanup: (() => void) | null = null;
  private workerConnCleanup: (() => void) | null = null;

  /** 会话级基础清理: 心跳与 waiters (函数引用稳定，Set 内天然去重) */
  private readonly baseCleanupDisposers: Array<() => Promise<void> | void> = [
    () => this.stopHeartbeat(),
    () => this.rejectWaiters(new Error("Controller 已关闭，等待已被取消")),
  ];

  /** 可注入的终端启动器，单元测试不实际开窗 */
  public launchSpawner: ((command: string, args: string[], options: SpawnOptions) => ChildProcess) | null = null;

  constructor(
    private pi: ExtensionAPI,
    private readonly strictProtocol = false,
  ) {
    this.ensureBaseCleanups();
  }

  /** 注册会话级基础清理 (幂等: 同一 registry 内按函数引用去重) */
  private ensureBaseCleanups(): void {
    for (const disposer of this.baseCleanupDisposers) {
      this.cleanupRegistry.register(disposer);
    }
  }

  /** 当前会话代际是否仍然有效 */
  public isCurrentGeneration(gen: number): boolean {
    return this.sessionGen.isValid(gen);
  }

  /** 结束全部等待者 (dispose 与会话切换共用)，区分错误文案由调用方传入 */
  private rejectWaiters(err: Error): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      this.detachAbort(w);
      try {
        w.reject(err);
      } catch {
        // 等待者已 settle 时忽略
      }
    }
  }

  /** 摘掉 waiter 的 AbortSignal 监听，避免取消后残留监听器 */
  private detachAbort(w: Waiter): void {
    if (w.signal && w.onAbort) {
      w.signal.removeEventListener("abort", w.onAbort);
    }
  }

  /** 从 waiters 中精确移除一个 waiter（超时/取消时必须调用，绝不泄漏） */
  private removeWaiter(target: Waiter): void {
    this.waiters = this.waiters.filter((w) => w !== target);
  }

  /** 注册一条已认证连接的销毁清理，并保留反注册句柄 */
  private registerConnCleanup(role: "supervisor" | "worker", conn: JsonlConnection): void {
    const unregister = this.cleanupRegistry.register(() => {
      if (role === "supervisor") {
        if (this.supervisorConn === conn) this.supervisorConn = null;
      } else {
        if (this.workerConn === conn) this.workerConn = null;
      }
      try {
        conn.destroy();
      } catch {
        // 忽略销毁时的错误
      }
    });
    if (role === "supervisor") {
      this.supervisorConnCleanup = unregister;
    } else {
      this.workerConnCleanup = unregister;
    }
  }

  /** 摘除某一角色连接的销毁清理 (连接已被单独销毁/已关闭时使用) */
  private unregisterConnCleanup(role: "supervisor" | "worker"): void {
    if (role === "supervisor") {
      if (this.supervisorConnCleanup) this.supervisorConnCleanup();
      this.supervisorConnCleanup = null;
    } else {
      if (this.workerConnCleanup) this.workerConnCleanup();
      this.workerConnCleanup = null;
    }
  }

  /**
   * 清空与具体 Worker 实例/会话绑定的报告、收件箱、缓存与诊断计数。
   * handleWorkerStart (新实例) 与 handleSessionStart (新会话) 共用。
   */
  private resetSessionScopedState(): void {
    this.currentCommittedReport = null;
    this.currentCandidateReport = null;
    this.workerReadyReceived = false;

    this.inbox = [];
    this.cursorCounter = 0;
    this.inboxBytes = 0;
    this.lastWaitCursor = 0;
    this.droppedInboxEvents = 0;
    this.inboxRejectedEvents = 0;
    this.reportCacheRejected = 0;
    this.identityRejectedEvents = 0;
    this.staleIgnoredEvents = 0;
    this.roleRejectedEvents = 0;
    this.staleCallbacksIgnored = 0;
    this.reportHistory = [];
    this.reportHistoryBytes = 0;
    this.unknownDeliveries = [];
    this.unknownDeliveriesDropped = 0;
  }

  public getInboxEvent(eventId: string): InboxEvent | undefined {
    return this.inbox.find((e) => e.eventId === eventId);
  }

  private appendInbox(
    type: string,
    payload: unknown,
    taskId?: string,
    revision?: number,
    runId?: number,
    options: { notify?: boolean } = {},
  ): InboxEvent {
    const inst = this.workerManager.getInstance();
    const event: InboxEvent = {
      cursor: ++this.cursorCounter,
      eventId: crypto.randomUUID(),
      timestamp: Date.now(),
      type,
      workerId: inst ? inst.workerId : "",
      taskId: taskId ?? inst?.taskId,
      revision: revision ?? inst?.revision,
      runId: runId ?? inst?.runId,
      payload,
    };

    const bytes = jsonByteLength(payload);

    // 为本次写入腾空间：最旧优先淘汰可淘汰事件
    this.evictInboxForCapacity(bytes);

    const overEvents = this.inbox.length + 1 > MAX_INBOX_EVENTS;
    const overBytes = this.inboxBytes + bytes > MAX_INBOX_BYTES;
    if (overEvents || overBytes) {
      if (!EVICTABLE_INBOX_EVENT_TYPES.has(type)) {
        // 关键事件不得静默丢弃，显式抛出容量错误 (不写入、不递增字节、不唤醒 Waiter)
        const limitType: "events" | "bytes" = overEvents ? "events" : "bytes";
        const message =
          `收件箱容量不足，无法容纳关键事件 "${type}": 当前 ${this.inbox.length}/${MAX_INBOX_EVENTS} 条、` +
          `${this.inboxBytes}/${MAX_INBOX_BYTES} 字节，新增 ${bytes} 字节 (越界维度: ${limitType})`;
        throw new InboxCapacityError(limitType, message);
      }
      // 可淘汰事件允许静默丢弃
      this.droppedInboxEvents++;
      console.warn(
        `[Controller] 可淘汰收件箱事件被丢弃 (type=${type}): 当前 ${this.inbox.length}/${MAX_INBOX_EVENTS} 条、` +
        `${this.inboxBytes}/${MAX_INBOX_BYTES} 字节，新增 ${bytes} 字节`,
      );
      return event;
    }

    this.inbox.push(event);
    this.inboxBytes += bytes;

    // 写入成功后才唤醒匹配的 Waiter（仅可操作关键事件）
    this.notifyWaiters(event);

    // 关键事件的收件箱写入成功后，再主动通知主代理。
    // 通知失败绝不影响收件箱写入/ACK：sendMessage 异常在本方法内部被吞掉，
    // 且始终保留 worker_wait 作为兜底。
    if (options.notify !== false) this.notifyProactive(event);

    return event;
  }

  /**
   * 最旧优先淘汰可淘汰事件，直到新增 incomingBytes 的事件可以同时满足条数与字节上限。
   * 恰好等于上限时不淘汰 (必须允许)；无可淘汰事件时直接返回。
   */
  private evictInboxForCapacity(incomingBytes: number): void {
    while (
      this.inbox.length + 1 > MAX_INBOX_EVENTS ||
      this.inboxBytes + incomingBytes > MAX_INBOX_BYTES
    ) {
      const idx = this.inbox.findIndex((e) =>
        EVICTABLE_INBOX_EVENT_TYPES.has(e.type),
      );
      if (idx === -1) return;
      const [victim] = this.inbox.splice(idx, 1);
      this.inboxBytes -= jsonByteLength(victim.payload);
    }
  }

  /**
   * 关键报告缓存：受 128 条 / 8 MiB 双重上限约束，超限时抛 ReportCacheFullError，
   * 不写入、不覆盖、不静默淘汰已有条目。
   */
  private cacheReport(
    stage: "candidate" | "committed",
    taskId: string,
    revision: number,
    runId: number,
    report: WorkerReportPayload,
  ): CachedReportEntry {
    const bytes = jsonByteLength(report);
    if (
      this.reportHistory.length + 1 > MAX_REPORT_CACHE_SIZE ||
      this.reportHistoryBytes + bytes > MAX_REPORT_CACHE_BYTES
    ) {
      throw new ReportCacheFullError(
        `关键报告缓存已满: 当前 ${this.reportHistory.length}/${MAX_REPORT_CACHE_SIZE} 条、` +
        `${this.reportHistoryBytes}/${MAX_REPORT_CACHE_BYTES} 字节，新增 ${bytes} 字节`,
      );
    }
    const entry: CachedReportEntry = {
      entryId: crypto.randomUUID(),
      stage,
      taskId,
      revision,
      runId,
      kind: report.kind,
      report,
      timestamp: Date.now(),
    };
    this.reportHistory.push(entry);
    this.reportHistoryBytes += bytes;
    return entry;
  }

  /**
   * 收件箱容量统计 (供 worker_status 与诊断输出使用)
   */
  public getInboxStats(): {
    count: number;
    bytes: number;
    dropped: number;
    rejected: number;
    maxEvents: number;
    maxBytes: number;
  } {
    return {
      count: this.inbox.length,
      bytes: this.inboxBytes,
      dropped: this.droppedInboxEvents,
      rejected: this.inboxRejectedEvents,
      maxEvents: MAX_INBOX_EVENTS,
      maxBytes: MAX_INBOX_BYTES,
    };
  }

  /**
   * 登记一条“投递结果未知”的请求。同一请求 ID 只登记一次；
   * 超过 MAX_UNKNOWN_DELIVERIES 时 FIFO 淘汰最旧并递增 unknownDeliveriesDropped。
   */
  private recordUnknownDelivery(entry: UnknownDeliveryEntry): void {
    if (this.unknownDeliveries.some((d) => d.requestId === entry.requestId)) {
      return;
    }
    if (this.unknownDeliveries.length >= MAX_UNKNOWN_DELIVERIES) {
      this.unknownDeliveries.shift();
      this.unknownDeliveriesDropped++;
    }
    this.unknownDeliveries.push(entry);
  }

  /**
   * 关键报告缓存统计 (供 worker_status 与诊断输出使用)
   */
  public getReportCacheStats(): {
    count: number;
    bytes: number;
    rejected: number;
    maxCount: number;
    maxBytes: number;
  } {
    return {
      count: this.reportHistory.length,
      bytes: this.reportHistoryBytes,
      rejected: this.reportCacheRejected,
      maxCount: MAX_REPORT_CACHE_SIZE,
      maxBytes: MAX_REPORT_CACHE_BYTES,
    };
  }

  private notifyWaiters(event: InboxEvent): void {
    // 只匹配可操作关键事件：普通进度（activity / report_candidate / 启动成功等）
    // 绝不让 worker_wait 提前返回。
    if (!ACTIONABLE_EVENT_TYPES.has(event.type)) return;
    const remaining: Waiter[] = [];
    for (const w of this.waiters) {
      if (event.cursor > w.afterCursor && event.workerId === w.workerId && event.taskId === w.taskId) {
        clearTimeout(w.timer);
        this.detachAbort(w);
        // 消费游标推进：默认 worker_wait 下次从该事件之后继续，避免重复返回。
        this.lastWaitCursor = Math.max(this.lastWaitCursor, event.cursor);
        w.resolve({ event, cursor: event.cursor });
      } else {
        remaining.push(w);
      }
    }
    this.waiters = remaining;
  }

  /**
   * 关键事件写入收件箱后主动唤醒主代理（空闲时开新轮，忙碌时 followUp 排队）。
   *
   * 安全边界：
   * - 旧会话语义由入口回调负责：bindWorker / bindSupervisor 在 appendInbox 之前
   *   已用 `isCurrentGeneration(gen)` 拦截旧 generation 的晚到消息，所以本方法只会
   *   被当前会话的事件调用；
   * - 下面的 `isCurrentGeneration(this.activeGeneration)` 只是 disposed 保护
   *   （防已销毁实例继续发通知），并不能、也不宣称能拦截旧代际；
   * - pi.sendMessage 缺失或抛错都被吞掉并降级为日志，绝不破坏收件箱/ACK 协议；
   * - 发送失败不自动重试、不阻塞，始终保留 worker_wait 作为兜底。
   */
  private notifyProactive(event: InboxEvent): void {
    if (!ACTIONABLE_EVENT_TYPES.has(event.type)) return;
    // disposed 保护：已销毁实例的 activeGeneration 不再有效时不再发通知。
    // 旧代际拦截发生在入口回调（bindWorker/bindSupervisor）的 gen 检查处。
    if (!this.isCurrentGeneration(this.activeGeneration)) return;

    try {
      const send = (this.pi as { sendMessage?: ExtensionAPI["sendMessage"] }).sendMessage;
      if (typeof send !== "function") return;
      send.call(
        this.pi,
        {
          customType: WORKER_NOTIFICATION_CUSTOM_TYPE,
          content: [{ type: "text", text: this.buildNotificationText(event) }],
          display: true,
          details: {
            eventId: event.eventId,
            cursor: event.cursor,
            type: event.type,
            workerId: event.workerId,
            taskId: event.taskId,
            revision: event.revision,
            runId: event.runId,
          },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } catch (err) {
      console.warn(
        `[Controller] 主动通知发送失败 (type=${event.type})，已忽略并保留 worker_wait 兜底:`,
        err,
      );
    }
  }

  /** 构造有界的关键事件通知正文：含完整身份/游标与有界摘要，并明确后续动作。 */
  private buildNotificationText(event: InboxEvent): string {
    let summary: string;
    try {
      summary = JSON.stringify(event.payload ?? {});
    } catch {
      summary = String(event.payload);
    }
    if (typeof summary !== "string") summary = String(summary);
    if (summary.length > MAX_NOTIFICATION_SUMMARY_CHARS) {
      summary = summary.slice(0, MAX_NOTIFICATION_SUMMARY_CHARS) + "…(已截断)";
    }
    const identity =
      `workerId=${event.workerId || "(none)"} taskId=${event.taskId ?? "(none)"} ` +
      `revision=${event.revision ?? "-"} runId=${event.runId ?? "-"} ` +
      `cursor=${event.cursor} eventId=${event.eventId}`;
    return (
      `[pi-terminal-worker] 关键事件 ${event.type} 已到达。\n` +
      `${identity}\n` +
      `摘要: ${summary}\n` +
      `处理建议: 用 worker_status({ workerId, eventId }) 获取完整详情与当前状态；` +
      `无需立即处理时可结束当前轮，后续关键事件会自动唤醒，不必循环调用 worker_wait。`
    );
  }

  /**
   * 启动管道服务端并等待连接
   */
  public async startServer(controllerId: string): Promise<string> {
    if (this.server) {
      try {
        this.server.close();
      } catch {}
      this.server = null;
    }
    if (this.serverCleanup) {
      this.serverCleanup();
      this.serverCleanup = null;
    }

    this.pipePath = getPipePath(controllerId);

    return new Promise<string>((resolve, reject) => {
      const srv = net.createServer((socket) => {
        this.handleIncomingSocket(socket);
      });

      srv.on("error", (err) => {
        reject(
          new Error(
            `命名管道监听失败 (${this.pipePath}): ${err.message}`,
          ),
        );
      });

      srv.listen(this.pipePath, () => {
        this.server = srv;
        if (this.serverCleanup) this.serverCleanup();
        this.serverCleanup = this.cleanupRegistry.register(() => {
          try {
            srv.close();
          } catch {
            // 忽略关闭时的错误
          }
          if (this.server === srv) this.server = null;
        });
        resolve(this.pipePath!);
      });
    });
  }

  /**
   * 接受一条新连接：每角色最多一条，认证完成前只允许 hello，
   * 认证成功后绑定并回 hello_ok；任何失败路径统一走 rejectIncomingSocket。
   */
  private handleIncomingSocket(socket: net.Socket): void {
    let authenticated = false;
    let authTimer: NodeJS.Timeout | null = setTimeout(() => {
      authTimer = null;
      if (!authenticated) {
        clearAuthTimer();
        socket.destroy();
      }
    }, this.authTimeoutMs);

    const clearAuthTimerRaw = (): void => {
      if (authTimer) {
        clearTimeout(authTimer);
        authTimer = null;
      }
    };

    // 认证完成前: 把“认证定时器 + 未认证 socket”注册进清理器，
    // 一旦认证成功/被拒绝/对端关闭就立即摘除，避免 dispose 误销毁新会话连接。
    let unregisterPending: (() => void) | null = null;
    const clearAuthTimer = (): void => {
      clearAuthTimerRaw();
      if (unregisterPending) {
        unregisterPending();
        unregisterPending = null;
      }
    };
    unregisterPending = this.cleanupRegistry.register(() => {
      clearAuthTimerRaw();
      try {
        socket.destroy();
      } catch {
        // 忽略销毁时的错误
      }
    });

    const tempConn = new JsonlConnection(socket, "controller", this.strictProtocol);

    // socket 提前关闭时必须清掉认证定时器，避免泄漏 timer 或在已关闭 socket 上操作
    tempConn.on("close", () => {
      clearAuthTimer();
    });

    tempConn.on("message", (env: Envelope) => {
      try {
      // 已认证连接：只拦截 hello 重放，其余消息交给 bind* 的监听处理
      if (authenticated) {
        if (env.type === "hello") {
          this.sendConnError(
            tempConn,
            env,
            ProtocolErrorCode.ALREADY_EXISTS,
            "该连接已完成认证，拒绝重复的 hello（不销毁当前活跃连接）",
          );
        }
        return;
      }

      // 认证完成前收到非 hello：明确拒绝并销毁，不认证、不绑定
      if (env.type !== "hello") {
        this.rejectIncomingSocket(
          tempConn,
          env,
          socket,
          clearAuthTimer,
          ProtocolErrorCode.PROTOCOL_ERROR,
          "认证完成前只接受 hello 消息",
        );
        return;
      }

      const payload = env.payload as HelloPayload;
      const role = payload.role;

      // 角色本身非法：拒绝
      if (role !== "supervisor" && role !== "worker") {
        this.rejectIncomingSocket(
          tempConn,
          env,
          socket,
          clearAuthTimer,
          ProtocolErrorCode.IDENTITY_MISMATCH,
          `未知的 hello 角色: ${String(role)}`,
        );
        return;
      }

      // token 不匹配或期望 token 尚未设置：认证失败
      const expectedToken =
        role === "supervisor" ? this.expectedBootstrapToken : this.expectedWorkerToken;
      if (!expectedToken || !timingSafeCompare(payload.token, expectedToken)) {
        this.rejectIncomingSocket(
          tempConn,
          env,
          socket,
          clearAuthTimer,
          ProtocolErrorCode.AUTH_FAILED,
          "Token 认证失败或角色不匹配",
        );
        return;
      }

      // 实例身份校验：hello 的 controllerId/workerId 必须与当前实例完全一致
      const inst = this.workerManager.getInstance();
      if (
        !inst ||
        payload.controllerId !== inst.controllerId ||
        payload.workerId !== inst.workerId
      ) {
        this.rejectIncomingSocket(
          tempConn,
          env,
          socket,
          clearAuthTimer,
          ProtocolErrorCode.IDENTITY_MISMATCH,
          "hello 身份与当前 Worker 实例不一致",
        );
        return;
      }

      // 同角色最多一条连接：绝不覆盖已绑定的连接对象，也不重复 bind
      if (role === "supervisor" && this.supervisorConn) {
        this.rejectIncomingSocket(
          tempConn,
          env,
          socket,
          clearAuthTimer,
          ProtocolErrorCode.ALREADY_EXISTS,
          "Supervisor 连接已建立，拒绝第二条连接",
        );
        return;
      }
      if (role === "worker" && this.workerConn) {
        this.rejectIncomingSocket(
          tempConn,
          env,
          socket,
          clearAuthTimer,
          ProtocolErrorCode.ALREADY_EXISTS,
          "Worker 连接已建立，拒绝第二条连接",
        );
        return;
      }

      // 认证成功：清定时器、绑定并回一次 hello_ok
      authenticated = true;
      clearAuthTimer();
      if (role === "supervisor") {
        this.supervisorConn = tempConn;
        this.bindSupervisor(tempConn);
        this.registerConnCleanup("supervisor", tempConn);
      } else {
        this.workerConn = tempConn;
        this.bindWorker(tempConn);
        this.registerConnCleanup("worker", tempConn);
      }
      tempConn.sendEnvelope({
        version: PROTOCOL_VERSION,
        controllerId: env.controllerId,
        workerId: env.workerId,
        id: crypto.randomUUID(),
        replyTo: env.id,
        seq: tempConn.nextSeq,
        type: "hello_ok",
        payload: { sessionGeneration: this.sessionGen.generation },
      });
      } catch (err) {
        // 认证阶段的未预期异常不得逃逸到 socket 回调
        console.error("[Controller] 认证阶段处理消息时出现未预期异常:", err);
        clearAuthTimer();
        try {
          socket.destroy();
        } catch {
          // 忽略销毁时的错误
        }
      }
    });

    tempConn.on("error", () => {
      socket.destroy();
    });
  }

  /**
   * 拒绝一条新连接的统一出口：清认证定时器、尽力回送 error envelope 后销毁 socket，
   * 绝不覆盖已绑定连接、不改变任何实例状态。
   */
  private rejectIncomingSocket(
    conn: JsonlConnection,
    env: Envelope,
    socket: net.Socket,
    clearAuthTimer: () => void,
    code: string,
    message: string,
  ): void {
    clearAuthTimer();
    void this.sendConnError(conn, env, code, message).finally(() => {
      try {
        socket.destroy();
      } catch {
        // 忽略销毁时的错误
      }
    });
  }

  private bindSupervisor(conn: JsonlConnection): void {
    const gen = this.activeGeneration;
    conn.on("message", (env: Envelope) => {
      if (!this.isCurrentGeneration(gen)) {
        this.staleCallbacksIgnored++;
        return;
      }
      try {
        // 已认证连接上的 hello 由认证层处理（ALREADY_EXISTS），此处静默跳过
        if (env.type === "hello") return;
        if (!this.checkRoleAllowed(env.type, SUPERVISOR_ALLOWED_MESSAGE_TYPES)) return;
        const inst = this.workerManager.getInstance();
        if (!this.checkEnvelopeIdentity(conn, env, inst)) return;

        this.lastActivityTime = Date.now();
        if (env.type === "child_spawned") {
          const p = env.payload as ChildSpawnedPayload;
          this.workerManager.setChildPid(p.pid);
          this.appendInbox("child_spawned", p);
        } else if (env.type === "child_exit") {
          const p = env.payload as ChildExitPayload;
          // 在状态变成 closed 前识别预期退出。仅在 close 仍在等待且正常退出时
          // 静默：工具本身会返回关闭结果；超时后晚到的退出及异常退出仍需通知。
          const expectedExit =
            inst?.lifecycleState === "closing" &&
            this.closeInFlight?.workerId === inst.workerId &&
            p.code === 0 && p.signal === null;
          this.childExitConfirmed = true;
          this.workerManager.updateLifecycleState("closed");
          this.appendInbox("child_exit", p, undefined, undefined, undefined, { notify: !expectedExit });
          this.stopHeartbeat();
        } else if (env.type === "launch_failed") {
          const p = env.payload as LaunchFailedPayload;
          this.childExitConfirmed = true;
          this.workerManager.updateLifecycleState("closed");
          this.appendInbox("launch_failed", p);
        }
      } catch (err) {
        this.reportEnvelopeRejected(conn, env, err);
      }
    });

    conn.on("close", () => {
      if (!this.isCurrentGeneration(gen)) {
        this.staleCallbacksIgnored++;
        return;
      }
      if (this.supervisorConn === conn) {
        this.supervisorConn = null;
        this.unregisterConnCleanup("supervisor");
      }
      // closing 中间态不被 disconnected 覆盖；双连接丢失且无 child_exit 时给出明确诊断。
      const inst = this.workerManager.getInstance();
      if (
        inst &&
        inst.lifecycleState === "closing" &&
        this.workerConn === null &&
        !this.childExitConfirmed
      ) {
        this.appendInbox("child_exit_unconfirmed", {
          pid: inst.childPid,
          workerConnAlive: false,
          supervisorConnAlive: false,
          taskState: inst.taskState,
        });
      }
    });
  }

  /**
   * 角色白名单校验：不允许的消息类型只忽略 + 计数，不改变状态、不回 error。
   */
  private checkRoleAllowed(type: string, allowed: Set<string>): boolean {
    if (allowed.has(type)) return true;
    this.roleRejectedEvents++;
    console.warn(`[Controller] 忽略角色不允许的消息类型: ${type}`);
    return false;
  }

  /**
   * 每帧实例身份校验：controllerId/workerId 与当前实例不符（或无实例）时，
   * 回一条 IDENTITY_MISMATCH error、忽略该消息、不销毁连接、不改变状态。
   */
  private checkEnvelopeIdentity(
    conn: JsonlConnection,
    env: Envelope,
    inst: WorkerInstanceMetadata | null,
  ): boolean {
    if (inst && env.controllerId === inst.controllerId && env.workerId === inst.workerId) {
      return true;
    }
    this.identityRejectedEvents++;
    const detail = inst
      ? `env=${env.controllerId}/${env.workerId} 实例=${inst.controllerId}/${inst.workerId}`
      : "当前无活动 Worker 实例";
    console.warn(`[Controller] 忽略身份不符的信封 (type=${env.type}): ${detail}`);
    this.sendConnError(
      conn,
      env,
      ProtocolErrorCode.IDENTITY_MISMATCH,
      `信封身份与当前实例不一致: ${detail}`,
    );
    return false;
  }

  private bindWorker(conn: JsonlConnection): void {
    this.workerManager.updateLifecycleState("connected");
    this.startHeartbeat();

    const gen = this.activeGeneration;
    conn.on("message", (env: Envelope) => {
      if (!this.isCurrentGeneration(gen)) {
        this.staleCallbacksIgnored++;
        return;
      }
      try {
      // 已认证连接上的 hello 由认证层处理（ALREADY_EXISTS），此处静默跳过
      if (env.type === "hello") return;
      if (!this.checkRoleAllowed(env.type, WORKER_ALLOWED_MESSAGE_TYPES)) return;
      const inst = this.workerManager.getInstance();
      if (!this.checkEnvelopeIdentity(conn, env, inst)) return;
      this.lastActivityTime = Date.now();

      switch (env.type) {
        case "pong":
          // 心跳应答
          break;

        case "worker_ready": {
          const p = env.payload as WorkerReadyPayload;
          this.workerReadyReceived = true;
          this.workerManager.setModelInfo(p.provider, p.modelId, p.thinkingLevel, p.tools);
          this.appendInbox("worker_ready", p);
          break;
        }

        case "model_changed": {
          const p = env.payload as ModelChangedPayload;
          this.workerManager.setModelInfo(p.provider, p.modelId, p.thinkingLevel);
          this.appendInbox("model_changed", p);
          break;
        }

        case "activity": {
          const p = env.payload as ActivityPayload;
          this.workerManager.updateActivityState(p.state);
          this.appendInbox("activity", p);
          break;
        }

        case "report_candidate": {
          const p = env.payload as ReportCandidatePayload;
          if (inst && p.taskId === inst.taskId && p.revision === inst.revision && p.runId === inst.runId) {
            // 缓存满时显式拒绝，不更新候选状态
            try {
              this.cacheReport("candidate", p.taskId, p.revision, p.runId, p.report);
            } catch (err) {
              if (err instanceof ReportCacheFullError) {
                this.handleReportCacheRejected(conn, env, p, "candidate");
                break;
              }
              throw err;
            }
            this.currentCandidateReport = p.report;
            this.appendInbox("report_candidate", p.report, p.taskId, p.revision, p.runId);
          } else {
            this.staleIgnoredEvents++;
          }
          break;
        }

        case "report_committed": {
          const p = env.payload as ReportCommittedPayload;
          if (inst && p.taskId === inst.taskId && p.revision === inst.revision && p.runId === inst.runId) {
            // 缓存满时显式拒绝，任务状态必须保持原状
            try {
              this.cacheReport("committed", p.taskId, p.revision, p.runId, p.report);
            } catch (err) {
              if (err instanceof ReportCacheFullError) {
                this.handleReportCacheRejected(conn, env, p, "committed");
                break;
              }
              throw err;
            }

            this.currentCommittedReport = p.report;
            this.currentCandidateReport = null;

            if (p.report.kind === "result") {
              this.workerManager.updateTaskState("ready_for_review");
            } else if (p.report.kind === "question") {
              this.workerManager.updateTaskState("waiting_reply");
            } else if (p.report.kind === "blocked") {
              this.workerManager.updateTaskState("blocked");
            } else if (p.report.kind === "failed") {
              this.workerManager.updateTaskState("failed");
            }

            this.appendInbox("report_committed", p.report, p.taskId, p.revision, p.runId);
          } else {
            this.staleIgnoredEvents++;
          }
          break;
        }

        case "report_missing": {
          const p = env.payload as ReportMissingPayload;
          if (inst && p.taskId === inst.taskId && p.revision === inst.revision && p.runId === inst.runId) {
            this.currentCommittedReport = null;
            this.currentCandidateReport = null;
            this.workerManager.updateTaskState("idle_unreported");
            this.appendInbox("report_missing", {}, p.taskId, p.revision, p.runId);
          } else {
            this.staleIgnoredEvents++;
          }
          break;
        }

        case "stopped": {
          const p = env.payload as StoppedPayload;
          if (inst && p.taskId === inst.taskId && p.revision === inst.revision && p.runId === inst.runId) {
            this.currentCommittedReport = null;
            this.currentCandidateReport = null;
            this.workerManager.updateTaskState("stopped");
            this.appendInbox("stopped", {}, p.taskId, p.revision, p.runId);
          } else {
            this.staleIgnoredEvents++;
          }
          break;
        }

        case "local_input": {
          const p = env.payload as LocalInputPayload;
          this.currentCommittedReport = null;
          this.currentCandidateReport = null;
          this.workerManager.updateActivityState("unknown");
          this.workerManager.updateTaskState("running");
          this.appendInbox("local_input", p);
          break;
        }
      }
      } catch (err) {
        this.reportEnvelopeRejected(conn, env, err);
      }
    });

    conn.on("close", () => {
      if (!this.isCurrentGeneration(gen)) {
        this.staleCallbacksIgnored++;
        return;
      }
      if (this.workerConn === conn) {
        this.workerConn = null;
        this.unregisterConnCleanup("worker");
      }
      const inst = this.workerManager.getInstance();
      if (!inst) return;
      if (inst.lifecycleState === "closing") {
        // closing 中间态优先于断连：保留 closing，仅追加可诊断事件，不释放名额
        this.appendInbox("conn_closed", {
          role: "worker",
          previousState: "closing",
          pid: inst.childPid,
        });
        return;
      }
      if (inst.lifecycleState === "closed") {
        // 已确认退出，不追加 disconnected
        return;
      }
      this.workerManager.updateLifecycleState("disconnected");
      this.appendInbox("disconnected", { workerId: inst.workerId });
    });
  }

  /**
   * 关键报告缓存满时的统一拒绝路径：计数、告警、显式 error envelope、诊断事件。
   * 不更新 taskState / currentCommittedReport / currentCandidateReport。
   */
  private handleReportCacheRejected(
    conn: JsonlConnection,
    env: Envelope,
    p: { taskId: string; revision: number; runId: number },
    stage: "candidate" | "committed",
  ): void {
    this.reportCacheRejected++;
    const stats = this.getReportCacheStats();
    const message =
      `关键报告缓存已满，本次 ${stage} 回执被拒绝: 当前 ${stats.count}/${stats.maxCount} 条、` +
      `${stats.bytes}/${stats.maxBytes} 字节`;
    console.warn(`[Controller] ${message}`);
    this.sendConnError(conn, env, ProtocolErrorCode.REPORT_CACHE_FULL, message);
    // 尽力追加一条可淘汰的诊断事件，自身失败不得再抛
    try {
      this.appendInbox(
        "report_rejected",
        { reason: "report_cache_full", stage, taskId: p.taskId },
        p.taskId,
        p.revision,
        p.runId,
      );
    } catch {
      // 诊断事件追加失败忽略
    }
  }

  /**
   * socket 消息处理体被异常击穿时的统一出口：
   * 区分容量错误与其他异常，均显式回送 error envelope，不得抛出、不得把状态改成成功。
   */
  private reportEnvelopeRejected(
    conn: JsonlConnection,
    env: Envelope,
    err: unknown,
  ): void {
    if (err instanceof InboxCapacityError) {
      this.inboxRejectedEvents++;
      console.warn(`[Controller] ${err.message}`);
      this.sendConnError(conn, env, ProtocolErrorCode.INBOX_FULL, err.message);
      // 尽力追加一条可淘汰的诊断事件，自身失败忽略
      try {
        this.appendInbox("inbox_rejected", {
          reason: "inbox_full",
          limitType: err.limitType,
          event: env.type,
        });
      } catch {
        // 诊断事件追加失败忽略
      }
      return;
    }

    if (err instanceof ReportCacheFullError) {
      this.reportCacheRejected++;
      console.warn(`[Controller] ${err.message}`);
      this.sendConnError(conn, env, ProtocolErrorCode.REPORT_CACHE_FULL, err.message);
      return;
    }

    console.error("[Controller] 处理信封时出现未预期异常:", err);
    this.sendConnError(
      conn,
      env,
      ProtocolErrorCode.PROTOCOL_ERROR,
      err instanceof Error ? err.message : String(err),
    );
  }

  /**
   * 向对端发送 error envelope；连接已断开等失败静默忽略
   */
  private sendConnError(
    conn: JsonlConnection,
    env: Envelope,
    code: string,
    message: string,
  ): Promise<void> {
    try {
      return conn
        .sendEnvelope({
          version: PROTOCOL_VERSION,
          controllerId: env.controllerId,
          workerId: env.workerId,
          id: crypto.randomUUID(),
          replyTo: env.id,
          seq: conn.nextSeq,
          type: "error",
          payload: { code, message },
        })
        .catch(() => {});
    } catch {
      // 发送失败忽略，不阻断后续处理
      return Promise.resolve();
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastActivityTime = Date.now();
    const gen = this.activeGeneration;
    const timer = setInterval(() => {
      // 旧会话的定时器已被 clearInterval 取消；这里再双重防御：
      // 回调队列中晚到的旧 tick 不得写新会话状态、不得向新连接发 ping。
      if (!this.isCurrentGeneration(gen)) return;
      if (this.heartbeatTimer !== timer) return;

      const now = Date.now();
      if (now - this.lastActivityTime > HEARTBEAT_TIMEOUT_MS) {
        const inst = this.workerManager.getInstance();
        if (inst && inst.lifecycleState === "connected") {
          this.workerManager.updateLifecycleState("unresponsive");
          this.appendInbox("unresponsive", { workerId: inst.workerId });
        }
      }

      if (this.workerConn && !this.workerConn.socket.destroyed) {
        const inst = this.workerManager.getInstance();
        this.workerConn.sendEnvelope({
          version: PROTOCOL_VERSION,
          controllerId: inst ? inst.controllerId : "ctrl",
          workerId: inst ? inst.workerId : "work",
          id: crypto.randomUUID(),
          seq: this.workerConn.nextSeq,
          type: "ping",
          payload: { timestamp: now },
        }).catch(() => {});
      }
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer = timer;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 丢弃上一实例遗留的 supervisor/worker 连接引用。
   * 上一实例已 closed 或被 force 释放，其 socket 可能仍然活着（如 supervisor 上报
   * launch_failed 后未退出），但该连接对新实例而言是陈旧引用：必须 destroy + 置 null，
   * 否则新 Supervisor/Worker 的 hello 会因「同角色已有连接」被 ALREADY_EXISTS 拒绝，
   * 导致新实例永远等不到握手。不等待对端关闭，也不发送 close/abort 指令。
   */
  private resetStaleConnections(): void {
    if (this.supervisorConn) {
      const conn = this.supervisorConn;
      this.supervisorConn = null;
      this.unregisterConnCleanup("supervisor");
      try {
        conn.destroy();
      } catch {
        // 忽略销毁时的错误
      }
    }
    if (this.workerConn) {
      const conn = this.workerConn;
      this.workerConn = null;
      this.unregisterConnCleanup("worker");
      try {
        conn.destroy();
      } catch {
        // 忽略销毁时的错误
      }
    }
  }

  /**
   * 工具：worker_start
   */
  public async handleWorkerStart(params: {
    cwd: string;
    title: string;
    task: string;
    context?: string;
    allowedPaths?: string[];
    acceptanceCriteria?: string[];
    provider?: string;
    model?: string;
    thinkingLevel?: string;
  }, probes: Partial<TerminalProbes> = {}, internal: {
    ids?: { controllerId?: string; workerId?: string; taskId?: string };
    bootstrapToken?: string;
    workerToken?: string;
    launchTimeoutMs?: number;
  } = {}): Promise<{
    ok: boolean;
    workerId: string;
    taskId: string;
    revision: number;
    message: string;
  }> {
    if (jsonByteLength({
      task: params.task,
      context: params.context,
      allowedPaths: params.allowedPaths,
      acceptanceCriteria: params.acceptanceCriteria,
    }) > MAX_TASK_TEXT_SIZE) {
      throw new Error(`任务上下文超过 256 KiB 限制: ${ProtocolErrorCode.PAYLOAD_TOO_LARGE}`);
    }

    const env = validateAndPrepareLaunch(params.cwd, probes);

    // 未显式指定时使用 Worker 默认模型配置 (deepseek/deepseek-flash/high，可由环境变量覆盖)
    const modelParams = resolveWorkerModelParams(params);

    // internal 仅用于测试注入确定性 id/token/超时，不改变默认对外行为
    const controllerId = internal.ids?.controllerId ?? "ctrl-" + crypto.randomUUID().slice(0, 8);
    const workerId = internal.ids?.workerId ?? "worker-" + crypto.randomUUID().slice(0, 8);
    const taskId = internal.ids?.taskId ?? "task-" + crypto.randomUUID().slice(0, 8);
    const bootstrapToken = internal.bootstrapToken ?? crypto.randomBytes(32).toString("hex");
    const workerToken = internal.workerToken ?? crypto.randomBytes(32).toString("hex");
    if (internal.launchTimeoutMs !== undefined) {
      this.launchTimeoutMs = internal.launchTimeoutMs;
    }
    const launchTimeoutMs = this.launchTimeoutMs;

    this.expectedBootstrapToken = bootstrapToken;
    this.expectedWorkerToken = workerToken;

    // 锁定名额：acquireLaunchSlot 抛 ALREADY_EXISTS 时必须先抛出，不得在此时清理活跃连接
    this.workerManager.acquireLaunchSlot(
      controllerId,
      workerId,
      taskId,
      params.cwd,
      params.title,
    );

    // 名额锁定后才清理上一实例遗留的连接引用：上一实例已 closed/被 force 释放，
    // 其连接对新实例而言是陈旧引用，必须丢弃，否则新 hello 会被 ALREADY_EXISTS 挡死。
    this.resetStaleConnections();
    this.childExitConfirmed = false;

    // 新实例必须从干净的报告 / 收件箱 / 缓存 / 诊断计数状态开始
    this.resetSessionScopedState();

    try {
      // 启动管道服务
      const pipePath = await this.startServer(controllerId);

      const desc: WorkerDescriptor = {
        version: PROTOCOL_VERSION,
        controllerId,
        workerId,
        pipePath,
        bootstrapToken,
      };
      const descB64 = encodeDescriptor(desc);

      const spec = buildTerminalLaunch(env, params.title, descB64);

      const terminalBackends = detectTerminalBackends(probes);
      let launchedBackend = spec.backend;
      let launchError: unknown = null;
      let child = launchWorkerWindow(spec, { spawnFn: this.launchSpawner ?? undefined });

      // 仅在 spawn 明确失败时回退。握手超时不是安全的回退信号，避免重复开窗。
      try {
        await this.waitForSupervisor(launchTimeoutMs, launchedBackend, child);
      } catch (err: unknown) {
        if (!(err instanceof TerminalSpawnError)) throw err;
        launchError = err;
        const startIndex = terminalBackends.findIndex((x) => x.backend === launchedBackend);
        const fallback = terminalBackends.slice(startIndex + 1);
        let lastError: unknown = err;
        for (const backend of fallback) {
          const fallbackEnv = { ...env, terminal: backend };
          const fallbackSpec = buildTerminalLaunch(fallbackEnv, params.title, descB64);
          try {
            child = launchWorkerWindow(fallbackSpec, { spawnFn: this.launchSpawner ?? undefined });
            launchedBackend = backend.backend;
            await this.waitForSupervisor(launchTimeoutMs, launchedBackend, child);
            launchError = null;
            break;
          } catch (fallbackErr: unknown) {
            lastError = fallbackErr;
            if (!(fallbackErr instanceof TerminalSpawnError)) throw fallbackErr;
          }
        }
        if (launchError) {
          throw lastError;
        }
      }

      // 发送 launch 指令 (可选模型参数不传时保持 Pi 默认设置)
      const launchPayload: LaunchPayload = {
        cwd: env.cwd,
        nodePath: env.nodePath,
        piCliPath: env.piCliPath,
        extensionPath: env.extensionPath,
        workerToken,
        workerPipePath: pipePath,
        provider: modelParams.provider,
        model: modelParams.model,
        thinkingLevel: modelParams.thinkingLevel,
      };

      await this.supervisorConn!.sendRequest({
        version: PROTOCOL_VERSION,
        controllerId,
        workerId,
        id: crypto.randomUUID(),
        seq: this.supervisorConn!.nextSeq,
        type: "launch",
        payload: launchPayload,
      });

      // 等待 worker 连接与 ready
      await this.waitForWorkerReady(launchTimeoutMs);

      // 发送初始任务
      const taskPayload: TaskPayload = {
        taskId,
        runId: 1,
        revision: 1,
        task: params.task,
        context: params.context,
        allowedPaths: params.allowedPaths,
        acceptanceCriteria: params.acceptanceCriteria,
      };

      const taskRequestId = crypto.randomUUID();
      let ack;
      try {
        ack = await this.workerConn!.sendRequest({
          version: PROTOCOL_VERSION,
          controllerId,
          workerId,
          taskId,
          revision: 1,
          id: taskRequestId,
          seq: this.workerConn!.nextSeq,
          type: "task",
          payload: taskPayload,
        });
      } catch (err: unknown) {
        if (isDeliveryUnknownError(err)) {
          // ACK 超时 = 投递结果未知：任务可能已被 Worker 接收并执行。
          // 不释放名额、不降级 lifecycle（连接仍存活，保持 connected），仅登记并明确上报。
          this.recordUnknownDelivery({
            requestId: taskRequestId,
            kind: "task",
            taskId,
            revision: 1,
            runId: 1,
            at: Date.now(),
          });
          throw new DeliveryUnknownError(
            `[${ProtocolErrorCode.DELIVERY_UNKNOWN}] 初始任务投递结果未知 (req: ${taskRequestId})：` +
              `任务可能已被 Worker 接收并执行，结果未知。` +
              `请用 worker_status 查看 unknownDeliveries / 任务状态确认，不要重复派发。`,
            taskRequestId,
          );
        }
        throw err;
      }

      if (!ack.ok) {
        throw new Error(`Worker 拒绝接收任务: ${ack.error || "未知原因"}`);
      }

      this.workerManager.updateTaskState("running");
      this.appendInbox("task_accepted", taskPayload, taskId, 1, 1);

      return {
        ok: true,
        workerId,
        taskId,
        revision: 1,
        message:
          "Worker 已成功启动并接收初始任务。后续关键事件会自动唤醒本会话（空闲时开新轮，忙碌时 followUp 排队），" +
          "无需循环 worker_wait；如需诊断或同步确认再显式调用 worker_wait。",
      };
    } catch (err: unknown) {
      const inst = this.workerManager.getInstance();
      if (inst?.lifecycleState === "closed") {
        // 「进程已确认退出」优先级高于「投递未知」：Supervisor 已明确上报
        // launch_failed / child_exit → 必须释放单实例名额；若同时存在投递未知，
        // 也要在错误里保留任务请求 ID / DELIVERY_UNKNOWN 与“不要直接重派”的事实，
        // 不得因为走退出分支而丢掉未知投递信息（登记已在抛出前完成）。
        this.workerManager.releaseSlot();
        const reason = err instanceof Error ? err.message : String(err);
        let unknownSuffix = "";
        if (err instanceof DeliveryUnknownError) {
          unknownSuffix =
            `；[${ProtocolErrorCode.DELIVERY_UNKNOWN}] 同时存在投递结果未知 (req: ${err.requestId})：` +
            `Worker 进程已确认退出，任务是否执行过未知，不要直接重派。`;
        } else if (isDeliveryUnknownError(err)) {
          const reqId = (err as { requestId?: string }).requestId ?? "unknown";
          unknownSuffix =
            `；[${ProtocolErrorCode.DELIVERY_UNKNOWN}] 同时存在投递结果未知 (req: ${reqId})：` +
            `Worker 进程已确认退出，任务是否执行过未知，不要直接重派。`;
        }
        throw new Error(
          `[${ProtocolErrorCode.LAUNCH_FAILED}] Worker 启动明确失败，已释放单实例名额: ${reason}${unknownSuffix}`,
        );
      }
      if (err instanceof DeliveryUnknownError) {
        // 投递结果未知且进程未确认退出：Worker 连接仍存活时保持一致状态 (connected / 保留名额)，
        // 绝不降级为 launch_unknown、绝不自动重发。
        throw err;
      }
      // 握手超时、职责未确认等：保留占位，等待人工或后续确认
      this.workerManager.updateLifecycleState("launch_unknown");
      throw err;
    }
  }

  private async waitForSupervisor(
    timeoutMs: number,
    backend: string,
    child?: ChildProcess,
  ): Promise<void> {
    const gen = this.activeGeneration;
    const start = Date.now();
    let spawnError: TerminalSpawnError | null = null;
    const onError = (err: Error) => {
      spawnError = new TerminalSpawnError(backend, err);
    };
    child?.once?.("error", onError);

    while (Date.now() - start < timeoutMs) {
      if (!this.isCurrentGeneration(gen)) {
        throw new Error("会话已切换，等待 Supervisor 握手已取消");
      }
      if (this.supervisorConn) return;
      if (spawnError) throw spawnError;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (spawnError) throw spawnError;
    throw new Error(
      `等待终端窗口与 Supervisor 握手超时 (${timeoutMs}ms，后端: ${backend})。` +
        `为避免重复开窗，不会自动重开窗口；请检查新窗口是否已出现，可用 /worker-forget 手动解除占位。`,
    );
  }

  /**
   * 等待真实的 worker_ready 消息 (不只是管道连接)：
   * worker_ready 在 Worker 的 session_start 时发出，收到它才能保证 currentContext 已就绪，
   * 避免初始任务先于会话启动而永久卡在内部队列。
   */
  private async waitForWorkerReady(timeoutMs: number): Promise<void> {
    const gen = this.activeGeneration;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!this.isCurrentGeneration(gen)) {
        throw new Error("会话已切换，等待 Worker worker_ready 已取消");
      }
      if (this.workerReadyReceived && this.workerConn) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(
      `等待 Worker 真实 worker_ready 握手超时 (${timeoutMs}ms，管道连接: ${this.workerConn ? "已建立" : "未建立"})。` +
        `Worker 会话可能尚未启动；为避免重复派发任务，不会自动重发，可用 /worker-forget 解除占位后重试。`,
    );
  }

  /**
   * 工具：worker_send
   */
  public async handleWorkerSend(params: {
    workerId: string;
    taskId: string;
    message: string;
    kind: "supplement" | "reply" | "revision";
  }): Promise<{
    ok: boolean;
    workerId: string;
    taskId: string;
    revision: number;
    message: string;
  }> {
    const gen = this.activeGeneration;
    const inst = this.workerManager.getInstance();
    if (!inst || inst.workerId !== params.workerId || inst.taskId !== params.taskId) {
      throw new Error(`[${ProtocolErrorCode.NOT_FOUND}] 找不到匹配的 Worker 或 Task ID`);
    }

    if (!this.workerConn || this.workerConn.socket.destroyed) {
      throw new Error(`[${ProtocolErrorCode.PEER_DISCONNECTED}] Worker 连接已中断`);
    }

    let revision = inst.revision;
    let runId = inst.runId;

    if (params.kind === "revision") {
      if (inst.taskState !== "ready_for_review") {
        throw new Error(
          `只有在 ready_for_review 状态下才允许发起 revision 返修 (当前: ${inst.taskState})`,
        );
      }
      const bumped = this.workerManager.bumpRevision();
      revision = bumped.revision;
      runId = bumped.runId;
      this.currentCommittedReport = null;
    } else {
      runId = this.workerManager.bumpRunId();
    }

    const payload: FollowupPayload = {
      taskId: params.taskId,
      runId,
      revision,
      message: params.message,
      kind: params.kind,
    };

    this.currentCommittedReport = null;
    this.currentCandidateReport = null;
    this.workerManager.updateActivityState("busy");
    this.workerManager.updateTaskState("running");

    const followupRequestId = crypto.randomUUID();
    let ack;
    try {
      ack = await this.workerConn.sendRequest({
        version: PROTOCOL_VERSION,
        controllerId: inst.controllerId,
        workerId: inst.workerId,
        taskId: inst.taskId,
        revision,
        id: followupRequestId,
        seq: this.workerConn.nextSeq,
        type: "followup",
        payload,
      });
    } catch (err: unknown) {
      if (!this.isCurrentGeneration(gen)) {
        throw new Error("会话已切换，已忽略过时的 followup 发送结果");
      }
      if (isDeliveryUnknownError(err)) {
        // ACK 超时 = 投递结果未知：绝不自动重发。
        // 保留现有语义：旧回执已作废、状态已推进为 running，不因超时回退。
        this.recordUnknownDelivery({
          requestId: followupRequestId,
          kind: "followup",
          taskId: inst.taskId,
          revision,
          runId,
          at: Date.now(),
        });
        throw new DeliveryUnknownError(
          `[${ProtocolErrorCode.DELIVERY_UNKNOWN}] ${params.kind} 说明投递结果未知 (req: ${followupRequestId})：` +
            `Worker 可能已接收并处理，结果未知。请用 worker_status 查看 unknownDeliveries / 任务状态，不要重复发送。`,
          followupRequestId,
        );
      }
      throw err;
    }

    if (!this.isCurrentGeneration(gen)) {
      // 会话已切换：不得把旧会话的发送结果写进新会话状态
      throw new Error("会话已切换，已忽略过时的 followup 发送结果");
    }

    if (!ack.ok) {
      throw new Error(`Worker 拒绝接收 followup: ${ack.error || "未知原因"}`);
    }

    this.appendInbox("followup_accepted", payload, params.taskId, revision, runId);

    return {
      ok: true,
      workerId: params.workerId,
      taskId: params.taskId,
      revision,
      message:
        `已成功发送 ${params.kind} 说明至 Worker。后续关键事件（交付/提问/阻塞/停止/断连等）会自动唤醒本会话，` +
        `无需连续 worker_wait。`,
    };
  }

  /**
   * 工具：worker_wait
   *
   * 语义（避免高频轮询）：
   * - 只匹配 ACTIONABLE_EVENT_TYPES 中的可操作关键事件；普通进度绝不唤醒。
   * - 未显式传 afterCursor 时，从上次已消费游标之后开始（默认消费，不重复返回同一事件）；
   *   显式传 afterCursor 仍可重放历史关键事件。
   * - 超时/取消必须移除 waiter，绝不泄漏；默认 5 分钟，上限 10 分钟。
   * - 支持 AbortSignal 取消（如可行）。
   */
  public async handleWorkerWait(
    params: {
      workerId: string;
      afterCursor?: number;
      timeoutMs?: number;
    },
    options: { signal?: AbortSignal } = {},
  ): Promise<{
    event: {
      type: string;
      cursor: number;
      eventId: string;
      taskId?: string;
      revision?: number;
      summary: string;
      truncated?: boolean;
    };
    currentTaskState: string;
    currentLifecycleState: string;
  }> {
    const inst = this.workerManager.getInstance();
    if (!inst || inst.workerId !== params.workerId) {
      throw new Error(`[${ProtocolErrorCode.NOT_FOUND}] 找不到 Worker: ${params.workerId}`);
    }

    const gen = this.activeGeneration;
    const afterCursor = params.afterCursor !== undefined ? params.afterCursor : this.lastWaitCursor;
    const timeout = Math.min(
      Math.max(params.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, MIN_WAIT_TIMEOUT_MS),
      MAX_WAIT_TIMEOUT_MS,
    );

    const isMatch = (e: InboxEvent): boolean =>
      e.cursor > afterCursor &&
      e.workerId === inst.workerId &&
      e.taskId === inst.taskId &&
      ACTIONABLE_EVENT_TYPES.has(e.type);

    // 检查是否有当前 Worker/Task 的现有可操作关键事件
    const existing = this.inbox.find(isMatch);
    let selectedEvent: InboxEvent;

    if (existing) {
      // 立即命中也要推进默认游标，避免下一次默认调用重复返回同一事件。
      this.lastWaitCursor = Math.max(this.lastWaitCursor, existing.cursor);
      selectedEvent = existing;
    } else if (options.signal?.aborted) {
      throw new Error("worker_wait 已被调用方取消");
    } else {
      // 挂起等待
      selectedEvent = await new Promise<InboxEvent>((resolve, reject) => {
        const waiter: Waiter = {
          afterCursor,
          workerId: inst.workerId,
          taskId: inst.taskId,
          resolve: (res) => resolve(res.event),
          reject,
          timer: undefined as unknown as NodeJS.Timeout,
        };

        waiter.timer = setTimeout(() => {
          // 超时必须先移除 waiter（绝不泄漏），再结算 promise
          this.removeWaiter(waiter);
          this.detachAbort(waiter);
          if (!this.isCurrentGeneration(gen)) {
            // 会话已切换：拒绝而不是挂起，也不返回伪事件污染新会话
            reject(new Error("会话已切换，等待已被取消"));
            return;
          }
          // 超时返回伪事件，携带当前状态与诊断计数
          resolve({
            cursor: this.cursorCounter,
            eventId: crypto.randomUUID(),
            timestamp: Date.now(),
            type: "wait_timeout",
            workerId: inst.workerId,
            taskId: inst.taskId,
            revision: inst.revision,
            payload: {
              message:
                `等待超时，Worker 仍在运行中 (诊断计数: 丢弃 ${this.droppedInboxEvents}，` +
                `收件箱拒绝 ${this.inboxRejectedEvents}，报告缓存拒绝 ${this.reportCacheRejected})`,
              droppedInboxEvents: this.droppedInboxEvents,
              inboxRejectedEvents: this.inboxRejectedEvents,
              reportCacheRejected: this.reportCacheRejected,
            },
          });
        }, timeout);

        if (options.signal) {
          waiter.signal = options.signal;
          waiter.onAbort = () => {
            this.removeWaiter(waiter);
            clearTimeout(waiter.timer);
            this.detachAbort(waiter);
            reject(new Error("worker_wait 已被调用方取消"));
          };
          options.signal.addEventListener("abort", waiter.onAbort, { once: true });
        }

        this.waiters.push(waiter);
      });
    }

    const payloadJson = JSON.stringify(selectedEvent.payload ?? {});
    let summary = payloadJson;
    let truncated = false;
    if (Buffer.byteLength(summary, "utf8") > MAX_WAIT_RESULT_SIZE) {
      summary = summary.slice(0, MAX_WAIT_RESULT_SIZE) + "... (超长文本截断，请使用 worker_status 分页拉取)";
      truncated = true;
    }

    return {
      event: {
        type: selectedEvent.type,
        cursor: selectedEvent.cursor,
        eventId: selectedEvent.eventId,
        taskId: selectedEvent.taskId,
        revision: selectedEvent.revision,
        summary,
        truncated,
      },
      currentTaskState: inst.taskState,
      currentLifecycleState: inst.lifecycleState,
    };
  }

  /**
   * 工具：worker_status
   */
  public async handleWorkerStatus(params: {
    workerId: string;
    eventId?: string;
    offset?: number;
    limit?: number;
  }): Promise<{
    worker: WorkerInstanceMetadata | null;
    committedReport: WorkerReportPayload | null;
    candidateReport: WorkerReportPayload | null;
    inbox: ReturnType<ControllerManager["getInboxStats"]>;
    reportCache: ReturnType<ControllerManager["getReportCacheStats"]>;
    unknownDeliveries: UnknownDeliveryEntry[];
    diagnostics: {
      droppedInboxEvents: number;
      inboxRejectedEvents: number;
      reportCacheRejected: number;
      identityRejectedEvents: number;
      staleIgnoredEvents: number;
      roleRejectedEvents: number;
      unknownDeliveriesDropped: number;
      staleCallbacksIgnored: number;
    };
    eventDetail?: {
      eventId: string;
      type: string;
      totalLength: number;
      offset: number;
      content: string;
      hasMore: boolean;
    };
  }> {
    const inst = this.workerManager.getInstance();
    if (!inst || inst.workerId !== params.workerId) {
      throw new Error(`[${ProtocolErrorCode.NOT_FOUND}] 找不到 Worker: ${params.workerId}`);
    }

    let eventDetail: any = undefined;
    if (params.eventId) {
      const e = this.getInboxEvent(params.eventId);
      if (e) {
        const str = JSON.stringify(e.payload, null, 2);
        const offset = params.offset ?? 0;
        const limit = params.limit ?? 4000;
        const slice = str.slice(offset, offset + limit);
        eventDetail = {
          eventId: e.eventId,
          type: e.type,
          totalLength: str.length,
          offset,
          content: slice,
          hasMore: offset + limit < str.length,
        };
      }
    }

    return {
      worker: inst,
      committedReport: this.currentCommittedReport,
      candidateReport: this.currentCandidateReport,
      inbox: this.getInboxStats(),
      reportCache: this.getReportCacheStats(),
      unknownDeliveries: [...this.unknownDeliveries],
      diagnostics: {
        droppedInboxEvents: this.droppedInboxEvents,
        inboxRejectedEvents: this.inboxRejectedEvents,
        reportCacheRejected: this.reportCacheRejected,
        identityRejectedEvents: this.identityRejectedEvents,
        staleIgnoredEvents: this.staleIgnoredEvents,
        roleRejectedEvents: this.roleRejectedEvents,
        unknownDeliveriesDropped: this.unknownDeliveriesDropped,
        staleCallbacksIgnored: this.staleCallbacksIgnored,
      },
      eventDetail,
    };
  }

  /**
   * 工具：worker_stop
   */
  public async handleWorkerStop(params: {
    workerId: string;
    reason?: string;
  }): Promise<{ ok: boolean; message: string }> {
    const gen = this.activeGeneration;
    const inst = this.workerManager.getInstance();
    if (!inst || inst.workerId !== params.workerId) {
      throw new Error(`[${ProtocolErrorCode.NOT_FOUND}] 找不到 Worker: ${params.workerId}`);
    }

    if (this.workerConn && !this.workerConn.socket.destroyed) {
      const abortRequestId = crypto.randomUUID();
      try {
        await this.workerConn.sendRequest(
          {
            version: PROTOCOL_VERSION,
            controllerId: inst.controllerId,
            workerId: inst.workerId,
            taskId: inst.taskId,
            id: abortRequestId,
            seq: this.workerConn.nextSeq,
            type: "abort",
            payload: { reason: params.reason },
          },
          AUTH_TIMEOUT_MS,
        );
      } catch (err: unknown) {
        if (!this.isCurrentGeneration(gen)) {
          throw new Error("会话已切换，已忽略过时的停止结果");
        }
        if (isDeliveryUnknownError(err)) {
          // ACK 超时 = 投递结果未知：请求确实写到了管道上，Pi 可能正在中止。
          // 仍置 taskState=stopping，但绝不报告 stopped。
          this.recordUnknownDelivery({
            requestId: abortRequestId,
            kind: "abort",
            taskId: inst.taskId,
            revision: inst.revision,
            runId: inst.runId,
            at: Date.now(),
          });
          this.workerManager.updateTaskState("stopping");
          throw new DeliveryUnknownError(
            `[${ProtocolErrorCode.DELIVERY_UNKNOWN}] 中止请求投递结果未知 (req: ${abortRequestId})：` +
              `请求已写入管道，Worker 可能正在中止；已标记为 stopping，绝不报告 stopped。` +
              `请用 worker_status 查看 unknownDeliveries / 任务状态确认，不要重复发送中止。`,
            abortRequestId,
          );
        }
        throw err;
      }
    }

    if (!this.isCurrentGeneration(gen)) {
      // 会话已切换：不得把旧会话的停止结果写进新会话状态
      return { ok: false, message: "会话已切换，已忽略过时的停止结果" };
    }

    this.workerManager.updateTaskState("stopping");
    return { ok: true, message: "已向 Worker 发送合作式停止请求" };
  }

  /**
   * 工具：worker_close
   */
  public async handleWorkerClose(params: {
    workerId: string;
    disposition: "accepted" | "abandoned";
    force?: boolean;
  }): Promise<{ ok: boolean; disposition: string; message: string }> {
    // 关闭流程只允许完成一次：同一 workerId 的在途关闭直接复用结果，
    // 不同 disposition 则拒绝（调用方需等上一次结束）。
    if (this.closeInFlight && this.closeInFlight.workerId === params.workerId) {
      if (this.closeInFlight.disposition === params.disposition) {
        return await this.closeInFlight.promise;
      }
      throw new Error(
        `[${ProtocolErrorCode.INVALID_STATE}] 已有一次进行中的 worker_close (disposition: ${this.closeInFlight.disposition})，` +
          `不能同时以 ${params.disposition} 再次关闭；请等待上一次关闭结束`,
      );
    }

    const run = async (): Promise<{ ok: boolean; disposition: string; message: string }> => {
      const gen = this.activeGeneration;
      const inst = this.workerManager.getInstance();
      if (!inst || inst.workerId !== params.workerId) {
        throw new Error(`[${ProtocolErrorCode.NOT_FOUND}] 找不到 Worker: ${params.workerId}`);
      }

      if (params.disposition === "accepted") {
        // 验收门槛严格校验
        if (inst.taskState !== "ready_for_review") {
          throw new Error(`任务尚未处于 ready_for_review 状态，无法执行 accepted 验收`);
        }
        if (!this.currentCommittedReport || this.currentCommittedReport.kind !== "result") {
          throw new Error(`未找到有效的 committed result 交付回执，无法验收`);
        }
        if (
          this.currentCommittedReport.unresolved &&
          this.currentCommittedReport.unresolved.length > 0
        ) {
          throw new Error(
            `交付回执中仍有未解决问题 (${this.currentCommittedReport.unresolved.join("; ")})，不能验收`,
          );
        }
        if (this.currentCommittedReport.validation) {
          const failedTests = this.currentCommittedReport.validation.filter(
            (v) => v.outcome === "failed",
          );
          if (failedTests.length > 0) {
            throw new Error(
              `交付回执中包含失败的测试 (${failedTests.map((t) => t.command).join(", ")})，不能验收`,
            );
          }
        }
        if (inst.activityState !== "idle" || !this.workerConn || this.workerConn.socket.destroyed || inst.lifecycleState !== "connected") {
          throw new Error("Worker 尚未稳定空闲或连接已断开，无法验收");
        }
        this.workerManager.updateTaskState("accepted");
      } else {
        this.workerManager.updateTaskState("abandoned");
      }

      this.workerManager.updateLifecycleState("closing");

      // 关闭指令的投递结果未知时记录请求 ID，供后续未确认退出的错误信息诊断
      let closeUnknownRequestId: string | null = null;

      // 发送关闭或强杀指令
      if (params.force && this.supervisorConn) {
        await this.supervisorConn.sendRequest({
          version: PROTOCOL_VERSION,
          controllerId: inst.controllerId,
          workerId: inst.workerId,
          id: crypto.randomUUID(),
          seq: this.supervisorConn.nextSeq,
          type: "terminate",
          payload: { force: true },
        });
      } else if (this.workerConn) {
        const closeRequestId = crypto.randomUUID();
        try {
          await this.workerConn.sendRequest({
            version: PROTOCOL_VERSION,
            controllerId: inst.controllerId,
            workerId: inst.workerId,
            id: closeRequestId,
            seq: this.workerConn.nextSeq,
            type: "close",
            payload: { disposition: params.disposition, force: params.force },
          });
        } catch (err: unknown) {
          // ACK 超时 = 关闭指令送达未知：登记备案后继续等待 child_exit 确认；
          // 普通（非超时）异常仍然吞掉，保持既有行为。
          if (isDeliveryUnknownError(err)) {
            this.recordUnknownDelivery({
              requestId: closeRequestId,
              kind: "close",
              taskId: inst.taskId,
              revision: inst.revision,
              runId: inst.runId,
              at: Date.now(),
            });
            closeUnknownRequestId = closeRequestId;
          }
        }
      }

      // 等待子进程退出确认 (ACK → child_exit → socket close / child_exit → socket close /
      // socket close → child_exit 三种顺序均在此收敛为一次关闭)
      const start = Date.now();
      while (Date.now() - start < this.closeWaitTimeoutMs) {
        if (!this.isCurrentGeneration(gen)) break;
        const cur = this.workerManager.getInstance();
        if (!cur || cur.lifecycleState === "closed") {
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      if (!this.isCurrentGeneration(gen)) {
        // 会话已切换：不把旧会话的关闭结果写进新会话，也不释放新会话名额
        throw new Error(
          "会话已切换，关闭流程已终止；保留单实例占位，请在新会话确认状态",
        );
      }

      const confirmed = this.workerManager.getInstance();
      if (confirmed?.lifecycleState !== "closed") {
        const unknownSuffix = closeUnknownRequestId
          ? `；关闭指令送达未知 (req: ${closeUnknownRequestId})，结果待确认`
          : "";
        throw new Error(
          "未确认 Worker 进程退出；保留单实例占位，请检查状态后重试关闭" + unknownSuffix,
        );
      }
      this.workerManager.releaseSlot();
      this.stopHeartbeat();

      return {
        ok: true,
        disposition: params.disposition,
        message: `Worker 已关闭 (disposition: ${params.disposition})`,
      };
    };

    const promise = run();
    this.closeInFlight = {
      workerId: params.workerId,
      disposition: params.disposition,
      promise,
    };
    try {
      return await promise;
    } finally {
      if (this.closeInFlight && this.closeInFlight.promise === promise) {
        this.closeInFlight = null;
      }
    }
  }

  /**
   * 人工强制解除占位 (仅限断连、detached 等异常场景)
   */
  public handleWorkerForget(): void {
    this.workerManager.releaseSlot(true);
    this.stopHeartbeat();
  }

  public registerToolsAndCommands(): void {
    // 注册主控工具
    this.pi.registerTool({
      name: "worker_start",
      label: "Worker Start",
      description:
        "在独立的终端窗口 (Windows Terminal，缺失时回退 PowerShell/CMD) 中启动一个交互式 Worker Pi，派发初始任务并建立监督通信。" +
        "Worker 的关键事件（交付/提问/阻塞/停止/断连等）会主动唤醒本会话：空闲时开新轮，忙碌时 followUp 排队，无需轮询。",
      executionMode: "sequential",
      parameters: Type.Object({
        cwd: Type.String({ description: "Worker 工作的根目录 (必须为绝对路径)" }),
        title: Type.String({ description: "Windows Terminal 窗口的标题" }),
        task: Type.String({ description: "初始任务需求与指令说明" }),
        context: Type.Optional(Type.String({ description: "任务背景与前置上下文" })),
        allowedPaths: Type.Optional(Type.Array(Type.String(), { description: "允许修改的文件或目录契约" })),
        acceptanceCriteria: Type.Optional(Type.Array(Type.String(), { description: "验收指标与测试要求" })),
        provider: Type.Optional(Type.String({ description: `可选：限定 --model 查找的 provider；不传时使用 Worker 默认配置 (${DEFAULT_WORKER_PROVIDER})` })),
        model: Type.Optional(Type.String({ description: `可选：模型 ID 或模糊匹配模式，可含 provider/id 与 :<thinking> 后缀；不传时使用 Worker 默认配置 (${DEFAULT_WORKER_MODEL})` })),
        thinkingLevel: Type.Optional(Type.Union([
          Type.Literal("off"),
          Type.Literal("minimal"),
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
          Type.Literal("xhigh"),
          Type.Literal("max"),
        ], { description: `可选：思考级别；不传时使用 Worker 默认配置 (${DEFAULT_WORKER_THINKING_LEVEL})` })),
      }),
      execute: async (_toolCallId: string, params: any) => {
        const res = await this.handleWorkerStart(params);
        return {
          content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
          details: res,
        };
      },
    });

    this.pi.registerTool({
      name: "worker_send",
      label: "Worker Send",
      description:
        "向存活的 Worker 发送补充说明、问题回复或发起新一轮返修 (revision)。发送后无需连续等待，后续关键事件会自动唤醒本会话。",
      executionMode: "sequential",
      parameters: Type.Object({
        workerId: Type.String(),
        taskId: Type.String(),
        message: Type.String({ description: "发送的消息正文" }),
        kind: Type.Union([
          Type.Literal("supplement"),
          Type.Literal("reply"),
          Type.Literal("revision"),
        ], { description: "消息种类：supplement(补充说明), reply(回复提问), revision(返修，要求处于 ready_for_review 状态)" }),
      }),
      execute: async (_toolCallId: string, params: any) => {
        const res = await this.handleWorkerSend(params);
        return {
          content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
          details: res,
        };
      },
    });

    this.pi.registerTool({
      name: "worker_wait",
      label: "Worker Wait",
      description:
        "同步等待 Worker 的可操作关键事件（交付/提问/阻塞/停止/断连/退出等）——仅作为恢复、诊断或同步等待的兜底。" +
        "默认从上次已消费游标之后匹配（不重复返回同一事件）；显式传 afterCursor 可重放历史事件。" +
        "关键事件平时会自动唤醒本会话，无需用它轮询。",
      executionMode: "sequential",
      parameters: Type.Object({
        workerId: Type.String(),
        afterCursor: Type.Optional(
          Type.Number({ description: "只等待晚于该游标的事件；不传则使用上次已消费游标（避免重复）" }),
        ),
        timeoutMs: Type.Optional(
          Type.Number({ description: `等待超时毫秒数 (默认 ${DEFAULT_WAIT_TIMEOUT_MS}，最小 ${MIN_WAIT_TIMEOUT_MS}，最大 ${MAX_WAIT_TIMEOUT_MS})` }),
        ),
      }),
      execute: async (_toolCallId: string, params: any, signal?: AbortSignal) => {
        const res = await this.handleWorkerWait(params, { signal });
        return {
          content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
          details: res,
        };
      },
    });

    this.pi.registerTool({
      name: "worker_status",
      label: "Worker Status",
      description: "查询当前 Worker 状态、模型、生命周期及回执详情；支持通过 eventId 分页拉取长事件内容。",
      executionMode: "sequential",
      parameters: Type.Object({
        workerId: Type.String(),
        eventId: Type.Optional(Type.String({ description: "要分页读取详情的事件 ID" })),
        offset: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number()),
      }),
      execute: async (_toolCallId: string, params: any) => {
        const res = await this.handleWorkerStatus(params);
        return {
          content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
          details: res,
        };
      },
    });

    this.pi.registerTool({
      name: "worker_stop",
      label: "Worker Stop",
      description: "请求 Worker 合作式中止当前任务，不关闭窗口。",
      executionMode: "sequential",
      parameters: Type.Object({
        workerId: Type.String(),
        reason: Type.Optional(Type.String()),
      }),
      execute: async (_toolCallId: string, params: any) => {
        const res = await this.handleWorkerStop(params);
        return {
          content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
          details: res,
        };
      },
    });

    this.pi.registerTool({
      name: "worker_close",
      label: "Worker Close",
      description: "完成任务验收 (accepted) 或放弃任务 (abandoned)，安全关闭执行端并释放单实例名额。",
      executionMode: "sequential",
      parameters: Type.Object({
        workerId: Type.String(),
        disposition: Type.Union([Type.Literal("accepted"), Type.Literal("abandoned")]),
        force: Type.Optional(Type.Boolean({ description: "是否强制杀掉进程树" })),
      }),
      execute: async (_toolCallId: string, params: any) => {
        if (params.force) {
          throw new Error("模型工具不允许强制终止 Worker；请由用户在主终端人工处理");
        }
        const res = await this.handleWorkerClose(params);
        return {
          content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
          details: res,
        };
      },
    });

    // 注册用户直接控制的命令
    this.pi.registerCommand("worker-status", {
      description: "查看当前 Terminal Worker 状态与进度",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        const inst = this.workerManager.getInstance();
        if (!inst || inst.lifecycleState === "none") {
          ctx.ui.notify("当前没有运行中的 Worker", "info");
          return;
        }
        ctx.ui.notify(
          `Worker: ${inst.workerId} | 任务: ${inst.taskState} | 状态: ${inst.lifecycleState} | rev: ${inst.revision}`,
          "info",
        );
      },
    });

    this.pi.registerCommand("worker-stop", {
      description: "中止当前 Worker 的运行",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        const inst = this.workerManager.getInstance();
        if (!inst || !this.workerManager.hasActiveInstance()) {
          ctx.ui.notify("当前没有运行中的 Worker", "warning");
          return;
        }
        await this.handleWorkerStop({ workerId: inst.workerId, reason: "用户命令中止" });
        ctx.ui.notify("已发送停止请求", "info");
      },
    });

    this.pi.registerCommand("worker-close", {
      description: "关闭 Worker 窗口并释放名额",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        const inst = this.workerManager.getInstance();
        if (!inst) {
          ctx.ui.notify("当前没有 Worker 实例", "warning");
          return;
        }
        await this.handleWorkerClose({
          workerId: inst.workerId,
          disposition: "abandoned",
        });
        ctx.ui.notify("Worker 已关闭", "info");
      },
    });

    this.pi.registerCommand("worker-forget", {
      description: "人工强制解除 Worker 占位 (用于异常断网排错)",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        const confirmed = await ctx.ui.confirm(
          "解除 Worker 占位警告",
          "强制解除占位不会自动杀死可能仍存活的子进程，是否确认解除？",
        );
        if (confirmed) {
          this.handleWorkerForget();
          ctx.ui.notify("已强制解除 Worker 占位", "warning");
        }
      },
    });
  }

  /**
   * 开始一个新会话 (session_start / reload / /new / /resume)：
   * 递增 generation、结束上一会话的连接/心跳/server/waiters、清空会话状态，
   * 但绝不释放单实例名额（丢失连接不能释放名额）。dispose 之后同一实例可复用。
   */
  public async handleSessionStart(): Promise<void> {
    this.activeGeneration = this.sessionGen.nextGeneration();
    this.staleCallbacksIgnored = 0;
    this.isDisposed = false;
    this.closeInFlight = null;

    // 结束上一会话的连接与 pipe 服务
    this.stopHeartbeat();
    this.resetStaleConnections();
    if (this.server) {
      const srv = this.server;
      this.server = null;
      if (this.serverCleanup) {
        this.serverCleanup();
        this.serverCleanup = null;
      }
      try {
        srv.close();
      } catch {
        // 忽略关闭时的错误
      }
    }
    this.pipePath = null;

    // 结束所有等待者（区别于 Controller 已关闭的文案）
    this.rejectWaiters(new Error("会话已切换，等待已被取消"));

    // 连接已不再绑定到新会话：活动实例降级为 disconnected，但绝不调用 releaseSlot、
    // 绝不清空单实例名额（设计第 9 节）。closed / closing 等状态保持原样。
    const inst = this.workerManager.getInstance();
    if (inst) {
      const s = inst.lifecycleState;
      if (
        s === "connected" ||
        s === "unresponsive" ||
        s === "launching" ||
        s === "launch_unknown"
      ) {
        this.workerManager.updateLifecycleState("disconnected");
      }
    }

    this.childExitConfirmed = false;
    this.resetSessionScopedState();

    // 清空上一会话的清理器并复位，使本实例可被下一次会话继续复用
    await this.cleanupRegistry.disposeAll();
    this.cleanupRegistry.reset();
    this.serverCleanup = null;
    this.supervisorConnCleanup = null;
    this.workerConnCleanup = null;

    // 新会话的基础清理（server/连接/心跳在创建时注册）
    this.ensureBaseCleanups();
  }

  public async dispose(): Promise<void> {
    // 幂等：重复调用不得再发 close、不得重复 destroy、不得抛错
    if (this.isDisposed) return;
    this.isDisposed = true;

    const gen = this.activeGeneration;
    this.stopHeartbeat();

    // 尽力发送一次 close 指令后统一销毁资源（close 只发一次）
    const inst = this.workerManager.getInstance();
    const conn = this.workerConn;
    if (inst && conn && !conn.socket.destroyed) {
      try {
        await conn.sendRequest(
          {
            version: PROTOCOL_VERSION,
            controllerId: inst.controllerId,
            workerId: inst.workerId,
            taskId: inst.taskId,
            revision: inst.revision,
            id: crypto.randomUUID(),
            seq: conn.nextSeq,
            type: "close",
            payload: { disposition: "abandoned", force: false },
          },
          1000,
        );
      } catch {}
    }

    if (!this.isCurrentGeneration(gen)) {
      // 会话已切换：本轮 dispose 已过时，不再改写新会话状态与资源引用
      return;
    }

    this.rejectWaiters(new Error("Controller 已关闭，等待已被取消"));
    this.resetSessionScopedState();

    // 统一清理 server / 两个连接 / 心跳 / 认证定时器 / waiters
    await this.cleanupRegistry.disposeAll();
    this.cleanupRegistry.reset();
    this.serverCleanup = null;
    this.supervisorConnCleanup = null;
    this.workerConnCleanup = null;
  }
}
