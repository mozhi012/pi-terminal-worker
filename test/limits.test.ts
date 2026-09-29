import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as net from "node:net";
import * as crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { ControllerManager, InboxCapacityError, ReportCacheFullError } from "../dist/controller.js";
import { WorkerManager } from "../dist/worker.js";
import {
  MAX_INBOX_EVENTS,
  MAX_INBOX_BYTES,
  MAX_REPORT_CACHE_SIZE,
  MAX_REPORT_CACHE_BYTES,
  MAX_FOLLOWUP_QUEUE_BYTES,
  MAX_FOLLOWUP_QUEUE_SIZE,
  ProtocolErrorCode,
  jsonByteLength,
} from "../dist/protocol.js";
import { getPipePath } from "../dist/transport.js";
import { FakePiAPI, FakePiContext } from "./fake-pi.ts";
import type { Envelope } from "../dist/protocol.js";

/**
 * 构造假 Worker 连接：EventEmitter + socket 占位 + sendEnvelope 捕获 spy
 */
function makeFakeConn() {
  const sent: any[] = [];
  const conn = new EventEmitter() as EventEmitter & {
    socket: { destroyed: boolean };
    destroy: () => void;
    nextSeq: number;
    sendEnvelope: (env: any) => Promise<void>;
  };
  conn.socket = { destroyed: false };
  conn.destroy = () => {};
  conn.nextSeq = 1;
  conn.sendEnvelope = (env: any) => {
    sent.push(env);
    return Promise.resolve();
  };
  return { conn, sent };
}

async function waitFor(cond: () => unknown, timeoutMs = 1500): Promise<unknown> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = cond();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("等待条件超时");
}

describe("收件箱双重边界与关键事件语义", () => {
  it("inbox 条数上限：200 个可淘汰事件不抛异常，关键事件不被静默淘汰", () => {
    const ctrl = new ControllerManager(new FakePiAPI() as any);
    const append = (ctrl as any).appendInbox.bind(ctrl);

    // 连续追加 200 个可淘汰事件 (activity)
    for (let i = 0; i < 200; i++) {
      append("activity", { n: i });
    }
    const stats = ctrl.getInboxStats();
    assert.ok(stats.count <= MAX_INBOX_EVENTS, `条数不得超过上限: ${stats.count}`);
    assert.strictEqual(stats.count, MAX_INBOX_EVENTS);
    assert.strictEqual(stats.bytes < MAX_INBOX_BYTES, true);

    // 关键事件必须能挤掉最旧可淘汰事件并成功入箱，不得被静默丢弃
    const keyEvent = append("report_committed", { summary: "关键事件" });
    assert.ok(ctrl.getInboxEvent(keyEvent.eventId), "关键事件必须可在收件箱中查到");

    ctrl.dispose();
  });

  it("inbox 字节上限精确边界：恰好等于上限允许，再多 1 字节的关键事件抛 bytes 维度错误", () => {
    const ctrl = new ControllerManager(new FakePiAPI() as any);
    const append = (ctrl as any).appendInbox.bind(ctrl);

    // 用 jsonByteLength 校准 payload，使单条事件字节恰好等于上限
    const baseLen = jsonByteLength({ data: "" });
    const fullPayload = { data: "x".repeat(MAX_INBOX_BYTES - baseLen) };
    assert.strictEqual(jsonByteLength(fullPayload), MAX_INBOX_BYTES);

    append("report_committed", fullPayload);
    let stats = ctrl.getInboxStats();
    assert.strictEqual(stats.count, 1);
    assert.strictEqual(stats.bytes, MAX_INBOX_BYTES, "恰好等于字节上限时必须允许写入");

    // 再多 1 字节的关键事件 → 必须抛 InboxCapacityError(bytes)，且数量/字节保持不变
    assert.throws(
      () => append("report_committed", { a: 1 }),
      (err: unknown) =>
        err instanceof InboxCapacityError && err.limitType === "bytes",
    );
    stats = ctrl.getInboxStats();
    assert.strictEqual(stats.count, 1);
    assert.strictEqual(stats.bytes, MAX_INBOX_BYTES);

    ctrl.dispose();
  });

  it("inbox 条数上限精确边界：恰好 128 条关键事件允许，第 129 条抛 events 维度错误，可淘汰事件静默丢弃", () => {
    const ctrl = new ControllerManager(new FakePiAPI() as any);
    const append = (ctrl as any).appendInbox.bind(ctrl);

    for (let i = 0; i < MAX_INBOX_EVENTS; i++) {
      append("report_committed", { n: i });
    }
    let stats = ctrl.getInboxStats();
    assert.strictEqual(stats.count, MAX_INBOX_EVENTS, "恰好等于条数上限时必须允许");

    assert.throws(
      () => append("report_committed", { n: -1 }),
      (err: unknown) =>
        err instanceof InboxCapacityError && err.limitType === "events",
    );

    // 可淘汰事件静默丢弃：不抛、计数 +1、条数不变
    append("activity", { n: 0 });
    stats = ctrl.getInboxStats();
    assert.strictEqual(stats.dropped, 1);
    assert.strictEqual(stats.count, MAX_INBOX_EVENTS);

    ctrl.dispose();
  });

  it("可淘汰事件为关键事件腾空间：最旧 activity 被淘汰，关键事件成功入箱", () => {
    const ctrl = new ControllerManager(new FakePiAPI() as any);
    const append = (ctrl as any).appendInbox.bind(ctrl);

    for (let i = 0; i < MAX_INBOX_EVENTS; i++) {
      append("activity", { n: i });
    }
    const first = ctrl.getInboxEvent((ctrl as any).inbox[0].eventId);
    assert.ok(first, "前置：应能查到最旧 activity");

    const keyEvent = append("report_committed", { summary: "关键" });
    const stats = ctrl.getInboxStats();
    assert.strictEqual(stats.count, MAX_INBOX_EVENTS);
    assert.ok(ctrl.getInboxEvent(keyEvent.eventId), "关键事件必须可查到");
    assert.strictEqual(ctrl.getInboxEvent(first.eventId), undefined, "最旧 activity 必须已被淘汰");

    ctrl.dispose();
  });

  it("连接路径显式拒绝：inbox 条数满时 report_committed 回发 INBOX_FULL error 且不崩溃", () => {
    const ctrl = new ControllerManager(new FakePiAPI() as any);
    ctrl.workerManager.acquireLaunchSlot("ctrl-1", "worker-1", "task-1", process.cwd(), "T");
    const append = (ctrl as any).appendInbox.bind(ctrl);
    for (let i = 0; i < MAX_INBOX_EVENTS; i++) {
      append("report_committed", { n: i });
    }

    const { conn, sent } = makeFakeConn();
    (ctrl as any).bindWorker(conn);
    conn.emit("message", {
      controllerId: "ctrl-1",
      workerId: "worker-1",
      id: "rc-inbox-full",
      seq: 1,
      type: "report_committed",
      payload: { taskId: "task-1", revision: 1, runId: 1, report: { kind: "result", summary: "x" } },
    });

    const errEnv = sent.find((e) => e.type === "error" && e.payload.code === ProtocolErrorCode.INBOX_FULL);
    assert.ok(errEnv, "必须回发 INBOX_FULL error envelope");
    assert.strictEqual(errEnv.replyTo, "rc-inbox-full");
    assert.ok(ctrl.getInboxStats().rejected >= 1, "inboxRejectedEvents 必须累计");

    ctrl.dispose();
  });
});

describe("关键报告缓存边界", () => {
  it("报告缓存条数上限：第 129 条 candidate 收到 REPORT_CACHE_FULL，count 保持 128", () => {
    const ctrl = new ControllerManager(new FakePiAPI() as any);
    ctrl.workerManager.acquireLaunchSlot("ctrl-1", "worker-1", "task-1", process.cwd(), "T");
    const { conn, sent } = makeFakeConn();
    (ctrl as any).bindWorker(conn);

    const emitCandidate = (i: number) =>
      conn.emit("message", {
        controllerId: "ctrl-1",
        workerId: "worker-1",
        id: `rc-${i}`,
        seq: i + 1,
        type: "report_candidate",
        payload: {
          taskId: "task-1",
          revision: 1,
          runId: 1,
          report: { kind: "progress", summary: "x" },
        },
      });

    for (let i = 0; i < MAX_REPORT_CACHE_SIZE; i++) {
      emitCandidate(i);
    }
    let stats = ctrl.getReportCacheStats();
    assert.strictEqual(stats.count, MAX_REPORT_CACHE_SIZE);

    emitCandidate(MAX_REPORT_CACHE_SIZE);
    stats = ctrl.getReportCacheStats();
    const errEnv = sent.find(
      (e) => e.type === "error" && e.payload.code === ProtocolErrorCode.REPORT_CACHE_FULL,
    );
    assert.ok(errEnv, "第 129 条必须收到 REPORT_CACHE_FULL error");
    assert.strictEqual(stats.count, MAX_REPORT_CACHE_SIZE, "缓存条数不得增长");
    assert.ok(stats.rejected >= 1, "rejected 计数必须累计");

    ctrl.dispose();
  });

  it("报告缓存字节上限：8 条 1 MiB 报告后 bytes 恰好达上限，第 9 条小报告也拒绝 (count 远小于 128)", () => {
    const ctrl = new ControllerManager(new FakePiAPI() as any);
    ctrl.workerManager.acquireLaunchSlot("ctrl-1", "worker-1", "task-1", process.cwd(), "T");
    const { conn, sent } = makeFakeConn();
    (ctrl as any).bindWorker(conn);

    // 用 jsonByteLength 校准 summary，使每条 report 恰好 1 MiB
    const base = jsonByteLength({ kind: "progress", summary: "" });
    const pad = "x".repeat(MAX_REPORT_CACHE_BYTES / 8 - base);
    const bigReport = { kind: "progress", summary: pad };
    assert.strictEqual(jsonByteLength(bigReport), MAX_REPORT_CACHE_BYTES / 8);

    for (let i = 0; i < 8; i++) {
      conn.emit("message", {
        controllerId: "ctrl-1",
        workerId: "worker-1",
        id: `rcc-${i}`,
        seq: i + 1,
        type: "report_candidate",
        payload: { taskId: "task-1", revision: 1, runId: 1, report: bigReport },
      });
    }
    let stats = ctrl.getReportCacheStats();
    assert.strictEqual(stats.bytes, MAX_REPORT_CACHE_BYTES, "8 条后字节数恰好达到上限");
    assert.strictEqual(stats.count, 8);

    // 第 9 条小报告 → 字节上限独立生效
    conn.emit("message", {
      controllerId: "ctrl-1",
      workerId: "worker-1",
      id: "rcc-8",
      seq: 9,
      type: "report_candidate",
      payload: { taskId: "task-1", revision: 1, runId: 1, report: { kind: "progress", summary: "x" } },
    });
    stats = ctrl.getReportCacheStats();
    const errEnv = sent.find(
      (e) => e.type === "error" && e.payload.code === ProtocolErrorCode.REPORT_CACHE_FULL,
    );
    assert.ok(errEnv, "第 9 条必须收到 REPORT_CACHE_FULL error");
    assert.strictEqual(stats.count, 8);
    assert.ok(stats.count < MAX_REPORT_CACHE_SIZE, "证明字节上限独立于条数上限生效");

    ctrl.dispose();
  });

  it("缓存满时 report_committed 不得推进任务状态", () => {
    const ctrl = new ControllerManager(new FakePiAPI() as any);
    ctrl.workerManager.acquireLaunchSlot("ctrl-1", "worker-1", "task-1", process.cwd(), "T");
    const { conn, sent } = makeFakeConn();
    (ctrl as any).bindWorker(conn);

    // 先用 candidate 填满缓存
    for (let i = 0; i < MAX_REPORT_CACHE_SIZE; i++) {
      conn.emit("message", {
        controllerId: "ctrl-1",
        workerId: "worker-1",
        id: `rcfill-${i}`,
        seq: i + 1,
        type: "report_candidate",
        payload: {
          taskId: "task-1",
          revision: 1,
          runId: 1,
          report: { kind: "progress", summary: "x" },
        },
      });
    }

    // 注入合法小 result 报告
    conn.emit("message", {
      controllerId: "ctrl-1",
      workerId: "worker-1",
      id: "rc-commit-full",
      seq: MAX_REPORT_CACHE_SIZE + 1,
      type: "report_committed",
      payload: { taskId: "task-1", revision: 1, runId: 1, report: { kind: "result", summary: "x" } },
    });

    const errEnv = sent.find(
      (e) => e.type === "error" && e.payload.code === ProtocolErrorCode.REPORT_CACHE_FULL,
    );
    assert.ok(errEnv, "必须收到 REPORT_CACHE_FULL error");
    assert.notStrictEqual(
      ctrl.workerManager.getInstance()?.taskState,
      "ready_for_review",
      "任务状态不得推进到 ready_for_review",
    );
    assert.strictEqual((ctrl as any).currentCommittedReport, null, "committed 回执必须保持未设置");
    assert.deepStrictEqual(
      (ctrl as any).currentCandidateReport,
      { kind: "progress", summary: "x" },
      "candidate 状态必须保持被拒前原状，不得被清空或覆盖",
    );

    ctrl.dispose();
  });
});

describe("诊断输出与状态清理", () => {
  it("worker_wait 超时返回诊断计数 (droppedInboxEvents / inboxRejectedEvents / reportCacheRejected)", async () => {
    const ctrl = new ControllerManager(new FakePiAPI() as any);
    const append = (ctrl as any).appendInbox.bind(ctrl);

    // 先于实例占位填充收件箱 (workerId 为 ""，不会匹配后续 worker_wait)
    for (let i = 0; i < MAX_INBOX_EVENTS; i++) {
      append("report_committed", { n: i });
    }
    append("activity", { n: 0 }); // → dropped = 1

    ctrl.workerManager.acquireLaunchSlot("ctrl-1", "worker-1", "task-1", process.cwd(), "T");
    const { conn } = makeFakeConn();
    (ctrl as any).bindWorker(conn);

    // 129 条 candidate → 第 129 条触发 reportCacheRejected；前 128 条 appendInbox 触发 inboxRejected
    for (let i = 0; i <= MAX_REPORT_CACHE_SIZE; i++) {
      conn.emit("message", {
        controllerId: "ctrl-1",
        workerId: "worker-1",
        id: `rcdiag-${i}`,
        seq: i + 1,
        type: "report_candidate",
        payload: {
          taskId: "task-1",
          revision: 1,
          runId: 1,
          report: { kind: "progress", summary: "x" },
        },
      });
    }

    const res = await ctrl.handleWorkerWait({
      workerId: "worker-1",
      afterCursor: 0,
      timeoutMs: 1000,
    });
    assert.strictEqual(res.event.type, "wait_timeout");
    const p = res.event.summary ? JSON.parse(res.event.summary) : {};
    assert.strictEqual(typeof p.droppedInboxEvents, "number");
    assert.strictEqual(typeof p.inboxRejectedEvents, "number");
    assert.strictEqual(typeof p.reportCacheRejected, "number");
    assert.ok(p.droppedInboxEvents >= 1);
    assert.ok(p.inboxRejectedEvents >= 1);
    assert.strictEqual(p.reportCacheRejected, 1);

    ctrl.dispose();
  });

  it("handleWorkerStatus 返回 inbox 与 reportCache 统计 (含 max 值)", async () => {
    const ctrl = new ControllerManager(new FakePiAPI() as any);
    ctrl.workerManager.acquireLaunchSlot("ctrl-1", "worker-1", "task-1", process.cwd(), "T");

    const res = await ctrl.handleWorkerStatus({ workerId: "worker-1" });
    assert.deepStrictEqual(res.inbox, {
      count: 0,
      bytes: 0,
      dropped: 0,
      rejected: 0,
      maxEvents: MAX_INBOX_EVENTS,
      maxBytes: MAX_INBOX_BYTES,
    });
    assert.deepStrictEqual(res.reportCache, {
      count: 0,
      bytes: 0,
      rejected: 0,
      maxCount: MAX_REPORT_CACHE_SIZE,
      maxBytes: MAX_REPORT_CACHE_BYTES,
    });

    ctrl.dispose();
  });
});

describe("Worker followup 队列双重边界", () => {
  it("队列条数上限：第 9 条抛错且 message 含 QUEUE_FULL", () => {
    const worker = new WorkerManager(new FakePiAPI() as any);
    const q = worker as any;

    for (let i = 0; i < MAX_FOLLOWUP_QUEUE_SIZE; i++) {
      q.enqueueOrDispatchMessage({ taskId: "task-1", revision: 1, runId: 1, message: `m${i}` });
    }
    assert.strictEqual(q.followupQueue.length, MAX_FOLLOWUP_QUEUE_SIZE);

    assert.throws(
      () => q.enqueueOrDispatchMessage({ taskId: "task-1", revision: 1, runId: 1, message: "m9" }),
      (err: Error) => err.message.includes(ProtocolErrorCode.QUEUE_FULL),
    );
    assert.strictEqual(q.followupQueue.length, MAX_FOLLOWUP_QUEUE_SIZE, "超限条目不得入队");
  });

  it("队列字节上限：两条 ~600 KiB 消息中第二条抛错且 message 含 QUEUE_BYTES_EXCEEDED", () => {
    const worker = new WorkerManager(new FakePiAPI() as any);
    const q = worker as any;
    const big = "x".repeat(600 * 1024);

    q.enqueueOrDispatchMessage({ taskId: "task-1", revision: 1, runId: 1, message: big });
    assert.ok(q.followupQueueBytes <= MAX_FOLLOWUP_QUEUE_BYTES);

    assert.throws(
      () => q.enqueueOrDispatchMessage({ taskId: "task-1", revision: 1, runId: 1, message: big }),
      (err: Error) => err.message.includes(ProtocolErrorCode.QUEUE_BYTES_EXCEEDED),
    );
    assert.ok(q.followupQueueBytes <= MAX_FOLLOWUP_QUEUE_BYTES, "字节计数不得超过上限");
    assert.strictEqual(q.followupQueue.length, 1, "超限条目不得入队");
  });

  it("出队/清空扣减字节，归零后可继续正常入队", () => {
    const worker = new WorkerManager(new FakePiAPI() as any);
    const q = worker as any;
    const itemA = { taskId: "task-1", revision: 1, runId: 1, message: "aaa" };
    const itemB = { taskId: "task-1", revision: 1, runId: 1, message: "bbbb" };

    q.enqueueOrDispatchMessage(itemA);
    q.enqueueOrDispatchMessage(itemB);
    assert.strictEqual(
      q.followupQueueBytes,
      jsonByteLength(itemA) + jsonByteLength(itemB),
    );

    const shifted = q.shiftQueueItem();
    assert.strictEqual(shifted.message, "aaa", "出队必须按 FIFO 顺序");
    assert.strictEqual(q.followupQueueBytes, jsonByteLength(itemB), "出队必须扣减字节");

    q.clearQueue();
    assert.strictEqual(q.followupQueueBytes, 0, "清空必须归零字节");
    assert.strictEqual(q.followupQueue.length, 0);

    // 归零后正常入队
    q.enqueueOrDispatchMessage({ taskId: "task-1", revision: 1, runId: 1, message: "ccc" });
    assert.strictEqual(q.followupQueue.length, 1);
  });

  it("管道集成：session_start 前连发 1 task + 8 followup，第 9 条仅一条失败 ACK 且含 QUEUE_FULL", async () => {
    const pipeId = "test-limits-" + crypto.randomUUID().slice(0, 8);
    const pipePath = getPipePath(pipeId);
    const controllerId = "ctrl-limits";
    const workerId = "worker-limits";

    const receivedEnvelopes: Envelope[] = [];
    let clientSocket: net.Socket | null = null;

    const server = net.createServer((socket) => {
      clientSocket = socket;
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          const env = JSON.parse(line);
          receivedEnvelopes.push(env);
          if (env.type === "hello") {
            socket.write(
              JSON.stringify({
                version: 1,
                controllerId,
                workerId,
                id: crypto.randomUUID(),
                replyTo: env.id,
                seq: 1,
                type: "hello_ok",
                payload: {},
              }) + "\n",
            );
          }
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(pipePath, resolve));

    process.env.PI_TERMINAL_WORKER_CONTROLLER_ID = controllerId;
    process.env.PI_TERMINAL_WORKER_WORKER_ID = workerId;
    process.env.PI_TERMINAL_WORKER_PIPE_PATH = pipePath;
    process.env.PI_TERMINAL_WORKER_TOKEN = "limits-token";

    const fakePi = new FakePiAPI();
    const worker = new WorkerManager(fakePi as any);
    await worker.init();

    await waitFor(() => receivedEnvelopes.some((e) => e.type === "hello"));
    assert.ok(clientSocket);

    const taskId = "task-limits-1";
    // session_start 之前先派发 1 条 task（建立任务绑定），再连发 8 条 followup
    // （runId=2..9，revision=1）；1 task + 8 followup 共 9 条消息，最后第 9 条仅
    // 因队列已满（8 条上限）触发 QUEUE_FULL。
    clientSocket!.write(
      JSON.stringify({
        version: 1,
        controllerId,
        workerId,
        id: "task-limits-0",
        seq: 1,
        type: "task",
        payload: { taskId, runId: 1, revision: 1, task: "会话就绪前的初始任务" },
      }) + "\n",
    );
    for (let i = 0; i < MAX_FOLLOWUP_QUEUE_SIZE; i++) {
      clientSocket!.write(
        JSON.stringify({
          version: 1,
          controllerId,
          workerId,
          id: `followup-${i + 1}`,
          seq: i + 2,
          type: "followup",
          payload: {
            taskId,
            runId: i + 2,
            revision: 1,
            message: `消息 ${i + 1}`,
            kind: "supplement",
          },
        }) + "\n",
      );
    }

    // 第 9 条必须收到 ok=false 的 ACK，错误文本含 QUEUE_FULL
    const badAck = (await waitFor(() =>
      receivedEnvelopes.find((e) => e.type === "ack" && (e.payload as any).ok === false),
    )) as Envelope;
    assert.strictEqual((badAck.payload as any).id, "followup-8");
    assert.match(String((badAck.payload as any).error ?? ""), /QUEUE_FULL/);

    // 错误 ACK 恰好 1 条，且对应第 9 条消息 (followup-8)
    const badAcks = receivedEnvelopes.filter((e) => e.type === "ack" && (e.payload as any).ok === false);
    assert.strictEqual(badAcks.length, 1, "只能产生一条失败 ACK");
    assert.strictEqual((badAcks[0].payload as any).id, "followup-8", "失败 ACK 必须对应第 9 条消息");
    assert.strictEqual(
      receivedEnvelopes.filter((e) => e.type === "ack" && (e.payload as any).id === "followup-8").length,
      1,
      "失败请求只能产生一条 ACK",
    );
    assert.strictEqual(
      receivedEnvelopes.filter((e) => e.type === "ack" && (e.payload as any).ok === true).length,
      MAX_FOLLOWUP_QUEUE_SIZE,
      "1 task + 7 followup 必须各有成功 ACK",
    );
    assert.strictEqual(fakePi.sentUserMessages.length, 0, "队列消息在会话就绪前不得派发");

    (worker as any).conn?.destroy();
    server.closeAllConnections?.();
    server.close();
  });
});

// 引用避免 tree-shaking 警告 (测试中未直接使用的导出)
void ReportCacheFullError;
void FakePiContext;
void InboxCapacityError;
