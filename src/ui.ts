/**
 * 原生 UI 集成：状态栏、小部件与通知
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { WorkerInstanceMetadata } from "./lifecycle.js";

/**
 * 刷新状态栏中的 Worker 状态
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
