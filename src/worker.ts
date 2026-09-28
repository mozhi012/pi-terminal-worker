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
  ProtocolErrorCode,
  type Envelope,
  type TaskPayload,
  type FollowupPayload,
  type AbortPayload,
  type ClosePayload,
  type WorkerReportPayload,
} from "./protocol.js";
import { JsonlConnection } from "./transport.js";

export class WorkerManager {
  private conn: JsonlConnection | null = null;
  private isDetached = false;
  private currentContext: ExtensionContext | null = null;

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

  private followupQueue: Array<{
    taskId: string;
    revision: number;
    runId: number;
    message: string;
  }> = [];

  constructor(private pi: ExtensionAPI) {
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
    this.conn = new JsonlConnection(socket, "worker");

    socket.on("connect", () => {
      // 发送 hello 认证
      this.conn!.sendEnvelope({
        version: PROTOCOL_VERSION,
        controllerId: this.controllerId,
        workerId: this.workerId,
        id: crypto.randomUUID(),
        seq: this.conn!.nextSeq,
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

  private handleControllerEnvelope(env: Envelope): void {
    const { id, type, payload } = env;

    if (type === "hello_ok") {
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
      try {
        const p = payload as TaskPayload;
        this.currentTaskId = p.taskId;
        this.currentRevision = p.revision;
        this.currentRunId = p.runId;
        this.currentCandidate = null;
        this.candidateInvalidated = false;
        this.taskHasReported = false;

        const formattedPrompt = this.buildTaskPrompt(p);

        // 发送 ACK
        this.sendAck(id, true);

        // 排队或直接派发
        this.enqueueOrDispatchMessage({
          taskId: p.taskId,
          revision: p.revision,
          runId: p.runId,
          message: formattedPrompt,
        });
      } catch (err: unknown) {
        this.sendAck(id, false, (err as Error).message);
      }
      return;
    }

    if (type === "followup") {
      try {
        const p = payload as FollowupPayload;
        this.currentRevision = p.revision;
        this.currentRunId = p.runId;
        this.currentCandidate = null;
        this.candidateInvalidated = false;
        this.taskHasReported = false;

        const formattedPrompt = `【来自主控端的 ${p.kind === "revision" ? "返修任务" : "补充说明"} (Revision ${p.revision})】\n${p.message}\n\n请在实施完毕或遇到问题时，通过 worker_report 工具提交新的回执。`;

        this.sendAck(id, true);

        this.enqueueOrDispatchMessage({
          taskId: p.taskId,
          revision: p.revision,
          runId: p.runId,
          message: formattedPrompt,
        });
      } catch (err: unknown) {
        this.sendAck(id, false, (err as Error).message);
      }
      return;
    }

    if (type === "abort") {
      this.followupQueue = [];
      this.currentCandidate = null;
      if (this.currentContext) {
        this.currentContext.abort();
      }
      this.sendAck(id, true);
      return;
    }

    if (type === "close") {
      this.sendAck(id, true);
      setTimeout(() => {
        if (this.currentContext) {
          this.currentContext.shutdown();
        }
      }, 200);
      return;
    }
  }

  private sendAck(replyTo: string, ok: boolean, error?: string): void {
    if (!this.conn || this.conn.socket.destroyed) return;
    this.conn.sendEnvelope({
      version: PROTOCOL_VERSION,
      controllerId: this.controllerId,
      workerId: this.workerId,
      id: crypto.randomUUID(),
      replyTo,
      seq: this.conn.nextSeq,
      type: "ack",
      payload: { id: replyTo, ok, error },
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

  private enqueueOrDispatchMessage(item: {
    taskId: string;
    revision: number;
    runId: number;
    message: string;
  }): void {
    if (this.currentContext && this.currentContext.isIdle() && !this.currentContext.hasPendingMessages()) {
      this.dispatchUserMessage(item.message);
    } else {
      if (this.followupQueue.length >= MAX_FOLLOWUP_QUEUE_SIZE) {
        throw new Error(`Worker 内部消息队列已满 (${MAX_FOLLOWUP_QUEUE_SIZE})`);
      }
      this.followupQueue.push(item);
    }
  }

  private dispatchUserMessage(text: string): void {
    this.pi.sendUserMessage(text, {
      expandPromptTemplates: false,
    });
  }

  private setupPiEventListeners(): void {
    // 监听 session_start
    this.pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
      this.currentContext = ctx;
      const tools = this.pi.getActiveTools();
      if (this.conn && !this.conn.socket.destroyed) {
        this.conn.sendEnvelope({
          version: PROTOCOL_VERSION,
          controllerId: this.controllerId,
          workerId: this.workerId,
          id: crypto.randomUUID(),
          seq: this.conn.nextSeq,
          type: "worker_ready",
          payload: {
            cwd: ctx.cwd,
            tools,
            version: PROTOCOL_VERSION.toString(),
          },
        }).catch(() => {});
      }
    });

    // 监听 session_shutdown
    this.pi.on("session_shutdown", async () => {
      if (this.conn) {
        this.conn.destroy();
        this.conn = null;
      }
    });

    // 监听 input 事件：识别本地用户在终端窗口键盘输入干预
    this.pi.on("input", async (event: InputEvent) => {
      if (event.source === "interactive") {
        // 用户敲键盘干预！
        this.candidateInvalidated = true;
        this.currentCandidate = null;
        this.followupQueue = []; // 暂停自动派发旧队列

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

    // 监听 tool_execution_start
    this.pi.on("tool_execution_start", async (event: ToolExecutionStartEvent) => {
      // 如果此前记录了 candidate，但模型又调用了其他工具，则 candidate 失效
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
            toolName: event.toolName,
          },
        }).catch(() => {});
      }
    });

    // 监听 agent_settled：回执最终确认与后续消息触发
    this.pi.on("agent_settled", async (_event: any, ctx: ExtensionContext) => {
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
        if (
          this.followupQueue.length > 0 &&
          this.currentContext &&
          this.currentContext.isIdle() &&
          !this.currentContext.hasPendingMessages()
        ) {
          const next = this.followupQueue.shift()!;
          this.dispatchUserMessage(next.message);
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
        const report = params as WorkerReportPayload;

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
                toolName: `worker_report [progress: ${report.summary}]`,
              },
            }).catch(() => {});
          }
          return {
            content: [{ type: "text", text: `已记录阶段进展: ${report.summary}` }],
            details: report,
          };
        }

        // 终结类报告：记录 candidate 并立即发送给主控
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
