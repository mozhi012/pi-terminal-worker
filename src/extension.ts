/**
 * pi-terminal-worker 扩展统一入口
 * 根据环境变量 PI_TERMINAL_WORKER_ROLE 识别 controller 或 worker 角色并激活相应能力
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ControllerManager } from "./controller.js";
import { WorkerManager } from "./worker.js";
import { updateWorkerUiStatus } from "./ui.js";

// 生产入口固定开启严格协议校验 (入站 seq 严格递增 + Worker 任务身份校验)
export const STRICT_PROTOCOL = true;

export function createControllerManager(pi: ExtensionAPI): ControllerManager {
  return new ControllerManager(pi, STRICT_PROTOCOL);
}

export function createWorkerManager(pi: ExtensionAPI): WorkerManager {
  return new WorkerManager(pi, STRICT_PROTOCOL);
}

export default function (pi: ExtensionAPI): void {
  const role = process.env.PI_TERMINAL_WORKER_ROLE;

  if (role === "worker") {
    // 作为受控端 Worker 启动
    const worker = createWorkerManager(pi);
    worker.init().catch((err) => {
      console.error("[pi-terminal-worker] Worker 初始化失败:", err);
    });
  } else {
    // 默认作为主控端 Controller 启动
    const controller = createControllerManager(pi);
    controller.registerToolsAndCommands();

    // 监听 session_start，结束上一会话资源并递增 generation，然后更新 UI 状态栏
    pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
      await controller.handleSessionStart();
      updateWorkerUiStatus(ctx.ui, controller.workerManager.getInstance());
    });

    // 监听 session_shutdown，释放主控端长连接与资源
    pi.on("session_shutdown", async (_event: any, ctx: ExtensionContext) => {
      updateWorkerUiStatus(ctx.ui, null);
      await controller.dispose();
    });
  }
}
