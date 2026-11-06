import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import extension, { setupLeadRole } from "../dist/extension.js";
import { WorkerManager } from "../dist/worker.js";
import { ControllerManager, WORKER_NOTIFICATION_CUSTOM_TYPE } from "../dist/controller.js";
import { MultiWorkerCoordinator } from "../dist/multi-worker.js";
import { resolveChildRole, validatePayload } from "../dist/protocol.js";
import { encodeDescriptor, decodeDescriptor } from "../dist/launcher.js";
import { FakePiAPI, FakePiContext } from "./fake-pi.ts";

process.env.PI_TEST_MOCK_CLI = "1";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const roleEnv = "PI_TERMINAL_WORKER_ROLE";
function setRole(role?: string) {
  const saved = process.env[roleEnv];
  if (role === undefined) delete process.env[roleEnv];
  else process.env[roleEnv] = role;
  return () => { if (saved === undefined) delete process.env[roleEnv]; else process.env[roleEnv] = saved; };
}
function makeConnection() {
  const frames: any[] = [];
  const conn = Object.assign(new EventEmitter(), {
    socket: { destroyed: false }, nextSeq: 1,
    sendEnvelope: async (env: any) => { frames.push(env); },
    sendRequest: async (env: any) => { frames.push(env); return { id: env.id, ok: true }; },
    recordDedup: () => {}, checkDedup: () => null,
    destroy() { this.socket.destroyed = true; },
  });
  return { conn, frames };
}
function withFakeConnect<T>(run: () => T): T {
  const original = (WorkerManager.prototype as any).connectToController;
  const savedPipe = process.env.PI_TERMINAL_WORKER_PIPE_PATH;
  const savedToken = process.env.PI_TERMINAL_WORKER_TOKEN;
  process.env.PI_TERMINAL_WORKER_PIPE_PATH = "test-lead-pipe";
  process.env.PI_TERMINAL_WORKER_TOKEN = "test-lead-token";
  (WorkerManager.prototype as any).connectToController = async () => {};
  try { return run(); }
  finally {
    (WorkerManager.prototype as any).connectToController = original;
    if (savedPipe === undefined) delete process.env.PI_TERMINAL_WORKER_PIPE_PATH;
    else process.env.PI_TERMINAL_WORKER_PIPE_PATH = savedPipe;
    if (savedToken === undefined) delete process.env.PI_TERMINAL_WORKER_TOKEN;
    else process.env.PI_TERMINAL_WORKER_TOKEN = savedToken;
  }
}

/** Pi 的 custom message 通道不会触发 input；user message 来源为 extension。 */
class LeadPi extends FakePiAPI {
  customMessages: any[] = [];
  sendMessage(message: any, options: any) { this.customMessages.push({ message, options }); }
}
async function setupLead() {
  const pi = new LeadPi();
  pi.registerTool({ name: "subagent" } as any);
  pi.registerTool({ name: "bash" } as any);
  const handle = withFakeConnect(() => setupLeadRole(pi as any));
  await handle.ready;
  const ctx = new FakePiContext();
  const upstream = makeConnection();
  (handle.worker as any).conn = upstream.conn;
  await pi.emitPiEvent("session_start", {}, ctx);
  (handle.worker as any).currentTaskId = "phase-task";
  const children: ControllerManager[] = [];
  (handle.coordinator as any).createController = () => {
    const ctrl = new ControllerManager(pi as any, true);
    ctrl.handleWorkerStart = async (params: any, _probes: any, internal: any) => {
      ctrl.workerManager.acquireLaunchSlot(internal.ids.controllerId, internal.ids.workerId,
        internal.ids.taskId, params.cwd, params.title, params.role);
      ctrl.workerManager.updateLifecycleState("connected");
      const childConn = makeConnection();
      (ctrl as any).workerConn = childConn.conn;
      (ctrl as any).registerConnCleanup("worker", childConn.conn);
      (ctrl as any).__testChildFrames = childConn.frames;
      children.push(ctrl);
      return { ok: true, workerId: internal.ids.workerId, taskId: internal.ids.taskId, revision: 1, message: "started" };
    };
    return ctrl;
  };
  return { pi, handle, ctx, upstream, children };
}

function controllerEnvelope(worker: any, type: string, payload: any) {
  return { version: 1, controllerId: worker.controllerId, workerId: worker.workerId,
    id: crypto.randomUUID(), seq: 1, type, payload };
}

describe("lead roles and assembly", () => {
  it("role 默认 worker，非法值拒绝；仅未设置 ROLE 的顶层允许 lead", async () => {
    const restore = setRole();
    try {
      assert.equal(resolveChildRole(undefined), "worker");
      assert.equal(resolveChildRole("worker"), "worker");
      assert.equal(resolveChildRole("lead"), "lead");
      for (const value of [null, "controller", "", 1, {}, true]) {
        assert.throws(() => resolveChildRole(value), /role/);
      }
      for (const role of ["lead", "worker", "", "invalid"]) {
        process.env[roleEnv] = role;
        assert.throws(() => resolveChildRole("lead"), /顶层主控/);
        const coordinator = new MultiWorkerCoordinator(new FakePiAPI() as any);
        await assert.rejects(coordinator.handleWorkerStart({ role: "lead", cwd: process.cwd(), title: "x", task: "x" }), /顶层主控/);
        assert.equal(coordinator.size, 0);
        const ctrl = new ControllerManager(new FakePiAPI() as any);
        await assert.rejects(ctrl.handleWorkerStart({ role: "lead", cwd: process.cwd(), title: "x", task: "x" }), /顶层主控/);
        assert.equal(ctrl.workerManager.hasActiveInstance(), false);
        await ctrl.dispose();
      }
    } finally { restore(); }
  });

  it("lead 装配双能力，过滤不冲突、命令各自唯一，worker 不装协调器", async () => {
    const restore = setRole("lead");
    const h = await setupLead();
    try {
      const names = h.pi.getActiveTools();
      for (const name of ["worker_start", "worker_send", "worker_wait", "worker_status", "worker_list", "worker_stop", "worker_close", "worker_report", "bash"]) {
        assert.ok(names.includes(name), name);
      }
      assert.ok(!names.includes("subagent"));
      assert.equal(await h.pi.emitPiEvent("tool_call", { toolName: "worker_start" }, h.ctx), undefined);
      assert.deepEqual(await h.pi.emitPiEvent("tool_call", { toolName: "subagent" }, h.ctx),
        { block: true, reason: "Worker 不允许递归派发子代理" });
      assert.ok(h.pi.commands.has("lead-status"));
      assert.ok(h.pi.commands.has("worker-status"));
      assert.match(h.pi.commands.get("worker-status").description, /所有 Worker/);
      const start = h.pi.tools.get("worker_start")!;
      await assert.rejects(start.execute("nested", { role: "lead", cwd: process.cwd(), title: "x", task: "x" } as any), /顶层主控/);
      const child = await h.handle.coordinator.handleWorkerStart({ cwd: process.cwd(), title: "child", task: "x" });
      assert.equal((await h.handle.coordinator.handleWorkerStatus({ workerId: child.workerId })).worker?.role, "worker");
      assert.equal((await h.handle.coordinator.handleWorkerList()).workers[0].role, "worker");
      assert.equal(h.handle.statusPoller.isRunning, true);

      process.env[roleEnv] = "worker";
      const workerPi = new FakePiAPI();
      withFakeConnect(() => extension(workerPi as any));
      await workerPi.emitPiEvent("session_start", {}, new FakePiContext());
      assert.ok(workerPi.tools.has("worker_report"));
      assert.ok(!workerPi.tools.has("worker_start"));
      await workerPi.emitPiEvent("session_shutdown", {}, new FakePiContext());
    } finally {
      await h.pi.emitPiEvent("session_shutdown", {}, h.ctx);
      restore();
    }
  });

  it("默认扩展入口识别 lead 并注册双能力，非法环境角色拒绝", async () => {
    const restore = setRole("lead");
    const pi = new FakePiAPI();
    try {
      withFakeConnect(() => extension(pi as any));
      await pi.emitPiEvent("session_start", {}, new FakePiContext());
      assert.ok(pi.tools.has("worker_start"));
      assert.ok(pi.tools.has("worker_report"));
      process.env[roleEnv] = "invalid";
      assert.throws(() => extension(new FakePiAPI() as any), /非法 PI_TERMINAL_WORKER_ROLE/);
    } finally { await pi.emitPiEvent("session_shutdown", {}, new FakePiContext()); restore(); }
  });

  it("lead 初始提示包含派发和末次汇报约束，worker 保留禁止派发提示", () => {
    const pi = new FakePiAPI();
    const task = { taskId: "phase", revision: 1, runId: 1, task: "test" };
    const lead = new WorkerManager(pi as any, true, { role: "lead" });
    const worker = new WorkerManager(pi as any, true, { role: "worker" });
    const prompt = (lead as any).buildTaskPrompt(task);
    assert.match(prompt, /阶段主代理/);
    assert.match(prompt, /只能 worker 角色，不能嵌套 lead/);
    assert.match(prompt, /worker_report 应是本轮最后一个工具调用/);
    assert.match((worker as any).buildTaskPrompt(task), /不得再派发子代理或启动新终端/);
  });

  it("有未关闭 L2 时不缺报且上报 waiting_children；退出/验收/放弃后恢复缺报", async () => {
    const restore = setRole("lead");
    const h = await setupLead();
    try {
      const a = await h.handle.coordinator.handleWorkerStart({ cwd: process.cwd(), title: "a", task: "x" });
      const b = await h.handle.coordinator.handleWorkerStart({ cwd: process.cwd(), title: "b", task: "x" });
      assert.equal(h.handle.coordinator.getActiveChildCount(), 2);
      // ready_for_review、closing、失联占位仍属活跃。
      h.children[0].workerManager.updateTaskState("ready_for_review");
      h.children[0].workerManager.updateLifecycleState("closing");
      h.children[1].workerManager.updateLifecycleState("disconnected");
      await h.pi.emitPiEvent("agent_settled", {}, h.ctx);
      await tick();
      assert.ok(!h.upstream.frames.some((e) => e.type === "report_missing"));
      assert.ok(h.upstream.frames.some((e) => e.type === "activity" && e.payload.state === "waiting_children"));
      validatePayload("activity", { state: "waiting_children" });
      h.children[0].workerManager.updateLifecycleState("closed");
      assert.equal(h.handle.coordinator.getActiveChildCount(), 1);
      h.children[1].workerManager.updateTaskState("accepted");
      assert.equal(h.handle.coordinator.getActiveChildCount(), 0);
      h.children[1].workerManager.updateTaskState("abandoned");
      assert.equal(h.handle.coordinator.getActiveChildCount(), 0);
      await h.pi.emitPiEvent("agent_settled", {}, h.ctx);
      assert.equal(h.upstream.frames.filter((e) => e.type === "report_missing").length, 1);
      assert.equal((await h.handle.coordinator.handleWorkerStatus({ workerId: a.workerId })).worker?.role, "worker");
      assert.ok(b.workerId);
    } finally { await h.pi.emitPiEvent("session_shutdown", {}, h.ctx); restore(); }
  });

  it("L2 custom 唤醒不触发 local_input，也不清空 L0 队列或作废候选", async () => {
    const restore = setRole("lead");
    const h = await setupLead();
    try {
      await h.handle.coordinator.handleWorkerStart({ cwd: process.cwd(), title: "a", task: "x" });
      const worker: any = h.handle.worker;
      h.ctx.idleState = false;
      for (const [index, message] of ["first", "second"].entries()) {
        worker.handleControllerEnvelope(controllerEnvelope(worker, "followup", {
          taskId: "phase-task", revision: 1, runId: index + 2, message, kind: "supplement",
        }));
      }
      await h.pi.tools.get("worker_report")!.execute("report", { kind: "result", summary: "candidate" } as any);
      const candidate = worker.currentCandidate;
      (h.children[0] as any).appendInbox("report_committed", { report: { kind: "result", summary: "L2 done" } }, "child-task", 1, 1);
      assert.equal(h.pi.customMessages.length, 1);
      assert.equal(h.pi.customMessages[0].message.customType, WORKER_NOTIFICATION_CUSTOM_TYPE);
      assert.deepEqual(h.pi.customMessages[0].options, { triggerTurn: true, deliverAs: "followUp" });
      assert.equal(worker.followupQueue.length, 2);
      assert.equal(worker.currentCandidate, candidate);
      await h.pi.emitPiEvent("input", { source: "extension", text: "L0 followup" }, h.ctx);
      assert.equal(worker.followupQueue.length, 2);
      assert.equal(worker.currentCandidate, candidate);
      assert.ok(!h.upstream.frames.some((e) => e.type === "local_input"));
      h.ctx.idleState = true;
      h.ctx.pendingMessages = true; // Pi 仍有 L2 custom notification 待处理。
      await h.pi.emitPiEvent("agent_settled", {}, h.ctx);
      await tick();
      assert.equal(h.pi.sentUserMessages.length, 0);
      h.ctx.pendingMessages = false;
      await h.pi.emitPiEvent("agent_settled", {}, h.ctx);
      await tick();
      assert.match(h.pi.sentUserMessages[0].content, /first/);
      await h.pi.emitPiEvent("agent_settled", {}, h.ctx);
      await tick();
      assert.match(h.pi.sentUserMessages[1].content, /second/);
      assert.ok(h.pi.sentUserMessages.every((m) => m.options?.deliverAs === "followUp"));
      // 真正本地人工输入仍生效。
      worker.currentCandidate = candidate;
      await h.pi.emitPiEvent("input", { source: "interactive", text: "stop" }, h.ctx);
      assert.equal(worker.currentCandidate, null);
      assert.equal(h.upstream.frames.filter((e) => e.type === "local_input").length, 1);
    } finally { await h.pi.emitPiEvent("session_shutdown", {}, h.ctx); restore(); }
  });

  it("无 L2 但仍有 L0/L2 排队消息时暂缓缺报，上行新消息不会越过旧队列", async () => {
    const restore = setRole("lead");
    const h = await setupLead();
    try {
      const worker: any = h.handle.worker;
      h.ctx.idleState = false;
      worker.handleControllerEnvelope(controllerEnvelope(worker, "followup", {
        taskId: "phase-task", revision: 1, runId: 2, message: "older", kind: "supplement",
      }));
      h.ctx.idleState = true;
      worker.handleControllerEnvelope(controllerEnvelope(worker, "followup", {
        taskId: "phase-task", revision: 1, runId: 3, message: "newer", kind: "supplement",
      }));
      assert.equal(h.pi.sentUserMessages.length, 0, "新消息不能越过队列中旧消息");
      await h.pi.emitPiEvent("agent_settled", {}, h.ctx);
      await tick();
      assert.match(h.pi.sentUserMessages[0].content, /older/);
      assert.ok(!h.upstream.frames.some((e) => e.type === "report_missing"));
      await h.pi.emitPiEvent("agent_settled", {}, h.ctx);
      await tick();
      assert.match(h.pi.sentUserMessages[1].content, /newer/);
      h.ctx.pendingMessages = true;
      await h.pi.emitPiEvent("agent_settled", {}, h.ctx);
      assert.ok(!h.upstream.frames.some((e) => e.type === "report_missing"));
      h.ctx.pendingMessages = false;
      await h.pi.emitPiEvent("agent_settled", {}, h.ctx);
      assert.equal(h.upstream.frames.filter((e) => e.type === "report_missing").length, 1);
    } finally { await h.pi.emitPiEvent("session_shutdown", {}, h.ctx); restore(); }
  });

  it("lead session_start 先清空旧上行任务，再等待 L2 会话清理", async () => {
    const restore = setRole("lead");
    const h = await setupLead();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    try {
      const worker: any = h.handle.worker;
      worker.currentCandidate = { kind: "result", summary: "old session" };
      h.ctx.idleState = false;
      worker.handleControllerEnvelope(controllerEnvelope(worker, "followup", {
        taskId: "phase-task", revision: 1, runId: 2, message: "old queue", kind: "supplement",
      }));
      const original = h.handle.coordinator.handleSessionStart.bind(h.handle.coordinator);
      h.handle.coordinator.handleSessionStart = async () => { await barrier; await original(); };
      const switching = h.pi.emitPiEvent("session_start", {}, new FakePiContext());
      assert.equal(worker.currentTaskId, null);
      assert.equal(worker.currentCandidate, null);
      assert.equal(worker.followupQueue.length, 0);
      release();
      await switching;
    } finally { release(); await h.pi.emitPiEvent("session_shutdown", {}, h.ctx); restore(); }
  });

  it("lead shutdown 在等待 L2 清理前先使上行消息失效", async () => {
    const restore = setRole("lead");
    const h = await setupLead();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    try {
      await h.handle.coordinator.handleWorkerStart({ cwd: process.cwd(), title: "a", task: "x" });
      const original = h.children[0].dispose.bind(h.children[0]);
      h.children[0].dispose = async () => { await barrier; await original(); };
      const closing = h.pi.emitPiEvent("session_shutdown", {}, h.ctx);
      assert.equal(h.upstream.conn.socket.destroyed, true);
      assert.equal((h.handle.worker as any).currentContext, null);
      const worker: any = h.handle.worker;
      worker.handleControllerEnvelope(controllerEnvelope(worker, "followup", {
        taskId: "phase-task", revision: 1, runId: 2, message: "too late", kind: "supplement",
      }));
      assert.equal(h.pi.sentUserMessages.length, 0);
      release();
      await closing;
      assert.equal(h.handle.coordinator.size, 0);
    } finally { release(); await h.pi.emitPiEvent("session_shutdown", {}, h.ctx); restore(); }
  });

  it("L0 close 触发 lead shutdown，并清理全部 L2 连接、登记与状态栏", async () => {
    const restore = setRole("lead");
    const h = await setupLead();
    try {
      await h.handle.coordinator.handleWorkerStart({ cwd: process.cwd(), title: "a", task: "x" });
      await h.handle.coordinator.handleWorkerStart({ cwd: process.cwd(), title: "b", task: "x" });
      const childConnections = h.children.map((c) => (c as any).workerConn);
      let shutdown: Promise<any> | undefined;
      h.ctx.shutdown = () => {
        h.ctx.shutDown = true;
        shutdown = h.pi.emitPiEvent("session_shutdown", {}, h.ctx);
      };
      const worker: any = h.handle.worker;
      worker.handleControllerEnvelope(controllerEnvelope(worker, "close", { disposition: "abandoned" }));
      await new Promise((resolve) => setTimeout(resolve, 240));
      assert.ok(shutdown);
      await shutdown;
      assert.equal(h.ctx.shutDown, true);
      assert.equal(h.handle.coordinator.size, 0);
      assert.equal(h.handle.statusPoller.isRunning, false);
      assert.equal(h.ctx.statuses.get("worker"), undefined);
      assert.equal(h.upstream.conn.socket.destroyed, true);
      for (const [index, conn] of childConnections.entries()) {
        assert.equal(conn.socket.destroyed, true);
        assert.equal((h.children[index] as any).__testChildFrames.filter((e: any) => e.type === "close").length, 1);
      }
      await h.pi.emitPiEvent("session_shutdown", {}, h.ctx); // 幂等
    } finally { await h.pi.emitPiEvent("session_shutdown", {}, h.ctx); restore(); }
  });
});

describe("role startup descriptors", () => {
  const descriptor = { version: 1 as const, controllerId: "c", workerId: "w", pipePath: "p", bootstrapToken: "t" };
  it("描述符校验允许两种角色和正整数 ownerPid，拒绝非法值", () => {
    for (const role of [undefined, "worker", "lead"]) {
      const value = { ...descriptor, ...(role === undefined ? {} : { role }), ownerPid: 123 };
      assert.deepEqual(decodeDescriptor(encodeDescriptor(value as any)), value);
    }
    for (const role of [null, "", "controller", 3, {}]) {
      assert.throws(() => decodeDescriptor(encodeDescriptor({ ...descriptor, role } as any)), /描述符/);
    }
    for (const ownerPid of [null, 0, -1, 1.5, "12", Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => decodeDescriptor(encodeDescriptor({ ...descriptor, ownerPid } as any)), /描述符/);
    }
  });

  for (const scenario of [
    { parent: undefined, role: undefined, expected: "worker", owner: false },
    { parent: undefined, role: "lead", expected: "lead", owner: false },
    { parent: "lead", role: undefined, expected: "worker", owner: true },
  ]) {
    it(`启动描述符 parent=${scenario.parent} role=${scenario.role} 写入角色与 owner 边界`, async () => {
      const restore = setRole(scenario.parent);
      const ctrl = new ControllerManager(new FakePiAPI() as any, true);
      let captured: any;
      try {
        // 固定握手边界，真正执行 ControllerManager 的角色校验/描述符生成/任务派发。
        (ctrl as any).startServer = async () => "test-pipe";
        ctrl.launchSpawner = ((_command: string, args: string[]) => {
          captured = decodeDescriptor(args[args.indexOf("--descriptor") + 1]);
          return new EventEmitter();
        }) as any;
        (ctrl as any).waitForSupervisor = async () => {};
        (ctrl as any).waitForWorkerReady = async () => {};
        (ctrl as any).supervisorConn = makeConnection().conn;
        (ctrl as any).workerConn = makeConnection().conn;
        // handleWorkerStart 清理旧引用，因此在握手回调重新装入连接。
        (ctrl as any).waitForSupervisor = async () => { (ctrl as any).supervisorConn = makeConnection().conn; };
        (ctrl as any).waitForWorkerReady = async () => { (ctrl as any).workerConn = makeConnection().conn; };
        const result = await ctrl.handleWorkerStart({ cwd: process.cwd(), title: "test", task: "x", role: scenario.role as any }, {
          platform: "win32", findWt: () => "wt.exe", findPowershell: () => null, findCmd: () => null,
        });
        assert.equal(result.ok, true);
        assert.equal(captured.role, scenario.expected);
        assert.equal(captured.ownerPid, scenario.owner ? process.pid : undefined);
        assert.equal((await ctrl.handleWorkerStatus({ workerId: result.workerId })).worker?.role, scenario.expected);
      } finally { await ctrl.dispose(); restore(); }
    });
  }
});
