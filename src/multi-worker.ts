/**
 * 主控端多 Worker 协调器（阶段 B：真正并发启动及同实例竞态控制）
 *
 * 设计要点（见 docs/multi-worker-concurrency-plan.md 第 1、2、4 节）：
 * - 保留 ControllerManager 作为“单个 Worker”的会话内核，其 pipe server、两条连接、
 *   token、收件箱、报告缓存、心跳、关闭流程均保持实例私有，不做字段全局化。
 * - 协调器维护 Map<workerId, WorkerEntry>：每次 worker_start 同步登记一个 WorkerEntry，
 *   并为该实例创建独立 ControllerManager；workerId 是唯一公开路由键。
 * - 主控入口只注册一次工具与命令；worker_start/send/wait/status/stop/close 按 workerId
 *   精确委托到对应 ControllerManager，未知 workerId 返回清晰的 NOT_FOUND 错误。
 *
 * 阶段 B 新增：
 * - 六个主控工具改为 executionMode "parallel"，让同批 worker_start 的握手真正重叠；
 * - 每个 WorkerEntry 自带一条 mutating 操作队列 (send/stop/close 串行化)，保证同一
 *   Worker 的 runId/revision 不乱序；worker_wait / worker_status 不占队列。
 * - close 进入 closing 后拒绝新的 send/stop；同 disposition 的并发 close 复用同一
 *   in-flight promise，不同 disposition 明确拒绝。
 * - 身份 ID 用安全随机来源生成，并在登记时避开仍未关闭及历史已关闭的 ID（永不复用）；
 *   Map 登记/删除不跨 await，晚到回调按 entry 引用 + epoch 双重校验，不删新登记。
 */

import * as crypto from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  ControllerManager,
  DEFAULT_WORKER_PROVIDER,
  DEFAULT_WORKER_MODEL,
  DEFAULT_WORKER_THINKING_LEVEL,
  DEFAULT_WAIT_TIMEOUT_MS,
  MIN_WAIT_TIMEOUT_MS,
  MAX_WAIT_TIMEOUT_MS,
} from "./controller.js";
import { ProtocolErrorCode } from "./protocol.js";
import type { WorkerInstanceMetadata } from "./lifecycle.js";

/** close 结果类型 (与 ControllerManager.handleWorkerClose 一致) */
type CloseResult = { ok: boolean; disposition: string; message: string };

/** 协调器内登记的一个 Worker 实例 */
export interface WorkerEntry {
  readonly controllerId: string;
  readonly workerId: string;
  readonly taskId: string;
  /** 该 Worker 独占的会话内核 (pipe/连接/token/收件箱/心跳均独立) */
  readonly controller: ControllerManager;
  readonly createdAt: number;
  /**
   * 本实例 mutating 操作 (send/stop/close) 的串行化队列尾。
   * 只用于同一 workerId 的本地排序，绝不跨实例共享；worker_wait/worker_status 不入队。
   */
  opChain: Promise<void>;
  /**
   * 正在进行的 close。同 disposition 复用该 promise，不同 disposition 明确拒绝。
   * 该字段在进入关闭流程时同步写入，保证两个并发 close 之间不会都落到控制器层。
   */
  closeInFlight: { disposition: "accepted" | "abandoned"; promise: Promise<CloseResult> } | null;
  /** 已进入关闭流程：此后 send/stop 必须明确拒绝，不得在 closing 后仍接纳修改 */
  closing: boolean;
  /** 人工 forget 已排队：同步阻止期间到达的新 send/stop/close */
  forgetting: boolean;
  /**
   * 该实例当前在途的 controller.handleWorkerStart（settle 后置 null）。
   * dispose 据此对该实例单独推进一次代际取消并等待其 settle，不依赖全局集合。
   */
  startPromise: Promise<unknown> | null;
}

export interface MultiWorkerCoordinatorOptions {
  /** 严格协议校验开关 (生产入口固定 true) */
  strictProtocol?: boolean;
  /** 底层 ControllerManager 工厂；测试注入用，默认按 strictProtocol 构造 */
  controllerFactory?: () => ControllerManager;
  /**
   * 身份 ID 生成器；默认使用 node:crypto 安全随机来源。
   * 仅测试注入用，生产路径不接受 LLM/调用方覆盖 ID。
   */
  idGenerator?: () => { controllerId: string; workerId: string; taskId: string };
}

export interface WorkerStartParams {
  cwd: string;
  title: string;
  task: string;
  context?: string;
  allowedPaths?: string[];
  acceptanceCriteria?: string[];
  provider?: string;
  model?: string;
  thinkingLevel?: string;
}

/** worker_list 单条有界摘要（不含报告/事件明细，明细仍走 worker_status） */
export interface WorkerListSummary {
  workerId: string;
  taskId: string;
  title: string;
  cwd: string;
  lifecycleState: string;
  taskState: string;
  activityState: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  provider?: string;
}

export interface WorkerListResult {
  ok: boolean;
  total: number;
  returned: number;
  truncated: boolean;
  workers: WorkerListSummary[];
}

/** 状态栏汇总计数；running/review/issue 三分类之和等于 total */
export interface WorkerSummaryCounts {
  total: number;
  running: number;
  review: number;
  issue: number;
}

/** worker_list 单次返回最大条数，避免多实例状态一次塞满上下文 */
export const WORKER_LIST_MAX_ITEMS = 20;
const WORKER_LIST_MAX_TITLE = 80;
const WORKER_LIST_MAX_CWD = 200;
const WORKER_LIST_MAX_MODEL = 80;
const WORKER_LIST_MAX_PROVIDER = 80;

/** 把长文本截断为有界摘要（保留尾部省略号，避免超出上下文预算） */
function truncateForList(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + "…";
}

/** 生产路径的身份 ID 一律由安全随机来源生成，不接受调用方覆盖 */
function generateIdentityIds(): {
  controllerId: string;
  workerId: string;
  taskId: string;
} {
  return {
    controllerId: "ctrl-" + crypto.randomUUID().slice(0, 8),
    workerId: "worker-" + crypto.randomUUID().slice(0, 8),
    taskId: "task-" + crypto.randomUUID().slice(0, 8),
  };
}

export class MultiWorkerCoordinator {
  private readonly entries = new Map<string, WorkerEntry>();
  private readonly strictProtocol: boolean;
  private readonly controllerFactory?: () => ControllerManager;
  private readonly idGenerator: () => { controllerId: string; workerId: string; taskId: string };
  /**
   * 曾经登记过的全部身份 ID。已关闭/失败的 ID 永不回收，
   * 确保新实例不会复用旧 workerId/taskId/controllerId，晚到回调也无法命中新登记。
   */
  private readonly usedWorkerIds = new Set<string>();
  private readonly usedControllerIds = new Set<string>();
  private readonly usedTaskIds = new Set<string>();
  /** 协调器会话代际：防止会话切换后的晚到回调删除/写入新 epoch 的登记 */
  private epoch = 0;
  private isDisposed = false;
  /**
   * 会话级生命周期串行队列：handleSessionStart 与 dispose 不并发进入内核，
   * 避免底层 handleSessionStart 在 dispose 之后又复活 generation/cleanups。
   */
  private lifecycleChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly pi: ExtensionAPI,
    options: MultiWorkerCoordinatorOptions = {},
  ) {
    this.strictProtocol = options.strictProtocol ?? false;
    this.controllerFactory = options.controllerFactory;
    this.idGenerator = options.idGenerator ?? generateIdentityIds;
  }

  /** 当前登记的 workerId 列表 (诊断/worker_list 基础，保持插入顺序) */
  public listWorkerIds(): string[] {
    return [...this.entries.keys()];
  }

  /** 按 workerId 取登记项 (诊断用) */
  public getEntry(workerId: string): WorkerEntry | undefined {
    return this.entries.get(workerId);
  }

  /** 当前登记实例数量 */
  public get size(): number {
    return this.entries.size;
  }

  /**
   * 用于会话事件刷新 UI 的“主实例”快照。
   * 阶段 A 不做多实例汇总：多实例时取最近创建者，单实例语义与旧实现完全一致。
   */
  public getPrimaryInstance(): WorkerInstanceMetadata | null {
    let latest: WorkerEntry | null = null;
    for (const entry of this.entries.values()) {
      if (!latest || entry.createdAt >= latest.createdAt) latest = entry;
    }
    return latest?.controller.workerManager.getInstance() ?? null;
  }

  private createController(): ControllerManager {
    if (this.controllerFactory) return this.controllerFactory();
    return new ControllerManager(this.pi, this.strictProtocol);
  }

  /** 单实例摘要：instance 元数据 + 登记时间，长文本截断为有界内容 */
  private summarizeEntry(entry: WorkerEntry): WorkerListSummary {
    const inst = entry.controller.workerManager.getInstance();
    return {
      workerId: entry.workerId,
      taskId: entry.taskId,
      title: truncateForList(inst?.title ?? "", WORKER_LIST_MAX_TITLE),
      cwd: truncateForList(inst?.cwd ?? "", WORKER_LIST_MAX_CWD),
      lifecycleState: inst?.lifecycleState ?? "unknown",
      taskState: inst?.taskState ?? "unknown",
      activityState: inst?.activityState ?? "unknown",
      createdAt: entry.createdAt,
      updatedAt: inst?.updatedAt ?? entry.createdAt,
      model: inst?.modelId ? truncateForList(inst.modelId, WORKER_LIST_MAX_MODEL) : undefined,
      provider: inst?.provider ? truncateForList(inst.provider, WORKER_LIST_MAX_PROVIDER) : undefined,
    };
  }

  /**
   * 状态栏三分类：issue 优先于 review。
   * 断连/不可响应的实例即使任务仍标为 ready_for_review，也必须计入 issue，
   * 不能让 review 掩盖已失去监督的事实。
   */
  private classifyEntry(entry: WorkerEntry): "running" | "review" | "issue" {
    const inst = entry.controller.workerManager.getInstance();
    if (!inst) return "issue";
    if (
      inst.taskState === "failed" ||
      inst.taskState === "blocked" ||
      inst.lifecycleState === "disconnected" ||
      inst.lifecycleState === "unresponsive" ||
      inst.lifecycleState === "launch_unknown" ||
      inst.lifecycleState === "detached"
    ) {
      return "issue";
    }
    if (inst.taskState === "ready_for_review") return "review";
    return "running";
  }

  /**
   * worker_list：返回活跃及未确认退出实例的有界摘要。
   * 只包含轻量字段；错误、报告与事件明细仍须按 workerId 走 worker_status。
   */
  public async handleWorkerList(maxItems: number = WORKER_LIST_MAX_ITEMS): Promise<WorkerListResult> {
    const active = this.getActiveEntries();
    const requested =
      Number.isFinite(maxItems) && maxItems > 0 ? Math.floor(maxItems) : WORKER_LIST_MAX_ITEMS;
    // 无论调用方请求多少，单次返回都不得超过 WORKER_LIST_MAX_ITEMS
    const limit = Math.min(requested, WORKER_LIST_MAX_ITEMS, active.length);
    const workers = active.slice(0, limit).map((entry) => this.summarizeEntry(entry));
    return {
      ok: true,
      total: active.length,
      returned: workers.length,
      truncated: active.length > workers.length,
      workers,
    };
  }

  /** 状态栏汇总：对当前活跃/未确认退出实例按 running/review/issue 计数 */
  public getSummary(): WorkerSummaryCounts {
    const counts: WorkerSummaryCounts = { total: 0, running: 0, review: 0, issue: 0 };
    for (const entry of this.getActiveEntries()) {
      counts.total += 1;
      counts[this.classifyEntry(entry)] += 1;
    }
    return counts;
  }

  /** 按 workerId 精确查找；找不到绝不退回“最近创建的实例” */
  private requireEntry(workerId: string): WorkerEntry {
    const entry = this.entries.get(workerId);
    if (!entry) {
      throw new Error(`[${ProtocolErrorCode.NOT_FOUND}] 找不到 Worker: ${workerId}`);
    }
    return entry;
  }

  /**
   * 生成一组与现存登记及历史已关闭 ID 都不冲突的身份 ID。
   * 冲突时重新生成（同一批并发 start 也共享 entries 的同步写入，因此不会互相撞号）。
   */
  private generateUniqueIdentity(): { controllerId: string; workerId: string; taskId: string } {
    for (let attempt = 0; attempt < 100; attempt++) {
      const ids = this.idGenerator();
      if (
        !this.entries.has(ids.workerId) &&
        !this.usedWorkerIds.has(ids.workerId) &&
        !this.usedControllerIds.has(ids.controllerId) &&
        !this.usedTaskIds.has(ids.taskId)
      ) {
        return ids;
      }
    }
    throw new Error("无法生成不与现存/已关闭实例冲突的身份 ID，请重试");
  }

  /** 永久登记本次使用的身份 ID，避免后续实例复用（即使该实例随后关闭/失败） */
  private markIdentityUsed(ids: { controllerId: string; workerId: string; taskId: string }): void {
    this.usedWorkerIds.add(ids.workerId);
    this.usedControllerIds.add(ids.controllerId);
    this.usedTaskIds.add(ids.taskId);
  }

  /**
   * 把同一实例的 mutating 操作追加到本地队列尾并串行执行。
   * 入队时捕获会话 epoch，真正执行前复核 disposed / epoch / entry 引用：
   * 会话切换、forget 或 dispose 之后的旧 send/stop/close 绝不触碰底层连接。
   */
  private enqueueMutation<T>(entry: WorkerEntry, op: () => Promise<T>): Promise<T> {
    const epoch = this.epoch;
    const guarded = async (): Promise<T> => {
      this.assertMutationAllowed(entry, epoch);
      return op();
    };
    const run = entry.opChain.then(guarded, guarded);
    entry.opChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** mutating 操作的执行前门槛：旧会话/已忘记/已释放的实例一律拒绝 */
  private assertMutationAllowed(entry: WorkerEntry, epoch: number): void {
    if (this.isDisposed) {
      throw new Error(`[${ProtocolErrorCode.INVALID_STATE}] 协调器已释放，拒绝该操作`);
    }
    if (this.epoch !== epoch || this.entries.get(entry.workerId) !== entry) {
      throw new Error(
        `[${ProtocolErrorCode.NOT_FOUND}] Worker ${entry.workerId} 已不在当前会话的监督范围`,
      );
    }
  }

  // ===== 六个主控操作的协调器级入口 =====

  public async handleWorkerStart(params: WorkerStartParams): Promise<{
    ok: boolean;
    workerId: string;
    taskId: string;
    revision: number;
    message: string;
  }> {
    // dispose 一旦开始就不再接受新的启动，避免清理后重新创建 pipe/定时器
    if (this.isDisposed) {
      throw new Error(`[${ProtocolErrorCode.INVALID_STATE}] 协调器已释放，不能再启动新的 Worker`);
    }
    const ids = this.generateUniqueIdentity();
    const controller = this.createController();
    const entry: WorkerEntry = {
      controllerId: ids.controllerId,
      workerId: ids.workerId,
      taskId: ids.taskId,
      controller,
      createdAt: Date.now(),
      opChain: Promise.resolve(),
      closeInFlight: null,
      closing: false,
      forgetting: false,
      startPromise: null,
    };

    // 先登记、后异步启动：Map 写入不跨 await，保证同批并发调用之间即可按 ID 查询/清理，
    // 且身份 ID 一旦使用即永久登记，后续 start 不会复用。
    this.markIdentityUsed(ids);
    this.entries.set(entry.workerId, entry);
    const epoch = this.epoch;

    // 在途 start 由 entry 自己持有：dispose 可对每个实例独立取消+等待，互不阻塞
    const startPromise = controller.handleWorkerStart(params, {}, { ids });
    entry.startPromise = startPromise;
    try {
      const res = await startPromise;
      return {
        ok: res.ok,
        workerId: entry.workerId,
        taskId: entry.taskId,
        revision: res.revision,
        message: res.message,
      };
    } catch (err: unknown) {
      // 仅“进程已确认退出/参数未创建进程” (名额已释放) 才回收本次登记；
      // 握手超时、投递未知等保留占位，可按 ID 继续诊断，绝不自动删除。
      if (this.epoch === epoch && this.entries.get(entry.workerId) === entry) {
        if (!controller.workerManager.hasActiveInstance()) {
          this.entries.delete(entry.workerId);
          try {
            await controller.dispose();
          } catch {
            // dispose 幂等且尽力而为，忽略单实例清理异常
          }
        }
      }
      throw err;
    } finally {
      entry.startPromise = null;
    }
  }

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
    const entry = this.requireEntry(params.workerId);
    // close/forget 已进入流程：明确拒绝，绝不在关闭或忘记后继续接纳修改
    if (entry.closing || entry.forgetting) {
      throw new Error(
        `[${ProtocolErrorCode.INVALID_STATE}] Worker ${params.workerId} 正在关闭或解除占位，拒绝发送 ${params.kind}`,
      );
    }
    // 同一 workerId 的 send 串行化：保证 runId/revision 递增与实际投递顺序一致
    return this.enqueueMutation(entry, () => entry.controller.handleWorkerSend(params));
  }

  public async handleWorkerWait(
    params: {
      workerId: string;
      afterCursor?: number;
      timeoutMs?: number;
    },
    options: { signal?: AbortSignal } = {},
  ) {
    const entry = this.requireEntry(params.workerId);
    return entry.controller.handleWorkerWait(params, options);
  }

  public async handleWorkerStatus(params: {
    workerId: string;
    eventId?: string;
    offset?: number;
    limit?: number;
  }) {
    const entry = this.requireEntry(params.workerId);
    return entry.controller.handleWorkerStatus(params);
  }

  public async handleWorkerStop(params: {
    workerId: string;
    reason?: string;
  }): Promise<{ ok: boolean; message: string }> {
    const entry = this.requireEntry(params.workerId);
    if (entry.closing || entry.forgetting) {
      throw new Error(
        `[${ProtocolErrorCode.INVALID_STATE}] Worker ${params.workerId} 正在关闭或解除占位，拒绝停止请求`,
      );
    }
    return this.enqueueMutation(entry, () => entry.controller.handleWorkerStop(params));
  }

  public async handleWorkerClose(params: {
    workerId: string;
    disposition: "accepted" | "abandoned";
    force?: boolean;
  }): Promise<{ ok: boolean; disposition: string; message: string }> {
    const entry = this.requireEntry(params.workerId);

    // forget 已排队：不得再进入关闭流程
    if (entry.forgetting) {
      throw new Error(
        `[${ProtocolErrorCode.INVALID_STATE}] Worker ${params.workerId} 正在解除占位，拒绝关闭`,
      );
    }

    // 并发 close 的本地门槛（在进入队列前同步判定，两个并发调用不会都落到控制器层）：
    // - 同 disposition：复用同一 in-flight promise，底层只关闭一次；
    // - 不同 disposition：明确拒绝，调用方需等上一次结束。
    if (entry.closeInFlight) {
      if (entry.closeInFlight.disposition === params.disposition) {
        return entry.closeInFlight.promise;
      }
      throw new Error(
        `[${ProtocolErrorCode.INVALID_STATE}] 已有一次进行中的 worker_close (disposition: ${entry.closeInFlight.disposition})，` +
          `不能同时以 ${params.disposition} 再次关闭；请等待上一次关闭结束`,
      );
    }

    // 同步置位，确保后续 / 并发到达的 send/stop 立即被拒绝
    entry.closing = true;
    const epoch = this.epoch;

    const promise = this.enqueueMutation(entry, async () => {
      const res = await entry.controller.handleWorkerClose(params);

      // 只有该实例已确认退出 (close 成功会释放名额) 才从 Map 删除并清理其资源；
      // 会话已切换 (epoch 变化) 或登记项已被替换时不清理新 epoch 的实例。
      if (
        res.ok &&
        this.epoch === epoch &&
        this.entries.get(entry.workerId) === entry &&
        !entry.controller.workerManager.hasActiveInstance()
      ) {
        this.entries.delete(entry.workerId);
        try {
          await entry.controller.dispose();
        } catch {
          // 单实例清理异常不得影响其它实例
        }
      }
      return res;
    });

    entry.closeInFlight = { disposition: params.disposition, promise };
    try {
      return await promise;
    } finally {
      if (entry.closeInFlight && entry.closeInFlight.promise === promise) {
        entry.closeInFlight = null;
        // 关闭失败（如未满足 accepted 门槛）时解禁，允许后续重试；
        // 成功时该 entry 已从 Map 移除，解禁不再有可观察影响。
        entry.closing = false;
      }
    }
  }

  // ===== 会话生命周期委托 =====

  /** 会话生命周期操作串行执行（handleSessionStart / dispose 不并发进入内核） */
  private runLifecycle<T>(op: () => Promise<T>): Promise<T> {
    const run = this.lifecycleChain.then(op, op);
    this.lifecycleChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 会话切换：逐个委托 handleSessionStart，一个失败不跳过其余实例。
   * 旧连接失效、旧 waiters 被取消；无法确认退出的实例保留占位。
   *
   * 同一扩展实例可能被新会话复用（会话替换不保证重建实例）：新 session_start 会
   * 重新武装本协调器，使后续 worker_start 可用；旧实例已在 dispose 中清理，
   * 且 dispose 后、新 session_start 之前不会调用任何内核。
   */
  public handleSessionStart(): Promise<void> {
    return this.runLifecycle(async () => {
      if (this.isDisposed) {
        // 上一生命周期已 dispose：重新武装启动能力；旧登记已清理，不再调用旧内核
        this.entries.clear();
        this.isDisposed = false;
        this.epoch++;
        return;
      }
      this.epoch++;
      const entries = [...this.entries.values()];
      const errors: unknown[] = [];
      for (const entry of entries) {
        if (this.isDisposed) break;
        if (this.entries.get(entry.workerId) !== entry) continue;
        try {
          await entry.controller.handleSessionStart();
        } catch (err: unknown) {
          errors.push(err);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, `会话切换时 ${errors.length} 个 Worker 实例清理失败`);
      }
    });
  }

  /** 关闭：串联在生命周期链上，按实例幂等；一个失败不影响其它实例 */
  public dispose(): Promise<void> {
    return this.runLifecycle(() => this.disposeInternal());
  }

  private async disposeInternal(): Promise<void> {
    if (this.isDisposed) return;
    this.isDisposed = true;
    // 使会话切换后/进程释放后的晚到 start/close/tool 回调失效，不再写回登记或资源
    this.epoch += 1;

    const entries = [...this.entries.values()];
    this.entries.clear();

    // 每个实例独立清理：在途 start 先单次取消并等它 settle 再 dispose，非在途立即 dispose。
    // 全部并行 allSettled，慢 A 不阻塞 B 的清理；不再依赖全局 pendingStarts 集合。
    const results = await Promise.allSettled(entries.map((entry) => this.disposeEntry(entry)));
    const errors: unknown[] = [];
    for (const result of results) {
      if (result.status === "rejected") errors.push(result.reason);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `释放时 ${errors.length} 个 Worker 实例清理失败`);
    }
  }

  /**
   * 单实例释放：在途 start 只推进一次代际取消，等待其 settle 后 dispose 该实例；
   * 非在途实例直接 dispose。各实例互不阻塞。
   */
  private async disposeEntry(entry: WorkerEntry): Promise<void> {
    const errors: unknown[] = [];
    const startPromise = entry.startPromise;
    if (startPromise) {
      try {
        await entry.controller.handleSessionStart();
      } catch (err: unknown) {
        errors.push(err);
      }
      try {
        await startPromise;
      } catch {
        // 在途 start 自身的失败由 handleWorkerStart 处理，这里只需确认其已 settle
      }
    }
    try {
      await entry.controller.dispose();
    } catch (err: unknown) {
      errors.push(err);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `Worker ${entry.workerId} 清理失败`);
    }
  }

  // ===== 一次性注册工具与命令 =====

  /** 主控入口只调用一次；绝不能对每个 ControllerManager 分别注册 */
  public registerToolsAndCommands(): void {
    this.pi.registerTool({
      name: "worker_start",
      label: "Worker Start",
      description:
        "在独立的终端窗口 (Windows Terminal，缺失时回退 PowerShell/CMD) 中启动一个交互式 Worker Pi，派发初始任务并建立监督通信。" +
        "Worker 的关键事件（交付/提问/阻塞/停止/断连等）会主动唤醒本会话：空闲时开新轮，忙碌时 followUp 排队，无需轮询。",
      executionMode: "parallel",
      parameters: Type.Object({
        cwd: Type.String({ description: "Worker 工作的根目录 (必须为绝对路径)" }),
        title: Type.String({ description: "Windows Terminal 窗口的标题" }),
        task: Type.String({ description: "初始任务需求与指令说明" }),
        context: Type.Optional(Type.String({ description: "任务背景与前置上下文" })),
        allowedPaths: Type.Optional(
          Type.Array(Type.String(), { description: "允许修改的文件或目录契约" }),
        ),
        acceptanceCriteria: Type.Optional(
          Type.Array(Type.String(), { description: "验收指标与测试要求" }),
        ),
        provider: Type.Optional(
          Type.String({
            description: `可选：限定 --model 查找的 provider；不传时使用 Worker 默认配置 (${DEFAULT_WORKER_PROVIDER})`,
          }),
        ),
        model: Type.Optional(
          Type.String({
            description: `可选：模型 ID 或模糊匹配模式，可含 provider/id 与 :<thinking> 后缀；不传时使用 Worker 默认配置 (${DEFAULT_WORKER_MODEL})`,
          }),
        ),
        thinkingLevel: Type.Optional(
          Type.Union(
            [
              Type.Literal("off"),
              Type.Literal("minimal"),
              Type.Literal("low"),
              Type.Literal("medium"),
              Type.Literal("high"),
              Type.Literal("xhigh"),
              Type.Literal("max"),
            ],
            {
              description: `可选：思考级别；不传时使用 Worker 默认配置 (${DEFAULT_WORKER_THINKING_LEVEL})`,
            },
          ),
        ),
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
      executionMode: "parallel",
      parameters: Type.Object({
        workerId: Type.String(),
        taskId: Type.String(),
        message: Type.String({ description: "发送的消息正文" }),
        kind: Type.Union(
          [Type.Literal("supplement"), Type.Literal("reply"), Type.Literal("revision")],
          {
            description:
              "消息种类：supplement(补充说明), reply(回复提问), revision(返修，要求处于 ready_for_review 状态)",
          },
        ),
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
      executionMode: "parallel",
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
      description:
        "查询当前 Worker 状态、模型、生命周期及回执详情；支持通过 eventId 分页拉取长事件内容。",
      executionMode: "parallel",
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
      name: "worker_list",
      label: "Worker List",
      description:
        "无参数列出当前活跃或未确认退出的 Worker 有界摘要 (workerId/taskId/标题/cwd/状态/时间/模型)。" +
        "需要错误、报告与事件明细时请按 workerId 使用 worker_status。",
      executionMode: "parallel",
      parameters: Type.Object({}),
      execute: async () => {
        const res = await this.handleWorkerList();
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
      executionMode: "parallel",
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
      description:
        "完成任务验收 (accepted) 或放弃任务 (abandoned)，安全关闭指定 Worker 并释放其名额。",
      executionMode: "parallel",
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

    this.registerCommands();
  }

  /**
   * 仍占用名额、需要人工处理的实例（含 launch_unknown / disconnected 占位）。
   * 已释放名额的 entry（如旧 forget 遗留）不计入，避免“无效 entry”挡住唯一活跃实例。
   */
  private getActiveEntries(): WorkerEntry[] {
    return [...this.entries.values()].filter((entry) =>
      entry.controller.workerManager.hasActiveInstance(),
    );
  }

  private describeEntry(entry: WorkerEntry): string {
    const inst = entry.controller.workerManager.getInstance();
    const task = inst?.taskState ?? "unknown";
    const lifecycle = inst?.lifecycleState ?? "unknown";
    const title = inst?.title ? ` | 标题: ${truncateForList(inst.title, 40)}` : "";
    return `${entry.workerId} (任务: ${task} | 状态: ${lifecycle}${title})`;
  }

  /** 解析用户命令参数中的 workerId（取首个空白分隔 token） */
  private parseCommandWorkerId(args: string): string | undefined {
    const trimmed = (args ?? "").trim();
    if (!trimmed) return undefined;
    return trimmed.split(/\s+/)[0];
  }

  /**
   * 目标选择：显式 ID 优先；未给 ID 时仅在恰好一个活跃实例时沿用快捷语义。
   * 多于一个且未指定时只列 ID 并提示用法，绝不隐式选择“最近创建”的实例。
   */
  private resolveCommandTarget(
    ctx: ExtensionCommandContext,
    opts: {
      action: string;
      workerId?: string;
      emptyMessage: string;
      allowInactive?: boolean;
    },
  ): WorkerEntry | null {
    if (opts.workerId) {
      const entry = this.entries.get(opts.workerId);
      if (!entry) {
        ctx.ui.notify(
          `找不到 Worker: ${opts.workerId}（使用 /worker-status 查看当前实例）`,
          "warning",
        );
        return null;
      }
      if (!opts.allowInactive && !entry.controller.workerManager.hasActiveInstance()) {
        ctx.ui.notify(`Worker ${opts.workerId} 已不占用名额，无需${opts.action}`, "warning");
        return null;
      }
      return entry;
    }

    const active = this.getActiveEntries();
    if (active.length === 0) {
      ctx.ui.notify(opts.emptyMessage, "warning");
      return null;
    }
    if (active.length > 1) {
      this.notifyAmbiguousTarget(ctx, opts.action, active);
      return null;
    }
    return active[0];
  }

  /** 单实例明细：供 /worker-status <workerId> 使用 */
  private async notifyEntryDetail(
    ctx: ExtensionCommandContext,
    entry: WorkerEntry,
  ): Promise<void> {
    const inst = entry.controller.workerManager.getInstance();
    if (!inst) {
      ctx.ui.notify(`Worker ${entry.workerId} 已无可用实例元数据（可考虑 /worker-forget）`, "warning");
      return;
    }
    const model = inst.modelId ? ` | 模型: ${inst.modelId}` : "";
    const provider = inst.provider ? ` (${inst.provider})` : "";
    ctx.ui.notify(
      `Worker: ${inst.workerId} | 任务: ${inst.taskState} | 状态: ${inst.lifecycleState} | 活动: ${inst.activityState} | rev: ${inst.revision}${model}${provider}\n` +
        `标题: ${inst.title} | cwd: ${inst.cwd} | taskId: ${inst.taskId}`,
      "info",
    );
  }

  /**
   * 多实例时列出候选并拒绝隐式选择：必须由用户显式给出 workerId。
   */
  private notifyAmbiguousTarget(
    ctx: ExtensionCommandContext,
    action: string,
    entries: WorkerEntry[],
  ): void {
    const lines = entries.map((entry) => `- ${this.describeEntry(entry)}`);
    ctx.ui.notify(
      `当前有 ${entries.length} 个运行中的 Worker，${action}需要明确 workerId，不会隐式选择目标。` +
        `请指定目标，例如：/worker-${action === "停止" ? "stop" : action === "关闭" ? "close" : "forget"} <workerId>\n${lines.join("\n")}`,
      "warning",
    );
  }

  /**
   * 用户命令：命令只注册一次，目标选择集中在协调器内。
   * 显式 workerId 优先；恰好一个活跃实例时保留单 Worker 无参快捷语义；
   * 多于一个时只列出 workerId 并提示用法，绝不隐式选择“最近创建”的实例。
   */
  private registerCommands(): void {
    this.pi.registerCommand("worker-status", {
      description: "查看当前所有 Worker 摘要；传入 workerId 查看单个实例明细",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const workerId = this.parseCommandWorkerId(args);
        if (workerId) {
          const entry = this.entries.get(workerId);
          if (!entry) {
            ctx.ui.notify(`找不到 Worker: ${workerId}`, "warning");
            return;
          }
          await this.notifyEntryDetail(ctx, entry);
          return;
        }

        const active = this.getActiveEntries();
        if (active.length === 0) {
          ctx.ui.notify("当前没有运行中的 Worker", "info");
          return;
        }
        const lines = active.map((entry) => `- ${this.describeEntry(entry)}`);
        ctx.ui.notify(
          `当前有 ${active.length} 个运行中的 Worker：\n${lines.join("\n")}\n` +
            `使用 /worker-status <workerId> 查看单个实例明细。`,
          "info",
        );
      },
    });

    this.pi.registerCommand("worker-stop", {
      description: "中止指定 Worker 的运行（多实例时需显式 workerId）",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const entry = this.resolveCommandTarget(ctx, {
          action: "停止",
          workerId: this.parseCommandWorkerId(args),
          emptyMessage: "当前没有运行中的 Worker",
        });
        if (!entry) return;
        try {
          await this.handleWorkerStop({ workerId: entry.workerId, reason: "用户命令中止" });
          ctx.ui.notify(`已发送停止请求 (${entry.workerId})`, "info");
        } catch (err: unknown) {
          ctx.ui.notify(`停止失败 (${entry.workerId}): ${(err as Error).message}`, "error");
        }
      },
    });

    this.pi.registerCommand("worker-close", {
      description: "关闭指定 Worker 窗口并释放名额（多实例时需显式 workerId）",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const entry = this.resolveCommandTarget(ctx, {
          action: "关闭",
          workerId: this.parseCommandWorkerId(args),
          emptyMessage: "当前没有 Worker 实例",
        });
        if (!entry) return;
        try {
          const res = await this.handleWorkerClose({
            workerId: entry.workerId,
            disposition: "abandoned",
          });
          ctx.ui.notify(`Worker 已关闭 (${entry.workerId}): ${res.message}`, "info");
        } catch (err: unknown) {
          ctx.ui.notify(`关闭失败 (${entry.workerId}): ${(err as Error).message}`, "error");
        }
      },
    });

    this.pi.registerCommand("worker-forget", {
      description: "人工强制解除指定 Worker 占位 (用于异常断网排错)",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const entry = this.resolveCommandTarget(ctx, {
          action: "解除占位",
          workerId: this.parseCommandWorkerId(args),
          emptyMessage: "当前没有 Worker 占位",
          allowInactive: true,
        });
        if (!entry) return;

        // 非交互模式没有可靠的人工确认：绝不自动执行破坏性操作
        const ui = ctx.ui;
        if (!ui || typeof ui.confirm !== "function") {
          ctx.ui?.notify?.(
            `非交互模式无法确认，已取消解除占位 (${entry.workerId})`,
            "warning",
          );
          return;
        }

        const epoch = this.epoch;
        let confirmed = false;
        try {
          confirmed = await ui.confirm(
            `解除 Worker 占位警告 (${entry.workerId})`,
            `强制解除占位不会自动杀死可能仍存活的子进程，且只销毁该实例 (${entry.workerId}) 的资源，是否确认解除？`,
          );
        } catch {
          confirmed = false;
        }
        if (!confirmed) return;

        // 人工确认期间实例可能已被关闭/忘记，或会话已切换：必须重新核对后再动作
        if (this.isDisposed || this.epoch !== epoch || this.entries.get(entry.workerId) !== entry) {
          ui.notify(`Worker ${entry.workerId} 已在确认期间发生变化，已取消解除占位`, "warning");
          return;
        }

        // 同步置位：forget 排队期间到达的新 send/stop/close 必须立即被拒绝
        entry.forgetting = true;
        let outcome: "forgotten" | "cancelled" = "cancelled";
        try {
          outcome = await this.executeForget(entry);
        } finally {
          // 取消且实例仍在登记时解禁（成功时 entry 已移除，无需恢复）
          if (this.entries.get(entry.workerId) === entry) {
            entry.forgetting = false;
          }
        }
        if (outcome === "forgotten") {
          ui.notify(`已强制解除 Worker 占位 (${entry.workerId})`, "warning");
        } else {
          ui.notify(`Worker ${entry.workerId} 已在确认期间发生变化，已取消解除占位`, "warning");
        }
      },
    });
  }

  /**
   * 执行人工 forget：与目标实例的 mutating 队列协调。
   * - `enqueueMutation` 在执行前复核 disposed/epoch/entry，旧会话或已忘记实例不会进入内核；
   * - `releaseSlot(true)` 不发送 close/terminate，不杀进程；
   * - `dispose()` 销毁该实例的管道/连接/定时器并取消其全部 waiters；
   * - 会话已切换 / 登记已被替换 / 协调器已释放时返回 `cancelled`。
   */
  private async executeForget(entry: WorkerEntry): Promise<"forgotten" | "cancelled"> {
    const epoch = this.epoch;
    try {
      return await this.enqueueMutation(entry, async () => {
        entry.controller.handleWorkerForget();
        try {
          await entry.controller.dispose();
        } catch {
          // 单实例清理异常不阻断登记移除
        }
        // dispose 期间会话可能切换：只有仍在同一 epoch 且登记未变才移除
        if (this.epoch === epoch && this.entries.get(entry.workerId) === entry) {
          this.entries.delete(entry.workerId);
          return "forgotten" as const;
        }
        return "cancelled" as const;
      });
    } catch {
      return "cancelled";
    }
  }
}
