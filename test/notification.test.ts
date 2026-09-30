/**
 * 主动通知（pi.sendMessage）分支测试
 *
 * 覆盖：
 * - 关键事件写入后主动 sendMessage（triggerTurn + deliverAs: followUp），且含完整身份/游标与有界摘要；
 * - 普通过程性事件（activity/model_changed/report_candidate/启动成功等）静默不推送；
 * - 发送失败不破坏收件箱写入与事件可查（协议不被破坏，保留 worker_wait 兜底）；
 * - 旧会话（generation 已切换）的晚到事件绝不推送。
 */

import { describe, it } from "node:test";
import * as assert from "node:assert";
import { EventEmitter } from "node:events";
import {
  ControllerManager,
  ACTIONABLE_EVENT_TYPES,
  MAX_NOTIFICATION_SUMMARY_CHARS,
  WORKER_NOTIFICATION_CUSTOM_TYPE,
} from "../dist/controller.js";
import { FakePiAPI } from "./fake-pi.ts";

interface SentNotification {
  message: any;
  options: any;
}

/** 创建带 sendMessage 探针的控制器（已占位一个实例） */
function setupWithSpy(): {
  ctrl: ControllerManager;
  calls: SentNotification[];
} {
  const pi = new FakePiAPI();
  const calls: SentNotification[] = [];
  (pi as any).sendMessage = (message: any, options: any) => {
    calls.push({ message, options });
  };
  const ctrl = new ControllerManager(pi as any);
  ctrl.workerManager.acquireLaunchSlot("ctrl-1", "worker-1", "task-1", process.cwd(), "Title");
  return { ctrl, calls };
}

function makeConn(): EventEmitter & { socket: { destroyed: boolean }; destroy: () => void } {
  const conn = new EventEmitter() as EventEmitter & {
    socket: { destroyed: boolean };
    destroy: () => void;
  };
  conn.socket = { destroyed: false };
  conn.destroy = () => {};
  return conn;
}

describe("主动通知：关键事件推送", () => {
  it("关键事件写入后主动 sendMessage，含身份/游标与有界摘要，使用 followUp + triggerTurn", () => {
    const { ctrl, calls } = setupWithSpy();

    const event = (ctrl as any).appendInbox(
      "report_committed",
      { kind: "result", summary: "完成" },
      "task-1",
      1,
      1,
    );

    assert.strictEqual(calls.length, 1, "关键事件必须触发一次主动通知");
    const { message, options } = calls[0];
    assert.strictEqual(message.customType, WORKER_NOTIFICATION_CUSTOM_TYPE);
    assert.deepStrictEqual(options, { triggerTurn: true, deliverAs: "followUp" });

    const text = message.content[0].text as string;
    assert.match(text, /report_committed/);
    assert.match(text, /workerId=worker-1/);
    assert.match(text, /taskId=task-1/);
    assert.match(text, /revision=1/);
    assert.match(text, /runId=1/);
    assert.match(text, new RegExp(`cursor=${event.cursor}`));
    assert.match(text, new RegExp(`eventId=${event.eventId}`));
    assert.match(text, /worker_status/, "必须明确可用 worker_status 取详情");
    assert.match(text, /无需.*worker_wait|不必循环/, "必须明确无需轮询");

    // details 携带结构化身份，便于渲染/检索
    assert.strictEqual(message.details.eventId, event.eventId);
    assert.strictEqual(message.details.cursor, event.cursor);
    assert.strictEqual(message.details.workerId, "worker-1");

    ctrl.dispose();
  });

  it("白名单内的关键事件类型都会推送", () => {
    for (const type of ACTIONABLE_EVENT_TYPES) {
      const { ctrl, calls } = setupWithSpy();
      (ctrl as any).appendInbox(type, { note: type }, "task-1", 1, 1);
      assert.strictEqual(calls.length, 1, `关键事件 ${type} 必须推送`);
      ctrl.dispose();
    }
  });

  for (const disposition of ["accepted", "abandoned"] as const) {
    it(`主动 ${disposition} 正常关闭不推送，但保留收件箱与等待结果`, async () => {
      const { ctrl, calls } = setupWithSpy();
      const conn = makeConn();
      (ctrl as any).bindSupervisor(conn);
      ctrl.workerManager.updateLifecycleState("connected");
      ctrl.workerManager.updateActivityState("idle");
      ctrl.workerManager.updateTaskState("ready_for_review");
      (ctrl as any).currentCommittedReport = { kind: "result", summary: "done" };
      (ctrl as any).workerConn = {
        socket: { destroyed: false }, nextSeq: 1, sendRequest: async () => ({ ok: true }),
      };
      const waiting = ctrl.handleWorkerWait({ workerId: "worker-1", timeoutMs: 1000 });
      const closing = ctrl.handleWorkerClose({ workerId: "worker-1", disposition });
      conn.emit("message", {
        controllerId: "ctrl-1", workerId: "worker-1", type: "child_exit",
        payload: { pid: 123, code: 0, signal: null },
      });
      const event = (await waiting).event;
      assert.strictEqual(event.type, "child_exit");
      assert.ok(ctrl.getInboxEvent(event.eventId), "静默仅影响推送，不影响入箱");
      assert.strictEqual(calls.length, 0, "主动关闭结果由工具返回，不额外唤醒");
      assert.strictEqual((await closing).ok, true);
      await ctrl.dispose();
    });
  }

  for (const scenario of [
    { name: "非主动零码退出", closing: false, code: 0, signal: null },
    { name: "关闭期间非零退出", closing: true, code: 1, signal: null },
    { name: "关闭期间信号退出", closing: true, code: null, signal: "SIGTERM" },
    { name: "关闭超时后的正常退出", closing: true, code: 0, signal: null, timeout: true },
  ]) {
    it(`${scenario.name}仍主动通知`, async () => {
      const { ctrl, calls } = setupWithSpy();
      const conn = makeConn();
      (ctrl as any).bindSupervisor(conn);
      let closing: Promise<unknown> | undefined;
      if (scenario.closing) {
        if (scenario.timeout) ctrl.closeWaitTimeoutMs = 0;
        closing = ctrl.handleWorkerClose({ workerId: "worker-1", disposition: "abandoned" });
        if (scenario.timeout) await assert.rejects(closing, /未确认/);
      }
      conn.emit("message", {
        controllerId: "ctrl-1", workerId: "worker-1", type: "child_exit",
        payload: { pid: 123, code: scenario.code, signal: scenario.signal },
      });
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].message.details.type, "child_exit");
      if (closing && !scenario.timeout) await closing;
      await ctrl.dispose();
    });
  }

  it("超大摘要被截断为有界文本", () => {
    const { ctrl, calls } = setupWithSpy();
    (ctrl as any).appendInbox(
      "report_committed",
      { summary: "x".repeat(100_000) },
      "task-1",
      1,
      1,
    );
    assert.strictEqual(calls.length, 1);
    const text = calls[0].message.content[0].text as string;
    assert.match(text, /已截断/);
    assert.ok(
      text.length < MAX_NOTIFICATION_SUMMARY_CHARS + 1000,
      `通知正文必须是有界的，实际 ${text.length}`,
    );
    ctrl.dispose();
  });

  it("普通过程性事件静默不推送，也不产生通知", () => {
    const nonCritical = [
      "activity",
      "model_changed",
      "report_candidate",
      "task_accepted",
      "followup_accepted",
      "local_input",
      "worker_ready",
      "child_spawned",
    ];
    const { ctrl, calls } = setupWithSpy();
    for (const type of nonCritical) {
      (ctrl as any).appendInbox(type, { note: type }, "task-1", 1, 1);
    }
    assert.strictEqual(calls.length, 0, "普通事件绝不能触发主动通知");
    ctrl.dispose();
  });

  it("sendMessage 抛错不影响收件箱写入与事件可查（保留 wait 兜底）", () => {
    const pi = new FakePiAPI();
    (pi as any).sendMessage = () => {
      throw new Error("boom");
    };
    const ctrl = new ControllerManager(pi as any);
    ctrl.workerManager.acquireLaunchSlot("ctrl-1", "worker-1", "task-1", process.cwd(), "T");

    const event = (ctrl as any).appendInbox(
      "report_committed",
      { summary: "ok" },
      "task-1",
      1,
      1,
    );
    // 入箱不受通知失败影响
    assert.strictEqual(ctrl.getInboxEvent(event.eventId)?.eventId, event.eventId);
    assert.strictEqual(ctrl.getInboxStats().count, 1);
    ctrl.dispose();
  });

  it("旧会话（generation 已切换）晚到事件绝不推送", async () => {
    const pi = new FakePiAPI();
    const calls: SentNotification[] = [];
    (pi as any).sendMessage = (message: any, options: any) => calls.push({ message, options });
    const ctrl = new ControllerManager(pi as any);
    ctrl.workerManager.acquireLaunchSlot("ctrl-1", "worker-1", "task-1", process.cwd(), "T");
    const conn = makeConn();
    (ctrl as any).bindWorker(conn);

    const commitFrame = {
      controllerId: "ctrl-1",
      workerId: "worker-1",
      type: "report_committed",
      payload: {
        taskId: "task-1",
        revision: 1,
        runId: 1,
        report: { kind: "result", summary: "new" },
      },
    };

    conn.emit("message", commitFrame);
    assert.strictEqual(calls.length, 1, "新会话中的关键事件必须推送");

    await ctrl.handleSessionStart();
    const before = calls.length;
    // 旧 generation 的监听器必须忽略该消息，绝不推送
    conn.emit("message", commitFrame);
    assert.strictEqual(calls.length, before, "旧会话晚到事件不得推送");
    assert.ok((ctrl as any).staleCallbacksIgnored >= 1);

    await ctrl.dispose();
  });
});
