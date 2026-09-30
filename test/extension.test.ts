/**
 * 生产入口严格协议模式回归测试
 * 验证默认导出与工厂函数使用 STRICT_PROTOCOL=true 创建管理器；
 * 并覆盖阶段 C 的多 Worker 状态栏汇总与事件刷新接线。
 */

import { describe, it } from "node:test";
import * as assert from "node:assert";
import extensionDefault, {
  STRICT_PROTOCOL,
  createControllerManager,
  createWorkerManager,
  createMultiWorkerCoordinator,
  setupMultiWorkerControllerRole,
} from "../dist/extension.js";
import { WorkerStatusBarPoller, updateMultiWorkerUiStatus } from "../dist/ui.js";
import { FakePiAPI, FakePiContext } from "./fake-pi.ts";

describe("生产入口严格协议模式", () => {
  it("STRICT_PROTOCOL 固定为 true", () => {
    assert.strictEqual(STRICT_PROTOCOL, true);
  });

  it("createControllerManager / createWorkerManager 以严格模式创建管理器", async () => {
    const pi = new FakePiAPI();
    const controller = createControllerManager(pi as any);
    const worker = createWorkerManager(pi as any);

    assert.strictEqual((controller as any).strictProtocol, true, "Controller 必须开启严格协议");
    assert.strictEqual((worker as any).strictProtocol, true, "Worker 必须开启严格协议");

    await controller.dispose();
  });

  it("默认导出为扩展入口函数", () => {
    assert.strictEqual(typeof extensionDefault, "function");
  });

  it("createMultiWorkerCoordinator 以严格模式创建协调器", () => {
    const pi = new FakePiAPI();
    const coordinator = createMultiWorkerCoordinator(pi as any);
    assert.strictEqual((coordinator as any).strictProtocol, true, "协调器必须开启严格协议");
  });
});

describe("多 Worker 状态栏汇总", () => {
  function makeUi(): {
    ui: any;
    statuses: Map<string, string | undefined>;
  } {
    const statuses = new Map<string, string | undefined>();
    return {
      statuses,
      ui: {
        setStatus: (key: string, text: string | undefined) => {
          statuses.set(key, text);
        },
      },
    };
  }

  it("格式化 running/review/issue 计数，空实例清除状态", () => {
    const { ui, statuses } = makeUi();

    updateMultiWorkerUiStatus(ui, { total: 3, running: 2, review: 1, issue: 0 });
    assert.strictEqual(statuses.get("worker"), "Workers 3 | running 2 | review 1 | issue 0");

    updateMultiWorkerUiStatus(ui, { total: 1, running: 0, review: 0, issue: 1 });
    assert.strictEqual(statuses.get("worker"), "Workers 1 | running 0 | review 0 | issue 1");

    updateMultiWorkerUiStatus(ui, { total: 0, running: 0, review: 0, issue: 0 });
    assert.strictEqual(statuses.get("worker"), undefined, "0 实例必须清除状态栏");

    updateMultiWorkerUiStatus(ui, null);
    assert.strictEqual(statuses.get("worker"), undefined);
  });

  it("非交互模式（缺失 UI / 无 setStatus）安全降级", () => {
    assert.doesNotThrow(() =>
      updateMultiWorkerUiStatus(undefined, { total: 1, running: 1, review: 0, issue: 0 }),
    );
    assert.doesNotThrow(() =>
      updateMultiWorkerUiStatus({} as any, { total: 1, running: 1, review: 0, issue: 0 }),
    );
  });

  function makePollerUi(): { ui: any; statuses: Map<string, string | undefined> } {
    const statuses = new Map<string, string | undefined>();
    return {
      statuses,
      ui: {
        setStatus: (key: string, text: string | undefined) => {
          statuses.set(key, text);
        },
      },
    };
  }

  it("短周期轮询在无任何 pi 事件时刷新状态栏，stop 后清除定时器", async () => {
    const { ui, statuses } = makePollerUi();
    let summary = { total: 1, running: 1, review: 0, issue: 0 };
    let reads = 0;
    const poller = new WorkerStatusBarPoller(() => {
      reads += 1;
      return summary;
    }, 20);

    poller.start(ui);
    assert.strictEqual(poller.isRunning, true);
    assert.strictEqual(statuses.get("worker"), "Workers 1 | running 1 | review 0 | issue 0");

    // 仅改变底层状态，不触发任何 pi 事件：必须由轮询拾取
    summary = { total: 1, running: 0, review: 1, issue: 0 };
    await new Promise((r) => setTimeout(r, 70));
    assert.strictEqual(
      statuses.get("worker"),
      "Workers 1 | running 0 | review 1 | issue 0",
      "空闲期间必须由轮询刷新状态栏",
    );

    const readsAtStop = reads;
    poller.stop();
    assert.strictEqual(poller.isRunning, false, "stop 后 isRunning 必须为 false");
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(reads, readsAtStop, "stop 后不得继续轮询");
  });

  it("非交互模式的轮询不启动定时器且安全 no-op", () => {
    const summary = () => ({ total: 1, running: 1, review: 0, issue: 0 });
    const poller = new WorkerStatusBarPoller(summary, 20);

    assert.doesNotThrow(() => poller.start(undefined));
    assert.strictEqual(poller.isRunning, false, "无 UI 不得启动定时器");
    assert.doesNotThrow(() => poller.start({} as any));
    assert.strictEqual(poller.isRunning, false, "无 setStatus 不得启动定时器");
    assert.doesNotThrow(() => poller.refresh());
    poller.stop();
    assert.strictEqual(poller.isRunning, false);
  });

  it("扩展入口在会话活跃期间启动轮询，并在 session_shutdown 清理定时器", async () => {
    const previousRole = process.env.PI_TERMINAL_WORKER_ROLE;
    delete process.env.PI_TERMINAL_WORKER_ROLE;
    try {
      const pi = new FakePiAPI();
      const handle = setupMultiWorkerControllerRole(pi as any);
      assert.strictEqual(handle.statusPoller.isRunning, false, "未开始会话不得轮询");

      const ctxSession = new FakePiContext();
      await pi.emitPiEvent("session_start", {}, ctxSession);
      assert.strictEqual(handle.statusPoller.isRunning, true, "session_start 必须启动轮询");

      const ctxShutdown = new FakePiContext();
      await pi.emitPiEvent("session_shutdown", {}, ctxShutdown);
      assert.strictEqual(handle.statusPoller.isRunning, false, "session_shutdown 必须清理轮询定时器");
      assert.strictEqual(ctxShutdown.statuses.get("worker"), undefined, "会话关闭必须清除状态栏");
    } finally {
      if (previousRole === undefined) {
        delete process.env.PI_TERMINAL_WORKER_ROLE;
      } else {
        process.env.PI_TERMINAL_WORKER_ROLE = previousRole;
      }
    }
  });

  it("扩展入口在会话事件与 worker 工具结束时刷新状态栏", async () => {
    const previousRole = process.env.PI_TERMINAL_WORKER_ROLE;
    delete process.env.PI_TERMINAL_WORKER_ROLE;
    try {
      const pi = new FakePiAPI();
      extensionDefault(pi as any);

      // session_start：即使 0 实例也会刷新（清除过期文本）
      const ctxSession = new FakePiContext();
      await pi.emitPiEvent("session_start", {}, ctxSession);
      assert.ok(ctxSession.statuses.has("worker"), "session_start 必须刷新状态栏");

      // 非 worker 工具结束：不得触发刷新
      const ctxOther = new FakePiContext();
      await pi.emitPiEvent(
        "tool_execution_end",
        { type: "tool_execution_end", toolName: "bash", toolCallId: "1", result: null, isError: false },
        ctxOther,
      );
      assert.strictEqual(ctxOther.statuses.size, 0, "非 worker 工具不得刷新状态栏");

      // worker_* 工具结束：必须触发刷新
      const ctxWorker = new FakePiContext();
      await pi.emitPiEvent(
        "tool_execution_end",
        {
          type: "tool_execution_end",
          toolName: "worker_list",
          toolCallId: "2",
          result: null,
          isError: false,
        },
        ctxWorker,
      );
      assert.ok(ctxWorker.statuses.has("worker"), "worker_* 工具结束必须刷新状态栏");

      // turn_end / agent_settled：异步状态推进后刷新
      const ctxTurn = new FakePiContext();
      await pi.emitPiEvent("turn_end", {}, ctxTurn);
      assert.ok(ctxTurn.statuses.has("worker"), "turn_end 必须刷新状态栏");

      const ctxSettled = new FakePiContext();
      await pi.emitPiEvent("agent_settled", {}, ctxSettled);
      assert.ok(ctxSettled.statuses.has("worker"), "agent_settled 必须刷新状态栏");

      // session_shutdown：清除状态并释放资源
      const ctxShutdown = new FakePiContext();
      await pi.emitPiEvent("session_shutdown", {}, ctxShutdown);
      assert.strictEqual(ctxShutdown.statuses.get("worker"), undefined, "会话关闭必须清除状态栏");
    } finally {
      if (previousRole === undefined) {
        delete process.env.PI_TERMINAL_WORKER_ROLE;
      } else {
        process.env.PI_TERMINAL_WORKER_ROLE = previousRole;
      }
    }
  });

  it("session_start 清理失败也会启动轮询以展示异常汇总", async () => {
    const pi = new FakePiAPI();
    const handle = setupMultiWorkerControllerRole(pi as any);
    handle.coordinator.handleSessionStart = async () => {
      throw new Error("cleanup-fail");
    };

    const ctx = new FakePiContext();
    await assert.rejects(() => pi.emitPiEvent("session_start", {}, ctx), /cleanup-fail/);
    assert.strictEqual(
      handle.statusPoller.isRunning,
      true,
      "清理失败时 finally 仍必须启动轮询展示汇总",
    );
    assert.ok(ctx.statuses.has("worker"), "必须写入状态栏（0 实例时清除也算刷新）");

    const shutdownCtx = new FakePiContext();
    await pi.emitPiEvent("session_shutdown", {}, shutdownCtx);
    assert.strictEqual(handle.statusPoller.isRunning, false);
  });

  it("session_shutdown 后，晚到的 session_start 完成不得重启轮询", async () => {
    const pi = new FakePiAPI();
    const handle = setupMultiWorkerControllerRole(pi as any);

    let releaseSession!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    handle.coordinator.handleSessionStart = async () => {
      await gate;
    };

    const startCtx = new FakePiContext();
    const startP = pi.emitPiEvent("session_start", {}, startCtx);
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(handle.statusPoller.isRunning, false, "慢 session_start 尚未完成不启动轮询");

    const shutdownCtx = new FakePiContext();
    await pi.emitPiEvent("session_shutdown", {}, shutdownCtx);
    assert.strictEqual(handle.statusPoller.isRunning, false);

    releaseSession();
    await startP;
    assert.strictEqual(
      handle.statusPoller.isRunning,
      false,
      "旧 session_start 完成后不得重启轮询",
    );
  });
});
