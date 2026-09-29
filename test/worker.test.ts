import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as net from "node:net";
import * as crypto from "node:crypto";
import { WorkerManager } from "../dist/worker.js";
import { FakePiAPI, FakePiContext } from "./fake-pi.ts";
import { getPipePath } from "../dist/transport.js";
import type { Envelope } from "../dist/protocol.js";

describe("Worker Report and Queue Lifecycle Tests", () => {
  it("worker_report 工具调用与 agent_settled 提交/作废流转", async () => {
    const pipeId = "test-worker-" + crypto.randomUUID().slice(0, 8);
    const pipePath = getPipePath(pipeId);
    const token = "worker-secret-token";
    const controllerId = "ctrl-1";
    const workerId = "worker-1";

    const receivedEnvelopes: Envelope[] = [];

    // 建立模拟 Controller 管道服务
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

    // 设置 Worker 环境变量
    process.env.PI_TERMINAL_WORKER_CONTROLLER_ID = controllerId;
    process.env.PI_TERMINAL_WORKER_WORKER_ID = workerId;
    process.env.PI_TERMINAL_WORKER_PIPE_PATH = pipePath;
    process.env.PI_TERMINAL_WORKER_TOKEN = token;

    const fakePi = new FakePiAPI();
    fakePi.registerTool({ name: "subagent" } as any);
    const fakeCtx = new FakePiContext();
    const worker = new WorkerManager(fakePi as any);

    await worker.init();

    // 触发 session_start
    await fakePi.emitPiEvent("session_start", {}, fakeCtx);
    assert.ok(!fakePi.getActiveTools().includes("subagent"));
    const blocked = await fakePi.emitPiEvent("tool_call", { toolName: "subagent" }, fakeCtx);
    assert.deepStrictEqual(blocked, { block: true, reason: "Worker 不允许递归派发子代理" });

    // 验证 worker_report 工具已被注册
    const reportTool = fakePi.tools.get("worker_report");
    assert.ok(reportTool);
    await assert.rejects(
      () => reportTool.execute("large", { kind: "result", summary: "x".repeat(65 * 1024) }),
      /64 KiB/,
    );

    // 模拟接收初始任务
    (worker as any).currentTaskId = "task-100";
    (worker as any).currentRevision = 1;
    (worker as any).currentRunId = 1;

    // 场景 1: 模型调用 worker_report 记录候选回执
    const reportPayload = {
      kind: "result",
      summary: "代码修改完成并通过自测",
      changedFiles: ["a.ts"],
      validation: [{ command: "npm test", outcome: "passed" }],
    };

    const toolResult = await reportTool.execute("call-1", reportPayload);
    assert.ok(toolResult.content[0].text.includes("回执候选"));

    // 检查是否暂存为 candidate
    assert.strictEqual((worker as any).currentCandidate.summary, reportPayload.summary);

    // 场景 2: 如果模型在 report 之后又调用了其他工具 (例如 bash)，候选立即失效
    await fakePi.emitPiEvent(
      "tool_execution_start",
      { toolName: "bash", toolCallId: "call-2" },
      fakeCtx,
    );
    assert.strictEqual((worker as any).currentCandidate, null);

    // 场景 3: 重新上报 report，然后本地人工干预 (敲键盘)，候选失效且触发 local_input
    await reportTool.execute("call-3", reportPayload);
    assert.notStrictEqual((worker as any).currentCandidate, null);

    await fakePi.emitPiEvent(
      "input",
      { type: "input", text: "人工干预停止", source: "interactive" },
      fakeCtx,
    );
    assert.strictEqual((worker as any).currentCandidate, null);

    // 场景 4: 正常上报并在 agent_settled 顺利 committed
    await reportTool.execute("call-4", reportPayload);
    await fakePi.emitPiEvent("agent_settled", {}, fakeCtx);

    // 等待 socket 刷出
    await new Promise((r) => setTimeout(r, 100));

    const committedEnv = receivedEnvelopes.find((e) => e.type === "report_committed");
    assert.ok(committedEnv, "必须成功发送 report_committed 消息");
    assert.strictEqual((committedEnv.payload as any).report.summary, reportPayload.summary);

    // worker_ready 应携带实际模型信息 (来自 FakePiContext.model 与 FakePiAPI.getThinkingLevel)
    const readyEnv = receivedEnvelopes.find((e) => e.type === "worker_ready");
    assert.ok(readyEnv);
    assert.strictEqual((readyEnv.payload as any).provider, "fake-provider");
    assert.strictEqual((readyEnv.payload as any).modelId, "fake-model-1");
    assert.strictEqual((readyEnv.payload as any).thinkingLevel, "medium");

    (worker as any).conn?.destroy();
    server.closeAllConnections?.();
    server.close();
  });
});

async function waitFor(cond: () => unknown, timeoutMs = 1500): Promise<unknown> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = cond();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("等待条件超时");
}

describe("启动竞态回归测试", () => {
  it("task 先于 session_start 到达时入队，session_start 后补派发且 worker_ready 上报模型信息", async () => {
    const pipeId = "test-race-" + crypto.randomUUID().slice(0, 8);
    const pipePath = getPipePath(pipeId);
    const controllerId = "ctrl-race";
    const workerId = "worker-race";

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
    process.env.PI_TERMINAL_WORKER_TOKEN = "race-token";

    const fakePi = new FakePiAPI();
    const fakeCtx = new FakePiContext();
    fakeCtx.model = { provider: "local", id: "Qwen3.8-27B" } as any;
    const worker = new WorkerManager(fakePi as any);
    await worker.init();

    // 等待 hello 发出
    await waitFor(() => receivedEnvelopes.some((e) => e.type === "hello"));
    assert.ok(clientSocket);

    // 1. session_start 之前推送初始任务：应入队而非直接派发
    clientSocket.write(
      JSON.stringify({
        version: 1,
        controllerId,
        workerId,
        id: "task-early",
        seq: 1,
        type: "task",
        payload: { taskId: "task-race-1", runId: 1, revision: 1, task: "初始任务文本" },
      }) + "\n",
    );
    const ack = await waitFor(() => receivedEnvelopes.find((e) => e.type === "ack"));
    assert.strictEqual((ack as Envelope).payload.ok, true);
    assert.strictEqual(fakePi.sentUserMessages.length, 0);

    // 2. session_start 触发：必须补派发早到任务并发 worker_ready (含模型信息)
    await fakePi.emitPiEvent("session_start", {}, fakeCtx);
    assert.strictEqual(fakePi.sentUserMessages.length, 1);
    assert.ok(fakePi.sentUserMessages[0].content.includes("初始任务文本"));

    const ready = await waitFor(() =>
      receivedEnvelopes.find((e) => e.type === "worker_ready"),
    ) as Envelope;
    assert.strictEqual((ready.payload as any).provider, "local");
    assert.strictEqual((ready.payload as any).modelId, "Qwen3.8-27B");
    assert.strictEqual((ready.payload as any).thinkingLevel, "medium");
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(
      receivedEnvelopes.filter((e) => e.type === "worker_ready").length,
      1,
      "worker_ready 必须只发送一次",
    );

    // 3. model_select / thinking_level_select 后刷新上报 (real Pi 在事件时已更新 ctx.model)
    fakeCtx.model = { provider: "local", id: "Other-Model" } as any;
    await fakePi.emitPiEvent(
      "model_select",
      { type: "model_select", model: { provider: "local", id: "Other-Model" }, previousModel: undefined, source: "set" },
      fakeCtx,
    );
    const changed1 = await waitFor(() =>
      receivedEnvelopes.find((e) => e.type === "model_changed" && (e.payload as any).modelId === "Other-Model"),
    ) as Envelope;
    assert.strictEqual((changed1.payload as any).thinkingLevel, "medium");

    fakePi.thinkingLevel = "high";
    await fakePi.emitPiEvent(
      "thinking_level_select",
      { type: "thinking_level_select", level: "high", previousLevel: "medium" },
      fakeCtx,
    );
    const changed2 = await waitFor(() =>
      receivedEnvelopes.find((e) => e.type === "model_changed" && (e.payload as any).thinkingLevel === "high"),
    ) as Envelope;
    assert.strictEqual((changed2.payload as any).modelId, "Other-Model");

    (worker as any).conn?.destroy();
    server.closeAllConnections?.();
    server.close();
  });

  it("session_start 早于 hello_ok 时 worker_ready 不在认证前发送，认证确认后发送且仅一次", async () => {
    const pipeId = "test-race2-" + crypto.randomUUID().slice(0, 8);
    const pipePath = getPipePath(pipeId);
    const controllerId = "ctrl-race2";
    const workerId = "worker-race2";

    const receivedEnvelopes: Envelope[] = [];

    const server = net.createServer((socket) => {
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
    process.env.PI_TERMINAL_WORKER_TOKEN = "race2-token";

    const fakePi = new FakePiAPI();
    const fakeCtx = new FakePiContext();
    fakeCtx.model = { provider: "local", id: "Model-A" } as any;
    const worker = new WorkerManager(fakePi as any);
    await worker.init();

    // 立即触发 session_start：此时 hello 尚未完成往返，hello_ok 未到
    await fakePi.emitPiEvent("session_start", {}, fakeCtx);
    assert.ok(
      !receivedEnvelopes.some((e) => e.type === "worker_ready"),
      "认证确认前不得发送 worker_ready",
    );

    // hello / hello_ok 完成后必须补发 worker_ready
    const ready = await waitFor(() =>
      receivedEnvelopes.find((e) => e.type === "worker_ready"),
    ) as Envelope;
    assert.strictEqual((ready.payload as any).provider, "local");
    assert.strictEqual((ready.payload as any).modelId, "Model-A");
    assert.strictEqual((ready.payload as any).thinkingLevel, "medium");

    // 再次触发 session_start 不应重发
    await fakePi.emitPiEvent("session_start", {}, fakeCtx);
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(
      receivedEnvelopes.filter((e) => e.type === "worker_ready").length,
      1,
      "worker_ready 必须只发送一次",
    );

    (worker as any).conn?.destroy();
    server.closeAllConnections?.();
    server.close();
  });
});
