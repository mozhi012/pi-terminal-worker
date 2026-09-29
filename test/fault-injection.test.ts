import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as net from "node:net";
import * as crypto from "node:crypto";
import { WorkerManager } from "../dist/worker.js";
import { FakePiAPI, FakePiContext } from "./fake-pi.ts";
import { getPipePath } from "../dist/transport.js";
import { MAX_DEDUP_CACHE_SIZE, ProtocolErrorCode, type Envelope } from "../dist/protocol.js";

async function waitFor(cond: () => unknown, timeoutMs = 3000): Promise<unknown> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = cond();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("等待条件超时");
}

interface Harness {
  received: Envelope[];
  worker: WorkerManager;
  fakePi: FakePiAPI;
  fakeCtx: FakePiContext;
  socket: () => net.Socket;
  send: (id: string, type: string, payload: unknown, override?: { controllerId?: string; workerId?: string }) => void;
  close: () => Promise<void>;
}

/**
 * 建立假 Controller 管道 + WorkerManager (参考 worker.test.ts 写法)
 */
async function createHarness(controllerId: string, workerId: string): Promise<Harness> {
  const pipePath = getPipePath("test-fi-" + crypto.randomUUID().slice(0, 8));
  const received: Envelope[] = [];
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
        const env = JSON.parse(line) as Envelope;
        received.push(env);
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
  process.env.PI_TERMINAL_WORKER_TOKEN = "fi-token-" + workerId;

  const fakePi = new FakePiAPI();
  const fakeCtx = new FakePiContext();
  const worker = new WorkerManager(fakePi as any);
  await worker.init();

  // 等 hello 往返完成，并触发 session_start 使任务可直接派发
  await waitFor(() => received.some((e) => e.type === "hello"));
  await fakePi.emitPiEvent("session_start", {}, fakeCtx);

  return {
    received,
    worker,
    fakePi,
    fakeCtx,
    socket: () => {
      assert.ok(clientSocket, "worker 管道连接尚未建立");
      return clientSocket;
    },
    send: (id, type, payload, override) => {
      clientSocket!.write(
        JSON.stringify({
          version: 1,
          controllerId: override?.controllerId ?? controllerId,
          workerId: override?.workerId ?? workerId,
          id,
          seq: 1,
          type,
          payload,
        }) + "\n",
      );
    },
    close: async () => {
      (worker as any).conn?.destroy();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

function acksFor(received: Envelope[], id: string): Envelope[] {
  return received.filter((e) => e.type === "ack" && (e.payload as any).id === id);
}

describe("2A: Worker 接收侧故障注入 (去重 / 身份 / 容量)", () => {
  it("重复 task (同 id 同 payload) → 只派发一次，两次都收到 ok:true 的缓存 ACK", async () => {
    const h = await createHarness("ctrl-fi-1", "worker-fi-1");
    const taskPayload = { taskId: "task-fi-1", runId: 1, revision: 1, task: "任务文本 A" };

    h.send("task-dup-1", "task", taskPayload);
    const firstAck = (await waitFor(() => acksFor(h.received, "task-dup-1")[0])) as Envelope;
    assert.strictEqual((firstAck.payload as any).ok, true);
    await waitFor(() => h.fakePi.sentUserMessages.length === 1);

    // 连发第二次同 id 同 payload
    h.send("task-dup-1", "task", taskPayload);
    const secondAck = (await waitFor(() => acksFor(h.received, "task-dup-1")[1])) as Envelope;
    assert.strictEqual((secondAck.payload as any).ok, true);

    // 只派发一次
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(h.fakePi.sentUserMessages.length, 1, "重复 task 不得重复派发");

    await h.close();
  });

  it("同 id 不同 payload → ok:false 且 code=DUPLICATE_REQUEST_MISMATCH，不重复派发", async () => {
    const h = await createHarness("ctrl-fi-2", "worker-fi-2");

    h.send("task-mis-1", "task", { taskId: "t", runId: 1, revision: 1, task: "版本一" });
    await waitFor(() => acksFor(h.received, "task-mis-1")[0]);
    await waitFor(() => h.fakePi.sentUserMessages.length === 1);

    h.send("task-mis-1", "task", { taskId: "t", runId: 1, revision: 1, task: "版本二" });
    const badAck = (await waitFor(() => acksFor(h.received, "task-mis-1").find((e) => (e.payload as any).ok === false))) as Envelope;
    assert.strictEqual((badAck.payload as any).code, ProtocolErrorCode.DUPLICATE_REQUEST_MISMATCH);

    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(h.fakePi.sentUserMessages.length, 1, "内容冲突的重复 task 不得派发");

    await h.close();
  });

  it("重复 followup (同 id 同 payload) → 只入队/派发一次", async () => {
    const h = await createHarness("ctrl-fi-3", "worker-fi-3");

    h.send("task-3", "task", { taskId: "t3", runId: 1, revision: 1, task: "任务" });
    await waitFor(() => h.fakePi.sentUserMessages.length === 1);

    const fuPayload = { taskId: "t3", runId: 1, revision: 2, message: "补充说明", kind: "supplement" };
    h.send("fu-1", "followup", fuPayload);
    h.send("fu-1", "followup", fuPayload);
    await waitFor(() => acksFor(h.received, "fu-1").length === 2);
    const acks = acksFor(h.received, "fu-1");
    assert.ok(acks.every((e) => (e.payload as any).ok === true), "两次 followup 都应收到 ok:true");

    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(h.fakePi.sentUserMessages.length, 2, "重复 followup 只派发一次");

    await h.close();
  });

  it("重复 abort (同 id) → 只执行一次 abort，第二次走缓存 ACK 且 ok:true", async () => {
    const h = await createHarness("ctrl-fi-4", "worker-fi-4");

    h.send("task-4", "task", { taskId: "t4", runId: 1, revision: 1, task: "任务" });
    await waitFor(() => h.fakePi.sentUserMessages.length === 1);

    let abortCount = 0;
    const origAbort = h.fakeCtx.abort.bind(h.fakeCtx);
    h.fakeCtx.abort = () => {
      abortCount++;
      origAbort();
    };

    h.send("abort-1", "abort", {});
    const firstAck = (await waitFor(() => acksFor(h.received, "abort-1")[0])) as Envelope;
    assert.strictEqual((firstAck.payload as any).ok, true);

    h.send("abort-1", "abort", {});
    const secondAck = (await waitFor(() => acksFor(h.received, "abort-1")[1])) as Envelope;
    assert.strictEqual((secondAck.payload as any).ok, true, "缓存 ACK 应为 ok:true");

    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(abortCount, 1, "abort 只应执行一次");
    assert.strictEqual(h.fakeCtx.aborted, true);

    await h.close();
  });

  it("身份不匹配：workerId 写错的 task → 不回 ACK、不派发、回发 error；后续合法 task 仍正常派发", async () => {
    const h = await createHarness("ctrl-fi-5", "worker-fi-5");

    h.send("task-id-1", "task", { taskId: "t5", runId: 1, revision: 1, task: "任务" }, { workerId: "wrong-worker" });

    // Worker 回发 error (code PROTOCOL_ERROR)
    const errEnv = (await waitFor(() =>
      h.received.find((e) => e.type === "error" && e.replyTo === "task-id-1"),
    )) as Envelope;
    assert.strictEqual((errEnv.payload as any).code, ProtocolErrorCode.PROTOCOL_ERROR);
    assert.ok(String((errEnv.payload as any).message).includes("workerId"));

    // 不回 ACK、不派发
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(acksFor(h.received, "task-id-1").length, 0, "身份不匹配不得回 ACK");
    assert.strictEqual(h.fakePi.sentUserMessages.length, 0, "身份不匹配不得派发");

    // 随后一条合法 task 仍能正常派发 (连接未被误杀)
    h.send("task-id-2", "task", { taskId: "t5", runId: 1, revision: 1, task: "合法任务" });
    const ack = (await waitFor(() => acksFor(h.received, "task-id-2")[0])) as Envelope;
    assert.strictEqual((ack.payload as any).ok, true);
    await waitFor(() => h.fakePi.sentUserMessages.length === 1);

    await h.close();
  });

  it("MISMATCH 之后原始正文仍命中缓存 ACK (缓存条目不被冲突正文覆盖)", async () => {
    const h = await createHarness("ctrl-fi-8", "worker-fi-8");
    const payloadA = { taskId: "t8", runId: 1, revision: 1, task: "版本一" };
    const payloadB = { taskId: "t8", runId: 1, revision: 1, task: "版本二" };

    // 1) payloadA → ok:true，派发一次
    h.send("task-keep-1", "task", payloadA);
    const ackA1 = (await waitFor(() => acksFor(h.received, "task-keep-1")[0])) as Envelope;
    assert.strictEqual((ackA1.payload as any).ok, true);
    await waitFor(() => h.fakePi.sentUserMessages.length === 1);

    // 2) 同 id 的 payloadB → ok:false + MISMATCH，不派发
    h.send("task-keep-1", "task", payloadB);
    const ackB1 = (await waitFor(() =>
      acksFor(h.received, "task-keep-1").find((e) => (e.payload as any).ok === false),
    )) as Envelope;
    assert.strictEqual((ackB1.payload as any).code, ProtocolErrorCode.DUPLICATE_REQUEST_MISMATCH);

    // 3) 再发回 payloadA → 必须命中缓存的 ok:true ACK (不是 MISMATCH)
    h.send("task-keep-1", "task", payloadA);
    await waitFor(() =>
      acksFor(h.received, "task-keep-1").filter((e) => (e.payload as any).ok === true).length === 2,
    );
    const oks = acksFor(h.received, "task-keep-1").filter((e) => (e.payload as any).ok === true);
    assert.strictEqual(oks.length, 2, "原始正文必须再次命中缓存 ACK");

    // 4) 再发 payloadB → 仍然 MISMATCH
    h.send("task-keep-1", "task", payloadB);
    await waitFor(() =>
      acksFor(h.received, "task-keep-1").filter((e) => (e.payload as any).ok === false).length === 2,
    );
    const bads = acksFor(h.received, "task-keep-1").filter((e) => (e.payload as any).ok === false);
    assert.strictEqual(bads.length, 2);
    assert.strictEqual((bads[1].payload as any).code, ProtocolErrorCode.DUPLICATE_REQUEST_MISMATCH);

    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(h.fakePi.sentUserMessages.length, 1, "四连发只允许派发一次");

    await h.close();
  });

  it("普通去重表满：新 followup 收到 DEDUP_FULL，但 abort 仍 ok:true 并生效 (控制额度独立)", async () => {
    const h = await createHarness("ctrl-fi-6", "worker-fi-6");
    const conn = (h.worker as any).conn;
    assert.ok(conn, "worker 应已建立连接");

    // 预填满 1024 条普通去重记录
    for (let i = 0; i < MAX_DEDUP_CACHE_SIZE; i++) {
      conn.recordDedup(`fill-${i}`, { i }, { id: `fill-${i}`, ok: true });
    }
    assert.strictEqual(conn.getDedupStats().normal, MAX_DEDUP_CACHE_SIZE);

    const fuPayload = { taskId: "t6", runId: 1, revision: 1, message: "补充", kind: "supplement" };
    h.send("fu-full", "followup", fuPayload);
    const badAck = (await waitFor(() => acksFor(h.received, "fu-full")[0])) as Envelope;
    assert.strictEqual((badAck.payload as any).ok, false);
    assert.strictEqual((badAck.payload as any).code, ProtocolErrorCode.DEDUP_FULL);

    // abort 仍走独立控制额度：ok:true 并生效
    h.send("abort-full", "abort", {});
    const abortAck = (await waitFor(() => acksFor(h.received, "abort-full")[0])) as Envelope;
    assert.strictEqual((abortAck.payload as any).ok, true);
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(h.fakeCtx.aborted, true, "abort 应在控制额度内生效");

    await h.close();
  });

  it("心跳不进去重表：连发 3 条 ping 后 normal 计数不增长", async () => {
    const h = await createHarness("ctrl-fi-7", "worker-fi-7");
    const conn = (h.worker as any).conn;
    assert.ok(conn, "worker 应已建立连接");

    const before = conn.getDedupStats().normal;
    h.send("ping-1", "ping", { timestamp: Date.now() });
    h.send("ping-2", "ping", { timestamp: Date.now() });
    h.send("ping-3", "ping", { timestamp: Date.now() });

    // 三次 pong 全部回来
    await waitFor(() =>
      h.received.filter((e) => e.type === "pong" && ["ping-1", "ping-2", "ping-3"].includes(e.replyTo ?? "")).length === 3,
    );

    assert.strictEqual(conn.getDedupStats().normal, before, "心跳不得占用去重额度");

    await h.close();
  });
});

describe("2B: Worker 任务身份与版本校验", () => {
  it("旧 taskId 的 followup：回送 IDENTITY_MISMATCH，不派发且内部任务状态不被污染", async () => {
    const h = await createHarness("ctrl-fi-2b-1", "worker-fi-2b-1");

    // 先建立合法任务绑定：taskA/runId=1/revision=1 立即派发
    h.send("task-id-valid", "task", { taskId: "tA", runId: 1, revision: 1, task: "合法任务" });
    const okAck = (await waitFor(() => acksFor(h.received, "task-id-valid")[0])) as Envelope;
    assert.strictEqual((okAck.payload as any).ok, true);
    await waitFor(() => h.fakePi.sentUserMessages.length === 1);

    // 旧 taskId 的 followup：必须拒绝
    h.send("fu-old-task", "followup", {
      taskId: "tB",
      runId: 1,
      revision: 2,
      message: "旧 taskId 补充",
      kind: "supplement",
    });
    const badAck = (await waitFor(() =>
      acksFor(h.received, "fu-old-task").find((e) => (e.payload as any).ok === false),
    )) as Envelope;
    assert.strictEqual((badAck.payload as any).code, ProtocolErrorCode.IDENTITY_MISMATCH);

    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(h.fakePi.sentUserMessages.length, 1, "被拒 followup 不得派发");
    assert.strictEqual((h.worker as any).currentTaskId, "tA", "currentTaskId 不得被污染");
    assert.strictEqual((h.worker as any).currentRevision, 1, "currentRevision 不得被污染");
    assert.strictEqual((h.worker as any).currentRunId, 1, "currentRunId 不得被污染");

    await h.close();
  });

  it("旧 revision/runId 的 followup：回送 INVALID_STATE，状态与派发数不推进", async () => {
    const h = await createHarness("ctrl-fi-2b-2", "worker-fi-2b-2");

    h.send("task-rev-valid", "task", { taskId: "tR", runId: 1, revision: 1, task: "合法任务" });
    await waitFor(() => h.fakePi.sentUserMessages.length === 1);

    // 先接受 revision=2/runId=2 的 followup
    h.send("fu-rev-2", "followup", {
      taskId: "tR",
      runId: 2,
      revision: 2,
      message: "返修第一次",
      kind: "revision",
    });
    const okAck = (await waitFor(() => acksFor(h.received, "fu-rev-2")[0])) as Envelope;
    assert.strictEqual((okAck.payload as any).ok, true);
    await waitFor(() => h.fakePi.sentUserMessages.length === 2);
    assert.strictEqual((h.worker as any).currentRevision, 2);
    assert.strictEqual((h.worker as any).currentRunId, 2);

    // 再发 revision=2 且 runId=2 (不大于当前值) 的 followup：必须拒绝
    h.send("fu-rev-stale", "followup", {
      taskId: "tR",
      runId: 2,
      revision: 2,
      message: "过时的重复返修",
      kind: "revision",
    });
    const badAck = (await waitFor(() =>
      acksFor(h.received, "fu-rev-stale").find((e) => (e.payload as any).ok === false),
    )) as Envelope;
    assert.strictEqual((badAck.payload as any).code, ProtocolErrorCode.INVALID_STATE);

    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(h.fakePi.sentUserMessages.length, 2, "被拒 followup 不得派发");
    assert.strictEqual((h.worker as any).currentRevision, 2, "currentRevision 必须保持上一条被接受的值");
    assert.strictEqual((h.worker as any).currentRunId, 2, "currentRunId 必须保持上一条被接受的值");

    await h.close();
  });

  it("已绑定时再来初始 task：回送 INVALID_STATE，任务绑定不变且不派发", async () => {
    const h = await createHarness("ctrl-fi-2b-3", "worker-fi-2b-3");

    h.send("task-bound", "task", { taskId: "tC", runId: 1, revision: 1, task: "合法任务" });
    await waitFor(() => h.fakePi.sentUserMessages.length === 1);
    assert.strictEqual((h.worker as any).currentTaskId, "tC");

    // 已绑定后再来一条初始 task（新消息 id，taskId 与当前绑定一致 → 命中“已绑定”拒绝分支）
    h.send("task-bound-again", "task", { taskId: "tC", runId: 1, revision: 1, task: "重复初始任务" });
    const badAck = (await waitFor(() =>
      acksFor(h.received, "task-bound-again").find((e) => (e.payload as any).ok === false),
    )) as Envelope;
    assert.strictEqual((badAck.payload as any).code, ProtocolErrorCode.INVALID_STATE);

    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(h.fakePi.sentUserMessages.length, 1, "被拒初始 task 不得派发");
    assert.strictEqual((h.worker as any).currentTaskId, "tC", "currentTaskId 必须不变");
    assert.strictEqual((h.worker as any).currentRevision, 1, "currentRevision 必须不变");
    assert.strictEqual((h.worker as any).currentRunId, 1, "currentRunId 必须不变");

    await h.close();
  });
});
