/**
 * MultiWorkerCoordinator 阶段 A 协调器级测试
 *
 * 覆盖验收门槛：
 * - 两个 Worker 各自登记独立 ControllerManager / workerId / taskId / controllerId / pipe；
 * - 启动第二个 Worker 不会触发第一个实例的 resetSessionScopedState()/startServer()；
 * - 六个主控操作按 workerId 精确路由，未知 workerId 返回 NOT_FOUND；
 * - 同一批生命周期状态读取按实例隔离，worker_wait 游标/事件不交叉；
 * - dispose 清理所有实例且幂等；启动失败按“确认退出”回收登记。
 *
 * 测试通过 controllerFactory 注入真实 ControllerManager，并沿用
 * test/connection.test.ts 的 FakeSocket/handshake 注入方式，不实际开窗。
 */

import { describe, it } from "node:test";
import * as assert from "node:assert";
import { EventEmitter } from "node:events";
import { ControllerManager } from "../dist/controller.js";
import { MultiWorkerCoordinator } from "../dist/multi-worker.js";
import type { WorkerEntry } from "../dist/multi-worker.js";
import {
  ProtocolErrorCode,
  MAX_INBOX_EVENTS,
  MAX_INBOX_BYTES,
  MAX_REPORT_CACHE_SIZE,
  MAX_REPORT_CACHE_BYTES,
  jsonByteLength,
} from "../dist/protocol.js";
import { getPipePath } from "../dist/transport.js";
import type { TerminalProbes } from "../dist/launcher.js";
import { WorkerStatusBarPoller } from "../dist/ui.js";
import { FakePiAPI, FakePiContext } from "./fake-pi.ts";

/** 轻量假管道 Socket：实现 JsonlConnection 所需的最小接口 */
class FakeSocket extends EventEmitter {
  public destroyed = false;
  public written: string[] = [];
  public autoAckTypes = new Set<string>();
  /** 本连接已发送的入站帧最大 seq；严格协议要求入站 seq 严格递增 */
  public outboundSeq = 0;

  public write(data: unknown, encoding?: unknown, cb?: unknown): boolean {
    const str = typeof data === "string" ? data : Buffer.from(data as any).toString("utf8");
    this.written.push(str);
    const callback = typeof encoding === "function" ? encoding : cb;
    if (typeof callback === "function") {
      queueMicrotask(() => (callback as (e: null) => void)(null));
    }

    if (this.autoAckTypes.size > 0) {
      try {
        const env = JSON.parse(str.trim());
        if (env && typeof env.id === "string" && !env.replyTo && this.autoAckTypes.has(env.type)) {
          const ack = {
            version: 1,
            controllerId: env.controllerId,
            workerId: env.workerId,
            id: "ack-" + env.id,
            replyTo: env.id,
            seq: ++this.outboundSeq,
            type: "ack",
            payload: { id: env.id, ok: true },
          };
          queueMicrotask(() => this.emit("data", Buffer.from(JSON.stringify(ack) + "\n", "utf8")));
        }
      } catch {
        // 非 JSON 帧忽略
      }
    }
    return true;
  }

  public destroy(): void {
    this.destroyed = true;
  }

  public get frames(): any[] {
    return this.written
      .join("")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }
}

const TEST_PROBES: Partial<TerminalProbes> = {
  findWt: () => "wt.exe",
  findPowershell: () => null,
  findCmd: () => null,
};

function helloFrame(
  role: "supervisor" | "worker",
  controllerId: string,
  workerId: string,
  token: string,
  id?: string,
): any {
  return {
    version: 1,
    controllerId,
    workerId,
    id: id ?? `hello-${role}`,
    seq: 1,
    type: "hello",
    payload: { role, token, controllerId, workerId },
  };
}

function feed(sock: FakeSocket, env: any): void {
  if (typeof env?.seq === "number") {
    sock.outboundSeq = Math.max(sock.outboundSeq, env.seq);
  }
  sock.emit("data", Buffer.from(JSON.stringify(env) + "\n", "utf8"));
}

async function waitFor(cond: () => unknown, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("等待条件超时");
}

interface Harness {
  coordinator: MultiWorkerCoordinator;
  pi: FakePiAPI;
  controllers: ControllerManager[];
}

interface HarnessOptions {
  /** 每个 ControllerManager 的启动超时；数组按创建顺序取值，便于让 A 先超时而 B 仍成功 */
  launchTimeoutMs?: number | number[];
  /** 测试注入的确定性/冲突 ID 生成器 */
  idGenerator?: () => { controllerId: string; workerId: string; taskId: string };
}

/** 创建注入真实 ControllerManager 的协调器；不实际开窗、不依赖真实终端探测 */
function createHarness(pi = new FakePiAPI(), opts: HarnessOptions = {}): Harness {
  const controllers: ControllerManager[] = [];
  const coordinator = new MultiWorkerCoordinator(pi as any, {
    strictProtocol: true,
    idGenerator: opts.idGenerator,
    controllerFactory: () => {
      const ctrl = new ControllerManager(pi as any, true);
      ctrl.launchSpawner = (() => new EventEmitter() as any) as any;
      const idx = controllers.length;
      const configured = Array.isArray(opts.launchTimeoutMs)
        ? opts.launchTimeoutMs[idx]
        : opts.launchTimeoutMs;
      ctrl.launchTimeoutMs = configured ?? 3000;

      // 统计每个内核自己的 startServer / resetSessionScopedState 调用次数
      const origStart = ctrl.startServer.bind(ctrl);
      (ctrl as any).__startServerCalls = 0;
      (ctrl as any).startServer = (id: string) => {
        (ctrl as any).__startServerCalls += 1;
        return origStart(id);
      };
      const origReset = (ctrl as any).resetSessionScopedState.bind(ctrl);
      (ctrl as any).__resetCalls = 0;
      (ctrl as any).resetSessionScopedState = () => {
        (ctrl as any).__resetCalls += 1;
        return origReset();
      };

      // 协调器不暴露 probes，注入固定终端探测避免真实 where 探测
      const origHandleStart = ctrl.handleWorkerStart.bind(ctrl);
      ctrl.handleWorkerStart = ((params: any, _probes: any, internal: any) =>
        origHandleStart(params, TEST_PROBES, internal)) as any;

      controllers.push(ctrl);
      return ctrl;
    },
  });
  return { coordinator, pi, controllers };
}

/** 清理协调器：先摘除连接避免 dispose 等待不会到来的 close ACK，再逐一释放 */
async function teardown(h: Harness): Promise<void> {
  for (const c of h.controllers) {
    (c as any).workerConn = null;
    (c as any).supervisorConn = null;
  }
  await h.coordinator.dispose();
}

interface StartedWorker {
  workerId: string;
  taskId: string;
  controllerId: string;
  controller: ControllerManager;
  supSock: FakeSocket;
  workerSock: FakeSocket;
}
/** 启动一个 Worker 并完成 supervisor/worker 握手，返回其独立实例信息 */
async function startAndComplete(
  h: Harness,
  params: { cwd: string; title: string; task: string },
): Promise<StartedWorker> {
  const before = new Set(h.coordinator.listWorkerIds());
  const startPromise = h.coordinator.handleWorkerStart(params);

  // 协调器同步登记：调用返回时即可按新 workerId 找到实例
  const workerId = h.coordinator.listWorkerIds().find((id) => !before.has(id));
  assert.ok(workerId, "worker_start 必须同步登记 WorkerEntry");
  const entry = h.coordinator.getEntry(workerId!)!;
  const { controller, controllerId, taskId } = entry;

  const bootToken = (controller as any).expectedBootstrapToken as string;
  const workerToken = (controller as any).expectedWorkerToken as string;
  assert.ok(bootToken && workerToken, "底层控制器必须已生成独立 token");

  const supSock = new FakeSocket();
  supSock.autoAckTypes = new Set(["launch"]);
  (controller as any).handleIncomingSocket(supSock as any);
  feed(supSock, helloFrame("supervisor", controllerId, workerId!, bootToken, `hello-sup-${workerId}`));
  await waitFor(() => (controller as any).supervisorConn);

  const workerSock = new FakeSocket();
  workerSock.autoAckTypes = new Set(["task"]);
  (controller as any).handleIncomingSocket(workerSock as any);
  feed(workerSock, helloFrame("worker", controllerId, workerId!, workerToken, `hello-work-${workerId}`));
  await waitFor(() => (controller as any).workerConn);

  feed(workerSock, {
    version: 1,
    controllerId,
    workerId: workerId!,
    id: `ready-${workerId}`,
    seq: 2,
    type: "worker_ready",
    payload: { cwd: process.cwd(), tools: [], version: "1" },
  });

  const res = await startPromise;
  assert.strictEqual(res.ok, true, "初始任务必须被接受");
  return { workerId: workerId!, taskId, controllerId, controller, supSock, workerSock };
}

/** 并发 start 场景：完成 supervisor + worker 两条连接认证，但暂不发送 worker_ready */
async function openConnections(entry: WorkerEntry): Promise<{
  supSock: FakeSocket;
  workerSock: FakeSocket;
}> {
  const controller = entry.controller as any;
  const bootToken = controller.expectedBootstrapToken as string;
  const workerToken = controller.expectedWorkerToken as string;

  const supSock = new FakeSocket();
  supSock.autoAckTypes = new Set(["launch"]);
  controller.handleIncomingSocket(supSock as any);
  feed(
    supSock,
    helloFrame("supervisor", entry.controllerId, entry.workerId, bootToken, `hello-sup-${entry.workerId}`),
  );
  await waitFor(() => controller.supervisorConn);

  const workerSock = new FakeSocket();
  workerSock.autoAckTypes = new Set(["task"]);
  controller.handleIncomingSocket(workerSock as any);
  feed(
    workerSock,
    helloFrame("worker", entry.controllerId, entry.workerId, workerToken, `hello-work-${entry.workerId}`),
  );
  await waitFor(() => controller.workerConn);

  return { supSock, workerSock };
}

/** 发送 worker_ready 帧（seq 必须在 hello 之后严格递增） */
function feedReady(entry: WorkerEntry, workerSock: FakeSocket): void {
  feed(workerSock, {
    version: 1,
    controllerId: entry.controllerId,
    workerId: entry.workerId,
    id: `ready-${entry.workerId}`,
    seq: 2,
    type: "worker_ready",
    payload: { cwd: process.cwd(), tools: [], version: "1" },
  });
}

/** 同步发起一次 start 并立刻取回该次产生的登记项 (Map 写入不跨 await) */
function beginStart(
  h: Harness,
  params: { cwd: string; title: string; task: string },
): { promise: ReturnType<MultiWorkerCoordinator["handleWorkerStart"]>; entry: WorkerEntry } {
  const before = new Set(h.coordinator.listWorkerIds());
  const promise = h.coordinator.handleWorkerStart(params);
  const workerId = h.coordinator.listWorkerIds().find((id) => !before.has(id));
  assert.ok(workerId, "worker_start 必须在返回 promise 前同步登记");
  return { promise, entry: h.coordinator.getEntry(workerId!)! };
}

describe("MultiWorkerCoordinator 阶段 A：登记、路由与隔离", () => {
  it("只注册一次工具与命令，且新增 Worker 不重复注册", async () => {
    const h = createHarness();
    h.coordinator.registerToolsAndCommands();

    assert.deepStrictEqual(
      [...h.pi.tools.keys()].sort(),
      [
        "worker_close",
        "worker_list",
        "worker_send",
        "worker_start",
        "worker_status",
        "worker_stop",
        "worker_wait",
      ],
    );
    assert.deepStrictEqual(
      [...h.pi.commands.keys()].sort(),
      ["worker-close", "worker-forget", "worker-status", "worker-stop"],
    );

    // 启动两个 Worker 不会再次注册同名工具/命令
    await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });
    assert.strictEqual(h.pi.tools.size, 7, "工具注册总数必须保持 7");
    assert.strictEqual(h.pi.commands.size, 4, "命令注册总数必须保持 4");

    await teardown(h);
  });

  it("两个 Worker 使用独立实例、ID、pipe 与连接；启动第二个不触碰第一个", async () => {
    const h = createHarness();
    h.coordinator.registerToolsAndCommands();

    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const aStartCalls = (a.controller as any).__startServerCalls as number;
    const aResetCalls = (a.controller as any).__resetCalls as number;
    assert.strictEqual(aStartCalls, 1, "A 启动时调用一次 startServer");
    assert.strictEqual(aResetCalls, 1, "A 启动时调用一次 resetSessionScopedState");

    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });

    // 身份完全独立
    assert.notStrictEqual(a.workerId, b.workerId);
    assert.notStrictEqual(a.taskId, b.taskId);
    assert.notStrictEqual(a.controllerId, b.controllerId);
    assert.notStrictEqual(a.controller, b.controller, "每个 Worker 必须独占 ControllerManager");
    assert.strictEqual(h.coordinator.size, 2);

    // pipe 路径、连接、token 完全独立
    assert.strictEqual((a.controller as any).pipePath, getPipePath(a.controllerId));
    assert.strictEqual((b.controller as any).pipePath, getPipePath(b.controllerId));
    assert.notStrictEqual((a.controller as any).pipePath, (b.controller as any).pipePath);
    assert.strictEqual((a.controller as any).workerConn.socket, a.workerSock);
    assert.strictEqual((b.controller as any).workerConn.socket, b.workerSock);
    assert.notStrictEqual((a.controller as any).expectedWorkerToken, (b.controller as any).expectedWorkerToken);

    // 启动 B 不得再次触发 A 的内核启动/重置
    assert.strictEqual((a.controller as any).__startServerCalls, 1, "启动 B 不得再调用 A.startServer");
    assert.strictEqual((a.controller as any).__resetCalls, 1, "启动 B 不得再调用 A.resetSessionScopedState");
    assert.strictEqual((b.controller as any).__startServerCalls, 1);
    assert.strictEqual((b.controller as any).__resetCalls, 1);

    await teardown(h);
  });

  it("按 workerId 精确路由 send/status，未知 ID 返回 NOT_FOUND", async () => {
    const h = createHarness();
    h.coordinator.registerToolsAndCommands();

    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });

    // —— status 读取按实例隔离 ——
    const statusA = await h.coordinator.handleWorkerStatus({ workerId: a.workerId });
    const statusB = await h.coordinator.handleWorkerStatus({ workerId: b.workerId });
    assert.strictEqual(statusA.worker?.workerId, a.workerId);
    assert.strictEqual(statusA.worker?.taskId, a.taskId);
    assert.strictEqual(statusB.worker?.workerId, b.workerId);
    assert.strictEqual(statusB.worker?.taskId, b.taskId);

    // 只改 A 的任务状态，B 不受影响
    a.controller.workerManager.updateTaskState("waiting_reply");
    const statusA2 = await h.coordinator.handleWorkerStatus({ workerId: a.workerId });
    const statusB2 = await h.coordinator.handleWorkerStatus({ workerId: b.workerId });
    assert.strictEqual(statusA2.worker?.taskState, "waiting_reply");
    assert.notStrictEqual(statusB2.worker?.taskState, "waiting_reply");

    // —— send 只投递到目标实例的连接 ——
    const aCalls: any[] = [];
    const bCalls: any[] = [];
    (a.controller as any).workerConn.sendRequest = async (env: any) => {
      aCalls.push(env);
      return { ok: true };
    };
    (b.controller as any).workerConn.sendRequest = async (env: any) => {
      bCalls.push(env);
      return { ok: true };
    };
    const sendRes = await h.coordinator.handleWorkerSend({
      workerId: a.workerId,
      taskId: a.taskId,
      message: "补充说明",
      kind: "supplement",
    });
    assert.strictEqual(sendRes.ok, true);
    assert.strictEqual(aCalls.length, 1, "A 的连接必须收到 followup");
    assert.strictEqual(aCalls[0].type, "followup");
    assert.strictEqual(bCalls.length, 0, "B 的连接不得收到 A 的消息");

    // —— 通过已注册工具调用同样按 workerId 路由 ——
    const statusTool = h.pi.tools.get("worker_status")!;
    const toolRes: any = await statusTool.execute("t-status", { workerId: b.workerId });
    assert.strictEqual(toolRes.details.worker.workerId, b.workerId);

    // —— 未知 workerId：六个操作都应返回 NOT_FOUND，绝不命中其他实例 ——
    await assert.rejects(
      () => h.coordinator.handleWorkerSend({ workerId: "worker-missing", taskId: "t", message: "x", kind: "reply" }),
      new RegExp(ProtocolErrorCode.NOT_FOUND),
    );
    await assert.rejects(
      () => h.coordinator.handleWorkerWait({ workerId: "worker-missing", timeoutMs: 1000 }),
      new RegExp(ProtocolErrorCode.NOT_FOUND),
    );
    await assert.rejects(
      () => h.coordinator.handleWorkerStatus({ workerId: "worker-missing" }),
      new RegExp(ProtocolErrorCode.NOT_FOUND),
    );
    await assert.rejects(
      () => h.coordinator.handleWorkerStop({ workerId: "worker-missing" }),
      new RegExp(ProtocolErrorCode.NOT_FOUND),
    );
    await assert.rejects(
      () => h.coordinator.handleWorkerClose({ workerId: "worker-missing", disposition: "abandoned" }),
      new RegExp(ProtocolErrorCode.NOT_FOUND),
    );
    await assert.rejects(
      () => statusTool.execute("t-missing", { workerId: "worker-missing" }),
      new RegExp(ProtocolErrorCode.NOT_FOUND),
    );

    await teardown(h);
  });

  it("worker_wait 的事件与游标按实例隔离，同一游标可在两个 Worker 上独立解释", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });

    // 各实例注入同游标的可操作关键事件（worker_wait 只匹配关键事件，普通进度不唤醒）
    (a.controller as any).appendInbox("report_committed", { note: "A" }, a.taskId, 1, 1);
    (b.controller as any).appendInbox("report_committed", { note: "B" }, b.taskId, 1, 1);

    const waitA = await h.coordinator.handleWorkerWait({ workerId: a.workerId, afterCursor: 0 });
    const waitB = await h.coordinator.handleWorkerWait({ workerId: b.workerId, afterCursor: 0 });

    assert.strictEqual(waitA.event.taskId, a.taskId, "A 的等待必须命中 A 的事件");
    assert.strictEqual(waitB.event.taskId, b.taskId, "B 的等待必须命中 B 的事件");
    assert.strictEqual(waitA.event.cursor, waitB.event.cursor, "不同实例的游标可以从同一数值开始");

    // A 已消费的默认游标与 B 无关：A 默认再等会超时；但显式 afterCursor 仍可重放
    const aAgain = await h.coordinator.handleWorkerWait({ workerId: a.workerId, timeoutMs: 1000 });
    assert.strictEqual(aAgain.event.type, "wait_timeout", "默认消费后不得重复返回同一事件");
    const aReplay = await h.coordinator.handleWorkerWait({
      workerId: a.workerId,
      afterCursor: 0,
      timeoutMs: 1000,
    });
    assert.strictEqual(aReplay.event.cursor, waitA.event.cursor, "显式 afterCursor 仍可重放");

    const statusB = await h.coordinator.handleWorkerStatus({ workerId: b.workerId });
    assert.strictEqual(statusB.worker?.lifecycleState, "connected", "B 的登记不得受 A 等待影响");

    await teardown(h);
  });

  it("主动通知按实例隔离：A 的关键事件只推送 A 的 workerId", async () => {
    const h = createHarness();
    const sent: Array<{ message: any; options: any }> = [];
    (h.pi as any).sendMessage = (message: any, options: any) => sent.push({ message, options });

    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });
    sent.length = 0;

    (a.controller as any).appendInbox("report_committed", { note: "A" }, a.taskId, 1, 1);
    assert.strictEqual(sent.length, 1, "A 的关键事件只推送一次");
    assert.deepStrictEqual(sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
    const text = sent[0].message.content[0].text as string;
    assert.match(text, new RegExp(`workerId=${a.workerId}`), "必须携带 A 的 workerId");
    assert.ok(!text.includes(b.workerId), "不得混入 B 的 workerId");

    await teardown(h);
  });

  it("worker_wait 通过注册工具 execute 接收 signal 并支持取消（多实例入口）", async () => {
    const h = createHarness();
    h.coordinator.registerToolsAndCommands();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });

    const tool = h.pi.tools.get("worker_wait") as any;
    assert.ok(tool, "worker_wait 工具必须已注册");

    const ac = new AbortController();
    const pending = tool.execute("t-wait", { workerId: a.workerId, timeoutMs: 60000 }, ac.signal);
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual((a.controller as any).waiters.length, 1, "工具调用应挂起一个 waiter");

    ac.abort();
    await assert.rejects(() => pending, /取消/);
    assert.strictEqual((a.controller as any).waiters.length, 0, "execute 取消后必须移除 waiter");

    await teardown(h);
  });

  it("worker_close 成功后回收该实例登记并释放其资源，不影响其他实例", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });

    // 让 A 满足 abandoned 关闭所需的最小连接状态
    (a.controller as any).workerConn.sendRequest = async () => ({ ok: true });
    const closePromise = h.coordinator.handleWorkerClose({
      workerId: a.workerId,
      disposition: "abandoned",
    });
    // 模拟子进程退出确认
    setTimeout(() => a.controller.workerManager.updateLifecycleState("closed"), 30);
    const closeRes = await closePromise;

    assert.strictEqual(closeRes.ok, true);
    assert.strictEqual(h.coordinator.getEntry(a.workerId), undefined, "已关闭实例必须从 Map 移除");
    assert.strictEqual(h.coordinator.size, 1, "B 必须仍被登记");
    assert.ok(h.coordinator.getEntry(b.workerId), "B 的登记不得被误删");
    const statusB = await h.coordinator.handleWorkerStatus({ workerId: b.workerId });
    assert.strictEqual(statusB.worker?.lifecycleState, "connected", "B 连接状态不得受 A 关闭影响");

    await teardown(h);
  });

  it("dispose 清理所有登记实例且幂等", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });

    await teardown(h);
    assert.strictEqual(h.coordinator.size, 0, "dispose 后不得残留登记");
    assert.strictEqual(h.coordinator.listWorkerIds().length, 0);
    assert.strictEqual((a.controller as any).isDisposed, true);
    assert.strictEqual((b.controller as any).isDisposed, true);

    // 幂等：再次 dispose 不抛错、不改变状态
    await h.coordinator.dispose();
    assert.strictEqual(h.coordinator.size, 0);
  });

  it("参数校验失败不登记；握手超时保留占位；确认退出回收登记", async () => {
    // 场景 1：cwd 非法 → 未创建任何进程 → 立即回收
    const h1 = createHarness();
    await assert.rejects(
      () => h1.coordinator.handleWorkerStart({ cwd: "relative/not-absolute", title: "T", task: "x" }),
      /绝对路径/,
    );
    assert.strictEqual(h1.coordinator.size, 0, "参数校验失败不得残留登记");
    await teardown(h1);

    // 场景 2：握手超时（未确认退出）→ 保留占位，可按 ID 查询
    const h2 = createHarness(undefined, { launchTimeoutMs: 300 });
    const startPromise = h2.coordinator.handleWorkerStart({
      cwd: process.cwd(),
      title: "T",
      task: "x",
    });
    const timeoutId = h2.coordinator.listWorkerIds()[0];
    await assert.rejects(() => startPromise, /握手超时/);
    assert.strictEqual(h2.coordinator.size, 1, "未确认退出必须保留占位");
    const status = await h2.coordinator.handleWorkerStatus({ workerId: timeoutId });
    assert.strictEqual(status.worker?.lifecycleState, "launch_unknown");
    await teardown(h2);
    assert.strictEqual(h2.coordinator.size, 0);

    // 场景 3：supervisor 明确上报 launch_failed → 释放名额 → 回收登记
    const h3 = createHarness(undefined, { launchTimeoutMs: 2000 });
    const p3 = h3.coordinator.handleWorkerStart({ cwd: process.cwd(), title: "T", task: "x" });
    const failedId = h3.coordinator.listWorkerIds()[0];
    const entry = h3.coordinator.getEntry(failedId)!;
    const bootToken = (entry.controller as any).expectedBootstrapToken as string;
    const supSock = new FakeSocket();
    supSock.autoAckTypes = new Set(["launch"]);
    (entry.controller as any).handleIncomingSocket(supSock as any);
    feed(supSock, helloFrame("supervisor", entry.controllerId, failedId, bootToken, "hello-lf"));
    await waitFor(() => (entry.controller as any).supervisorConn);
    feed(supSock, {
      version: 1,
      controllerId: entry.controllerId,
      workerId: failedId,
      id: "lf",
      seq: 2,
      type: "launch_failed",
      payload: { error: "boom" },
    });
    await assert.rejects(() => p3, /LAUNCH_FAILED/);
    assert.strictEqual(h3.coordinator.size, 0, "确认退出必须回收登记");
    await teardown(h3);
  });

  it("多实例时 stop/close/forget 命令拒绝隐式选择目标，status 列出计数", async () => {
    const h = createHarness();
    h.coordinator.registerToolsAndCommands();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });

    let aSend = 0;
    let bSend = 0;
    (a.controller as any).workerConn.sendRequest = async () => {
      aSend++;
      return { ok: true };
    };
    (b.controller as any).workerConn.sendRequest = async () => {
      bSend++;
      return { ok: true };
    };
    const ctx = new FakePiContext();
    const invoke = (name: string) => h.pi.commands.get(name)!.handler("", ctx);

    await invoke("worker-stop");
    await invoke("worker-close");
    await invoke("worker-forget");

    assert.strictEqual(aSend, 0, "多实例时不得对 A 发送任何动作");
    assert.strictEqual(bSend, 0, "多实例时不得对 B 发送任何动作");
    assert.strictEqual(a.controller.workerManager.getInstance()?.lifecycleState, "connected");
    assert.strictEqual(b.controller.workerManager.getInstance()?.lifecycleState, "connected");
    assert.strictEqual(h.coordinator.size, 2, "多实例时不得删除任何登记");

    const refused = ctx.notifications.filter((n) => n.type === "warning").map((n) => n.message).join("\n");
    assert.ok(refused.includes(a.workerId), "提示必须列出 A 的 workerId");
    assert.ok(refused.includes(b.workerId), "提示必须列出 B 的 workerId");
    assert.ok(/workerId|阶段 C/.test(refused), "必须提示需要显式 workerId");

    await invoke("worker-status");
    assert.ok(
      ctx.notifications.some((n) => n.message.includes("2 个运行中的 Worker")),
      "worker-status 多实例应提示计数/列表",
    );

    await teardown(h);
  });

  it("已释放名额的无效 entry 不会挡住唯一活跃实例的快捷命令", async () => {
    const h = createHarness();
    h.coordinator.registerToolsAndCommands();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });

    // 模拟历史 forget 遗留：B 名额已释放但登记仍在（阶段 A 不自动删除）
    b.controller.handleWorkerForget();
    assert.strictEqual(b.controller.workerManager.hasActiveInstance(), false);
    assert.strictEqual(h.coordinator.size, 2, "已释放名额的 entry 仍保留在 registry");

    const aFrames: any[] = [];
    (a.controller as any).workerConn.sendRequest = async (env: any) => {
      aFrames.push(env);
      return { ok: true };
    };
    const ctx = new FakePiContext();
    await h.pi.commands.get("worker-stop")!.handler("", ctx);

    assert.strictEqual(aFrames.length, 1, "必须对唯一活跃实例 A 发送 abort");
    assert.strictEqual(aFrames[0].type, "abort");
    assert.ok(ctx.notifications.some((n) => n.message.includes("已发送停止请求")));

    await teardown(h);
  });

  it("唯一活跃实例 /worker-forget 后移除无效登记并清理资源", async () => {
    const h = createHarness();
    h.coordinator.registerToolsAndCommands();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });

    const ctx = new FakePiContext();
    ctx.confirmResponse = true;
    await h.pi.commands.get("worker-forget")!.handler("", ctx);

    assert.strictEqual(h.coordinator.getEntry(a.workerId), undefined, "forget 后必须移除无效登记");
    assert.strictEqual(h.coordinator.size, 0);
    assert.strictEqual((a.controller as any).isDisposed, true, "forget 必须销毁该实例资源");
    assert.strictEqual(a.controller.workerManager.hasActiveInstance(), false);
    assert.ok(
      ctx.notifications.some((n) => n.message.includes("已强制解除 Worker 占位")),
      "必须给出解除成功通知",
    );

    await teardown(h);
  });
});

describe("MultiWorkerCoordinator 阶段 B：并发启动与同实例竞态", () => {
  const SIX_TOOLS = [
    "worker_start",
    "worker_send",
    "worker_wait",
    "worker_status",
    "worker_stop",
    "worker_close",
  ];

  it("六个主控工具声明为 parallel；慢 A 握手不阻塞快 B", async () => {
    const h = createHarness();
    h.coordinator.registerToolsAndCommands();

    // —— 执行模式：必须为 parallel，否则同批 start 会被 Pi 串行化 ——
    for (const name of SIX_TOOLS) {
      const tool = h.pi.tools.get(name) as any;
      assert.ok(tool, `工具 ${name} 必须已注册`);
      assert.strictEqual(tool.executionMode, "parallel", `${name} 必须声明 parallel`);
    }

    // —— 同批并发 start：两次调用在 await 之前都已同步登记 ——
    const a = beginStart(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = beginStart(h, { cwd: process.cwd(), title: "B", task: "任务B" });
    assert.strictEqual(h.coordinator.size, 2, "两个 start 必须各自同步登记");
    assert.notStrictEqual(a.entry.workerId, b.entry.workerId);
    assert.notStrictEqual(a.entry.taskId, b.entry.taskId);
    assert.notStrictEqual(a.entry.controller, b.entry.controller);
    assert.notStrictEqual(a.entry.controllerId, b.entry.controllerId);

    // —— A 只完成两条连接，故意不给 worker_ready；B 完整握手并 ready ——
    const aConns = await openConnections(a.entry);
    const bConns = await openConnections(b.entry);
    feedReady(b.entry, bConns.workerSock);

    const resB = await b.promise;
    assert.strictEqual(resB.ok, true, "B 必须能先完成");
    assert.strictEqual(resB.workerId, b.entry.workerId);

    let aSettled = false;
    void a.promise.then(
      () => {
        aSettled = true;
      },
      () => {
        aSettled = true;
      },
    );
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(aSettled, false, "A 握手未完成前不得因 B 抢先而提前 settle");
    assert.strictEqual(h.coordinator.size, 2, "A 的登记不得被 B 的完成影响");

    // 完成 A 的 ready 后才应返回
    feedReady(a.entry, aConns.workerSock);
    const resA = await a.promise;
    assert.strictEqual(resA.ok, true);
    assert.strictEqual(resA.workerId, a.entry.workerId);

    // 两个实例的 pipe 路径必须独立
    assert.strictEqual((a.entry.controller as any).pipePath, getPipePath(a.entry.controllerId));
    assert.strictEqual((b.entry.controller as any).pipePath, getPipePath(b.entry.controllerId));
    assert.notStrictEqual(
      (a.entry.controller as any).pipePath,
      (b.entry.controller as any).pipePath,
    );

    await teardown(h);
  });

  it("A 明确 launch_failed 不影响已完成的 B；A 确认退出后仅回收 A", async () => {
    const h = createHarness(undefined, { launchTimeoutMs: [500, 3000] });
    const a = beginStart(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = beginStart(h, { cwd: process.cwd(), title: "B", task: "任务B" });

    // B 先完整成功
    const bConns = await openConnections(b.entry);
    feedReady(b.entry, bConns.workerSock);
    const resB = await b.promise;
    assert.strictEqual(resB.ok, true);

    // A 明确上报 launch_failed
    const supSock = new FakeSocket();
    supSock.autoAckTypes = new Set(["launch"]);
    (a.entry.controller as any).handleIncomingSocket(supSock as any);
    feed(
      supSock,
      helloFrame(
        "supervisor",
        a.entry.controllerId,
        a.entry.workerId,
        (a.entry.controller as any).expectedBootstrapToken,
        "hello-fail",
      ),
    );
    await waitFor(() => (a.entry.controller as any).supervisorConn);
    feed(supSock, {
      version: 1,
      controllerId: a.entry.controllerId,
      workerId: a.entry.workerId,
      id: "fail",
      seq: 2,
      type: "launch_failed",
      payload: { error: "boom" },
    });

    await assert.rejects(() => a.promise, /LAUNCH_FAILED/);

    assert.strictEqual(h.coordinator.getEntry(a.entry.workerId), undefined, "A 确认退出后必须回收");
    assert.ok(h.coordinator.getEntry(b.entry.workerId), "B 登记不得被 A 的失败误删");
    const statusB = await h.coordinator.handleWorkerStatus({ workerId: b.entry.workerId });
    assert.strictEqual(statusB.worker?.lifecycleState, "connected");
    assert.strictEqual(statusB.worker?.taskState, "running");

    await teardown(h);
  });

  it("A 握手超时保留可查询占位，B 仍能独立成功", async () => {
    const h = createHarness(undefined, { launchTimeoutMs: [200, 3000] });
    const a = beginStart(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = beginStart(h, { cwd: process.cwd(), title: "B", task: "任务B" });

    // B 完整成功（不等 A）
    const bConns = await openConnections(b.entry);
    feedReady(b.entry, bConns.workerSock);
    const resB = await b.promise;
    assert.strictEqual(resB.ok, true);

    // A 从未握手 → 超时，但未确认退出 → 保留占位
    await assert.rejects(() => a.promise, /握手超时/);
    assert.strictEqual(h.coordinator.size, 2, "超时的 A 必须保留可查询占位");
    const statusA = await h.coordinator.handleWorkerStatus({ workerId: a.entry.workerId });
    assert.strictEqual(statusA.worker?.lifecycleState, "launch_unknown");
    assert.notStrictEqual(h.coordinator.getEntry(b.entry.workerId), undefined);

    await teardown(h);
  });

  it("同一 Worker 的两个 send 串行执行，runId 严格递增不乱序", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });

    const events: Array<{ runId: number; phase: "start" | "end"; at: number }> = [];
    let started = 0;
    (a.controller as any).workerConn.sendRequest = async (env: any) => {
      const at = Date.now();
      events.push({ runId: env.payload.runId, phase: "start", at });
      started += 1;
      if (started === 1) {
        await new Promise((r) => setTimeout(r, 80));
      }
      events.push({ runId: env.payload.runId, phase: "end", at: Date.now() });
      return { ok: true };
    };

    const p1 = h.coordinator.handleWorkerSend({
      workerId: a.workerId,
      taskId: a.taskId,
      message: "第一条",
      kind: "supplement",
    });
    const p2 = h.coordinator.handleWorkerSend({
      workerId: a.workerId,
      taskId: a.taskId,
      message: "第二条",
      kind: "supplement",
    });
    const [r1, r2] = await Promise.all([p1, p2]);

    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r2.ok, true);
    assert.deepStrictEqual(
      events.map((e) => `${e.runId}:${e.phase}`),
      ["2:start", "2:end", "3:start", "3:end"],
      "第二个 send 必须等第一个 send 结束后才开始，runId 递增且不乱序",
    );
    assert.ok(events[1].at <= events[2].at, "串行化必须保证第一个 send 结束后才发起第二个");

    await teardown(h);
  });

  it("不同 Worker 的 mutating 操作互不阻塞", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });

    const order: string[] = [];
    (a.controller as any).workerConn.sendRequest = async () => {
      order.push("A-start");
      await new Promise((r) => setTimeout(r, 100));
      order.push("A-end");
      return { ok: true };
    };
    (b.controller as any).workerConn.sendRequest = async () => {
      order.push("B-start");
      order.push("B-end");
      return { ok: true };
    };

    const pa = h.coordinator.handleWorkerSend({
      workerId: a.workerId,
      taskId: a.taskId,
      message: "A",
      kind: "supplement",
    });
    const pb = h.coordinator.handleWorkerSend({
      workerId: b.workerId,
      taskId: b.taskId,
      message: "B",
      kind: "supplement",
    });

    // B 不应等待 A 的慢发送
    await pb;
    assert.deepStrictEqual(order, ["A-start", "B-start", "B-end"], "B 必须先于 A 完成");
    await pa;
    assert.deepStrictEqual(order, ["A-start", "B-start", "B-end", "A-end"]);

    await teardown(h);
  });

  it("close 进入 closing 后拒绝新的 send/stop", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });

    let resolveClose!: (v: { ok: boolean; disposition: string; message: string }) => void;
    let closeCalls = 0;
    (a.controller as any).handleWorkerClose = () => {
      closeCalls += 1;
      return new Promise((r) => {
        resolveClose = r;
      });
    };

    const closeP = h.coordinator.handleWorkerClose({
      workerId: a.workerId,
      disposition: "abandoned",
    });

    await assert.rejects(
      () =>
        h.coordinator.handleWorkerSend({
          workerId: a.workerId,
          taskId: a.taskId,
          message: "关闭中不应接纳",
          kind: "supplement",
        }),
      new RegExp(ProtocolErrorCode.INVALID_STATE),
    );
    await assert.rejects(
      () => h.coordinator.handleWorkerStop({ workerId: a.workerId, reason: "关闭中" }),
      new RegExp(ProtocolErrorCode.INVALID_STATE),
    );
    assert.strictEqual(closeCalls, 1);

    resolveClose({ ok: false, disposition: "abandoned", message: "in-flight" });
    await closeP;

    // 关闭失败后解禁：后续 send 可以重新进入队列（验证不再被 closing 拒绝）
    let sendFrames = 0;
    (a.controller as any).workerConn.sendRequest = async () => {
      sendFrames += 1;
      return { ok: true };
    };
    const res = await h.coordinator.handleWorkerSend({
      workerId: a.workerId,
      taskId: a.taskId,
      message: "关闭失败后重试",
      kind: "supplement",
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(sendFrames, 1);

    await teardown(h);
  });

  it("并发 close：同 disposition 复用同一 promise，不同 disposition 明确拒绝", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });

    let closeCalls = 0;
    let resolveClose!: (v: { ok: boolean; disposition: string; message: string }) => void;
    (a.controller as any).handleWorkerClose = () => {
      closeCalls += 1;
      return new Promise((r) => {
        resolveClose = r;
      });
    };

    const p1 = h.coordinator.handleWorkerClose({
      workerId: a.workerId,
      disposition: "abandoned",
    });
    const p2 = h.coordinator.handleWorkerClose({
      workerId: a.workerId,
      disposition: "abandoned",
    });
    await assert.rejects(
      () =>
        h.coordinator.handleWorkerClose({
          workerId: a.workerId,
          disposition: "accepted",
        }),
      new RegExp(ProtocolErrorCode.INVALID_STATE),
    );
    assert.strictEqual(closeCalls, 1, "同 workerId 的 close 只应到达控制器一次");

    const marker = { ok: false, disposition: "abandoned", message: "in-flight" };
    resolveClose(marker);
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.strictEqual(r1, marker);
    assert.strictEqual(r2, marker, "同 disposition 的并发 close 必须复用同一结果");

    await teardown(h);
  });

  it("worker_wait 等待期间仍可 send，等待不被 mutating 队列占用", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    a.workerSock.autoAckTypes.add("followup");

    const waitP = h.coordinator.handleWorkerWait({
      workerId: a.workerId,
      afterCursor: 99999,
      timeoutMs: 1000,
    });
    let waitSettled = false;
    void waitP.then(() => {
      waitSettled = true;
    });

    const sendP = h.coordinator.handleWorkerSend({
      workerId: a.workerId,
      taskId: a.taskId,
      message: "等待期间发送",
      kind: "supplement",
    });
    const sendRes = await sendP;
    assert.strictEqual(sendRes.ok, true, "worker_wait 等待期间 send 必须能执行");
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(waitSettled, false, "send 不应结束/取消 worker_wait");

    const waitRes = await waitP;
    assert.strictEqual(waitRes.event.type, "wait_timeout");

    await teardown(h);
  });

  it("身份 ID 永不复用：已关闭 ID 不被新实例占用，旧 ID 查询返回 NOT_FOUND", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });

    (a.controller as any).workerConn.sendRequest = async () => ({ ok: true });
    const closeP = h.coordinator.handleWorkerClose({
      workerId: a.workerId,
      disposition: "abandoned",
    });
    setTimeout(() => a.controller.workerManager.updateLifecycleState("closed"), 30);
    await closeP;
    assert.strictEqual(h.coordinator.getEntry(a.workerId), undefined);

    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });
    assert.notStrictEqual(b.workerId, a.workerId, "新实例不得复用已关闭的 workerId");
    assert.notStrictEqual(b.taskId, a.taskId);
    assert.notStrictEqual(b.controllerId, a.controllerId);

    await assert.rejects(
      () => h.coordinator.handleWorkerStatus({ workerId: a.workerId }),
      new RegExp(ProtocolErrorCode.NOT_FOUND),
    );

    await teardown(h);
  });

  it("ID 生成器撞号时重新生成，仍能并发登记互不冲突", async () => {
    let n = 0;
    const h = createHarness(undefined, {
      // 极小启动超时，让两次 start 快速失败并释放其 pipe server，避免测试退出时泄漏
      launchTimeoutMs: 120,
      idGenerator: () => {
        n += 1;
        // 第二次故意重复第一次的 workerId，协调器必须重新生成
        const workerId = n <= 2 ? "worker-dup" : `worker-${n}`;
        return { controllerId: `ctrl-${n}`, workerId, taskId: `task-${n}` };
      },
    });

    const a = beginStart(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = beginStart(h, { cwd: process.cwd(), title: "B", task: "任务B" });

    assert.strictEqual(a.entry.workerId, "worker-dup");
    assert.notStrictEqual(b.entry.workerId, "worker-dup", "撞号必须重新生成，不得复用");
    assert.strictEqual(h.coordinator.size, 2);
    assert.notStrictEqual(
      (a.entry.controller as any).expectedWorkerToken,
      (b.entry.controller as any).expectedWorkerToken,
    );

    // 本用例不做握手；等待两次 start 确定结局后再 teardown，确保 server 已被建立并可被关闭
    await Promise.allSettled([a.promise, b.promise]);

    await teardown(h);
  });
});

describe("MultiWorkerCoordinator 阶段 C：列表、命令、会话清理与状态栏", () => {
  it("worker_list 无参返回有界摘要（含要求字段），不替代 worker_status", async () => {
    const h = createHarness();
    h.coordinator.registerToolsAndCommands();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });

    a.controller.workerManager.setModelInfo("prov-a", "model-a", "high", ["read"]);
    a.controller.workerManager.updateTaskState("ready_for_review");

    // 工具必须注册且无参数、parallel
    const tool = h.pi.tools.get("worker_list") as any;
    assert.ok(tool, "worker_list 必须已注册");
    assert.strictEqual(tool.executionMode, "parallel");
    // worker_list 无参数：TypeBox 空对象 schema（语义等价于无参数）
    assert.deepStrictEqual(tool.parameters, { type: "object", properties: {} });

    const list = await h.coordinator.handleWorkerList();
    assert.strictEqual(list.ok, true);
    assert.strictEqual(list.total, 2);
    assert.strictEqual(list.returned, 2);
    assert.strictEqual(list.truncated, false);

    const aSummary = list.workers.find((w) => w.workerId === a.workerId)!;
    assert.ok(aSummary, "列表必须包含 A");
    assert.strictEqual(aSummary.taskId, a.taskId);
    assert.strictEqual(aSummary.title, "A");
    assert.strictEqual(aSummary.cwd, process.cwd());
    assert.strictEqual(aSummary.taskState, "ready_for_review");
    assert.strictEqual(aSummary.lifecycleState, "connected");
    assert.strictEqual(aSummary.activityState, "unknown");
    assert.strictEqual(aSummary.model, "model-a");
    assert.strictEqual(typeof aSummary.createdAt, "number");
    assert.strictEqual(typeof aSummary.updatedAt, "number");
    // 仅轻量摘要：不得携带报告/收件箱等明细（明细走 worker_status）
    assert.ok(!("committedReport" in aSummary));
    assert.ok(!("inbox" in aSummary));

    // 有界：限制条数时截断但仍报告 total
    const capped = await h.coordinator.handleWorkerList(1);
    assert.strictEqual(capped.total, 2);
    assert.strictEqual(capped.returned, 1);
    assert.strictEqual(capped.truncated, true);

    // 通过已注册工具调用同样返回摘要
    const toolRes: any = await tool.execute("t-list", {});
    assert.strictEqual(toolRes.details.total, 2);
    assert.strictEqual(toolRes.details.workers.length, 2);

    await teardown(h);
  });

  it("/worker-status 无参列全部、有 ID 给单实例明细、未知 ID 提示", async () => {
    const h = createHarness();
    h.coordinator.registerToolsAndCommands();
    const ctx = new FakePiContext();

    await h.pi.commands.get("worker-status")!.handler("", ctx);
    assert.ok(
      ctx.notifications.some((n) => n.message.includes("当前没有运行中的 Worker")),
      "空状态必须给出提示",
    );

    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });

    ctx.notifications.length = 0;
    await h.pi.commands.get("worker-status")!.handler("", ctx);
    const listMsg = ctx.notifications.map((n) => n.message).join("\n");
    assert.ok(listMsg.includes("2 个运行中的 Worker"));
    assert.ok(listMsg.includes(a.workerId) && listMsg.includes(b.workerId));

    ctx.notifications.length = 0;
    await h.pi.commands.get("worker-status")!.handler(a.workerId, ctx);
    const detailMsg = ctx.notifications.map((n) => n.message).join("\n");
    assert.ok(detailMsg.includes(a.workerId));
    assert.ok(detailMsg.includes(a.taskId), "单实例明细必须含 taskId");
    assert.ok(detailMsg.includes("rev:"));
    assert.ok(!detailMsg.includes(b.workerId), "单实例明细不得混入其他实例");

    ctx.notifications.length = 0;
    await h.pi.commands.get("worker-status")!.handler("worker-missing", ctx);
    assert.ok(ctx.notifications.some((n) => n.message.includes("找不到 Worker")));

    await teardown(h);
  });

  it("/worker-stop 与 /worker-close 显式 ID 精确作用于目标实例", async () => {
    const h = createHarness();
    h.coordinator.registerToolsAndCommands();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });

    let aSend = 0;
    let bSend = 0;
    (a.controller as any).workerConn.sendRequest = async () => {
      aSend += 1;
      return { ok: true };
    };
    (b.controller as any).workerConn.sendRequest = async () => {
      bSend += 1;
      return { ok: true };
    };

    const ctx = new FakePiContext();
    await h.pi.commands.get("worker-stop")!.handler(a.workerId, ctx);
    assert.strictEqual(aSend, 1, "必须只向 A 发送停止");
    assert.strictEqual(bSend, 0, "停止 A 不得触碰 B");

    // 显式 ID 关闭 B：只移除 B，A 不受影响
    let closeCalls = 0;
    (b.controller as any).handleWorkerClose = async () => {
      closeCalls += 1;
      queueMicrotask(() => b.controller.workerManager.updateLifecycleState("closed"));
      return { ok: true, disposition: "abandoned", message: "closed-b" };
    };
    await h.pi.commands.get("worker-close")!.handler(b.workerId, ctx);
    assert.strictEqual(closeCalls, 1);
    assert.strictEqual(h.coordinator.getEntry(b.workerId), undefined, "关闭 B 后必须移除 B");
    assert.ok(h.coordinator.getEntry(a.workerId), "A 不得被 B 的关闭影响");
    assert.ok(ctx.notifications.some((n) => n.message.includes(b.workerId)));

    // 恰好一个活跃实例时允许无参快捷关闭
    const ctx2 = new FakePiContext();
    let aClose = 0;
    (a.controller as any).handleWorkerClose = async () => {
      aClose += 1;
      queueMicrotask(() => a.controller.workerManager.updateLifecycleState("closed"));
      return { ok: true, disposition: "abandoned", message: "closed-a" };
    };
    await h.pi.commands.get("worker-close")!.handler("", ctx2);
    assert.strictEqual(aClose, 1, "唯一活跃实例允许无参关闭");
    assert.strictEqual(h.coordinator.size, 0);

    await teardown(h);
  });

  it("/worker-forget 二次确认明确目标，只销毁目标实例资源且不杀进程", async () => {
    const h = createHarness();
    h.coordinator.registerToolsAndCommands();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });

    let aTerminate = 0;
    (a.controller as any).workerConn.sendRequest = async (env: any) => {
      if (env?.type === "terminate") aTerminate += 1;
      return { ok: true };
    };

    const ctx = new FakePiContext();
    const confirmCalls: Array<{ title: string; message: string }> = [];
    ctx.ui.confirm = async (title: string, message: string) => {
      confirmCalls.push({ title, message });
      return true;
    };

    let bDisposed = false;
    const origBDispose = b.controller.dispose.bind(b.controller);
    (b.controller as any).dispose = async () => {
      bDisposed = true;
      await origBDispose();
    };

    await h.pi.commands.get("worker-forget")!.handler(a.workerId, ctx);

    assert.strictEqual(confirmCalls.length, 1, "必须经过一次人工确认");
    assert.ok(confirmCalls[0].title.includes(a.workerId), "确认标题必须明确目标 ID");
    assert.ok(confirmCalls[0].message.includes(a.workerId), "确认正文必须明确目标 ID");
    assert.ok(/不会自动杀死|不杀/.test(confirmCalls[0].message), "必须说明不杀进程");
    assert.strictEqual(aTerminate, 0, "forget 不得发送 terminate 强制杀进程");
    assert.strictEqual(h.coordinator.getEntry(a.workerId), undefined, "forget 必须移除目标登记");
    assert.strictEqual((a.controller as any).isDisposed, true, "必须销毁目标实例资源");
    assert.ok(h.coordinator.getEntry(b.workerId), "不得移除其他实例");
    assert.strictEqual(bDisposed, false, "不得销毁其他实例资源");

    // 未确认时不动作
    const ctx2 = new FakePiContext();
    ctx2.confirmResponse = false;
    await h.pi.commands.get("worker-forget")!.handler(b.workerId, ctx2);
    assert.ok(h.coordinator.getEntry(b.workerId), "未确认时不得移除登记");

    await teardown(h);
  });

  it("session_start 逐实例清理：一个失败不跳过其他，旧 waiters 被取消、占位保留", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });

    const waitP = h.coordinator.handleWorkerWait({
      workerId: a.workerId,
      afterCursor: 999999,
      timeoutMs: 60000,
    });
    const waitRejects = assert.rejects(() => waitP, /会话已切换/);

    // B 的会话清理抛错，不得阻止 A 的清理
    (b.controller as any).handleSessionStart = async () => {
      throw new Error("b-session-fail");
    };

    await assert.rejects(() => h.coordinator.handleSessionStart(), AggregateError);

    assert.ok(a.controller.sessionGen.generation > 0, "A 的 generation 必须递增");
    assert.strictEqual(
      a.controller.workerManager.getInstance()?.lifecycleState,
      "disconnected",
      "A 必须降级为 disconnected 占位",
    );
    await waitRejects;

    assert.strictEqual(h.coordinator.size, 2, "会话切换后必须保留可诊断占位");
    assert.ok(h.coordinator.getEntry(a.workerId));
    assert.ok(h.coordinator.getEntry(b.workerId));

    await teardown(h);
  });

  it("会话切换后旧的在途 close 回调不得删除新登记（epoch 防护）", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });

    let resolveClose!: (v: { ok: boolean; disposition: string; message: string }) => void;
    (a.controller as any).handleWorkerClose = () =>
      new Promise((resolve) => {
        resolveClose = resolve;
      });

    const closeP = h.coordinator.handleWorkerClose({
      workerId: a.workerId,
      disposition: "abandoned",
    });
    assert.strictEqual(h.coordinator.getEntry(a.workerId)?.closing, true);

    // 会话切换：epoch 递增；A 的占位必须保留
    await h.coordinator.handleSessionStart();
    assert.ok(h.coordinator.getEntry(a.workerId), "会话切换后占位必须保留");
    await waitFor(() => typeof resolveClose === "function");

    // 旧回调晚到：即使底层报告退出成功，也不得删除会话切换后的登记
    a.controller.workerManager.updateLifecycleState("closed");
    a.controller.workerManager.releaseSlot(true);
    resolveClose({ ok: true, disposition: "abandoned", message: "late" });
    const res = await closeP;
    assert.strictEqual(res.ok, true);
    assert.ok(h.coordinator.getEntry(a.workerId), "旧回调不得删除新 epoch 的登记");
    assert.strictEqual(h.coordinator.size, 1);

    await teardown(h);
  });

  it("dispose 多实例：一个实例清理失败不影响其他实例，且重复调用幂等", async () => {
    const h = createHarness();
    await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });
    const aEntry = h.coordinator.getEntry(h.coordinator.listWorkerIds().find((id) => id !== b.workerId)!)!;

    // 替换 dispose 以模拟单实例清理失败；保留真实 dispose 供最后清理，
    // 否则 A 的心跳/命名管道句柄会残留导致测试进程无法退出。
    const aController: any = aEntry.controller;
    const realDispose = aController.dispose.bind(aController);
    aController.dispose = async () => {
      throw new Error("a-dispose-fail");
    };

    await assert.rejects(() => h.coordinator.dispose(), AggregateError);
    assert.strictEqual((b.controller as any).isDisposed, true, "B 必须被清理");
    assert.strictEqual(h.coordinator.size, 0, "dispose 后登记必须清空");

    // 幂等：第二次调用直接返回、不抛错
    await h.coordinator.dispose();
    assert.strictEqual(h.coordinator.size, 0);

    await teardown(h);
    // 真正释放 A 的残留资源（心跳 / pipe server / 连接）
    await realDispose();
  });

  it("状态栏汇总按 running/review/issue 分类计数", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });
    const c = await startAndComplete(h, { cwd: process.cwd(), title: "C", task: "任务C" });

    a.controller.workerManager.updateTaskState("ready_for_review");
    b.controller.workerManager.updateTaskState("failed");
    // C 保持 running

    const summary = h.coordinator.getSummary();
    assert.deepStrictEqual(summary, { total: 3, running: 1, review: 1, issue: 1 });
    assert.strictEqual(summary.running + summary.review + summary.issue, summary.total);

    // disconnected 占位计入 issue
    c.controller.workerManager.updateLifecycleState("disconnected");
    const summary2 = h.coordinator.getSummary();
    assert.deepStrictEqual(summary2, { total: 3, running: 0, review: 1, issue: 2 });

    await teardown(h);
  });
});

describe("MultiWorkerCoordinator 阶段 C 修复：空闲刷新、生命周期竞态与列表边界", () => {
  it("worker_list 超过 20 条仍被硬上限截断，标题/模型/provider 均有界，预登记启动中可查询", async () => {
    const h = createHarness(undefined, { launchTimeoutMs: 5000 });
    const starts: Array<Promise<unknown>> = [];
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) {
      const b = beginStart(h, { cwd: process.cwd(), title: `标题-${i}`, task: `任务${i}` });
      // 启动同步登记且名额已锁定，实例元数据可写；仍在等待握手的 entry 也必须可查询
      b.entry.controller.workerManager.setModelInfo(
        "provider-" + "p".repeat(400),
        "model-" + "m".repeat(400),
        "high",
        [],
      );
      b.entry.controller.workerManager.updateTaskState("running");
      ids.push(b.entry.workerId);
      starts.push(b.promise.then(() => undefined, () => undefined));
    }
    assert.strictEqual(h.coordinator.size, 21, "21 次 start 必须全部同步登记");

    const list = await h.coordinator.handleWorkerList();
    assert.strictEqual(list.total, 21);
    assert.strictEqual(list.returned, 20, "单次返回不得超过 20 条");
    assert.strictEqual(list.workers.length, 20);
    assert.strictEqual(list.truncated, true);

    for (const w of list.workers) {
      assert.ok(ids.includes(w.workerId), "列表项必须是同一批预登记的 workerId");
      assert.ok(w.title.length <= 80, "title 必须有界");
      assert.ok(w.cwd.length <= 200, "cwd 必须有界");
      assert.ok((w.model ?? "").length <= 80, "model 必须有界");
      assert.ok((w.provider ?? "").length <= 80, "provider 必须有界");
      assert.ok(!("committedReport" in w) && !("inbox" in w), "摘要不得携带明细");
    }

    // 调用方请求超过上限也不得突破 WORKER_LIST_MAX_ITEMS
    const greedy = await h.coordinator.handleWorkerList(100);
    assert.strictEqual(greedy.returned, 20, "请求 100 条时仍不得超过硬上限 20");

    await teardown(h);
    await Promise.allSettled(starts);
  });

  it("dispose 后拒绝新的 worker_start，且不创建任何新实例", async () => {
    const h = createHarness();
    await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    await teardown(h);
    assert.strictEqual(h.coordinator.size, 0);

    await assert.rejects(
      () => h.coordinator.handleWorkerStart({ cwd: process.cwd(), title: "B", task: "任务B" }),
      new RegExp(ProtocolErrorCode.INVALID_STATE),
    );
    assert.strictEqual(h.coordinator.size, 0, "dispose 后不得留下新登记");
    assert.strictEqual(h.controllers.length, 1, "dispose 后不得再创建 ControllerManager");
  });

  it("dispose 与在途 start 交错：中止握手、不残留 server/清理器，dispose 幂等", async () => {
    const h = createHarness(undefined, { launchTimeoutMs: 3000 });
    const b = beginStart(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const controller: any = b.entry.controller;
    assert.strictEqual(controller.workerManager.hasActiveInstance(), true);
    const startOutcome = b.promise.then(
      () => "resolved",
      () => "rejected",
    );

    await h.coordinator.dispose();

    assert.strictEqual(await startOutcome, "rejected", "在途 start 必须被中止而不是成功");
    assert.strictEqual(h.coordinator.size, 0, "dispose 后不得残留登记");
    assert.strictEqual(controller.isDisposed, true, "实例资源必须被释放");
    assert.strictEqual(controller.server, null, "在途 start 建立/注册的 server 必须关闭");
    assert.strictEqual(controller.cleanupRegistry.size, 0, "不得残留清理器");

    // 幂等：再次 dispose 不抛错、不改变状态
    await h.coordinator.dispose();
    assert.strictEqual(h.coordinator.size, 0);
    assert.strictEqual(controller.isDisposed, true);
  });

  it("dispose 与在途 close 交错：close 结果不得复活登记或操作已释放实例", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });

    let resolveClose!: (v: { ok: boolean; disposition: string; message: string }) => void;
    (a.controller as any).handleWorkerClose = () =>
      new Promise((resolve) => {
        resolveClose = resolve;
      });

    const closeP = h.coordinator.handleWorkerClose({
      workerId: a.workerId,
      disposition: "abandoned",
    });
    assert.strictEqual(h.coordinator.getEntry(a.workerId)?.closing, true);

    // 摘除连接，避免 dispose 等待不会到来的 close ACK
    (a.controller as any).workerConn = null;
    (a.controller as any).supervisorConn = null;
    await h.coordinator.dispose();
    assert.strictEqual(h.coordinator.size, 0);
    assert.strictEqual((a.controller as any).isDisposed, true);

    resolveClose({ ok: true, disposition: "abandoned", message: "late" });
    const res = await closeP;
    assert.strictEqual(res.ok, true);
    assert.strictEqual(h.coordinator.getEntry(a.workerId), undefined, "晚到 close 不得复活登记");
    assert.strictEqual(h.coordinator.size, 0);
    await h.coordinator.dispose();
    assert.strictEqual(h.coordinator.size, 0);
  });

  it("/worker-forget 与 mutating 队列协调并取消全部 waiters", async () => {
    const h = createHarness();
    h.coordinator.registerToolsAndCommands();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });

    const waitP = h.coordinator.handleWorkerWait({
      workerId: a.workerId,
      afterCursor: 99999,
      timeoutMs: 60000,
    });
    const waitRejects = assert.rejects(() => waitP, /取消/);
    await waitFor(() => (a.controller as any).waiters.length === 1);

    const ctx = new FakePiContext();
    ctx.confirmResponse = true;
    await h.pi.commands.get("worker-forget")!.handler(a.workerId, ctx);

    await waitRejects;
    assert.strictEqual((a.controller as any).waiters.length, 0, "forget 必须取消 waiters");
    assert.strictEqual(h.coordinator.getEntry(a.workerId), undefined, "forget 必须移除登记");
    assert.strictEqual((a.controller as any).isDisposed, true);
    assert.ok(
      ctx.notifications.some((n) => n.message.includes("已强制解除 Worker 占位")),
      "正常 forget 必须给出成功通知",
    );

    await teardown(h);
  });

  it("/worker-forget 在确认期间发生会话切换时取消，不误删/不误销毁", async () => {
    const h = createHarness();
    h.coordinator.registerToolsAndCommands();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });

    const ctx = new FakePiContext();
    ctx.ui.confirm = async () => {
      await h.coordinator.handleSessionStart();
      return true;
    };
    await h.pi.commands.get("worker-forget")!.handler(a.workerId, ctx);

    assert.ok(h.coordinator.getEntry(a.workerId), "确认期间换会话后不得移除登记");
    assert.notStrictEqual((a.controller as any).isDisposed, true, "不得销毁新会话的实例资源");
    assert.ok(
      ctx.notifications.some((n) => n.message.includes("已取消解除占位")),
      "必须明确提示取消",
    );

    await teardown(h);
  });

  it("/worker-forget 在确认期间登记被移除时取消，不重复销毁", async () => {
    const h = createHarness();
    h.coordinator.registerToolsAndCommands();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });

    // 确认期间目标被 close 成功回收
    (a.controller as any).handleWorkerClose = async () => {
      a.controller.workerManager.updateLifecycleState("closed");
      a.controller.workerManager.releaseSlot(true);
      return { ok: true, disposition: "abandoned", message: "closed-in-confirm" };
    };

    let disposeCalls = 0;
    const realDispose = a.controller.dispose.bind(a.controller);
    (a.controller as any).dispose = async () => {
      disposeCalls += 1;
      await realDispose();
    };

    const ctx = new FakePiContext();
    ctx.ui.confirm = async () => {
      await h.coordinator.handleWorkerClose({ workerId: a.workerId, disposition: "abandoned" });
      return true;
    };
    await h.pi.commands.get("worker-forget")!.handler(a.workerId, ctx);

    assert.strictEqual(h.coordinator.getEntry(a.workerId), undefined, "目标已被 close 移除");
    // close 路径只 dispose 一次；forget 重新核对后必须取消，不得再次销毁
    assert.strictEqual(disposeCalls, 1, "确认期间已移除的实例不得被 forget 重复销毁");
    assert.ok(
      ctx.notifications.some((n) => n.message.includes("已取消解除占位")),
      "必须明确提示取消",
    );

    await teardown(h);
  });

  it("非交互模式没有 confirm 时 forget 不动作", async () => {
    const h = createHarness();
    h.coordinator.registerToolsAndCommands();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });

    const ctx = new FakePiContext();
    // 模拟非交互 UI：没有可用的 confirm
    delete (ctx.ui as any).confirm;
    await h.pi.commands.get("worker-forget")!.handler(a.workerId, ctx);

    assert.ok(h.coordinator.getEntry(a.workerId), "无 confirm 时不得移除登记");
    assert.strictEqual((a.controller as any).isDisposed, false, "无 confirm 时不得销毁资源");
    assert.ok(
      ctx.notifications.some((n) => n.message.includes("非交互模式")),
      "必须提示非交互模式无法确认",
    );

    await teardown(h);
  });

  it("session_start 取消所有实例的全部 waiters", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });

    const waits = [
      h.coordinator.handleWorkerWait({ workerId: a.workerId, afterCursor: 99999, timeoutMs: 60000 }),
      h.coordinator.handleWorkerWait({ workerId: a.workerId, afterCursor: 99998, timeoutMs: 60000 }),
      h.coordinator.handleWorkerWait({ workerId: b.workerId, afterCursor: 99999, timeoutMs: 60000 }),
    ];
    const rejects = waits.map((p) => assert.rejects(() => p, /会话已切换/));
    await waitFor(
      () => (a.controller as any).waiters.length === 2 && (b.controller as any).waiters.length === 1,
    );

    await h.coordinator.handleSessionStart();
    await Promise.all(rejects);

    assert.strictEqual((a.controller as any).waiters.length, 0, "A 的 waiters 必须全部取消");
    assert.strictEqual((b.controller as any).waiters.length, 0, "B 的 waiters 必须全部取消");
    assert.strictEqual(h.coordinator.size, 2, "会话切换后占位保留");

    await teardown(h);
  });

  it("同时 stop 一个实例与 close 另一个实例互不串线", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });

    let aAborts = 0;
    let bAborts = 0;
    (a.controller as any).workerConn.sendRequest = async (env: any) => {
      if (env?.type === "abort") aAborts += 1;
      return { ok: true };
    };
    (b.controller as any).workerConn.sendRequest = async (env: any) => {
      if (env?.type === "abort") bAborts += 1;
      return { ok: true };
    };
    (b.controller as any).handleWorkerClose = async () => {
      b.controller.workerManager.updateLifecycleState("closed");
      b.controller.workerManager.releaseSlot(true);
      return { ok: true, disposition: "abandoned", message: "closed-b" };
    };

    const [stopRes, closeRes] = await Promise.all([
      h.coordinator.handleWorkerStop({ workerId: a.workerId, reason: "并发停止" }),
      h.coordinator.handleWorkerClose({ workerId: b.workerId, disposition: "abandoned" }),
    ]);

    assert.strictEqual(stopRes.ok, true);
    assert.strictEqual(closeRes.ok, true);
    assert.strictEqual(aAborts, 1, "必须只向 A 发送 abort");
    assert.strictEqual(bAborts, 0, "停止 A 不得触碰 B");
    assert.ok(h.coordinator.getEntry(a.workerId), "A 登记必须保留");
    assert.strictEqual(h.coordinator.getEntry(b.workerId), undefined, "B 必须被移除");

    await teardown(h);
  });

  it("disconnected + ready_for_review 计入 issue，不被 review 掩盖", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    a.controller.workerManager.updateTaskState("ready_for_review");
    assert.deepStrictEqual(h.coordinator.getSummary(), { total: 1, running: 0, review: 1, issue: 0 });

    a.controller.workerManager.updateLifecycleState("disconnected");
    assert.deepStrictEqual(
      h.coordinator.getSummary(),
      { total: 1, running: 0, review: 0, issue: 1 },
      "断连实例必须计入 issue",
    );

    await teardown(h);
  });

  it("worker_status 的 eventId 详情严格按 workerId 隔离", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });

    const ev = (a.controller as any).appendInbox(
      "report_committed",
      { note: "only-in-a" },
      a.taskId,
      1,
      1,
    );
    const detailA = await h.coordinator.handleWorkerStatus({
      workerId: a.workerId,
      eventId: ev.eventId,
    });
    assert.ok(detailA.eventDetail, "A 必须能读到自己的事件详情");
    assert.ok(detailA.eventDetail!.content.includes("only-in-a"));

    const detailB = await h.coordinator.handleWorkerStatus({
      workerId: b.workerId,
      eventId: ev.eventId,
    });
    assert.strictEqual(detailB.eventDetail, undefined, "B 不得跨实例读到 A 的事件详情");

    await teardown(h);
  });

  it("空闲时异步 socket 报告/断连经短周期轮询刷新状态栏，stop 后停止", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });

    const statuses = new Map<string, string | undefined>();
    const ui = {
      setStatus: (key: string, text: string | undefined) => {
        statuses.set(key, text);
      },
    };
    const poller = new WorkerStatusBarPoller(() => h.coordinator.getSummary(), 25);
    poller.start(ui as any);
    assert.strictEqual(statuses.get("worker"), "Workers 1 | running 1 | review 0 | issue 0");

    // 主 Pi 完全空闲：不触发任何 worker_* 工具 / turn / agent_settled，直接喂异步 socket 报告
    feed(a.workerSock, {
      version: 1,
      controllerId: a.controllerId,
      workerId: a.workerId,
      id: "report-async",
      seq: a.workerSock.outboundSeq + 1,
      type: "report_committed",
      payload: {
        taskId: a.taskId,
        revision: 1,
        runId: 1,
        report: { kind: "result", summary: "完成" },
      },
    });
    await waitFor(
      () => a.controller.workerManager.getInstance()?.taskState === "ready_for_review",
      1000,
    );
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(
      statuses.get("worker"),
      "Workers 1 | running 0 | review 1 | issue 0",
      "空闲异步报告必须由轮询刷新状态栏",
    );

    // 断连 + ready_for_review：issue 优先
    a.controller.workerManager.updateLifecycleState("disconnected");
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(
      statuses.get("worker"),
      "Workers 1 | running 0 | review 0 | issue 1",
      "断连必须由轮询刷新并计入 issue",
    );

    poller.stop();
    assert.strictEqual(poller.isRunning, false, "stop 必须清除定时器");
    const frozen = statuses.get("worker");
    a.controller.workerManager.updateLifecycleState("connected");
    a.controller.workerManager.updateTaskState("running");
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(statuses.get("worker"), frozen, "stop 后不得再刷新");

    await teardown(h);
  });

  it("dispose 与队列中的 send/stop 交错：不复活登记、不重新创建资源", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });

    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let sendStarted = false;
    (a.controller as any).workerConn.sendRequest = async () => {
      sendStarted = true;
      await sendGate;
      return { ok: true };
    };
    const sendOutcome = h.coordinator
      .handleWorkerSend({
        workerId: a.workerId,
        taskId: a.taskId,
        message: "dispose 期间",
        kind: "supplement",
      })
      .then(
        () => "resolved",
        () => "rejected",
      );
    await waitFor(() => sendStarted);

    (a.controller as any).workerConn = null;
    (a.controller as any).supervisorConn = null;
    await h.coordinator.dispose();
    assert.strictEqual(h.coordinator.size, 0);
    assert.strictEqual((a.controller as any).isDisposed, true);

    // dispose 之后的操作必须按 ID 拒绝，绝不命中已释放实例
    await assert.rejects(
      () => h.coordinator.handleWorkerStop({ workerId: a.workerId, reason: "late" }),
      new RegExp(ProtocolErrorCode.NOT_FOUND),
    );
    await assert.rejects(
      () =>
        h.coordinator.handleWorkerSend({
          workerId: a.workerId,
          taskId: a.taskId,
          message: "late",
          kind: "supplement",
        }),
      new RegExp(ProtocolErrorCode.NOT_FOUND),
    );

    releaseSend();
    // 在途 send 允许按自身结果 settle（stub 返回成功），但绝不能复活登记或操作新实例
    assert.ok(["resolved", "rejected"].includes(await sendOutcome));
    assert.strictEqual(h.coordinator.getEntry(a.workerId), undefined, "晚到 send 不得复活登记");
    await h.coordinator.dispose();
    assert.strictEqual(h.coordinator.size, 0);
  });
});

describe("MultiWorkerCoordinator 返修：队列 guard、forget 排队与生命周期串行", () => {
  it("session 切换后队列中的旧 send/stop/close 不触碰底层", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });

    let releaseHead!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    let headCalls = 0;
    let stopCalls = 0;
    let closeCalls = 0;
    (a.controller as any).handleWorkerSend = async () => {
      headCalls += 1;
      await gate;
      return { ok: true, workerId: a.workerId, taskId: a.taskId, revision: 1, message: "ok" };
    };
    (a.controller as any).handleWorkerStop = async () => {
      stopCalls += 1;
      return { ok: true, message: "stopped" };
    };
    (a.controller as any).handleWorkerClose = async () => {
      closeCalls += 1;
      return { ok: false, disposition: "abandoned", message: "noop" };
    };

    // 队首占位，后面的 send/stop/close 还在排队
    const head = h.coordinator.handleWorkerSend({
      workerId: a.workerId,
      taskId: a.taskId,
      message: "head",
      kind: "supplement",
    });
    await waitFor(() => headCalls === 1);
    const queued = [
      h.coordinator.handleWorkerSend({
        workerId: a.workerId,
        taskId: a.taskId,
        message: "queued",
        kind: "supplement",
      }),
      h.coordinator.handleWorkerStop({ workerId: a.workerId, reason: "queued" }),
      h.coordinator.handleWorkerClose({ workerId: a.workerId, disposition: "abandoned" }),
    ].map((p) => p.then(() => "resolved", () => "rejected"));

    // 会话切换使 epoch 失效，然后放行队首
    await h.coordinator.handleSessionStart();
    releaseHead();
    await head;

    assert.deepStrictEqual(await Promise.all(queued), ["rejected", "rejected", "rejected"]);
    assert.strictEqual(headCalls, 1, "只有队首到达底层");
    assert.strictEqual(stopCalls, 0, "排队中的 stop 不得调用底层");
    assert.strictEqual(closeCalls, 0, "排队中的 close 不得调用底层");

    await teardown(h);
  });

  it("dispose 后队列中的旧 send/stop/close 不触碰底层", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });

    let releaseHead!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    let headCalls = 0;
    let stopCalls = 0;
    let closeCalls = 0;
    (a.controller as any).handleWorkerSend = async () => {
      headCalls += 1;
      await gate;
      return { ok: true, workerId: a.workerId, taskId: a.taskId, revision: 1, message: "ok" };
    };
    (a.controller as any).handleWorkerStop = async () => {
      stopCalls += 1;
      return { ok: true, message: "stopped" };
    };
    (a.controller as any).handleWorkerClose = async () => {
      closeCalls += 1;
      return { ok: false, disposition: "abandoned", message: "noop" };
    };

    const head = h.coordinator.handleWorkerSend({
      workerId: a.workerId,
      taskId: a.taskId,
      message: "head",
      kind: "supplement",
    });
    await waitFor(() => headCalls === 1);
    const queued = [
      h.coordinator.handleWorkerSend({
        workerId: a.workerId,
        taskId: a.taskId,
        message: "queued",
        kind: "supplement",
      }),
      h.coordinator.handleWorkerStop({ workerId: a.workerId, reason: "queued" }),
      h.coordinator.handleWorkerClose({ workerId: a.workerId, disposition: "abandoned" }),
    ].map((p) => p.then(() => "resolved", () => "rejected"));

    // 摘除连接避免 dispose 等 close ACK
    (a.controller as any).workerConn = null;
    (a.controller as any).supervisorConn = null;
    await h.coordinator.dispose();
    releaseHead();
    await head;

    assert.deepStrictEqual(await Promise.all(queued), ["rejected", "rejected", "rejected"]);
    assert.strictEqual(headCalls, 1);
    assert.strictEqual(stopCalls, 0, "dispose 后 stop 不得调用底层");
    assert.strictEqual(closeCalls, 0, "dispose 后 close 不得调用底层");
    assert.strictEqual(h.coordinator.size, 0);
  });

  it("forget 排队期间同步拒绝新 send/stop/close，且 close 与 forget 只释放一次", async () => {
    const h = createHarness();
    h.coordinator.registerToolsAndCommands();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });

    // close 先入队（closing=true），forget 排在它后面
    let resolveClose!: (v: { ok: boolean; disposition: string; message: string }) => void;
    (a.controller as any).handleWorkerClose = () =>
      new Promise((resolve) => {
        resolveClose = (v) => {
          a.controller.workerManager.updateLifecycleState("closed");
          a.controller.workerManager.releaseSlot(true);
          resolve(v);
        };
      });
    let disposeCalls = 0;
    const realDispose = a.controller.dispose.bind(a.controller);
    (a.controller as any).dispose = async () => {
      disposeCalls += 1;
      await realDispose();
    };
    let sendCalls = 0;
    (a.controller as any).handleWorkerSend = async () => {
      sendCalls += 1;
      return { ok: true, workerId: a.workerId, taskId: a.taskId, revision: 1, message: "ok" };
    };

    const closeP = h.coordinator.handleWorkerClose({
      workerId: a.workerId,
      disposition: "abandoned",
    });
    const ctx = new FakePiContext();
    ctx.confirmResponse = true;
    const forgetP = h.pi.commands.get("worker-forget")!.handler(a.workerId, ctx);

    // 等 forget 通过 confirm 并同步置位 forgetting
    await waitFor(() => h.coordinator.getEntry(a.workerId)?.forgetting === true);

    // 排队期间到达的新修改必须被同步拒绝，绝不进入队列/底层
    await assert.rejects(
      () =>
        h.coordinator.handleWorkerSend({
          workerId: a.workerId,
          taskId: a.taskId,
          message: "during-forget",
          kind: "supplement",
        }),
      new RegExp(ProtocolErrorCode.INVALID_STATE),
    );
    await assert.rejects(
      () => h.coordinator.handleWorkerStop({ workerId: a.workerId, reason: "during-forget" }),
      new RegExp(ProtocolErrorCode.INVALID_STATE),
    );
    await assert.rejects(
      () =>
        h.coordinator.handleWorkerClose({ workerId: a.workerId, disposition: "abandoned" }),
      new RegExp(ProtocolErrorCode.INVALID_STATE),
    );
    assert.strictEqual(sendCalls, 0, "forget 排队期间不得到达底层");

    // 放行 close：close 成功回收后 forget 应取消，资源只释放一次
    resolveClose({ ok: true, disposition: "abandoned", message: "closed" });
    await closeP;
    await forgetP;

    assert.strictEqual(disposeCalls, 1, "close/forget 交错只能释放一次资源");
    assert.strictEqual(h.coordinator.getEntry(a.workerId), undefined);
    assert.ok(
      ctx.notifications.some((n) => /已取消解除占位|找不到/.test(n.message)),
      "已关闭的目标应提示取消/找不到",
    );

    await teardown(h);
  });

  it("handleSessionStart 与 dispose 串行：不并发进入内核，dispose 后不再调用内核", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });

    let releaseSession!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    let kernelSessionCalls = 0;
    const realSession = a.controller.handleSessionStart.bind(a.controller);
    (a.controller as any).handleSessionStart = async () => {
      kernelSessionCalls += 1;
      await gate;
      await realSession();
    };

    const sessionP = h.coordinator.handleSessionStart();
    await waitFor(() => kernelSessionCalls === 1);
    const disposeP = h.coordinator.dispose();

    // dispose 必须等内核 sessionStart 完成后才能清理，不得并发
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual((a.controller as any).isDisposed, false, "dispose 不得与内核 sessionStart 并发");

    releaseSession();
    await Promise.all([sessionP, disposeP]);
    assert.strictEqual((a.controller as any).isDisposed, true);
    assert.strictEqual((a.controller as any).cleanupRegistry.size, 0, "不得残留 cleanups");
    assert.strictEqual(h.coordinator.size, 0);
    await h.coordinator.dispose(); // 幂等

    const before = kernelSessionCalls;
    await h.coordinator.handleSessionStart();
    assert.strictEqual(kernelSessionCalls, before, "disposed 后 sessionStart 不得再调用内核");
  });

  it("同一实例会话替换：dispose 后 session_start 重新武装，可再次启动 Worker", async () => {
    const h = createHarness();
    await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    await teardown(h); // dispose：旧登记清空
    assert.strictEqual(h.coordinator.size, 0);

    // 重新武装之前禁止 start"
    await assert.rejects(
      () => h.coordinator.handleWorkerStart({ cwd: process.cwd(), title: "B", task: "任务B" }),
      new RegExp(ProtocolErrorCode.INVALID_STATE),
    );

    // 新会话的 session_start 重新武装协调器（不依赖宿主重建扩展实例）
    await h.coordinator.handleSessionStart();
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });
    assert.ok(b.workerId, "新会话必须能再次启动 Worker");
    assert.strictEqual(h.coordinator.size, 1);

    await teardown(h);
  });

  it("dispose 并行清理：慢在途 A 不阻塞非在途 B 立即释放", async () => {
    const h = createHarness(undefined, { launchTimeoutMs: 3000 });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });
    const a = beginStart(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    assert.strictEqual(h.coordinator.size, 2);

    // A 的在途 start 取消被卡住；B 非在途应立即释放
    let releaseA!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const realASession = a.entry.controller.handleSessionStart.bind(a.entry.controller);
    (a.entry.controller as any).handleSessionStart = async () => {
      await gate;
      await realASession();
    };
    (b.controller as any).workerConn = null;
    (b.controller as any).supervisorConn = null;
    (b.controller as any).handleWorkerClose = async () => ({
      ok: true,
      disposition: "abandoned",
      message: "closed-b",
    });

    const aOutcome = a.promise.then(
      () => "resolved",
      () => "rejected",
    );
    const disposeP = h.coordinator.dispose();

    await waitFor(() => (b.controller as any).isDisposed === true, 1000);
    assert.strictEqual(
      (a.entry.controller as any).isDisposed,
      false,
      "A 仍在取消中，B 不得被其阻塞",
    );

    releaseA();
    await disposeP;
    assert.strictEqual(await aOutcome, "rejected");
    assert.strictEqual((a.entry.controller as any).isDisposed, true);
    assert.strictEqual((b.controller as any).cleanupRegistry.size, 0);
    assert.strictEqual(h.coordinator.size, 0);
  });
});

// ============================================================================
// 阶段 D：协调器级双实例故障注入（复用真实 ControllerManager + FakeSocket）
//
// 覆盖 plan 第 6、7 节要求：认证错 token/错 workerId、报告交错与 local_input/返修、
// wait 超时/取消、心跳超时与断连、关闭超时与迟到 child_exit、初始 task ACK 未知、
// 以及收件箱/报告缓存条数与字节上限的实例隔离。
// 断言均基于公开协调器入口 + 真实 socket 帧或明确的实例行为，不以 Map 条数代替语义。
// ============================================================================

let dFrameSeq = 0;

/** 以严格递增 seq 注入一帧到指定假连接（复用 feed 的 outboundSeq 记账） */
function nextFrame(sock: FakeSocket, base: Record<string, unknown>): void {
  dFrameSeq += 1;
  sock.outboundSeq += 1;
  feed(sock, { ...base, id: base.id ?? `d-frame-${dFrameSeq}`, seq: sock.outboundSeq });
}

/** 用实例当前 taskId/revision/runId 注入候选/提交报告帧 */
function feedReport(
  sock: FakeSocket,
  entry: WorkerEntry,
  type: "report_candidate" | "report_committed",
  report: Record<string, unknown>,
): void {
  const inst = entry.controller.workerManager.getInstance()!;
  nextFrame(sock, {
    version: 1,
    controllerId: entry.controllerId,
    workerId: entry.workerId,
    type,
    payload: { taskId: inst.taskId, revision: inst.revision, runId: inst.runId, report },
  });
}

/** 注入 activity 帧（设置活动状态，用于 accepted 验收所需的 idle） */
function feedActivity(entry: WorkerEntry, sock: FakeSocket, state: string): void {
  nextFrame(sock, {
    version: 1,
    controllerId: entry.controllerId,
    workerId: entry.workerId,
    type: "activity",
    payload: { state },
  });
}

/** 注入 local_input 帧（作废本实例的 committed/candidate 回执并回到 running） */
function feedLocalInput(entry: WorkerEntry, sock: FakeSocket): void {
  nextFrame(sock, {
    version: 1,
    controllerId: entry.controllerId,
    workerId: entry.workerId,
    type: "local_input",
    payload: { textSummary: "本地输入" },
  });
}

/** 注入 supervisor 侧 child_exit 帧，确认子进程退出 */
function feedChildExit(entry: WorkerEntry, supSock: FakeSocket, code: number): void {
  nextFrame(supSock, {
    version: 1,
    controllerId: entry.controllerId,
    workerId: entry.workerId,
    type: "child_exit",
    payload: { pid: 4242, code, signal: null },
  });
}

describe("MultiWorkerCoordinator 阶段 D：双实例故障隔离", () => {
  it("认证隔离：用另一实例的 token/workerId 认证被拒，且不覆盖两侧既有连接", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });

    const aWorkerToken = (a.controller as any).expectedWorkerToken as string;
    const bWorkerToken = (b.controller as any).expectedWorkerToken as string;
    const aBound = (a.controller as any).workerConn;
    const bBound = (b.controller as any).workerConn;
    assert.ok(aBound && bBound, "A/B 都必须已绑定各自的 worker 连接");

    // 1) 向 A 出示 B 的 token + B 的 workerId → token 不匹配，AUTH_FAILED，不绑定
    const intruder1 = new FakeSocket();
    (a.controller as any).handleIncomingSocket(intruder1 as any);
    feed(intruder1, helloFrame("worker", a.controllerId, b.workerId, bWorkerToken, "cross-token"));
    await waitFor(() => intruder1.frames.some((f) => f.type === "error"));
    const err1 = intruder1.frames.find((f) => f.type === "error")!;
    assert.strictEqual(err1.payload.code, ProtocolErrorCode.AUTH_FAILED, "跨实例 token 必须 AUTH_FAILED");
    assert.strictEqual(intruder1.destroyed, true, "被拒连接必须销毁");
    assert.strictEqual((a.controller as any).workerConn, aBound, "A 的绑定连接不得被覆盖");

    // 2) 向 A 出示 A 的 token + B 的 workerId → 身份不符，IDENTITY_MISMATCH，仍不绑定
    const intruder2 = new FakeSocket();
    (a.controller as any).handleIncomingSocket(intruder2 as any);
    feed(intruder2, helloFrame("worker", a.controllerId, b.workerId, aWorkerToken, "cross-id"));
    await waitFor(() => intruder2.frames.some((f) => f.type === "error"));
    const err2 = intruder2.frames.find((f) => f.type === "error")!;
    assert.strictEqual(err2.payload.code, ProtocolErrorCode.IDENTITY_MISMATCH);
    assert.strictEqual(intruder2.destroyed, true);
    assert.strictEqual((a.controller as any).workerConn, aBound);

    // 3) 反向：向 B 出示 A 的 token + A 的 workerId 同样被拒，B 连接不动
    const intruder3 = new FakeSocket();
    (b.controller as any).handleIncomingSocket(intruder3 as any);
    feed(intruder3, helloFrame("worker", b.controllerId, a.workerId, aWorkerToken, "cross-b"));
    await waitFor(() => intruder3.frames.some((f) => f.type === "error"));
    assert.strictEqual((b.controller as any).workerConn, bBound, "B 的绑定连接不得被覆盖");

    // 4) 已认证的 B 连接收到携带 A 身份的帧 → IDENTITY_MISMATCH、忽略、不销毁、不改状态
    const bTaskStateBefore = b.controller.workerManager.getInstance()?.taskState;
    nextFrame(b.workerSock, {
      version: 1,
      controllerId: b.controllerId,
      workerId: a.workerId,
      id: "cross-frame",
      type: "activity",
      payload: { state: "busy" },
    });
    await waitFor(() =>
      b.workerSock.frames.some((f) => f.type === "error" && f.replyTo === "cross-frame"),
    );
    const crossErr = b.workerSock.frames.find(
      (f) => f.type === "error" && f.replyTo === "cross-frame",
    )!;
    assert.strictEqual(crossErr.payload.code, ProtocolErrorCode.IDENTITY_MISMATCH);
    assert.strictEqual(b.workerSock.destroyed, false, "身份不符的单帧不得销毁活跃连接");
    assert.strictEqual((b.controller as any).workerConn, bBound);
    assert.strictEqual(b.controller.workerManager.getInstance()?.taskState, bTaskStateBefore);
    assert.strictEqual((b.controller as any).identityRejectedEvents, 1, "跨实例帧必须被计数且忽略");

    // 两侧状态仍按各自 workerId 可读
    const sA = await h.coordinator.handleWorkerStatus({ workerId: a.workerId });
    const sB = await h.coordinator.handleWorkerStatus({ workerId: b.workerId });
    assert.strictEqual(sA.worker?.workerId, a.workerId);
    assert.strictEqual(sB.worker?.workerId, b.workerId);

    await teardown(h);
  });

  it("报告交错：A 的 local_input/返修不抹 B 的 committed 回执，B 仍可 accepted 验收", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });
    a.workerSock.autoAckTypes.add("followup");

    // 交错注入：A candidate → B candidate → A committed → B committed
    feedReport(a.workerSock, a, "report_candidate", { kind: "result", summary: "A候选" });
    feedReport(b.workerSock, b, "report_candidate", { kind: "result", summary: "B候选" });
    feedReport(a.workerSock, a, "report_committed", { kind: "result", summary: "A完成" });
    feedActivity(b, b.workerSock, "idle");
    feedReport(b.workerSock, b, "report_committed", { kind: "result", summary: "B完成" });

    await waitFor(() => b.controller.workerManager.getInstance()?.taskState === "ready_for_review");
    const sA = await h.coordinator.handleWorkerStatus({ workerId: a.workerId });
    const sB = await h.coordinator.handleWorkerStatus({ workerId: b.workerId });
    assert.strictEqual(sA.committedReport?.summary, "A完成", "A 必须缓存自己的回执");
    assert.strictEqual(sB.committedReport?.summary, "B完成", "B 必须缓存自己的回执");
    assert.strictEqual(sA.worker?.taskState, "ready_for_review");
    assert.strictEqual(sB.worker?.taskState, "ready_for_review");

    // A 的 local_input 只作废 A 的回执，B 的 committed 必须保留
    feedLocalInput(a, a.workerSock);
    await waitFor(() => a.controller.workerManager.getInstance()?.taskState === "running");
    const sA2 = await h.coordinator.handleWorkerStatus({ workerId: a.workerId });
    const sB2 = await h.coordinator.handleWorkerStatus({ workerId: b.workerId });
    assert.strictEqual(sA2.committedReport, null, "A 的 committed 必须被 local_input 作废");
    assert.strictEqual(sB2.committedReport?.summary, "B完成", "B 的 committed 不得被 A 的 local_input 抹除");
    assert.strictEqual(sB2.worker?.taskState, "ready_for_review");

    // A 重新交付后发起 revision；A 的 revision 同样不得作废 B 的回执
    feedReport(a.workerSock, a, "report_committed", { kind: "result", summary: "A二次完成" });
    await waitFor(() => a.controller.workerManager.getInstance()?.taskState === "ready_for_review");
    const revRes = await h.coordinator.handleWorkerSend({
      workerId: a.workerId,
      taskId: a.taskId,
      message: "返修",
      kind: "revision",
    });
    assert.strictEqual(revRes.ok, true);
    const sA3 = await h.coordinator.handleWorkerStatus({ workerId: a.workerId });
    const sB3 = await h.coordinator.handleWorkerStatus({ workerId: b.workerId });
    assert.strictEqual(sA3.committedReport, null, "发起 revision 后 A 自己的回执作废");
    assert.strictEqual(sB3.committedReport?.summary, "B完成", "A 的 revision 不得抹除 B 的 committed");
    assert.strictEqual(sB3.worker?.taskState, "ready_for_review");

    // B 仍可 accepted：idle + committed result + connected
    b.workerSock.autoAckTypes.add("close");
    const closeP = h.coordinator.handleWorkerClose({ workerId: b.workerId, disposition: "accepted" });
    await waitFor(() => b.controller.workerManager.getInstance()?.lifecycleState === "closing");
    feedChildExit(b, b.supSock, 0);
    const closeRes = await closeP;
    assert.strictEqual(closeRes.ok, true, "B 必须能独立验收关闭");
    assert.strictEqual(h.coordinator.getEntry(b.workerId), undefined, "B accepted 后必须回收");
    assert.ok(h.coordinator.getEntry(a.workerId), "A 的登记不得受 B 关闭影响");

    await teardown(h);
  });

  it("wait 隔离：一方超时/取消不影响另一方可被事件正常唤醒", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });

    // A 短超时、B 长等待；B 的事件只能唤醒 B，A 必须超时
    const waitA = h.coordinator.handleWorkerWait({ workerId: a.workerId, afterCursor: 0, timeoutMs: 150 });
    const waitB = h.coordinator.handleWorkerWait({ workerId: b.workerId, afterCursor: 0, timeoutMs: 5000 });
    feedReport(b.workerSock, b, "report_committed", { kind: "question", summary: "B提问" });

    const resB = await waitB;
    assert.strictEqual(resB.event.type, "report_committed", "B 必须被自己的事件唤醒");
    assert.strictEqual(resB.event.taskId, b.taskId);
    const resA = await waitA;
    assert.strictEqual(resA.event.type, "wait_timeout", "A 不得被 B 的事件唤醒");
    assert.strictEqual(resA.event.taskId, a.taskId);

    // 取消 A 的等待不影响 B 的等待
    const ac = new AbortController();
    const waitA2 = h.coordinator.handleWorkerWait(
      { workerId: a.workerId, afterCursor: 0, timeoutMs: 60000 },
      { signal: ac.signal },
    );
    const waitB2 = h.coordinator.handleWorkerWait({
      workerId: b.workerId,
      afterCursor: resB.event.cursor,
      timeoutMs: 5000,
    });
    await waitFor(
      () => (a.controller as any).waiters.length === 1 && (b.controller as any).waiters.length === 1,
    );
    ac.abort();
    await assert.rejects(() => waitA2, /取消/);
    assert.strictEqual((a.controller as any).waiters.length, 0, "取消后 A 不得泄漏 waiter");

    feedReport(b.workerSock, b, "report_committed", { kind: "result", summary: "B二次" });
    const resB2 = await waitB2;
    assert.strictEqual(resB2.event.type, "report_committed", "B 的等待必须仍被唤醒");
    assert.strictEqual(resB2.event.taskId, b.taskId);
    assert.strictEqual((b.controller as any).waiters.length, 0);

    await teardown(h);
  });

  it("心跳/断连隔离：A 失联不污染 B 的连接与状态", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });
    const bBound = (b.controller as any).workerConn;

    // 缩短 A 的心跳间隔；先启动定时器再强制其活动时间过期 → A 进入 unresponsive
    (a.controller as any).heartbeatIntervalMs = 20;
    (a.controller as any).startHeartbeat();
    (a.controller as any).lastActivityTime = Date.now() - 60_000;
    await waitFor(
      () => a.controller.workerManager.getInstance()?.lifecycleState === "unresponsive",
      1500,
    );
    assert.strictEqual(
      b.controller.workerManager.getInstance()?.lifecycleState,
      "connected",
      "A 心跳失联不得把 B 标为 unresponsive",
    );
    assert.strictEqual((b.controller as any).workerConn, bBound);

    // A 两条连接断开 → A 占位 disconnected；B 仍 connected 且连接对象不变
    const aWorkerConn = (a.controller as any).workerConn;
    const aSupConn = (a.controller as any).supervisorConn;
    aWorkerConn.emit("close", false);
    aSupConn.emit("close", false);
    await waitFor(
      () => a.controller.workerManager.getInstance()?.lifecycleState === "disconnected",
      1500,
    );
    assert.strictEqual(b.controller.workerManager.getInstance()?.lifecycleState, "connected");
    assert.strictEqual((b.controller as any).workerConn, bBound, "B 连接对象不得被 A 断连影响");

    // B 仍能正常收发：状态可读、回执可提交、wait 可唤醒
    const sB = await h.coordinator.handleWorkerStatus({ workerId: b.workerId });
    assert.strictEqual(sB.worker?.lifecycleState, "connected");
    feedReport(b.workerSock, b, "report_committed", { kind: "result", summary: "B仍工作" });
    await waitFor(() => b.controller.workerManager.getInstance()?.taskState === "ready_for_review");
    const waitB = await h.coordinator.handleWorkerWait({ workerId: b.workerId, afterCursor: 0 });
    assert.strictEqual(waitB.event.type, "report_committed");
    assert.strictEqual(waitB.event.taskId, b.taskId);

    await teardown(h);
  });

  it("关闭隔离：A 关闭超时保留占位，B 独立确认 child_exit 关闭；A 迟到 exit 不动 B", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });

    // A：关闭等待期极短且不喂 child_exit → 关闭超时，保留占位
    (a.controller as any).closeWaitTimeoutMs = 120;
    a.workerSock.autoAckTypes.add("close");
    const aCloseErr = await h.coordinator
      .handleWorkerClose({ workerId: a.workerId, disposition: "abandoned" })
      .then(
        () => null,
        (e) => e as Error,
      );
    assert.ok(aCloseErr, "A 未确认退出必须关闭失败");
    assert.match(aCloseErr!.message, /未确认|超时/);
    assert.ok(h.coordinator.getEntry(a.workerId), "A 必须保留可诊断占位");
    assert.strictEqual(a.controller.workerManager.getInstance()?.lifecycleState, "closing");

    // B：独立关闭并通过 child_exit 确认退出 → 回收 B，不影响 A
    b.workerSock.autoAckTypes.add("close");
    const bCloseP = h.coordinator.handleWorkerClose({ workerId: b.workerId, disposition: "abandoned" });
    await waitFor(() => b.controller.workerManager.getInstance()?.lifecycleState === "closing");
    feedChildExit(b, b.supSock, 0);
    const bClose = await bCloseP;
    assert.strictEqual(bClose.ok, true, "B 独立确认退出必须成功关闭");
    assert.strictEqual(h.coordinator.getEntry(b.workerId), undefined, "B 必须被回收");
    assert.ok(h.coordinator.getEntry(a.workerId), "A 的超时占位不得被 B 关闭影响");

    // A 迟到 child_exit：只把 A 标为 closed，不得自动删除占位，也不得触碰已回收的 B
    feedChildExit(a, a.supSock, 0);
    await waitFor(() => a.controller.workerManager.getInstance()?.lifecycleState === "closed", 1500);
    assert.ok(h.coordinator.getEntry(a.workerId), "A 迟到 exit 不得被自动删除，需人工确认");
    assert.strictEqual(h.coordinator.getEntry(b.workerId), undefined);
    assert.strictEqual(h.coordinator.size, 1);

    await teardown(h);
  });

  it("启动故障隔离：A 初始 task ACK 超时 DELIVERY_UNKNOWN 不重派，B 仍可启动并工作", async () => {
    const h = createHarness(undefined, { launchTimeoutMs: [3000, 3000] });
    const a = beginStart(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const aConns = await openConnections(a.entry);
    // 不自动 ACK task，并缩短真实 ACK 超时，模拟投递结果未知
    aConns.workerSock.autoAckTypes.delete("task");
    const aWorkerConn: any = (a.entry.controller as any).workerConn;
    const realSend = aWorkerConn.sendRequest.bind(aWorkerConn);
    let taskCalls = 0;
    aWorkerConn.sendRequest = (env: any, timeout?: number) => {
      if (env?.type === "task") taskCalls += 1;
      return realSend(env, 60);
    };
    feedReady(a.entry, aConns.workerSock);

    const aErr = await a.promise.then(
      () => null,
      (e) => e as Error,
    );
    assert.ok(aErr, "A 初始任务 ACK 超时必须失败");
    assert.match(aErr!.message, /DELIVERY_UNKNOWN/);
    assert.strictEqual(taskCalls, 1, "初始 task 只发一次，绝不自动重派");
    const aUnknown = (a.entry.controller as any).unknownDeliveries;
    assert.strictEqual(aUnknown.length, 1);
    assert.strictEqual(aUnknown[0].kind, "task");
    assert.strictEqual(aUnknown[0].taskId, a.entry.taskId);
    // 未确认退出：保留占位、保持 connected，绝不降级为 launch_unknown 或重派
    assert.ok(h.coordinator.getEntry(a.entry.workerId), "投递未知必须保留占位");
    assert.strictEqual(a.entry.controller.workerManager.getInstance()?.lifecycleState, "connected");
    assert.notStrictEqual(a.entry.controller.workerManager.getInstance()?.taskState, "running");

    // B 仍可正常启动并工作
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });
    let bSent = 0;
    (b.controller as any).workerConn.sendRequest = async () => {
      bSent += 1;
      return { ok: true };
    };
    const sendRes = await h.coordinator.handleWorkerSend({
      workerId: b.workerId,
      taskId: b.taskId,
      message: "B收到补充",
      kind: "supplement",
    });
    assert.strictEqual(sendRes.ok, true);
    assert.strictEqual(bSent, 1);
    assert.strictEqual(taskCalls, 1, "A 的 task 调用数不得因 B 成功而变化");
    assert.strictEqual(h.coordinator.size, 2, "A 保留占位、B 正常登记");

    await teardown(h);
  });

  it("收件箱条数上限隔离：A 满不占 B 配额，关键事件按实例拒绝且 eventId 详情不跨实例", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });

    // 清空两侧收件箱以获得确定性边界，再填满 A 的关键事件
    (a.controller as any).inbox = [];
    (a.controller as any).inboxBytes = 0;
    (b.controller as any).inbox = [];
    (b.controller as any).inboxBytes = 0;
    for (let i = 0; i < MAX_INBOX_EVENTS; i++) {
      (a.controller as any).appendInbox("stopped", { i }, a.taskId, 1, 1);
    }
    assert.strictEqual((a.controller as any).inbox.length, MAX_INBOX_EVENTS);
    assert.strictEqual((b.controller as any).inbox.length, 0, "填充 A 不得占用 B 的收件箱");

    // A 收到关键 report_committed → 显式 INBOX_FULL，且不入箱
    feedReport(a.workerSock, a, "report_committed", { kind: "result", summary: "A被拒" });
    await waitFor(() =>
      a.workerSock.frames.some(
        (f) => f.type === "error" && f.payload.code === ProtocolErrorCode.INBOX_FULL,
      ),
    );
    const aCountAfterReject = (a.controller as any).inbox.length;
    assert.strictEqual(aCountAfterReject, MAX_INBOX_EVENTS, "被拒事件不得入箱");
    assert.ok((a.controller as any).inboxRejectedEvents >= 1);

    // B 不受影响：仍能容纳关键事件并推进状态
    feedReport(b.workerSock, b, "report_committed", { kind: "result", summary: "B交付" });
    await waitFor(() => b.controller.workerManager.getInstance()?.taskState === "ready_for_review");
    assert.strictEqual((b.controller as any).inbox.length, 1, "B 只记录自己的事件");

    // eventId 详情按 workerId 隔离
    const bEventId: string = (b.controller as any).inbox[0].eventId;
    const detailB = await h.coordinator.handleWorkerStatus({ workerId: b.workerId, eventId: bEventId });
    assert.ok(detailB.eventDetail?.content.includes("B交付"), "B 必须能读到自己的事件详情");
    const detailA = await h.coordinator.handleWorkerStatus({ workerId: a.workerId, eventId: bEventId });
    assert.strictEqual(detailA.eventDetail, undefined, "A 不得跨实例读到 B 的事件详情");

    const statusA = await h.coordinator.handleWorkerStatus({ workerId: a.workerId });
    const statusB = await h.coordinator.handleWorkerStatus({ workerId: b.workerId });
    assert.strictEqual(statusA.inbox.count, MAX_INBOX_EVENTS);
    assert.strictEqual(statusB.inbox.count, 1);

    await teardown(h);
  });

  it("收件箱字节上限隔离：A 用真实 payload 填满 8 MiB 后关键报告被 INBOX_FULL 拒绝，B 仍可交付", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });
    const bBytesBefore = (b.controller as any).inboxBytes;
    const bCountBefore = (b.controller as any).inbox.length;

    // 清空 A 收件箱后，用 jsonByteLength 校准的真实 payload 经 appendInbox 精确填满 8 MiB
    (a.controller as any).inbox = [];
    (a.controller as any).inboxBytes = 0;
    const inboxBase = jsonByteLength({ data: "" });
    const fullPayload = { data: "x".repeat(MAX_INBOX_BYTES - inboxBase) };
    assert.strictEqual(jsonByteLength(fullPayload), MAX_INBOX_BYTES);
    (a.controller as any).appendInbox("report_committed", fullPayload, a.taskId, 1, 1);
    assert.strictEqual((a.controller as any).inbox.length, 1);
    assert.strictEqual(
      (a.controller as any).inboxBytes,
      MAX_INBOX_BYTES,
      "A 收件箱字节必须恰好填满上限",
    );
    assert.strictEqual(
      (b.controller as any).inboxBytes,
      bBytesBefore,
      "填满 A 不得占用或改变 B 的字节额度",
    );

    // A 再来一条关键报告 → 字节维度 INBOX_FULL，且不入箱、字节不变
    feedReport(a.workerSock, a, "report_committed", { kind: "result", summary: "A超字节" });
    await waitFor(() =>
      a.workerSock.frames.some(
        (f) => f.type === "error" && f.payload.code === ProtocolErrorCode.INBOX_FULL,
      ),
    );
    assert.strictEqual((a.controller as any).inbox.length, 1, "被拒关键事件不得入箱");
    assert.strictEqual((a.controller as any).inboxBytes, MAX_INBOX_BYTES);
    assert.ok((a.controller as any).inboxRejectedEvents >= 1);

    // B 不受影响：字节额度独立，仍能交付并推进状态
    feedReport(b.workerSock, b, "report_committed", { kind: "result", summary: "B交付" });
    await waitFor(() => b.controller.workerManager.getInstance()?.taskState === "ready_for_review");
    assert.strictEqual((b.controller as any).inbox.length, bCountBefore + 1);
    assert.ok((b.controller as any).inboxBytes > bBytesBefore);
    assert.ok((b.controller as any).inboxBytes < MAX_INBOX_BYTES);

    await teardown(h);
  });

  it("报告缓存条数/字节上限隔离：A 满被拒不占 B 配额，B 仍可独立验收", async () => {
    const h = createHarness();
    const a = await startAndComplete(h, { cwd: process.cwd(), title: "A", task: "任务A" });
    const b = await startAndComplete(h, { cwd: process.cwd(), title: "B", task: "任务B" });

    // —— 条数维度：填满 A 的缓存 ——
    for (let i = 0; i < MAX_REPORT_CACHE_SIZE; i++) {
      (a.controller as any).cacheReport("committed", a.taskId, 1, 1, {
        kind: "progress",
        summary: "x" + i,
      });
    }
    assert.strictEqual((a.controller as any).reportHistory.length, MAX_REPORT_CACHE_SIZE);
    assert.strictEqual((b.controller as any).reportHistory.length, 0, "B 的缓存不得被 A 占用");

    const aTaskStateBefore = a.controller.workerManager.getInstance()?.taskState;
    feedReport(a.workerSock, a, "report_committed", { kind: "result", summary: "A满拒" });
    await waitFor(() =>
      a.workerSock.frames.some(
        (f) => f.type === "error" && f.payload.code === ProtocolErrorCode.REPORT_CACHE_FULL,
      ),
    );
    assert.strictEqual(
      a.controller.workerManager.getInstance()?.taskState,
      aTaskStateBefore,
      "缓存满不得推进任务状态",
    );
    assert.strictEqual((a.controller as any).currentCommittedReport, null);
    assert.ok((a.controller as any).reportCacheRejected >= 1);

    // —— B 不受影响：正常缓存并到达 ready_for_review ——
    feedActivity(b, b.workerSock, "idle");
    feedReport(b.workerSock, b, "report_committed", { kind: "result", summary: "B交付" });
    await waitFor(() => b.controller.workerManager.getInstance()?.taskState === "ready_for_review");
    assert.strictEqual((b.controller as any).reportHistory.length, 1, "B 只记录自己的缓存");
    assert.strictEqual(
      (await h.coordinator.handleWorkerStatus({ workerId: b.workerId })).reportCache.count,
      1,
    );
    const aStatus = await h.coordinator.handleWorkerStatus({ workerId: a.workerId });
    assert.strictEqual(aStatus.reportCache.count, MAX_REPORT_CACHE_SIZE);
    assert.strictEqual(aStatus.committedReport, null);

    // —— 字节维度：先清空 A 缓存/字节，再用 cacheReport 真实填充 8 条各 1 MiB 报告（恰好 8 MiB）——
    (a.controller as any).reportHistory = [];
    (a.controller as any).reportHistoryBytes = 0;
    const reportBase = jsonByteLength({ kind: "progress", summary: "" });
    const oneMiBReport = {
      kind: "progress",
      summary: "y".repeat(MAX_REPORT_CACHE_BYTES / 8 - reportBase),
    };
    assert.strictEqual(jsonByteLength(oneMiBReport), MAX_REPORT_CACHE_BYTES / 8);
    for (let i = 0; i < 8; i++) {
      (a.controller as any).cacheReport("committed", a.taskId, 1, 1, oneMiBReport);
    }
    assert.strictEqual((a.controller as any).reportHistory.length, 8);
    assert.strictEqual(
      (a.controller as any).reportHistoryBytes,
      MAX_REPORT_CACHE_BYTES,
      "8 条各 1 MiB 报告后字节恰好达到上限",
    );

    feedReport(a.workerSock, a, "report_committed", { kind: "result", summary: "A字节满" });
    await waitFor(
      () =>
        a.workerSock.frames.filter(
          (f) => f.type === "error" && f.payload.code === ProtocolErrorCode.REPORT_CACHE_FULL,
        ).length >= 2,
    );
    assert.strictEqual((a.controller as any).currentCommittedReport, null);
    assert.strictEqual(
      (a.controller as any).reportHistory.length,
      8,
      "字节越界不得写入缓存，已有 8 条不变",
    );
    assert.strictEqual((a.controller as any).reportHistoryBytes, MAX_REPORT_CACHE_BYTES);

    // B 仍可 accepted 验收（缓存、连接、状态均未受 A 影响）
    b.workerSock.autoAckTypes.add("close");
    const closeP = h.coordinator.handleWorkerClose({ workerId: b.workerId, disposition: "accepted" });
    await waitFor(() => b.controller.workerManager.getInstance()?.lifecycleState === "closing");
    feedChildExit(b, b.supSock, 0);
    const closeRes = await closeP;
    assert.strictEqual(closeRes.ok, true, "B 必须能独立验收");
    assert.strictEqual(h.coordinator.getEntry(b.workerId), undefined);
    assert.ok(h.coordinator.getEntry(a.workerId), "A 的登记不得受 B 验收影响");

    await teardown(h);
  });
});
