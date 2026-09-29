import { describe, it } from "node:test";
import * as assert from "node:assert";
import { EventEmitter } from "node:events";
import { SingleWorkerManager } from "../dist/lifecycle.js";
import { ControllerManager, resolveWorkerModelDefaults, resolveWorkerModelParams } from "../dist/controller.js";
import { FakePiAPI } from "./fake-pi.ts";
import { ProtocolErrorCode } from "../dist/protocol.js";

describe("Controller and Single Worker Mutex Tests", () => {
  it("单实例互斥锁：同一时间只允许一个 Worker 实例启动", () => {
    const manager = new SingleWorkerManager();

    // 第一个实例成功获取名额
    const inst1 = manager.acquireLaunchSlot(
      "ctrl-1",
      "worker-1",
      "task-1",
      process.cwd(),
      "Worker Tab",
    );
    assert.strictEqual(inst1.workerId, "worker-1");
    assert.strictEqual(manager.hasActiveInstance(), true);

    // 第二个实例尝试获取名额应被拒绝
    assert.throws(() => {
      manager.acquireLaunchSlot(
        "ctrl-2",
        "worker-2",
        "task-2",
        process.cwd(),
        "Worker Tab 2",
      );
    }, (err: Error) => err.message.includes(ProtocolErrorCode.ALREADY_EXISTS));

    // 未 closed 时不能非强制释放
    assert.strictEqual(manager.releaseSlot(false), false);

    // 标记为 closed 后成功释放
    manager.updateLifecycleState("closed");
    assert.strictEqual(manager.releaseSlot(false), true);
    assert.strictEqual(manager.hasActiveInstance(), false);

    // 释放后允许新实例获取名额
    const inst2 = manager.acquireLaunchSlot(
      "ctrl-3",
      "worker-3",
      "task-3",
      process.cwd(),
      "Worker Tab 3",
    );
    assert.strictEqual(inst2.workerId, "worker-3");
  });

  it("验收门槛检验：未交付、包含失败测试或有未解决问题时严格拒绝 accepted", async () => {
    const fakePi = new FakePiAPI();
    const ctrl = new ControllerManager(fakePi as any);

    // 预置一个 worker
    ctrl.workerManager.acquireLaunchSlot(
      "ctrl-1",
      "worker-1",
      "task-1",
      process.cwd(),
      "Title",
    );

    // 场景 1: taskState 还在 running，未处于 ready_for_review
    await assert.rejects(
      async () => {
        await ctrl.handleWorkerClose({
          workerId: "worker-1",
          disposition: "accepted",
        });
      },
      /尚未处于 ready_for_review 状态/,
    );

    // 场景 2: 状态改为 ready_for_review 但没有 committed report
    ctrl.workerManager.updateTaskState("ready_for_review");
    await assert.rejects(
      async () => {
        await ctrl.handleWorkerClose({
          workerId: "worker-1",
          disposition: "accepted",
        });
      },
      /未找到有效的 committed result 交付回执/,
    );

    // 场景 3: 注入包含未解决问题的报告
    (ctrl as any).currentCommittedReport = {
      kind: "result",
      summary: "部分完成",
      unresolved: ["模块B未实现"],
    };
    await assert.rejects(
      async () => {
        await ctrl.handleWorkerClose({
          workerId: "worker-1",
          disposition: "accepted",
        });
      },
      /仍有未解决问题/,
    );

    // 场景 4: 注入包含失败测试的报告
    (ctrl as any).currentCommittedReport = {
      kind: "result",
      summary: "测试挂了",
      validation: [
        { command: "npm test", outcome: "failed", note: "3 tests failed" },
      ],
    };
    await assert.rejects(
      async () => {
        await ctrl.handleWorkerClose({
          workerId: "worker-1",
          disposition: "accepted",
        });
      },
      /包含失败的测试/,
    );

    // 场景 5: 合法且测试通过的完整交付报告，成功验收并通过
    (ctrl as any).currentCommittedReport = {
      kind: "result",
      summary: "全部测试通过，代码已修改",
      changedFiles: ["src/index.ts"],
      validation: [
        { command: "npm test", outcome: "passed" },
      ],
      unresolved: [],
    };

    await assert.rejects(
      () => ctrl.handleWorkerClose({ workerId: "worker-1", disposition: "accepted" }),
      /稳定空闲/,
    );
    ctrl.workerManager.updateLifecycleState("connected");
    ctrl.workerManager.updateActivityState("idle");
    (ctrl as any).workerConn = {
      socket: { destroyed: false },
      nextSeq: 1,
      sendRequest: async () => ({ ok: true }),
    };

    // 模拟子进程退出反馈 (supervisor 发来 child_exit)
    setTimeout(() => {
      ctrl.workerManager.updateLifecycleState("closed");
    }, 50);

    const closeRes = await ctrl.handleWorkerClose({
      workerId: "worker-1",
      disposition: "accepted",
    });

    assert.strictEqual(closeRes.ok, true);
    assert.strictEqual(closeRes.disposition, "accepted");
    assert.strictEqual(ctrl.workerManager.hasActiveInstance(), false);
  });

  it("模型工具拒绝未经人工确认的强制关闭", async () => {
    const fakePi = new FakePiAPI();
    const ctrl = new ControllerManager(fakePi as any);
    ctrl.registerToolsAndCommands();
    const close = fakePi.tools.get("worker_close");
    assert.ok(close);
    await assert.rejects(
      () => close.execute("force-test", { workerId: "worker-1", disposition: "abandoned", force: true }),
      /模型工具不允许强制终止/,
    );
  });

  it("关闭 ACK 不等于进程退出，超时保留占位", async () => {
    const ctrl = new ControllerManager(new FakePiAPI() as any);
    ctrl.workerManager.acquireLaunchSlot("ctrl-1", "worker-1", "task-1", process.cwd(), "Title");
    (ctrl as any).workerConn = {
      socket: { destroyed: false },
      nextSeq: 1,
      sendRequest: async () => ({ ok: true }),
    };

    await assert.rejects(
      () => ctrl.handleWorkerClose({ workerId: "worker-1", disposition: "abandoned" }),
      /未确认 Worker 进程退出/,
    );
    assert.strictEqual(ctrl.workerManager.hasActiveInstance(), true);
    assert.strictEqual(ctrl.workerManager.getInstance()?.lifecycleState, "closing");
  });

  it("followup 送达未知时旧回执不可验收", async () => {
    const ctrl = new ControllerManager(new FakePiAPI() as any);
    ctrl.workerManager.acquireLaunchSlot("ctrl-1", "worker-1", "task-1", process.cwd(), "Title");
    ctrl.workerManager.updateLifecycleState("connected");
    ctrl.workerManager.updateTaskState("ready_for_review");
    ctrl.workerManager.updateActivityState("idle");
    (ctrl as any).currentCommittedReport = { kind: "result", summary: "old" };
    (ctrl as any).workerConn = {
      socket: { destroyed: false },
      nextSeq: 1,
      sendRequest: async () => { throw new Error("ACK timeout"); },
    };

    await assert.rejects(
      () => ctrl.handleWorkerSend({ workerId: "worker-1", taskId: "task-1", kind: "supplement", message: "more" }),
      /ACK timeout/,
    );
    assert.strictEqual((ctrl as any).currentCommittedReport, null);
    assert.strictEqual(ctrl.workerManager.getInstance()?.taskState, "running");
  });

  it("人工输入作废待验收回执", async () => {
    const ctrl = new ControllerManager(new FakePiAPI() as any);
    ctrl.workerManager.acquireLaunchSlot("ctrl-1", "worker-1", "task-1", process.cwd(), "Title");
    const conn = new EventEmitter() as EventEmitter & { socket: { destroyed: boolean }; destroy: () => void };
    conn.socket = { destroyed: true };
    conn.destroy = () => {};
    (ctrl as any).bindWorker(conn);
    (ctrl as any).currentCommittedReport = { kind: "result", summary: "done" };
    ctrl.workerManager.updateTaskState("ready_for_review");
    conn.emit("message", {
      controllerId: "ctrl-1",
      workerId: "worker-1",
      type: "local_input",
      payload: { taskId: "task-1" },
    });
    assert.strictEqual((ctrl as any).currentCommittedReport, null);
    assert.strictEqual(ctrl.workerManager.getInstance()?.taskState, "running");
    await ctrl.dispose();
  });

  it("超大任务在创建 Worker 前拒绝", async () => {
    const ctrl = new ControllerManager(new FakePiAPI() as any);
    await assert.rejects(
      () => ctrl.handleWorkerStart({
        cwd: process.cwd(),
        title: "oversized",
        task: "x".repeat(257 * 1024),
      }),
      /256 KiB/,
    );
    assert.strictEqual(ctrl.workerManager.hasActiveInstance(), false);
  });

  it("waitForWorkerReady 必须等待真实 worker_ready 而非仅连接，且标志每次启动重置", async () => {
    const ctrl = new ControllerManager(new FakePiAPI() as any);
    ctrl.workerManager.acquireLaunchSlot("ctrl-1", "worker-1", "task-1", process.cwd(), "Title");
    const conn = new EventEmitter() as EventEmitter & { socket: { destroyed: boolean }; destroy: () => void };
    conn.socket = { destroyed: false };
    conn.destroy = () => {};
    (ctrl as any).workerConn = conn;
    (ctrl as any).bindWorker(conn);

    // 只有连接没有 worker_ready → 超时拒绝
    await assert.rejects(
      () => (ctrl as any).waitForWorkerReady(250),
      /worker_ready/,
    );

    // 收到真实 worker_ready 后立即可通过，并记录模型信息
    conn.emit("message", {
      controllerId: "ctrl-1",
      workerId: "worker-1",
      type: "worker_ready",
      payload: {
        cwd: process.cwd(),
        provider: "local",
        modelId: "Qwen3.8-27B",
        thinkingLevel: "medium",
        tools: ["read"],
        version: "1",
      },
    });
    await (ctrl as any).waitForWorkerReady(250);
    let inst = ctrl.workerManager.getInstance();
    assert.strictEqual(inst.modelId, "Qwen3.8-27B");
    assert.strictEqual(inst.provider, "local");
    assert.strictEqual(inst.thinkingLevel, "medium");

    // 标志重置后，即使连接仍在也必须再次等待 worker_ready
    (ctrl as any).workerReadyReceived = false;
    await assert.rejects(
      () => (ctrl as any).waitForWorkerReady(250),
      /worker_ready/,
    );

    await ctrl.dispose();
  });

  it("model_changed 事件刷新主控端模型状态并进入收件箱", async () => {
    const ctrl = new ControllerManager(new FakePiAPI() as any);
    ctrl.workerManager.acquireLaunchSlot("ctrl-1", "worker-1", "task-1", process.cwd(), "Title");
    const conn = new EventEmitter() as EventEmitter & { socket: { destroyed: boolean }; destroy: () => void };
    conn.socket = { destroyed: false };
    conn.destroy = () => {};
    (ctrl as any).bindWorker(conn);

    conn.emit("message", {
      controllerId: "ctrl-1",
      workerId: "worker-1",
      type: "model_changed",
      payload: { provider: "local", modelId: "Other-Model", thinkingLevel: "high" },
    });

    const inst = ctrl.workerManager.getInstance();
    assert.strictEqual(inst.modelId, "Other-Model");
    assert.strictEqual(inst.provider, "local");
    assert.strictEqual(inst.thinkingLevel, "high");
    const last = (ctrl as any).inbox[(ctrl as any).inbox.length - 1];
    assert.strictEqual(last.type, "model_changed");
    assert.strictEqual((last.payload as any).modelId, "Other-Model");

    await ctrl.dispose();
  });

  it("worker_wait 不返回其他 Worker 或任务的旧事件", async () => {
    const fakePi = new FakePiAPI();
    const ctrl = new ControllerManager(fakePi as any);

    ctrl.workerManager.acquireLaunchSlot(
      "ctrl-1",
      "worker-current",
      "task-current",
      process.cwd(),
      "Title",
    );

    (ctrl as any).inbox.push({
      cursor: 1,
      eventId: "old-worker-event",
      timestamp: Date.now(),
      type: "report_committed",
      workerId: "worker-old",
      taskId: "task-old",
      payload: { summary: "old" },
    });
    (ctrl as any).cursorCounter = 1;

    const pending = ctrl.handleWorkerWait({
      workerId: "worker-current",
      afterCursor: 0,
      timeoutMs: 1000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    (ctrl as any).appendInbox("current_event", { note: "current" });

    const result = await pending;
    assert.strictEqual(result.event.type, "current_event");
  });
  it("worker_wait 与收件箱游标及分页查询", async () => {
    const fakePi = new FakePiAPI();
    const ctrl = new ControllerManager(fakePi as any);

    ctrl.workerManager.acquireLaunchSlot(
      "ctrl-1",
      "worker-1",
      "task-1",
      process.cwd(),
      "Title",
    );

    // 写入一条收件箱事件
    (ctrl as any).appendInbox("test_event", { note: "first event" });

    // 用 afterCursor: 0 等待，应立即返回现有事件
    const res1 = await ctrl.handleWorkerWait({
      workerId: "worker-1",
      afterCursor: 0,
      timeoutMs: 1000,
    });
    assert.strictEqual(res1.event.type, "test_event");
    assert.strictEqual(res1.event.cursor, 1);

    // 用 status 分页查询
    const statusRes = await ctrl.handleWorkerStatus({
      workerId: "worker-1",
      eventId: res1.event.eventId,
      offset: 0,
      limit: 10,
    });
    assert.ok(statusRes.eventDetail);
    assert.strictEqual(statusRes.eventDetail.eventId, res1.event.eventId);
    assert.ok(statusRes.eventDetail.content.length <= 10);
  });
});

describe("Worker (子代理) 默认模型配置", () => {
  it("未显式指定时默认 deepseek / deepseek-flash / high", () => {
    assert.deepStrictEqual(resolveWorkerModelDefaults({}), {
      provider: "deepseek",
      model: "deepseek-flash",
      thinkingLevel: "high",
    });
  });

  it("支持环境变量覆盖，且显式参数优先于默认值", () => {
    assert.deepStrictEqual(
      resolveWorkerModelDefaults({
        PI_TERMINAL_WORKER_DEFAULT_PROVIDER: "local",
        PI_TERMINAL_WORKER_DEFAULT_MODEL: "Qwen3.8-27B",
        PI_TERMINAL_WORKER_DEFAULT_THINKING: "low",
      }),
      { provider: "local", model: "Qwen3.8-27B", thinkingLevel: "low" },
    );

    // 显式参数覆盖默认配置
    assert.deepStrictEqual(
      resolveWorkerModelParams({ model: "other-model", thinkingLevel: "medium" }),
      { provider: "deepseek", model: "other-model", thinkingLevel: "medium" },
    );
    // 空白字符串视为未指定，回落到默认值
    assert.deepStrictEqual(resolveWorkerModelParams({ provider: "  ", model: "  " }), {
      provider: "deepseek",
      model: "deepseek-flash",
      thinkingLevel: "high",
    });
    // 显式值两侧空白会被裁剪
    assert.deepStrictEqual(
      resolveWorkerModelParams(
        { provider: " local ", model: " Qwen3.8-27B " },
        { provider: "deepseek", model: "deepseek-flash", thinkingLevel: "high" },
      ),
      { provider: "local", model: "Qwen3.8-27B", thinkingLevel: "high" },
    );
  });

  it("非法默认值或非法显式 thinkingLevel 必须报错，不静默回落", () => {
    assert.throws(
      () => resolveWorkerModelDefaults({ PI_TERMINAL_WORKER_DEFAULT_THINKING: "bogus" }),
      /无效的 Worker 默认 thinkingLevel/,
    );
    assert.throws(
      () => resolveWorkerModelParams({ thinkingLevel: "bogus" }),
      /无效的 thinkingLevel/,
    );
  });
});
