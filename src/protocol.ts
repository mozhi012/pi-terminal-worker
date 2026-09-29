/**
 * 通讯协议 v1 定义与常量约束
 * 双向命名管道 JSONL 通讯
 */

export const PROTOCOL_VERSION = 1;

// 协议限额与超时常量 (设计方案第 5 节)
export const MAX_FRAME_SIZE = 1 * 1024 * 1024; // 1 MiB 单帧上限
export const MAX_TASK_TEXT_SIZE = 256 * 1024;  // 256 KiB 任务文本上限
export const MAX_REPORT_SIZE = 64 * 1024;      // 64 KiB 单条报告上限
export const MAX_WAIT_RESULT_SIZE = 16 * 1024; // 16 KiB worker_wait 单次返回上限
export const MAX_DEDUP_CACHE_SIZE = 1024;      // 去重记录上限
export const MAX_FOLLOWUP_QUEUE_SIZE = 8;       // 排队 followup 上限
export const MAX_INBOX_EVENTS = 128;           // 收件箱事件条数上限
export const MAX_INBOX_BYTES = 8 * 1024 * 1024;// 收件箱总字节上限 (8 MiB)
export const MAX_FOLLOWUP_QUEUE_BYTES = 1 * 1024 * 1024; // followup 队列总字节上限 (1 MiB)
export const MAX_REPORT_CACHE_SIZE = 128;      // 关键报告缓存条数上限
export const MAX_REPORT_CACHE_BYTES = 8 * 1024 * 1024;   // 关键报告缓存总字节上限 (8 MiB)

// 2A: 协议严格校验字段上限
export const MAX_ID_LENGTH = 128;                  // controllerId/workerId/id/taskId/replyTo 长度上限
export const MAX_TYPE_LENGTH = 64;                 // 消息 type 长度上限
export const MAX_ERROR_MESSAGE_SIZE = 4 * 1024;    // error.message / ack.error 上限
export const MAX_FOLLOWUP_MESSAGE_SIZE = 256 * 1024; // followup.message 上限
export const MAX_REPORT_SUMMARY_SIZE = 8 * 1024;   // worker 回执 summary 上限
export const MAX_PATH_FIELD_SIZE = 4096;           // 路径字段上限
export const MAX_SEND_BUFFER_BYTES = 4 * 1024 * 1024; // 发送队列字节上限 (4 MiB)
export const MAX_CONTROL_DEDUP_SIZE = 256;         // 控制类消息独立去重额度

// 2B: 投递结果未知 (ACK 超时) 登记上限
export const MAX_UNKNOWN_DELIVERIES = 64;          // unknownDeliveries 条数上限 (FIFO 淘汰)

/**
 * 协议消息类型白名单 (共 23 个)
 */
export const MESSAGE_TYPES = [
  "hello",
  "hello_ok",
  "ping",
  "pong",
  "ack",
  "error",
  "launch",
  "terminate",
  "child_spawned",
  "child_exit",
  "launch_failed",
  "worker_ready",
  "model_changed",
  "task",
  "followup",
  "abort",
  "close",
  "activity",
  "report_candidate",
  "report_committed",
  "report_missing",
  "stopped",
  "local_input",
] as const;

export function isKnownMessageType(type: string): boolean {
  return (MESSAGE_TYPES as readonly string[]).includes(type);
}

export const AUTH_TIMEOUT_MS = 5000;           // 单连接认证超时 5s
export const DEFAULT_ACK_TIMEOUT_MS = 5000;    // 普通 ACK 超时 5s
export const LAUNCH_TIMEOUT_MS = 30000;        // 启动握手超时 30s
export const HEARTBEAT_INTERVAL_MS = 5000;     // 心跳发送间隔 5s
export const HEARTBEAT_TIMEOUT_MS = 20000;     // 连续 20s 无消息进入 unresponsive

/**
 * 协议基础信封
 */
export interface Envelope<T = unknown> {
  version: 1;
  controllerId: string;
  workerId: string;
  taskId?: string;
  revision?: number;
  id: string;          // 唯一消息 ID
  replyTo?: string;     // ACK/响应对应的请求 ID
  seq: number;          // 当前连接内递增序号
  type: string;         // 消息类型
  payload: T;
}

/**
 * 验证测试项
 */
export interface WorkerValidationItem {
  command: string;
  outcome: "passed" | "failed" | "not_run";
  note?: string;
}

/**
 * Worker 回执载荷
 */
export interface WorkerReportPayload {
  kind: "progress" | "question" | "blocked" | "result" | "failed";
  summary: string;
  changedFiles?: string[];
  validation?: WorkerValidationItem[];
  unresolved?: string[];
  question?: string;
}

export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

/**
 * Pi 支持的 thinking 级别 (与 @earendil-works/pi-agent-core ThinkingLevel 一致)
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelValue = (typeof THINKING_LEVELS)[number];

// 消息载荷定义
export interface HelloPayload {
  role: "supervisor" | "worker";
  token: string;
  controllerId: string;
  workerId: string;
}

export interface HelloOkPayload {
  sessionGeneration?: number;
}

export interface PingPayload {
  timestamp: number;
}

export interface PongPayload {
  timestamp: number;
  replyTimestamp: number;
}

export interface AckPayload {
  id: string;
  ok: boolean;
  error?: string;
  code?: string;
}

export interface ErrorPayload {
  code: string;
  message: string;
  retryable?: boolean;
}

export interface LaunchPayload {
  cwd: string;
  nodePath: string;
  piCliPath: string;
  extensionPath: string;
  workerToken: string;
  workerPipePath: string;
  /** 可选：限定 --model 查找的 provider；不传则使用 Pi 默认设置 */
  provider?: string;
  /** 可选：模型 ID 或模糊匹配模式 (可含 provider/id 与 :<thinking> 后缀) */
  model?: string;
  /** 可选：思考级别 off|minimal|low|medium|high|xhigh|max */
  thinkingLevel?: string;
}

export interface TerminatePayload {
  force?: boolean;
  reason?: string;
}

export interface ChildSpawnedPayload {
  pid: number;
}

export interface ChildExitPayload {
  pid: number;
  code: number | null;
  signal: string | null;
}

export interface LaunchFailedPayload {
  error: string;
}

export interface WorkerReadyPayload {
  cwd: string;
  sessionId?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  tools: string[];
  version: string;
}

/**
 * Worker 会话中模型或思考级别变化后的刷新上报
 */
export interface ModelChangedPayload {
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
}

export interface TaskPayload {
  taskId: string;
  runId: number;
  revision: number;
  task: string;
  context?: string;
  allowedPaths?: string[];
  acceptanceCriteria?: string[];
}

export interface FollowupPayload {
  taskId: string;
  runId: number;
  revision: number;
  message: string;
  kind: "supplement" | "reply" | "revision";
}

export interface AbortPayload {
  reason?: string;
}

export interface ClosePayload {
  disposition: "accepted" | "abandoned";
  force?: boolean;
}

export interface ActivityPayload {
  state: "idle" | "busy" | "waiting_ui" | "unknown";
  toolName?: string;
  modelId?: string;
}

export interface ReportCandidatePayload {
  taskId: string;
  revision: number;
  runId: number;
  report: WorkerReportPayload;
}

export interface ReportCommittedPayload {
  taskId: string;
  revision: number;
  runId: number;
  report: WorkerReportPayload;
}

export interface StoppedPayload {
  taskId: string;
  revision: number;
  runId: number;
}

export interface ReportMissingPayload {
  taskId: string;
  revision: number;
  runId: number;
}

export interface LocalInputPayload {
  taskId?: string;
  textSummary?: string;
}

/**
 * 协议错误码枚举
 */
export const ProtocolErrorCode = {
  AUTH_FAILED: "AUTH_FAILED",
  PROTOCOL_ERROR: "PROTOCOL_ERROR",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  TIMEOUT: "TIMEOUT",
  DUPLICATE_REQUEST_MISMATCH: "DUPLICATE_REQUEST_MISMATCH",
  ALREADY_EXISTS: "ALREADY_EXISTS",
  IDENTITY_MISMATCH: "IDENTITY_MISMATCH",
  NOT_FOUND: "NOT_FOUND",
  INVALID_STATE: "INVALID_STATE",
  DEDUP_FULL: "DEDUP_FULL",
  QUEUE_FULL: "QUEUE_FULL",
  QUEUE_BYTES_EXCEEDED: "QUEUE_BYTES_EXCEEDED",
  INBOX_FULL: "INBOX_FULL",
  REPORT_CACHE_FULL: "REPORT_CACHE_FULL",
  PEER_DISCONNECTED: "PEER_DISCONNECTED",
  PROCESS_EXITED: "PROCESS_EXITED",
  LAUNCH_FAILED: "LAUNCH_FAILED",
  DISPOSED: "DISPOSED",
  DELIVERY_UNKNOWN: "DELIVERY_UNKNOWN",
} as const;

export type ProtocolErrorCode = typeof ProtocolErrorCode[keyof typeof ProtocolErrorCode];

/**
 * 协议校验错误：携带错误码 (PROTOCOL_ERROR / PAYLOAD_TOO_LARGE 等)
 */
export class ProtocolValidationError extends Error {
  public readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ProtocolValidationError";
  }
}

// ===== 内部校验工具 (错误 message 均包含字段名与 ProtocolErrorCode) =====

function requireString(value: unknown, field: string, maxLen: number, minLen = 1): string {
  if (typeof value !== "string" || value.length < minLen) {
    throw new ProtocolValidationError(
      ProtocolErrorCode.PROTOCOL_ERROR,
      `${field} 必须是长度 >=${minLen} 的字符串: ${ProtocolErrorCode.PROTOCOL_ERROR}`,
    );
  }
  if (value.length > maxLen) {
    throw new ProtocolValidationError(
      ProtocolErrorCode.PAYLOAD_TOO_LARGE,
      `${field} 长度 ${value.length} 超过上限 ${maxLen}: ${ProtocolErrorCode.PAYLOAD_TOO_LARGE}`,
    );
  }
  return value;
}

function optionalString(value: unknown, field: string, maxLen: number): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requireString(value, field, maxLen);
}

function requireInt(value: unknown, field: string, opts: { min?: number } = {}): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ProtocolValidationError(
      ProtocolErrorCode.PROTOCOL_ERROR,
      `${field} 必须是整数: ${ProtocolErrorCode.PROTOCOL_ERROR}`,
    );
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new ProtocolValidationError(
      ProtocolErrorCode.PROTOCOL_ERROR,
      `${field} 必须 >= ${opts.min}，实际 ${value}: ${ProtocolErrorCode.PROTOCOL_ERROR}`,
    );
  }
  return value;
}

function requireEnum(value: unknown, field: string, allowed: readonly string[]): string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new ProtocolValidationError(
      ProtocolErrorCode.PROTOCOL_ERROR,
      `${field} 必须是以下之一: ${allowed.join(" | ")}，实际 ${JSON.stringify(value)}: ${ProtocolErrorCode.PROTOCOL_ERROR}`,
    );
  }
  return value;
}

function checkStringArray(value: string[], field: string, opts: { maxItems?: number; maxItemLen?: number }): string[] {
  if (opts.maxItems !== undefined && value.length > opts.maxItems) {
    throw new ProtocolValidationError(
      ProtocolErrorCode.PAYLOAD_TOO_LARGE,
      `${field} 项数 ${value.length} 超过上限 ${opts.maxItems}: ${ProtocolErrorCode.PAYLOAD_TOO_LARGE}`,
    );
  }
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item !== "string" || item.length === 0) {
      throw new ProtocolValidationError(
        ProtocolErrorCode.PROTOCOL_ERROR,
        `${field}[${i}] 必须是非空字符串: ${ProtocolErrorCode.PROTOCOL_ERROR}`,
      );
    }
    if (opts.maxItemLen !== undefined && item.length > opts.maxItemLen) {
      throw new ProtocolValidationError(
        ProtocolErrorCode.PAYLOAD_TOO_LARGE,
        `${field}[${i}] 长度 ${item.length} 超过上限 ${opts.maxItemLen}: ${ProtocolErrorCode.PAYLOAD_TOO_LARGE}`,
      );
    }
  }
  return value;
}

function optionalStringArray(value: unknown, field: string, opts: { maxItems?: number; maxItemLen?: number }): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new ProtocolValidationError(
      ProtocolErrorCode.PROTOCOL_ERROR,
      `${field} 必须是字符串数组: ${ProtocolErrorCode.PROTOCOL_ERROR}`,
    );
  }
  return checkStringArray(value, field, opts);
}

function requireStringArray(value: unknown, field: string, opts: { maxItems?: number; maxItemLen?: number }): string[] {
  if (!Array.isArray(value)) {
    throw new ProtocolValidationError(
      ProtocolErrorCode.PROTOCOL_ERROR,
      `${field} 必须是字符串数组: ${ProtocolErrorCode.PROTOCOL_ERROR}`,
    );
  }
  return checkStringArray(value, field, opts);
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolValidationError(
      ProtocolErrorCode.PROTOCOL_ERROR,
      `${field} 必须是非 null 的非数组对象: ${ProtocolErrorCode.PROTOCOL_ERROR}`,
    );
  }
  return value as Record<string, unknown>;
}

/**
 * 严格校验接收到的 Envelope 基础字段
 */
export function validateEnvelope(obj: unknown): Envelope {
  if (typeof obj !== "object" || obj === null) {
    throw new Error("Envelope 必须是一个非空对象");
  }
  const e = obj as Record<string, unknown>;
  if (e.version !== 1) {
    throw new Error(`不支持的协议版本: ${String(e.version)}`);
  }
  if (typeof e.controllerId !== "string" || !e.controllerId) {
    throw new Error("Envelope 缺少合法的 controllerId");
  }
  if (typeof e.workerId !== "string" || !e.workerId) {
    throw new Error("Envelope 缺少合法的 workerId");
  }
  if (typeof e.id !== "string" || !e.id) {
    throw new Error("Envelope 缺少合法的消息 id");
  }
  if (typeof e.seq !== "number" || !Number.isInteger(e.seq) || e.seq < 0) {
    throw new Error("Envelope 缺少合法的递增 seq");
  }
  if (typeof e.type !== "string" || !e.type) {
    throw new Error("Envelope 缺少合法的 type");
  }

  // 长度上限
  for (const field of ["controllerId", "workerId", "id"] as const) {
    const v = e[field] as string;
    if (v.length > MAX_ID_LENGTH) {
      throw new ProtocolValidationError(
        ProtocolErrorCode.PAYLOAD_TOO_LARGE,
        `Envelope ${field} 长度 ${v.length} 超过上限 ${MAX_ID_LENGTH}: ${ProtocolErrorCode.PAYLOAD_TOO_LARGE}`,
      );
    }
  }
  if (e.type.length > MAX_TYPE_LENGTH) {
    throw new ProtocolValidationError(
      ProtocolErrorCode.PAYLOAD_TOO_LARGE,
      `Envelope type 长度 ${e.type.length} 超过上限 ${MAX_TYPE_LENGTH}: ${ProtocolErrorCode.PAYLOAD_TOO_LARGE}`,
    );
  }
  if (!isKnownMessageType(e.type)) {
    throw new ProtocolValidationError(
      ProtocolErrorCode.PROTOCOL_ERROR,
      `Envelope 包含未知消息类型: "${e.type}": ${ProtocolErrorCode.PROTOCOL_ERROR}`,
    );
  }
  if (e.taskId !== undefined) {
    if (typeof e.taskId !== "string" || e.taskId.length === 0) {
      throw new ProtocolValidationError(
        ProtocolErrorCode.PROTOCOL_ERROR,
        `Envelope taskId 必须是长度 1..${MAX_ID_LENGTH} 的字符串: ${ProtocolErrorCode.PROTOCOL_ERROR}`,
      );
    }
    if (e.taskId.length > MAX_ID_LENGTH) {
      throw new ProtocolValidationError(
        ProtocolErrorCode.PAYLOAD_TOO_LARGE,
        `Envelope taskId 长度 ${e.taskId.length} 超过上限 ${MAX_ID_LENGTH}: ${ProtocolErrorCode.PAYLOAD_TOO_LARGE}`,
      );
    }
  }
  if (e.revision !== undefined) {
    if (typeof e.revision !== "number" || !Number.isInteger(e.revision) || e.revision < 1) {
      throw new ProtocolValidationError(
        ProtocolErrorCode.PROTOCOL_ERROR,
        `Envelope revision 必须是 >=1 的整数，实际 ${JSON.stringify(e.revision)}: ${ProtocolErrorCode.PROTOCOL_ERROR}`,
      );
    }
  }
  if (e.replyTo !== undefined) {
    if (typeof e.replyTo !== "string" || e.replyTo.length === 0) {
      throw new ProtocolValidationError(
        ProtocolErrorCode.PROTOCOL_ERROR,
        `Envelope replyTo 必须是长度 1..${MAX_ID_LENGTH} 的字符串: ${ProtocolErrorCode.PROTOCOL_ERROR}`,
      );
    }
    if (e.replyTo.length > MAX_ID_LENGTH) {
      throw new ProtocolValidationError(
        ProtocolErrorCode.PAYLOAD_TOO_LARGE,
        `Envelope replyTo 长度 ${e.replyTo.length} 超过上限 ${MAX_ID_LENGTH}: ${ProtocolErrorCode.PAYLOAD_TOO_LARGE}`,
      );
    }
  }
  if (typeof e.payload !== "object" || e.payload === null || Array.isArray(e.payload)) {
    throw new ProtocolValidationError(
      ProtocolErrorCode.PROTOCOL_ERROR,
      `Envelope payload 必须是非 null 的非数组对象: ${ProtocolErrorCode.PROTOCOL_ERROR}`,
    );
  }

  return e as unknown as Envelope;
}

/**
 * 按消息类型严格校验 payload，成功时返回规范化后的 payload 对象，失败抛 ProtocolValidationError
 */
export function validatePayload(type: string, payload: unknown): unknown {
  const p = requireObject(payload, "payload");
  switch (type) {
    case "hello": {
      requireEnum(p.role, "role", ["supervisor", "worker"]);
      requireString(p.token, "token", 256);
      requireString(p.controllerId, "controllerId", MAX_ID_LENGTH);
      requireString(p.workerId, "workerId", MAX_ID_LENGTH);
      return p;
    }
    case "hello_ok": {
      if (p.sessionGeneration !== undefined && typeof p.sessionGeneration !== "number") {
        throw new ProtocolValidationError(
          ProtocolErrorCode.PROTOCOL_ERROR,
          `hello_ok.sessionGeneration 必须是数字: ${ProtocolErrorCode.PROTOCOL_ERROR}`,
        );
      }
      return p;
    }
    case "ping": {
      requireInt(p.timestamp, "timestamp");
      return p;
    }
    case "pong": {
      requireInt(p.timestamp, "timestamp");
      requireInt(p.replyTimestamp, "replyTimestamp");
      return p;
    }
    case "ack": {
      requireString(p.id, "id", MAX_ID_LENGTH);
      if (typeof p.ok !== "boolean") {
        throw new ProtocolValidationError(
          ProtocolErrorCode.PROTOCOL_ERROR,
          `ack.ok 必须是布尔值: ${ProtocolErrorCode.PROTOCOL_ERROR}`,
        );
      }
      optionalString(p.error, "error", MAX_ERROR_MESSAGE_SIZE);
      optionalString(p.code, "code", MAX_TYPE_LENGTH);
      return p;
    }
    case "error": {
      requireString(p.code, "code", MAX_TYPE_LENGTH);
      requireString(p.message, "message", MAX_ERROR_MESSAGE_SIZE);
      if (p.retryable !== undefined && typeof p.retryable !== "boolean") {
        throw new ProtocolValidationError(
          ProtocolErrorCode.PROTOCOL_ERROR,
          `error.retryable 必须是布尔值: ${ProtocolErrorCode.PROTOCOL_ERROR}`,
        );
      }
      return p;
    }
    case "launch": {
      for (const field of ["cwd", "nodePath", "piCliPath", "extensionPath"] as const) {
        requireString(p[field], field, MAX_PATH_FIELD_SIZE);
      }
      requireString(p.workerToken, "workerToken", 256);
      requireString(p.workerPipePath, "workerPipePath", MAX_PATH_FIELD_SIZE);
      optionalString(p.provider, "provider", 256);
      optionalString(p.model, "model", 256);
      const thinkingLevel = optionalString(p.thinkingLevel, "thinkingLevel", 256);
      if (thinkingLevel !== undefined && !(THINKING_LEVELS as readonly string[]).includes(thinkingLevel)) {
        throw new ProtocolValidationError(
          ProtocolErrorCode.PROTOCOL_ERROR,
          `launch.thinkingLevel 必须是以下之一: ${THINKING_LEVELS.join(" | ")}，实际 "${thinkingLevel}": ${ProtocolErrorCode.PROTOCOL_ERROR}`,
        );
      }
      return p;
    }
    case "terminate": {
      if (p.force !== undefined && typeof p.force !== "boolean") {
        throw new ProtocolValidationError(
          ProtocolErrorCode.PROTOCOL_ERROR,
          `terminate.force 必须是布尔值: ${ProtocolErrorCode.PROTOCOL_ERROR}`,
        );
      }
      optionalString(p.reason, "reason", MAX_ERROR_MESSAGE_SIZE);
      return p;
    }
    case "child_spawned": {
      requireInt(p.pid, "pid", { min: 1 });
      return p;
    }
    case "child_exit": {
      requireInt(p.pid, "pid", { min: 0 });
      if (p.code !== null && p.code !== undefined) {
        requireInt(p.code, "code");
      }
      if (p.signal !== null && p.signal !== undefined) {
        requireString(p.signal, "signal", 64);
      }
      return p;
    }
    case "launch_failed": {
      requireString(p.error, "error", MAX_ERROR_MESSAGE_SIZE);
      return p;
    }
    case "worker_ready": {
      requireString(p.cwd, "cwd", MAX_PATH_FIELD_SIZE);
      requireStringArray(p.tools, "tools", { maxItems: 256, maxItemLen: 128 });
      requireString(p.version, "version", 64);
      optionalString(p.sessionId, "sessionId", 256);
      optionalString(p.provider, "provider", 256);
      optionalString(p.modelId, "modelId", 256);
      optionalString(p.thinkingLevel, "thinkingLevel", 256);
      return p;
    }
    case "model_changed": {
      optionalString(p.provider, "provider", 256);
      optionalString(p.modelId, "modelId", 256);
      optionalString(p.thinkingLevel, "thinkingLevel", 256);
      return p;
    }
    case "task": {
      requireString(p.taskId, "taskId", MAX_ID_LENGTH);
      requireInt(p.runId, "runId", { min: 1 });
      requireInt(p.revision, "revision", { min: 1 });
      requireString(p.task, "task", MAX_TASK_TEXT_SIZE);
      optionalString(p.context, "context", MAX_TASK_TEXT_SIZE);
      optionalStringArray(p.allowedPaths, "allowedPaths", { maxItems: 128, maxItemLen: 1024 });
      optionalStringArray(p.acceptanceCriteria, "acceptanceCriteria", { maxItems: 128, maxItemLen: 1024 });
      return p;
    }
    case "followup": {
      requireString(p.taskId, "taskId", MAX_ID_LENGTH);
      requireInt(p.runId, "runId", { min: 1 });
      requireInt(p.revision, "revision", { min: 1 });
      requireString(p.message, "message", MAX_FOLLOWUP_MESSAGE_SIZE);
      requireEnum(p.kind, "kind", ["supplement", "reply", "revision"]);
      return p;
    }
    case "abort": {
      optionalString(p.reason, "reason", MAX_ERROR_MESSAGE_SIZE);
      return p;
    }
    case "close": {
      requireEnum(p.disposition, "disposition", ["accepted", "abandoned"]);
      if (p.force !== undefined && typeof p.force !== "boolean") {
        throw new ProtocolValidationError(
          ProtocolErrorCode.PROTOCOL_ERROR,
          `close.force 必须是布尔值: ${ProtocolErrorCode.PROTOCOL_ERROR}`,
        );
      }
      return p;
    }
    case "activity": {
      requireEnum(p.state, "state", ["idle", "busy", "waiting_ui", "unknown"]);
      optionalString(p.toolName, "toolName", 256);
      optionalString(p.modelId, "modelId", 256);
      return p;
    }
    case "report_candidate":
    case "report_committed": {
      // 真实流程中 currentTaskId 为空时会回退为空串，这里允许 0 长度
      requireString(p.taskId, "taskId", MAX_ID_LENGTH, 0);
      requireInt(p.runId, "runId", { min: 1 });
      requireInt(p.revision, "revision", { min: 1 });
      p.report = validateWorkerReport(p.report);
      return p;
    }
    case "report_missing":
    case "stopped": {
      requireString(p.taskId, "taskId", MAX_ID_LENGTH, 0);
      requireInt(p.runId, "runId", { min: 1 });
      requireInt(p.revision, "revision", { min: 1 });
      return p;
    }
    case "local_input": {
      optionalString(p.taskId, "taskId", MAX_ID_LENGTH);
      optionalString(p.textSummary, "textSummary", 512);
      return p;
    }
    default:
      throw new ProtocolValidationError(
        ProtocolErrorCode.PROTOCOL_ERROR,
        `未知消息类型 "${type}" 的 payload 无法校验: ${ProtocolErrorCode.PROTOCOL_ERROR}`,
      );
  }
}

/**
 * 严格校验 worker 回执 (worker_report 载荷)
 */
export function validateWorkerReport(
  report: unknown,
  opts?: { maxBytes?: number },
): WorkerReportPayload {
  const maxBytes = opts?.maxBytes ?? MAX_REPORT_SIZE;
  const totalBytes = jsonByteLength(report);
  if (totalBytes > maxBytes) {
    throw new ProtocolValidationError(
      ProtocolErrorCode.PAYLOAD_TOO_LARGE,
      `回执整体 ${totalBytes} 字节超过上限 ${maxBytes} 字节 (64 KiB): ${ProtocolErrorCode.PAYLOAD_TOO_LARGE}`,
    );
  }
  const p = requireObject(report, "report");
  requireEnum(p.kind, "kind", ["progress", "question", "blocked", "result", "failed"]);
  requireString(p.summary, "summary", MAX_REPORT_SUMMARY_SIZE);
  optionalStringArray(p.changedFiles, "changedFiles", { maxItems: 256, maxItemLen: 1024 });
  if (p.validation !== undefined && p.validation !== null) {
    if (!Array.isArray(p.validation)) {
      throw new ProtocolValidationError(
        ProtocolErrorCode.PROTOCOL_ERROR,
        `report.validation 必须是数组: ${ProtocolErrorCode.PROTOCOL_ERROR}`,
      );
    }
    if (p.validation.length > 64) {
      throw new ProtocolValidationError(
        ProtocolErrorCode.PAYLOAD_TOO_LARGE,
        `report.validation 项数 ${p.validation.length} 超过上限 64: ${ProtocolErrorCode.PAYLOAD_TOO_LARGE}`,
      );
    }
    for (let i = 0; i < p.validation.length; i++) {
      const item = requireObject(p.validation[i], `report.validation[${i}]`);
      requireString(item.command, `report.validation[${i}].command`, 2048);
      requireEnum(item.outcome, `report.validation[${i}].outcome`, ["passed", "failed", "not_run"]);
      optionalString(item.note, `report.validation[${i}].note`, 1024);
    }
  }
  optionalStringArray(p.unresolved, "unresolved", { maxItems: 64, maxItemLen: 2048 });
  optionalString(p.question, "question", 8192);
  return p as unknown as WorkerReportPayload;
}
