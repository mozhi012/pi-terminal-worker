import { describe, it } from "node:test";
import * as assert from "node:assert";
import { SingleWorkerManager } from "../dist/lifecycle.js";
import { ControllerManager } from "../dist/controller.js";
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
