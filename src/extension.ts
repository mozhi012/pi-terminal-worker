/**
 * pi-terminal-worker 扩展统一入口
 * 根据环境变量 PI_TERMINAL_WORKER_ROLE 激活 controller / worker / lead 能力
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ControllerManager } from "./controller.js";
import { MultiWorkerCoordinator } from "./multi-worker.js";
import { WorkerManager, type WorkerManagerOptions } from "./worker.js";
import { WorkerStatusBarPoller, updateMultiWorkerUiStatus } from "./ui.js";

// 生产入口固定开启严格协议校验 (入站 seq 严格递增 + Worker 任务身份校验)
export const STRICT_PROTOCOL = true;

export function createControllerManager(pi: ExtensionAPI): ControllerManager {
  return new ControllerManager(pi, STRICT_PROTOCOL);
}

export function createWorkerManager(pi: ExtensionAPI, options: WorkerManagerOptions = {}): WorkerManager {
  return new WorkerManager(pi, STRICT_PROTOCOL, options);
}

/**
 * 创建主控端多 Worker 协调器。
 * 协调器为每次 worker_start 创建独立 ControllerManager，并只注册一次工具与命令。
 */
export function createMultiWorkerCoordinator(pi: ExtensionAPI): MultiWorkerCoordinator {
  return new MultiWorkerCoordinator(pi, { strictProtocol: STRICT_PROTOCOL });
}

export default function (pi: ExtensionAPI): void {
  const role = process.env.PI_TERMINAL_WORKER_ROLE;

  if (role === "lead") {
    setupLeadRole(pi);
  } else if (role === "worker") {
    // 作为受控端 Worker 启动
    const worker = createWorkerManager(pi);
    worker.init().catch((err) => {
      console.error("[pi-terminal-worker] Worker 初始化失败:", err);
    });
  } else if (role === undefined) {
    setupMultiWorkerControllerRole(pi);
  } else {
    throw new Error(`非法 PI_TERMINAL_WORKER_ROLE: ${role}`);
  }
}

/** lead 同时保留上行回执与下行协调能力，所有工具先注册再过滤 active tools。 */
export function setupLeadRole(pi: ExtensionAPI): ControllerRoleHandle & { worker: WorkerManager; ready: Promise<void> } {
  let coordinator: MultiWorkerCoordinator;
  const worker = createWorkerManager(pi, {
    role: "lead",
    getActiveChildCount: () => coordinator.getActiveChildCount(),
  });
  // init 在首个 await 前注册上行钩子：session_start/shutdown 先作废旧上行回调，
  // 再等待下级异步清理。active tools 的过滤发生在所有工具注册完毕后的 session_start。
  const ready = worker.init();
  const handle = setupMultiWorkerControllerRole(pi);
  coordinator = handle.coordinator;
  ready.catch((err) => console.error("[pi-terminal-worker] Lead 初始化失败:", err));
  return { ...handle, worker, ready };
}

/** 主控端角色的可测试装配句柄 (生产入口不直接使用，仅供内部/测试注入) */
export interface ControllerRoleHandle {
  coordinator: MultiWorkerCoordinator;
  statusPoller: WorkerStatusBarPoller;
}

/**
 * 装配主控端角色：创建协调器、只注册一次工具与命令，并接线会话事件与状态栏刷新。
 *
 * 状态栏只在会话活跃期间持有 ctx：`session_start` 启动短周期轮询，
 * `session_shutdown` 清理 timer 并释放全部实例资源。
 */
export function setupMultiWorkerControllerRole(pi: ExtensionAPI): ControllerRoleHandle {
  // 协调器负责多 Worker 注册表与路由
  const coordinator = createMultiWorkerCoordinator(pi);
  coordinator.registerToolsAndCommands();

  // 状态栏只展示多实例汇总计数，非交互模式安全降级为 no-op。
  // 异步 socket 事件（报告/断连）可能在主 Pi 空闲时推进状态：除事件刷新外，
  // 会话活跃期间用短周期轮询兜底，timer 在 session_shutdown 清理并 unref。
  const statusPoller = new WorkerStatusBarPoller(() => coordinator.getSummary());

  // 会话代际：用于阻止在途 session_start 在 session_shutdown 之后重启轮询
  let sessionEpoch = 0;

  // 会话切换：先逐实例清理（一个失败不跳过其他），再按新登记刷新状态栏
  pi.on("session_start", async (_event, ctx) => {
    const myEpoch = ++sessionEpoch;
    try {
      await coordinator.handleSessionStart();
    } finally {
      // 即使某个实例清理失败（AggregateError），也要展示汇总（issue 计数体现异常）
      if (sessionEpoch === myEpoch) {
        statusPoller.start(ctx.ui);
      }
    }
  });

  // 会话关闭：先使在途 session_start 失效，停止轮询、清除状态栏并释放实例资源
  pi.on("session_shutdown", async (_event, ctx) => {
    sessionEpoch += 1;
    statusPoller.stop();
    updateMultiWorkerUiStatus(ctx.ui, null);
    await coordinator.dispose();
  });

  // 实际状态变化时立即刷新状态栏：
  // - worker_* 工具执行结束（wait/status/start/close 等会推进实例状态）
  // - 每轮 / 每次 agent 收敛后（异步 socket 事件推进状态后）
  pi.on("tool_execution_end", (event, ctx) => {
    if (event.toolName.startsWith("worker_")) {
      statusPoller.refresh(ctx.ui);
    }
  });
  pi.on("turn_end", (_event, ctx) => {
    statusPoller.refresh(ctx.ui);
  });
  pi.on("agent_settled", (_event, ctx) => {
    statusPoller.refresh(ctx.ui);
  });

  return { coordinator, statusPoller };
}
