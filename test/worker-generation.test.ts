/**
 * 第三组第二半：Worker 侧 session generation 防护与 session 事件幂等测试
 *
 * 覆盖：
 * 1. 真实会话切换丢弃旧队列与旧候选，新 session 任务仍正常派发
 * 2. 启动竞态：首个 session_start 之前的早到任务被 adopt 到新 generation 并补派发
 * 3. 真实会话切换作废旧候选与旧任务绑定：旧 ctx 的 agent_settled 不发任何回执/activity
 * 4. agent_settled 的 setImmediate 续段失效：不派发新会话队列、不发 activity idle
 * 5. session_shutdown 幂等：conn 只 destroy 一次；之后 worker_report / input 不再发信封
 * 6. 失效 generation（真实切换 / session_shutdown 后）不得再调用 Pi API
 * 7. 同一会话内一切照旧，staleCallbacksIgnored 保持 0
 * 8. 回归：Pi 每个事件都是新 ctx 对象，跨事件身份比较恒为真——
 *    session_start 与 agent_settled 传两个不同 ctx 对象时回执仍必须提交
 *
 * 红线：不启动真实 Pi / 终端；每个用例结束销毁连接、关闭 server，保证 node --test 自然退出。
 */

import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as net from "node:net";
import * as crypto from "node:crypto";
import { WorkerManager } from "../dist/worker.js";
import { FakePiAPI, FakePiContext } from "./fake-pi.ts";
import { getPipePath } from "../dist/transport.js";
import type { Envelope } from "../dist/protocol.js";

async function waitFor(cond: () => unknown, timeoutMs = 2000): Promise<unknown> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = cond();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("等待条件超时");
}

/** 等待超过一个 setImmediate 检查周期 */
const tick = () => new Promise((r) => setTimeout(r, 30));

function acksFor(received: Envelope[], id: string): Envelope[] {
  return received.filter((e) => e.type === "ack" && (e.payload as any).id === id);
}

interface Harness {
  received: Envelope[];
  worker: any;
  fakePi: FakePiAPI;
  send: (id: string, type: string, payload: unknown) => void;
  cleanup: () => Promise<void>;
}

/**
 * 建立假 Controller 管道 + WorkerManager（复制 test/worker.test.ts 的 net server 思路，
 * 但本文件自包含，不跨文件 import 私有 helper）。默认不触发 session_start，由用例显式触发。
 */
async function createHarness(controllerId: string, workerId: string): Promise<Harness> {
  const pipePath = getPipePath("test-gen-" + crypto.randomUUID().slice(0, 8));
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
  process.env.PI_TERMINAL_WORKER_TOKEN = "gen-token-" + workerId;

  const fakePi = new FakePiAPI();
  const worker = new WorkerManager(fakePi as any);
  await worker.init();

  // 等待 hello 往返，确保连接已建立
  await waitFor(() => received.some((e) => e.type === "hello"));

  return {
    received,
    worker: worker as any,
    fakePi,
    send: (id, type, payload) => {
      assert.ok(clientSocket, "管道连接尚未建立");
      clientSocket!.write(
        JSON.stringify({
          version: 1,
          controllerId,
          workerId,
          id,
          seq: 1,
          type,
          payload,
        }) + "\n",
      );
    },
    cleanup: async () => {
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

describe("3B: Worker 侧 session generation 防护与幂等", () => {
  it("真实会话切换：清空旧队列、作废旧候选，新 session 任务仍正常派发", async () => {
    const h = await createHarness("ctrl-gen-1", "worker-gen-1");
    try {
      const ctx1 = new FakePiContext();
      await h.fakePi.emitPiEvent("session_start", {}, ctx1);

      // 会话 A 中制造一个候选（旧任务绑定由随后的 task 消息建立）
      h.worker.currentCandidate = { kind: "result", summary: "会话A候选" };
      h.worker.candidateInvalidated = false;

      // ctx1 处于 busy：任务只能入队
      ctx1.idleState = false;
      h.send("task-old", "task", {
        taskId: "task-a",
        runId: 1,
        revision: 1,
        task: "旧会话任务",
      });
      await waitFor(() => acksFor(h.received, "task-old").length === 1);
      assert.strictEqual(h.worker.followupQueue.length, 1, "busy 时任务必须入队");
      assert.strictEqual(h.fakePi.sentUserMessages.length, 0, "busy 时不得派发");

      // 真实会话切换
      const ctx2 = new FakePiContext();
      await h.fakePi.emitPiEvent("session_start", {}, ctx2);

      assert.strictEqual(h.worker.followupQueue.length, 0, "旧队列必须被清空");
      assert.strictEqual(h.worker.currentCandidate, null, "旧候选必须被作废");
      assert.strictEqual(h.worker.candidateInvalidated, true, "候选失效标志必须置位");
      assert.strictEqual(h.fakePi.sentUserMessages.length, 0, "旧会话消息绝不注入新 session");

      // 反向对照：新会话空闲时投递的任务必须正常派发（证明不是死代码）
      h.send("task-new", "task", {
        taskId: "task-new",
        runId: 1,
        revision: 1,
        task: "新会话任务",
      });
      await waitFor(() => h.fakePi.sentUserMessages.length === 1);
      assert.ok(h.fakePi.sentUserMessages[0].content.includes("新会话任务"));
    } finally {
      await h.cleanup();
    }
  });

  it("启动竞态：session_start 之前的早到任务被 adopt 到新 generation 并补派发", async () => {
    const h = await createHarness("ctrl-gen-2", "worker-gen-2");
    try {
      // 首个 session_start 之前投递任务：全部入队、不派发
      h.send("early-1", "task", { taskId: "task-early-1", runId: 1, revision: 1, task: "早到任务一" });
      h.send("early-2", "followup", {
        taskId: "task-early-1",
        runId: 2,
        revision: 1,
        message: "早到消息二",
        kind: "supplement",
      });
      await waitFor(
        () => acksFor(h.received, "early-1").length === 1 && acksFor(h.received, "early-2").length === 1,
      );

      assert.strictEqual(h.worker.followupQueue.length, 2);
      assert.strictEqual(h.worker.followupQueue[0].sessionGeneration, 0, "入队时绑定 generation 0");
      assert.strictEqual(h.worker.followupQueue[1].sessionGeneration, 0);
      assert.strictEqual(h.fakePi.sentUserMessages.length, 0, "session_start 前不得派发");

      const ctx = new FakePiContext();
      await h.fakePi.emitPiEvent("session_start", {}, ctx);

      assert.strictEqual(h.worker.activeGeneration, 1, "首个 session_start 推进到 generation 1");
      assert.strictEqual(h.fakePi.sentUserMessages.length, 1, "必须补派发一条");
      assert.ok(h.fakePi.sentUserMessages[0].content.includes("早到任务一"));
      assert.strictEqual(h.worker.followupQueue.length, 1, "剩余条目仍在队列");
      assert.strictEqual(
        h.worker.followupQueue[0].sessionGeneration,
        1,
        "队列条目必须被 adopt 到新 generation",
      );
      assert.strictEqual(h.worker.followupQueue[0].taskId, "task-early-1");
      assert.strictEqual(h.worker.followupQueue[0].runId, 2);
    } finally {
      await h.cleanup();
    }
  });

  it("会话切换作废旧候选与旧任务绑定：旧 ctx 的 agent_settled 不发任何回执/activity", async () => {
    const h = await createHarness("ctrl-gen-3", "worker-gen-3");
    try {
      const ctx1 = new FakePiContext();
      // 会话 A 处于 busy：真实场景下产生候选的 agent 不会同时空闲
      ctx1.idleState = false;
      await h.fakePi.emitPiEvent("session_start", {}, ctx1);

      h.worker.currentTaskId = "task-a";
      h.worker.currentRevision = 1;
      h.worker.currentRunId = 1;
      h.worker.currentCandidate = { kind: "result", summary: "会话A候选" };
      h.worker.candidateInvalidated = false;
      h.worker.taskHasReported = false;

      // 真实会话切换：候选、旧任务绑定与队列一律作废（不再依赖 ctx 身份）
      const ctx2 = new FakePiContext();
      await h.fakePi.emitPiEvent("session_start", {}, ctx2);

      assert.strictEqual(h.worker.currentCandidate, null, "切换会话必须作废旧候选");
      assert.strictEqual(h.worker.currentTaskId, null, "切换会话必须断开旧任务绑定");
      assert.strictEqual(h.worker.candidateInvalidated, true, "候选失效标志必须置位");

      const beforeCount = h.received.length;

      // 旧会话晚到的 agent_settled：既无候选也无 currentTaskId，不得发任何回执
      await h.fakePi.emitPiEvent("agent_settled", {}, ctx1);
      await tick();

      const newEnvelopes = h.received.slice(beforeCount);
      assert.strictEqual(
        newEnvelopes.filter((e) =>
          ["report_committed", "report_missing", "activity"].includes(e.type),
        ).length,
        0,
        "旧候选/旧任务已作废，晚到 settled 不得发出任何回执/activity 信封",
      );
      assert.strictEqual(h.worker.currentCandidate, null, "不得被旧回调重新写入候选");
      assert.strictEqual(h.worker.taskHasReported, false, "不得被旧回调置为已回执");
    } finally {
      await h.cleanup();
    }
  });

  it("agent_settled 的 setImmediate 续段失效：不派发新会话队列、不发 activity idle", async () => {
    const h = await createHarness("ctrl-gen-4", "worker-gen-4");
    try {
      const ctx1 = new FakePiContext();
      await h.fakePi.emitPiEvent("session_start", {}, ctx1);

      // 清空报告关联，避免 agent_settled 同步部分发送 report_missing 干扰
      h.worker.currentTaskId = null;
      h.worker.taskHasReported = true;

      // ctx1 busy：旧任务入队
      ctx1.idleState = false;
      h.send("task-old", "task", {
        taskId: "task-old",
        runId: 1,
        revision: 1,
        task: "旧会话排队任务",
      });
      await waitFor(() => h.worker.followupQueue.length === 1);

      // 触发 agent_settled：同步部分调度 setImmediate 续段（捕获 gen1/ctx1）
      const settled = h.fakePi.emitPiEvent("agent_settled", {}, ctx1);

      // 立即真实切换会话：刷新 generation、清空旧队列
      const ctx2 = new FakePiContext();
      await h.fakePi.emitPiEvent("session_start", {}, ctx2);
      await settled;

      // 新会话 busy 时入队一条新任务
      ctx2.idleState = false;
      h.worker.enqueueOrDispatchMessage(
        { taskId: "task-new", revision: 1, runId: 1, message: "新会话排队任务" },
        ctx2,
        h.worker.activeGeneration,
      );
      assert.strictEqual(h.worker.followupQueue.length, 1);

      // 新 ctx2 空闲：若续段未校验代际，就会误把新会话队列派发出去
      ctx2.idleState = true;
      const beforeCount = h.received.length;
      await tick();

      assert.strictEqual(h.fakePi.sentUserMessages.length, 0, "失效续段不得派发新会话队列");
      assert.strictEqual(h.worker.followupQueue.length, 1, "队列条目必须保留待正常派发");
      const newEnvelopes = h.received.slice(beforeCount);
      assert.strictEqual(
        newEnvelopes.filter((e) => e.type === "activity").length,
        0,
        "失效续段不得发送 activity idle",
      );
    } finally {
      await h.cleanup();
    }
  });

  it("session_shutdown 幂等：conn 只 destroy 一次；之后 worker_report / input 不再发信封", async () => {
    const h = await createHarness("ctrl-gen-5", "worker-gen-5");
    try {
      const ctx = new FakePiContext();
      await h.fakePi.emitPiEvent("session_start", {}, ctx);

      // 队列中放一条条目，验证 shutdown 清空
      h.worker.enqueueOrDispatchMessage(
        { taskId: "t", revision: 1, runId: 1, message: "queued" },
        null,
        h.worker.activeGeneration,
      );
      assert.strictEqual(h.worker.followupQueue.length, 1);

      const conn = h.worker.conn;
      assert.ok(conn, "worker 应已建立连接");
      let destroyCount = 0;
      const origDestroy = conn.destroy.bind(conn);
      conn.destroy = () => {
        destroyCount++;
        origDestroy();
      };

      await h.fakePi.emitPiEvent("session_shutdown", {}, ctx);
      assert.strictEqual(destroyCount, 1, "首次 shutdown 必须 destroy 一次");
      assert.strictEqual(h.worker.conn, null, "conn 必须置空");
      assert.strictEqual(h.worker.currentContext, null, "context 必须置空");
      assert.strictEqual(h.worker.followupQueue.length, 0, "队列必须清空");

      // 幂等：第二次触发不得再 destroy、不得抛错
      await h.fakePi.emitPiEvent("session_shutdown", {}, ctx);
      assert.strictEqual(destroyCount, 1, "重复 shutdown 不得再次 destroy");

      // 之后 worker_report 不得发信封、不得写候选
      const reportTool = h.fakePi.tools.get("worker_report")!;
      const beforeCount = h.received.length;
      const res = await reportTool.execute("call-shutdown", { kind: "result", summary: "shutdown 之后" });
      await tick();
      assert.strictEqual(h.worker.currentCandidate, null, "shutdown 后不得写候选");
      assert.ok(String(res.content[0].text).includes("作废"), "必须返回明确的作废说明");
      assert.strictEqual(
        h.received.slice(beforeCount).filter((e) => e.type === "report_candidate").length,
        0,
        "shutdown 后不得发送 report_candidate",
      );

      // input 不得发 local_input
      const inputRes = await h.fakePi.emitPiEvent(
        "input",
        { type: "input", text: "shutdown 后输入", source: "interactive" },
        ctx,
      );
      await tick();
      assert.deepStrictEqual(inputRes, { action: "continue" });
      assert.strictEqual(
        h.received.filter((e) => e.type === "local_input").length,
        0,
        "shutdown 后不得发送 local_input",
      );
    } finally {
      await h.cleanup();
    }
  });

  it("失效 generation 不得再调用 Pi API：真实切换与 shutdown 后 dispatchUserMessage 全部拦截", async () => {
    const h = await createHarness("ctrl-gen-6", "worker-gen-6");
    try {
      const ctx1 = new FakePiContext();
      await h.fakePi.emitPiEvent("session_start", {}, ctx1);
      const gen1 = h.worker.activeGeneration;

      const ctx2 = new FakePiContext();
      await h.fakePi.emitPiEvent("session_start", {}, ctx2);
      const gen2 = h.worker.activeGeneration;
      assert.notStrictEqual(gen1, gen2, "真实会话切换必须推进 generation");

      const before = h.fakePi.sentUserMessages.length;

      // 当前会话正常派发：正对照
      assert.strictEqual(h.worker.dispatchUserMessage("合法消息", ctx2, gen2), true);
      assert.strictEqual(h.fakePi.sentUserMessages.length, before + 1);

      // 旧 generation 失效：即便传入当前 ctx 也不得调用 Pi API
      assert.strictEqual(h.worker.dispatchUserMessage("旧代际消息", ctx2, gen1), false);

      // 通过 session_shutdown 使 generation 失效（不依赖 ctx 身份）
      await h.fakePi.emitPiEvent("session_shutdown", {}, ctx2);
      assert.strictEqual(h.worker.currentContext, null, "shutdown 后上下文必须置空");

      assert.strictEqual(h.worker.dispatchUserMessage("shutdown 后消息", ctx1, gen1), false);
      assert.strictEqual(h.worker.dispatchUserMessage("shutdown 后消息2", ctx2, gen2), false);
      assert.strictEqual(
        h.fakePi.sentUserMessages.length,
        before + 1,
        "失效 generation 绝不调用 Pi API",
      );
    } finally {
      await h.cleanup();
    }
  });

  it("同一会话内一切照旧：task 派发、report→committed、input→local_input，staleCallbacksIgnored 为 0", async () => {
    const h = await createHarness("ctrl-gen-7", "worker-gen-7");
    try {
      const ctx = new FakePiContext();
      await h.fakePi.emitPiEvent("session_start", {}, ctx);

      // task 派发
      h.send("task-7", "task", { taskId: "task-7", runId: 1, revision: 1, task: "同会话任务" });
      await waitFor(() => h.fakePi.sentUserMessages.length === 1);
      assert.ok(h.fakePi.sentUserMessages[0].content.includes("同会话任务"));

      // worker_report → agent_settled → report_committed
      const reportTool = h.fakePi.tools.get("worker_report")!;
      await reportTool.execute("call-1", { kind: "result", summary: "同会话回执" });
      assert.notStrictEqual(h.worker.currentCandidate, null);
      await h.fakePi.emitPiEvent("agent_settled", {}, ctx);
      await waitFor(() => h.received.some((e) => e.type === "report_committed"));

      // input → local_input
      await h.fakePi.emitPiEvent(
        "input",
        { type: "input", text: "本地输入", source: "interactive" },
        ctx,
      );
      await waitFor(() => h.received.some((e) => e.type === "local_input"));

      await tick();
      assert.strictEqual(h.worker.staleCallbacksIgnored, 0, "同一会话内不得有失效回调计数");
    } finally {
      await h.cleanup();
    }
  });

  it("真实 Pi 每个事件都是新 ctx：session_start 与 agent_settled 传不同 ctx 对象时回执仍必须提交", async () => {
    const h = await createHarness("ctrl-gen-8", "worker-gen-8");
    try {
      // Pi runner 的 emit() 每次都会 createContext()：session_start 与
      // agent_settled 拿到的 ctx 字段相同但不是同一引用。
      const ctx1 = new FakePiContext();
      await h.fakePi.emitPiEvent("session_start", {}, ctx1);

      // 派发任务（ctx1 空闲 → 立即派发）
      h.send("task-8", "task", {
        taskId: "task-8",
        runId: 1,
        revision: 1,
        task: "新 ctx 回归任务",
      });
      await waitFor(() => h.fakePi.sentUserMessages.length === 1);
      assert.strictEqual(h.worker.currentTaskId, "task-8");

      // 模型提交回执候选
      const reportTool = h.fakePi.tools.get("worker_report")!;
      await reportTool.execute("call-8", { kind: "result", summary: "新 ctx 回归回执" });
      assert.notStrictEqual(h.worker.currentCandidate, null, "候选必须已记录");
      await waitFor(() => h.received.some((e) => e.type === "report_candidate"));

      // 模拟 Pi 真实行为：agent_settled 收到另一个新建的 ctx（字段等价、引用不同）
      const ctx2 = new FakePiContext();
      ctx2.model = ctx1.model;
      ctx2.idleState = ctx1.idleState;
      ctx2.pendingMessages = ctx1.pendingMessages;
      assert.notStrictEqual(ctx2, ctx1, "两个事件必须是不同的 ctx 对象");

      const beforeCount = h.received.length;
      const staleBefore = h.worker.staleCallbacksIgnored;
      await h.fakePi.emitPiEvent("agent_settled", {}, ctx2);

      // 修复前：`ctx !== this.currentContext` 恒为真 → settled 被静默忽略 → 此处超时失败
      const committed = await waitFor(() =>
        h.received.slice(beforeCount).find((e) => e.type === "report_committed"),
      );
      assert.strictEqual((committed as Envelope).payload.taskId, "task-8");
      assert.strictEqual((committed as any).payload.report.summary, "新 ctx 回归回执");
      assert.strictEqual(
        h.worker.currentContext,
        ctx2,
        "agent_settled 后当前上下文应更新为本事件的新 ctx",
      );
      assert.strictEqual(
        h.worker.staleCallbacksIgnored,
        staleBefore,
        "真实事件不得被误判为失效回调",
      );
    } finally {
      await h.cleanup();
    }
  });
});
