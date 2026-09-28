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
  workerToken: string;
  workerPipePath: string;
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
  modelId?: string;
  thinkingLevel?: string;
  tools: string[];
  version: string;
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
  NOT_FOUND: "NOT_FOUND",
  INVALID_STATE: "INVALID_STATE",
  DEDUP_FULL: "DEDUP_FULL",
  QUEUE_FULL: "QUEUE_FULL",
  INBOX_FULL: "INBOX_FULL",
  PEER_DISCONNECTED: "PEER_DISCONNECTED",
  PROCESS_EXITED: "PROCESS_EXITED",
  LAUNCH_FAILED: "LAUNCH_FAILED",
  DISPOSED: "DISPOSED",
} as const;

export type ProtocolErrorCode = typeof ProtocolErrorCode[keyof typeof ProtocolErrorCode];

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
  return e as unknown as Envelope;
}
