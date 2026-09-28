/**
 * pi-terminal-worker 扩展统一入口
 * 根据环境变量 PI_TERMINAL_WORKER_ROLE 识别 controller 或 worker 角色并激活相应能力
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ControllerManager } from "./controller.js";
import { WorkerManager } from "./worker.js";
import { updateWorkerUiStatus } from "./ui.js";

export default function (pi: ExtensionAPI): void {
  const role = process.env.PI_TERMINAL_WORKER_ROLE;

  if (role === "worker") {
    // 作为受控端 Worker 启动
    const worker = new WorkerManager(pi);
    worker.init().catch((err) => {
      console.error("[pi-terminal-worker] Worker 初始化失败:", err);
    });
  } else {
    // 默认作为主控端 Controller 启动
    const controller = new ControllerManager(pi);
    controller.registerToolsAndCommands();

    // 监听 session_start，更新 UI 状态栏
    pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
      controller.sessionGen.nextGeneration();
      updateWorkerUiStatus(ctx.ui, controller.workerManager.getInstance());
    });

    // 监听 session_shutdown，释放主控端长连接与资源
    pi.on("session_shutdown", async (_event: any, ctx: ExtensionContext) => {
      updateWorkerUiStatus(ctx.ui, null);
      await controller.dispose();
    });
  }
}
