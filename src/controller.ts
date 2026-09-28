/**
 * 主控端核心：状态机、单实例管理、命名管道服务、收件箱与工具/命令注册
 */

import * as net from "node:net";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
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
  MAX_WAIT_RESULT_SIZE,
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
} from "./protocol.js";
import {
  JsonlConnection,
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
  encodeDescriptor,
  buildWtArgs,
  type WorkerDescriptor,
} from "./launcher.js";
import { updateWorkerUiStatus, notifyWorker } from "./ui.js";

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
  resolve: (res: { event: InboxEvent; cursor: number }) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
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
  private waiters: Waiter[] = [];

  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastActivityTime = Date.now();

  constructor(private pi: ExtensionAPI) {}

  public getInboxEvent(eventId: string): InboxEvent | undefined {
    return this.inbox.find((e) => e.eventId === eventId);
  }

  private appendInbox(
    type: string,
    payload: unknown,
    taskId?: string,
    revision?: number,
    runId?: number,
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

    this.inbox.push(event);

    // 有界清理
    if (this.inbox.length > MAX_INBOX_EVENTS) {
      this.inbox.shift();
    }

    // 唤醒匹配的 Waiter
    this.notifyWaiters(event);

    return event;
  }

  private notifyWaiters(event: InboxEvent): void {
    const remaining: Waiter[] = [];
    for (const w of this.waiters) {
      if (event.cursor > w.afterCursor) {
        clearTimeout(w.timer);
        w.resolve({ event, cursor: event.cursor });
      } else {
        remaining.push(w);
      }
    }
    this.waiters = remaining;
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
        resolve(this.pipePath!);
      });
    });
  }

  private handleIncomingSocket(socket: net.Socket): void {
    let authenticated = false;
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        socket.destroy();
      }
    }, AUTH_TIMEOUT_MS);

    const tempConn = new JsonlConnection(socket, "controller");

    tempConn.on("message", (env: Envelope) => {
      if (env.type === "hello") {
        const payload = env.payload as HelloPayload;
        if (payload.role === "supervisor") {
          if (
            this.expectedBootstrapToken &&
            timingSafeCompare(payload.token, this.expectedBootstrapToken)
          ) {
            authenticated = true;
            clearTimeout(authTimer);
            this.supervisorConn = tempConn;
            this.bindSupervisor(tempConn);
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
            return;
          }
        } else if (payload.role === "worker") {
          if (
            this.expectedWorkerToken &&
            timingSafeCompare(payload.token, this.expectedWorkerToken)
          ) {
            authenticated = true;
            clearTimeout(authTimer);
            this.workerConn = tempConn;
            this.bindWorker(tempConn);
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
            return;
          }
        }

        // 认证失败
        tempConn.sendEnvelope({
          version: PROTOCOL_VERSION,
          controllerId: env.controllerId,
          workerId: env.workerId,
          id: crypto.randomUUID(),
          replyTo: env.id,
          seq: tempConn.nextSeq,
          type: "error",
          payload: {
            code: ProtocolErrorCode.AUTH_FAILED,
            message: "Token 认证失败或角色不匹配",
          },
        });
        socket.destroy();
      }
    });

    tempConn.on("error", () => {
      socket.destroy();
    });
  }

  private bindSupervisor(conn: JsonlConnection): void {
    conn.on("message", (env: Envelope) => {
      this.lastActivityTime = Date.now();
      if (env.type === "child_spawned") {
        const p = env.payload as ChildSpawnedPayload;
        this.workerManager.setChildPid(p.pid);
        this.appendInbox("child_spawned", p);
      } else if (env.type === "child_exit") {
        const p = env.payload as ChildExitPayload;
        this.workerManager.updateLifecycleState("closed");
        this.appendInbox("child_exit", p);
        this.stopHeartbeat();
      } else if (env.type === "launch_failed") {
        const p = env.payload as LaunchFailedPayload;
        this.workerManager.updateLifecycleState("closed");
        this.appendInbox("launch_failed", p);
      }
    });

    conn.on("close", () => {
      this.supervisorConn = null;
    });
  }

  private bindWorker(conn: JsonlConnection): void {
    this.workerManager.updateLifecycleState("connected");
    this.startHeartbeat();

    conn.on("message", (env: Envelope) => {
      this.lastActivityTime = Date.now();
      const inst = this.workerManager.getInstance();

      switch (env.type) {
        case "pong":
          // 心跳应答
          break;

        case "worker_ready": {
          const p = env.payload as WorkerReadyPayload;
          this.workerManager.setModelInfo(p.modelId, p.thinkingLevel, p.tools);
          this.appendInbox("worker_ready", p);
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
          if (inst && p.revision === inst.revision && p.runId === inst.runId) {
            this.currentCandidateReport = p.report;
            this.appendInbox("report_candidate", p.report, p.taskId, p.revision, p.runId);
          }
          break;
        }

        case "report_committed": {
          const p = env.payload as ReportCommittedPayload;
          if (inst && p.revision === inst.revision && p.runId === inst.runId) {
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
          }
          break;
        }

        case "report_missing": {
          const p = env.payload as ReportMissingPayload;
          this.currentCandidateReport = null;
          this.workerManager.updateTaskState("idle_unreported");
          this.appendInbox("report_missing", {}, p.taskId, p.revision, p.runId);
          break;
        }

        case "stopped": {
          const p = env.payload as StoppedPayload;
          this.workerManager.updateTaskState("stopped");
          this.appendInbox("stopped", {}, p.taskId, p.revision, p.runId);
          break;
        }

        case "local_input": {
          const p = env.payload as LocalInputPayload;
          this.currentCandidateReport = null;
          this.appendInbox("local_input", p);
          break;
        }
      }
    });

    conn.on("close", () => {
      this.workerConn = null;
      const inst = this.workerManager.getInstance();
      if (inst && inst.lifecycleState !== "closed") {
        this.workerManager.updateLifecycleState("disconnected");
        this.appendInbox("disconnected", { workerId: inst.workerId });
      }
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastActivityTime = Date.now();
    this.heartbeatTimer = setInterval(() => {
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
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
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
  }): Promise<{
    ok: boolean;
    workerId: string;
    taskId: string;
    revision: number;
    message: string;
  }> {
    const env = validateAndPrepareLaunch(params.cwd);

    const controllerId = "ctrl-" + crypto.randomUUID().slice(0, 8);
    const workerId = "worker-" + crypto.randomUUID().slice(0, 8);
    const taskId = "task-" + crypto.randomUUID().slice(0, 8);
    const bootstrapToken = crypto.randomBytes(32).toString("hex");
    const workerToken = crypto.randomBytes(32).toString("hex");

    this.expectedBootstrapToken = bootstrapToken;
    this.expectedWorkerToken = workerToken;

    // 锁定名额
    this.workerManager.acquireLaunchSlot(
      controllerId,
      workerId,
      taskId,
      params.cwd,
      params.title,
    );

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

      const wtArgs = buildWtArgs(
        params.title,
        env.cwd,
        env.nodePath,
        env.bootstrapPath,
        descB64,
      );

      // 启动独立终端窗口
      spawn(env.wtPath, wtArgs, {
        shell: false,
        windowsHide: false,
        stdio: "ignore",
      });

      // 等待 supervisor 连接
      await this.waitForSupervisor(LAUNCH_TIMEOUT_MS);

      // 发送 launch 指令
      const launchPayload: LaunchPayload = {
        cwd: env.cwd,
        nodePath: env.nodePath,
        piCliPath: env.piCliPath,
        workerToken,
        workerPipePath: pipePath,
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
      await this.waitForWorkerReady(LAUNCH_TIMEOUT_MS);

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

      const ack = await this.workerConn!.sendRequest({
        version: PROTOCOL_VERSION,
        controllerId,
        workerId,
        taskId,
        revision: 1,
        id: crypto.randomUUID(),
        seq: this.workerConn!.nextSeq,
        type: "task",
        payload: taskPayload,
      });

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
        message: "Worker 已成功启动并接收初始任务",
      };
    } catch (err: unknown) {
      this.workerManager.updateLifecycleState("launch_unknown");
      throw err;
    }
  }

  private async waitForSupervisor(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.supervisorConn) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(
      `等待 Windows Terminal 及 Supervisor 握手超时 (${timeoutMs}ms)`,
    );
  }

  private async waitForWorkerReady(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.workerConn) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(
      `等待 Worker Pi 进程初始化及握手超时 (${timeoutMs}ms)`,
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

    const ack = await this.workerConn.sendRequest({
      version: PROTOCOL_VERSION,
      controllerId: inst.controllerId,
      workerId: inst.workerId,
      taskId: inst.taskId,
      revision,
      id: crypto.randomUUID(),
      seq: this.workerConn.nextSeq,
      type: "followup",
      payload,
    });

    if (!ack.ok) {
      throw new Error(`Worker 拒绝接收 followup: ${ack.error || "未知原因"}`);
    }

    this.workerManager.updateTaskState("running");
    this.appendInbox("followup_accepted", payload, params.taskId, revision, runId);

    return {
      ok: true,
      workerId: params.workerId,
      taskId: params.taskId,
      revision,
      message: `已成功发送 ${params.kind} 说明至 Worker`,
    };
  }

  /**
   * 工具：worker_wait
   */
  public async handleWorkerWait(params: {
    workerId: string;
    afterCursor?: number;
    timeoutMs?: number;
  }): Promise<{
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

    const afterCursor = params.afterCursor ?? 0;
    const timeout = Math.min(Math.max(params.timeoutMs ?? 30000, 1000), 60000);

    // 检查是否有现有事件
    const existing = this.inbox.find((e) => e.cursor > afterCursor);
    let selectedEvent: InboxEvent;

    if (existing) {
      selectedEvent = existing;
    } else {
      // 挂起等待
      selectedEvent = await new Promise<InboxEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          // 超时返回伪事件，携带当前状态
          resolve({
            cursor: this.cursorCounter,
            eventId: crypto.randomUUID(),
            timestamp: Date.now(),
            type: "wait_timeout",
            workerId: inst.workerId,
            taskId: inst.taskId,
            revision: inst.revision,
            payload: { message: "等待超时，Worker 仍在运行中" },
          });
        }, timeout);

        this.waiters.push({
          afterCursor,
          resolve: (res) => resolve(res.event),
          reject,
          timer,
        });
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
    const inst = this.workerManager.getInstance();
    if (!inst || inst.workerId !== params.workerId) {
      throw new Error(`[${ProtocolErrorCode.NOT_FOUND}] 找不到 Worker: ${params.workerId}`);
    }

    if (this.workerConn && !this.workerConn.socket.destroyed) {
      await this.workerConn.sendRequest(
        {
          version: PROTOCOL_VERSION,
          controllerId: inst.controllerId,
          workerId: inst.workerId,
          taskId: inst.taskId,
          id: crypto.randomUUID(),
          seq: this.workerConn.nextSeq,
          type: "abort",
          payload: { reason: params.reason },
        },
        AUTH_TIMEOUT_MS,
      );
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
      this.workerManager.updateTaskState("accepted");
    } else {
      this.workerManager.updateTaskState("abandoned");
    }

    this.workerManager.updateLifecycleState("closing");

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
      try {
        await this.workerConn.sendRequest({
          version: PROTOCOL_VERSION,
          controllerId: inst.controllerId,
          workerId: inst.workerId,
          id: crypto.randomUUID(),
          seq: this.workerConn.nextSeq,
          type: "close",
          payload: { disposition: params.disposition, force: params.force },
        });
      } catch {}
    }

    // 等待子进程退出确认
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const cur = this.workerManager.getInstance();
      if (!cur || cur.lifecycleState === "closed") {
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    // 释放单实例名额
    this.workerManager.releaseSlot(params.force || false);
    this.stopHeartbeat();

    return {
      ok: true,
      disposition: params.disposition,
      message: `Worker 已关闭 (disposition: ${params.disposition})`,
    };
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
      description: "在独立的 Windows Terminal 窗口中启动一个交互式 Worker Pi，派发初始任务并建立监督通信。",
      executionMode: "sequential",
      parameters: Type.Object({
        cwd: Type.String({ description: "Worker 工作的根目录 (必须为绝对路径)" }),
        title: Type.String({ description: "Windows Terminal 窗口的标题" }),
        task: Type.String({ description: "初始任务需求与指令说明" }),
        context: Type.Optional(Type.String({ description: "任务背景与前置上下文" })),
        allowedPaths: Type.Optional(Type.Array(Type.String(), { description: "允许修改的文件或目录契约" })),
        acceptanceCriteria: Type.Optional(Type.Array(Type.String(), { description: "验收指标与测试要求" })),
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
      description: "向存活的 Worker 发送补充说明、问题回复或发起新一轮返修 (revision)。",
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
      description: "等待 Worker 产生关键事件 (提问、阻塞、交付审查 ready_for_review、失败、停止或断开连接)。",
      executionMode: "sequential",
      parameters: Type.Object({
        workerId: Type.String(),
        afterCursor: Type.Optional(Type.Number({ description: "只等待晚于该游标的事件" })),
        timeoutMs: Type.Optional(Type.Number({ description: "等待超时毫秒数 (1000 - 60000)" })),
      }),
      execute: async (_toolCallId: string, params: any) => {
        const res = await this.handleWorkerWait(params);
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

  public async dispose(): Promise<void> {
    this.stopHeartbeat();
    if (this.workerConn) {
      this.workerConn.destroy();
      this.workerConn = null;
    }
    if (this.supervisorConn) {
      this.supervisorConn.destroy();
      this.supervisorConn = null;
    }
    if (this.server) {
      try {
        this.server.close();
      } catch {}
      this.server = null;
    }
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error("Controller 已关闭"));
    }
    this.waiters = [];
  }
}
