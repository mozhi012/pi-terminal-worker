/**
 * 原生 UI 集成：状态栏、小部件与通知
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { WorkerInstanceMetadata } from "./lifecycle.js";

/**
 * 多 Worker 状态栏汇总计数。
 * running/review/issue 三分类之和应等于 total（见 MultiWorkerCoordinator.getSummary）。
 */
export interface WorkerSummaryCounts {
  total: number;
  running: number;
  review: number;
  issue: number;
}

/**
 * 刷新状态栏中的单实例 Worker 状态（保留旧语义，供底层控制器/历史调用使用）
 */
export function updateWorkerUiStatus(
  ui: ExtensionUIContext | undefined,
  instance: WorkerInstanceMetadata | null,
): void {
  if (!ui) return;

  if (!instance || instance.lifecycleState === "none" || instance.lifecycleState === "closed") {
    ui.setStatus("worker", undefined);
    return;
  }

  const modelShort = instance.modelId ? ` (${instance.modelId})` : "";
  const statusStr = `[Worker: ${instance.taskState} | rev ${instance.revision}${modelShort}]`;
  ui.setStatus("worker", statusStr);
}

/**
 * 刷新状态栏中的多 Worker 汇总（只展示计数，不展示单实例明细）。
 *
 * - 无实例时清除状态栏，避免残留过期文本。
 * - 非交互模式（ctx.ui 缺失或 setStatus 不可用）安全降级为 no-op。
 */
export function updateMultiWorkerUiStatus(
  ui: ExtensionUIContext | undefined,
  summary: WorkerSummaryCounts | null,
): void {
  if (!ui || typeof ui.setStatus !== "function") return;

  if (!summary || summary.total <= 0) {
    ui.setStatus("worker", undefined);
    return;
  }

  ui.setStatus(
    "worker",
    `Workers ${summary.total} | running ${summary.running} | review ${summary.review} | issue ${summary.issue}`,
  );
}

/**
 * 空闲状态栏轮询默认间隔。
 *
 * 异步 socket 事件（report_committed、断连、退出）推进实例状态时，主 Pi 可能完全空闲，
 * 既没有工具调用也没有 turn/agent 事件；仅靠事件刷新会让状态栏停留在旧值。
 * 用短周期轮询覆盖这段空窗，只在会话活跃期间持有 ctx。
 */
export const WORKER_STATUS_POLL_INTERVAL_MS = 1000;

/**
 * 会话级状态栏轮询器。
 *
 * 生命周期由扩展入口显式管理：
 * - `start(ui)` 在 `session_start` 调用，立即刷新一次并启动短周期定时器；
 * - `stop()` 在 `session_shutdown` 调用，清除定时器并释放 ctx 引用；
 * - 定时器 `unref()`，不阻止进程正常退出；
 * - 非交互模式（ui 缺失或 setStatus 不可用）不启动定时器，安全降级为 no-op。
 */
export class WorkerStatusBarPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ui: ExtensionUIContext | undefined;

  constructor(
    private readonly readSummary: () => WorkerSummaryCounts,
    private readonly intervalMs: number = WORKER_STATUS_POLL_INTERVAL_MS,
  ) {}

  /** 会话是否仍在轮询状态栏（诊断/测试用） */
  public get isRunning(): boolean {
    return this.timer !== null;
  }

  /** 会话开始：持有 ctx 并在整个会话期间短周期刷新 */
  public start(ui: ExtensionUIContext | undefined): void {
    this.stop();
    if (!ui || typeof ui.setStatus !== "function") return;
    this.ui = ui;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.intervalMs);
    const timer = this.timer as unknown as { unref?: () => void };
    if (typeof timer.unref === "function") timer.unref();
  }

  /** 立即刷新；传入事件 ctx.ui 时更新持有的 UI 引用（同一会话内 ctx 可能变化） */
  public refresh(ui?: ExtensionUIContext): void {
    if (ui) this.ui = ui;
    if (!this.ui) return;
    updateMultiWorkerUiStatus(this.ui, this.readSummary());
  }

  /** 会话结束 / 卸载：清除定时器，释放 ctx 并停止轮询 */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.ui = undefined;
  }
}

/**
 * 显示工作者相关的通知
 */
export function notifyWorker(
  ui: ExtensionUIContext | undefined,
  message: string,
  type: "info" | "warning" | "error" = "info",
): void {
  if (!ui) return;
  ui.notify(message, type);
}
