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

    // 设置 Worker 环境变量
    process.env.PI_TERMINAL_WORKER_CONTROLLER_ID = controllerId;
    process.env.PI_TERMINAL_WORKER_WORKER_ID = workerId;
    process.env.PI_TERMINAL_WORKER_PIPE_PATH = pipePath;
    process.env.PI_TERMINAL_WORKER_TOKEN = token;

    const fakePi = new FakePiAPI();
    const fakeCtx = new FakePiContext();
    const worker = new WorkerManager(fakePi as any);

    await worker.init();

    // 触发 session_start
    await fakePi.emitPiEvent("session_start", {}, fakeCtx);

    // 验证 worker_report 工具已被注册
    const reportTool = fakePi.tools.get("worker_report");
    assert.ok(reportTool);

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

    (worker as any).conn?.destroy();
    server.closeAllConnections?.();
    server.close();
  });
});
