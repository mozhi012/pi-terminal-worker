/**
 * 生命周期与代际管理、单实例互斥与资源幂等清理
 */

import { ProtocolErrorCode } from "./protocol.js";

export type WorkerLifecycleState =
  | "none"
  | "launching"
  | "connected"
  | "closing"
  | "closed"
  | "disconnected"
  | "unresponsive"
  | "detached"
  | "launch_unknown";

export type WorkerTaskState =
  | "created"
  | "queued"
  | "running"
  | "waiting_reply"
  | "blocked"
  | "ready_for_review"
  | "failed"
  | "idle_unreported"
  | "stopping"
  | "stopped"
  | "accepted"
  | "abandoned";

export type WorkerActivityState = "idle" | "busy" | "waiting_ui" | "unknown";

export interface WorkerInstanceMetadata {
  controllerId: string;
  workerId: string;
  taskId: string;
  cwd: string;
  title: string;
  childPid?: number;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  tools?: string[];
  revision: number;
  runId: number;
  lifecycleState: WorkerLifecycleState;
  taskState: WorkerTaskState;
  activityState: WorkerActivityState;
  createdAt: number;
  updatedAt: number;
}

/**
 * 会话代际追踪器，防止跨 reload 或 session switch 的异步回调干扰新会话
 */
export class SessionGenerationManager {
  private currentGeneration = 0;

  public get generation(): number {
    return this.currentGeneration;
  }

  public nextGeneration(): number {
    return ++this.currentGeneration;
  }

  public isValid(gen: number): boolean {
    return gen === this.currentGeneration;
  }
}

/**
 * 单实例互斥状态机
 */
export class SingleWorkerManager {
  private currentInstance: WorkerInstanceMetadata | null = null;
  private mutexLocked = false;

  public hasActiveInstance(): boolean {
    if (!this.currentInstance) return false;
    return (
      this.currentInstance.lifecycleState !== "none" &&
      this.currentInstance.lifecycleState !== "closed"
    );
  }

  public getInstance(): WorkerInstanceMetadata | null {
    return this.currentInstance ? { ...this.currentInstance } : null;
  }

  /**
   * 原子请求启动名额
   */
  public acquireLaunchSlot(
    controllerId: string,
    workerId: string,
    taskId: string,
    cwd: string,
    title: string,
  ): WorkerInstanceMetadata {
    if (this.mutexLocked) {
      throw new Error(`当前正在处理其他状态转换，请稍候重试`);
    }

    this.mutexLocked = true;
    try {
      if (this.hasActiveInstance()) {
        const cur = this.currentInstance!;
        throw new Error(
          `[${ProtocolErrorCode.ALREADY_EXISTS}] 当前已存在运行中或未确认退出的 Worker (ID: ${cur.workerId}, 状态: ${cur.lifecycleState})。单主控同一时间仅允许一个执行端。`,
        );
      }

      const now = Date.now();
      const instance: WorkerInstanceMetadata = {
        controllerId,
        workerId,
        taskId,
        cwd,
        title,
        revision: 1,
        runId: 1,
        lifecycleState: "launching",
        taskState: "created",
        activityState: "unknown",
        createdAt: now,
        updatedAt: now,
      };

      this.currentInstance = instance;
      return { ...this.currentInstance };
    } finally {
      this.mutexLocked = false;
    }
  }

  /**
   * 更新当前实例生命周期状态
   */
  public updateLifecycleState(state: WorkerLifecycleState): void {
    if (!this.currentInstance) return;
    this.currentInstance.lifecycleState = state;
    this.currentInstance.updatedAt = Date.now();
  }

  /**
   * 更新当前任务状态
   */
  public updateTaskState(state: WorkerTaskState): void {
    if (!this.currentInstance) return;
    this.currentInstance.taskState = state;
    this.currentInstance.updatedAt = Date.now();
  }

  /**
   * 更新 Pi 活动状态
   */
  public updateActivityState(state: WorkerActivityState): void {
    if (!this.currentInstance) return;
    this.currentInstance.activityState = state;
    this.currentInstance.updatedAt = Date.now();
  }

  /**
   * 记录子进程 PID
   */
  public setChildPid(pid: number): void {
    if (!this.currentInstance) return;
    this.currentInstance.childPid = pid;
    this.currentInstance.updatedAt = Date.now();
  }

  /**
   * 更新模型信息 (worker_ready 初始上报或 model_changed 刷新)
   */
  public setModelInfo(
    provider?: string,
    modelId?: string,
    thinkingLevel?: string,
    tools?: string[],
  ): void {
    if (!this.currentInstance) return;
    if (provider !== undefined) this.currentInstance.provider = provider;
    if (modelId !== undefined) this.currentInstance.modelId = modelId;
    if (thinkingLevel !== undefined) this.currentInstance.thinkingLevel = thinkingLevel;
    if (tools) this.currentInstance.tools = [...tools];
    this.currentInstance.updatedAt = Date.now();
  }

  /**
   * 递增 Revision (返修)
   */
  public bumpRevision(): { revision: number; runId: number } {
    if (!this.currentInstance) {
      throw new Error("当前无存活的 Worker 实例");
    }
    this.currentInstance.revision += 1;
    this.currentInstance.runId += 1;
    this.currentInstance.taskState = "queued";
    this.currentInstance.updatedAt = Date.now();
    return {
      revision: this.currentInstance.revision,
      runId: this.currentInstance.runId,
    };
  }

  /**
   * 递增 RunId (同 Revision 下的重试或新一轮交互)
   */
  public bumpRunId(): number {
    if (!this.currentInstance) {
      throw new Error("当前无存活的 Worker 实例");
    }
    this.currentInstance.runId += 1;
    this.currentInstance.updatedAt = Date.now();
    return this.currentInstance.runId;
  }

  /**
   * 释放实例名额 (仅当状态为 closed 或人工 forget 时允许)
   */
  public releaseSlot(force: boolean = false): boolean {
    if (!this.currentInstance) return true;
    if (
      force ||
      this.currentInstance.lifecycleState === "closed" ||
      this.currentInstance.lifecycleState === "none"
    ) {
      this.currentInstance = null;
      return true;
    }
    return false;
  }
}

/**
 * 资源清理注册器，保证 session_shutdown 或退出时幂等清理
 */
export class CleanupRegistry {
  private disposers = new Set<() => Promise<void> | void>();
  private isDisposed = false;

  /** 当前待执行的 disposer 数量 (诊断/测试用) */
  public get size(): number {
    return this.disposers.size;
  }

  public register(disposer: () => Promise<void> | void): () => void {
    this.disposers.add(disposer);
    return () => {
      this.disposers.delete(disposer);
    };
  }

  /**
   * 执行并清空全部 disposer，同一轮只执行一次。
   * 重复调用直接返回，既不重复执行 disposer 也不抛错。
   */
  public async disposeAll(): Promise<void> {
    if (this.isDisposed) return;
    this.isDisposed = true;

    for (const disposer of Array.from(this.disposers)) {
      try {
        await disposer();
      } catch {
        // 忽略清理阶段的错误
      }
    }
    this.disposers.clear();
  }

  /**
   * 复位 dispose 标记，使同一个 registry 实例可被下一次会话复用。
   * disposers 已在 disposeAll 中清空，因此 reset 后可重新 register 并再次 disposeAll。
   */
  public reset(): void {
    this.isDisposed = false;
  }
}
