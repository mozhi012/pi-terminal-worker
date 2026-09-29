import { describe, it } from "node:test";
import * as assert from "node:assert";
import { EventEmitter } from "node:events";
import * as net from "node:net";
import * as crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ControllerManager } from "../dist/controller.js";
import { ProtocolErrorCode } from "../dist/protocol.js";
import { AckTimeoutError, getPipePath } from "../dist/transport.js";
import { encodeDescriptor, type TerminalProbes } from "../dist/launcher.js";
import { FakePiAPI } from "./fake-pi.ts";

/**
 * 轻量假管道 Socket：实现 JsonlConnection 所需的最小接口
 * (on/off/emit 来自 EventEmitter，另有 write/destroy/destroyed)。
 * 通过 socket.emit("data", Buffer.from(json + "\n")) 注入入站帧。
 */
class FakeSocket extends EventEmitter {
  public destroyed = false;
  public written: string[] = [];
  /** 需要自动回 ACK 的请求类型；为空表示不自动回。 */
  public autoAckTypes = new Set<string>();

  public write(data: unknown, encoding?: unknown, cb?: unknown): boolean {
    const str = typeof data === "string" ? data : Buffer.from(data as any).toString("utf8");
    this.written.push(str);
    const callback = typeof encoding === "function" ? encoding : cb;
    // 真实 socket 的写回调是异步的：同步回调会让 transport 的 doWrite 读到未初始化的 flushed
    if (typeof callback === "function") {
      queueMicrotask(() => (callback as (e: null) => void)(null));
    }

    // 自动 ACK：把出站请求视为已送达，避免测试等待真实 ACK 超时
    if (this.autoAckTypes.size > 0) {
      try {
        const env = JSON.parse(str.trim());
        if (
          env &&
          typeof env.id === "string" &&
          !env.replyTo &&
          this.autoAckTypes.has(env.type)
        ) {
          const ack = {
            version: 1,
            controllerId: env.controllerId,
            workerId: env.workerId,
            id: "ack-" + env.id,
            replyTo: env.id,
            seq: 1,
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

  public framesOfType(type: string): any[] {
    return this.frames.filter((f) => f.type === type);
  }

  public lastFrameOfType(type: string): any | undefined {
    return this.framesOfType(type).pop();
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
  sock.emit("data", Buffer.from(JSON.stringify(env) + "\n", "utf8"));
}

function makeController(opts: {
  controllerId?: string;
  workerId?: string;
  taskId?: string;
  bootstrapToken?: string;
  workerToken?: string;
  withInstance?: boolean;
} = {}): ControllerManager {
  const controllerId = opts.controllerId ?? "ctrl-1";
  const workerId = opts.workerId ?? "worker-1";
  const taskId = opts.taskId ?? "task-1";
  const ctrl = new ControllerManager(new FakePiAPI() as any);
  if (opts.withInstance !== false) {
    ctrl.workerManager.acquireLaunchSlot(controllerId, workerId, taskId, process.cwd(), "T");
  }
  (ctrl as any).expectedBootstrapToken = opts.bootstrapToken ?? "boot-token";
  (ctrl as any).expectedWorkerToken = opts.workerToken ?? "worker-token";
  return ctrl;
}

/** 建立一条已认证连接 */
function connectAndAuth(
  ctrl: ControllerManager,
  role: "supervisor" | "worker",
  ids: { controllerId: string; workerId: string },
  token: string,
  id?: string,
): FakeSocket {
  const sock = new FakeSocket();
  (ctrl as any).handleIncomingSocket(sock as any);
  feed(sock, helloFrame(role, ids.controllerId, ids.workerId, token, id));
  return sock;
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

async function waitFor(cond: () => unknown, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("等待条件超时");
}

/** 清理控制器，避免 dispose 等待不会到来的 close ACK，也避免定时器泄漏 */
async function cleanup(ctrl: ControllerManager): Promise<void> {
  (ctrl as any).workerConn = null;
  (ctrl as any).supervisorConn = null;
  await ctrl.dispose();
}

// ===== 2B 第二半：bootstrap 真实子进程测试 harness =====

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const BOOTSTRAP_PATH = fileURLToPath(new URL("../runtime/bootstrap.mjs", import.meta.url));
const FIXTURE_CLI_PATH = fileURLToPath(new URL("./fixtures/noop-pi-cli.mjs", import.meta.url));

function frameEnv(
  type: string,
  payload: unknown,
  id?: string,
  replyTo?: string,
): Record<string, unknown> {
  return {
    version: 1,
    controllerId: "ctrl-boot",
    workerId: "worker-boot",
    id: id ?? crypto.randomUUID(),
    replyTo,
    seq: 1,
    type,
    payload,
  };
}

interface BootstrapHarness {
  pipePath: string;
  server: net.Server;
  proc: ChildProcess;
  sockets: net.Socket[];
  frames: any[];
  send: (env: Record<string, unknown> | string) => void;
  waitFrame: (pred: (f: any) => boolean, label: string, timeoutMs?: number) => Promise<any>;
}

/** 启动一个真实 bootstrap 子进程并接住它的命名管道连接 */
async function startBootstrapShell(): Promise<BootstrapHarness> {
  const pipePath = getPipePath("ptw-test-" + crypto.randomUUID().slice(0, 8));
  const server = net.createServer();
  const sockets: net.Socket[] = [];
  const frames: any[] = [];
  server.on("connection", (sock) => {
    sockets.push(sock);
    // bootstrap 可能在写入过程中销毁连接：忽略 socket 错误，避免测试被未捕获异常击穿
    sock.on("error", () => {});
    let buffer = "";
    sock.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          frames.push(JSON.parse(line));
        } catch {
          // 非 JSON 帧忽略
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, () => resolve());
  });

  const descriptor = encodeDescriptor({
    version: 1,
    controllerId: "ctrl-boot",
    workerId: "worker-boot",
    pipePath,
    bootstrapToken: "boot-secret",
  });
  const proc = spawn(
    process.execPath,
    [BOOTSTRAP_PATH, "--descriptor", descriptor, "--title", "t"],
    { stdio: "ignore" },
  );

  const waitFrame = async (
    pred: (f: any) => boolean,
    label: string,
    timeoutMs = 4000,
  ): Promise<any> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = frames.find(pred);
      if (found) return found;
      if (proc.exitCode !== null || proc.signalCode !== null) {
        throw new Error(`等待帧超时: ${label} (bootstrap 已退出 code=${proc.exitCode})`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`等待帧超时: ${label}`);
  };

  const send = (env: Record<string, unknown> | string): void => {
    const sock = sockets[sockets.length - 1];
    assert.ok(sock, "没有已连接的 bootstrap socket");
    sock.write(typeof env === "string" ? env : JSON.stringify(env) + "\n", "utf8");
  };

  return { pipePath, server, proc, sockets, frames, send, waitFrame };
}

/** 清理 bootstrap 子进程、socket 与 server，确保不留残留 */
async function stopBootstrap(h: BootstrapHarness): Promise<void> {
  for (const s of h.sockets) {
    try {
      s.destroy();
    } catch {
      // 忽略
    }
  }
  await waitChildExit(h.proc, 2000);
  if (h.proc.exitCode === null && h.proc.signalCode === null) {
    try {
      h.proc.kill();
    } catch {
      // 忽略
    }
    await waitChildExit(h.proc, 1500);
  }
  if (h.proc.exitCode === null && h.proc.signalCode === null) {
    try {
      h.proc.kill("SIGKILL");
    } catch {
      // 忽略
    }
  }
  await new Promise<void>((resolve) => h.server.close(() => resolve()));
}

async function waitChildExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => proc.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

const IDS = { controllerId: "ctrl-1", workerId: "worker-1" };

describe("2B: Controller 连接接受与身份校验", () => {
  it("1. 正常路径：worker hello 认证成功 → 回 hello_ok 且 workerConn 被绑定", async () => {
    const ctrl = makeController();
    const sock = new FakeSocket();
    (ctrl as any).handleIncomingSocket(sock as any);
    feed(sock, helloFrame("worker", IDS.controllerId, IDS.workerId, "worker-token", "hello-w1"));
    await settle();

    const ok = sock.lastFrameOfType("hello_ok");
    assert.ok(ok, "必须回 hello_ok");
    assert.strictEqual(ok.replyTo, "hello-w1");
    assert.strictEqual((ctrl as any).workerConn.socket, sock);
    assert.strictEqual(sock.destroyed, false, "认证成功不得销毁连接");
    await cleanup(ctrl);
  });

  it("2. 同一角色第二条连接被拒绝：workerConn 仍指向第一条，第二条收到 error 并被销毁", async () => {
    const ctrl = makeController();
    const first = connectAndAuth(ctrl, "worker", IDS, "worker-token", "hello-first");
    await settle();
    const firstConn = (ctrl as any).workerConn;
    assert.ok(firstConn);

    const second = new FakeSocket();
    (ctrl as any).handleIncomingSocket(second as any);
    feed(second, helloFrame("worker", IDS.controllerId, IDS.workerId, "worker-token", "hello-second"));
    await settle();

    const err = second.lastFrameOfType("error");
    assert.ok(err, "第二条连接必须收到 error");
    assert.strictEqual(err.payload.code, ProtocolErrorCode.ALREADY_EXISTS);
    assert.strictEqual(err.replyTo, "hello-second");
    assert.strictEqual((ctrl as any).workerConn, firstConn, "不得覆盖已绑定的连接");
    assert.strictEqual(second.destroyed, true, "第二条连接必须被销毁");
    assert.strictEqual(first.destroyed, false, "第一条活跃连接不得被销毁");
    await cleanup(ctrl);
  });

  it("3. 已认证连接重放 hello → ALREADY_EXISTS，连接不销毁，workerConn 不变", async () => {
    const ctrl = makeController();
    const sock = connectAndAuth(ctrl, "worker", IDS, "worker-token", "hello-first");
    await settle();
    const bound = (ctrl as any).workerConn;
    const okCountBefore = sock.framesOfType("hello_ok").length;
    assert.strictEqual(okCountBefore, 1);

    feed(sock, helloFrame("worker", IDS.controllerId, IDS.workerId, "worker-token", "hello-replay"));
    await settle();

    const err = sock.lastFrameOfType("error");
    assert.ok(err);
    assert.strictEqual(err.payload.code, ProtocolErrorCode.ALREADY_EXISTS);
    assert.strictEqual(err.replyTo, "hello-replay");
    assert.strictEqual(sock.destroyed, false, "活跃连接不得因重放被销毁");
    assert.strictEqual((ctrl as any).workerConn, bound, "workerConn 不得改变");
    assert.strictEqual(sock.framesOfType("hello_ok").length, 1, "不得重复发送 hello_ok");
    await cleanup(ctrl);
  });

  it("4. 认证前发非 hello → PROTOCOL_ERROR，socket 被销毁且未绑定", async () => {
    const ctrl = makeController();
    const sock = new FakeSocket();
    (ctrl as any).handleIncomingSocket(sock as any);
    feed(sock, {
      version: 1,
      controllerId: IDS.controllerId,
      workerId: IDS.workerId,
      id: "ping-early",
      seq: 1,
      type: "ping",
      payload: { timestamp: 1 },
    });
    await settle();

    const err = sock.lastFrameOfType("error");
    assert.ok(err);
    assert.strictEqual(err.payload.code, ProtocolErrorCode.PROTOCOL_ERROR);
    assert.strictEqual(sock.destroyed, true);
    assert.strictEqual((ctrl as any).workerConn, null);
    await cleanup(ctrl);
  });

  it("5. 错误 token → AUTH_FAILED，socket 销毁且未绑定", async () => {
    const ctrl = makeController();
    const sock = new FakeSocket();
    (ctrl as any).handleIncomingSocket(sock as any);
    feed(sock, helloFrame("worker", IDS.controllerId, IDS.workerId, "wrong-token", "hello-bad"));
    await settle();

    const err = sock.lastFrameOfType("error");
    assert.ok(err);
    assert.strictEqual(err.payload.code, ProtocolErrorCode.AUTH_FAILED);
    assert.strictEqual(sock.destroyed, true);
    assert.strictEqual((ctrl as any).workerConn, null);
    await cleanup(ctrl);
  });

  it("6. hello 的 controllerId/workerId 与实例不符 → IDENTITY_MISMATCH，销毁且未绑定", async () => {
    const ctrl = makeController();
    const sock = new FakeSocket();
    (ctrl as any).handleIncomingSocket(sock as any);
    feed(sock, helloFrame("worker", "ctrl-other", "worker-other", "worker-token", "hello-x"));
    await settle();

    const err = sock.lastFrameOfType("error");
    assert.ok(err);
    assert.strictEqual(err.payload.code, ProtocolErrorCode.IDENTITY_MISMATCH);
    assert.strictEqual(sock.destroyed, true);
    assert.strictEqual((ctrl as any).workerConn, null);
    await cleanup(ctrl);
  });

  it("7. 无活动实例时任何 hello 都被拒绝 (AUTH_FAILED / IDENTITY_MISMATCH)", async () => {
    const ctrl = makeController({ withInstance: false });
    const sock = new FakeSocket();
    (ctrl as any).handleIncomingSocket(sock as any);
    feed(sock, helloFrame("worker", IDS.controllerId, IDS.workerId, "worker-token", "hello-noid"));
    await settle();

    const err = sock.lastFrameOfType("error");
    assert.ok(err);
    assert.ok(
      err.payload.code === ProtocolErrorCode.AUTH_FAILED ||
        err.payload.code === ProtocolErrorCode.IDENTITY_MISMATCH,
      `期望 AUTH_FAILED 或 IDENTITY_MISMATCH，实际 ${err.payload.code}`,
    );
    assert.strictEqual(sock.destroyed, true);
    assert.strictEqual((ctrl as any).workerConn, null);
    await cleanup(ctrl);
  });

  it("8. 认证超时销毁 socket 且未绑定；随后 socket close 不抛异常 (timer 已清理)", async () => {
    const ctrl = makeController();
    (ctrl as any).authTimeoutMs = 30;
    const sock = new FakeSocket();
    (ctrl as any).handleIncomingSocket(sock as any);
    // 不发送任何消息，等待认证超时
    await new Promise((r) => setTimeout(r, 90));

    assert.strictEqual(sock.destroyed, true, "认证超时必须销毁 socket");
    assert.strictEqual((ctrl as any).workerConn, null);

    // timer 已清理：socket close 后不得抛异常
    assert.doesNotThrow(() => sock.emit("close", false));
    await cleanup(ctrl);
  });

  it("9. worker 连接收到身份不符的 envelope → IDENTITY_MISMATCH、忽略、不销毁、不写状态", async () => {
    const ctrl = makeController();
    const sock = connectAndAuth(ctrl, "worker", IDS, "worker-token");
    await settle();

    feed(sock, {
      version: 1,
      controllerId: "ctrl-other",
      workerId: IDS.workerId,
      id: "wr-wrong-id",
      seq: 2,
      type: "worker_ready",
      payload: {
        cwd: process.cwd(),
        provider: "local",
        modelId: "M-BAD",
        thinkingLevel: "high",
        tools: ["read"],
        version: "1",
      },
    });
    await settle();

    const err = sock.lastFrameOfType("error");
    assert.ok(err);
    assert.strictEqual(err.payload.code, ProtocolErrorCode.IDENTITY_MISMATCH);
    assert.strictEqual(err.replyTo, "wr-wrong-id");
    assert.strictEqual(sock.destroyed, false, "身份不符不得销毁连接");
    assert.strictEqual((ctrl as any).identityRejectedEvents, 1);
    assert.strictEqual(ctrl.workerManager.getInstance()?.modelId, undefined, "不得写入模型状态");
    await cleanup(ctrl);
  });

  it("10. supervisor 连接收到身份不符的 envelope → IDENTITY_MISMATCH、忽略、不销毁、childPid 未设置", async () => {
    const ctrl = makeController();
    const sock = connectAndAuth(ctrl, "supervisor", IDS, "boot-token");
    await settle();

    feed(sock, {
      version: 1,
      controllerId: IDS.controllerId,
      workerId: "worker-other",
      id: "cs-wrong-id",
      seq: 2,
      type: "child_spawned",
      payload: { pid: 4321 },
    });
    await settle();

    const err = sock.lastFrameOfType("error");
    assert.ok(err);
    assert.strictEqual(err.payload.code, ProtocolErrorCode.IDENTITY_MISMATCH);
    assert.strictEqual(sock.destroyed, false);
    assert.strictEqual((ctrl as any).identityRejectedEvents, 1);
    assert.strictEqual(ctrl.workerManager.getInstance()?.childPid, undefined, "childPid 不得被设置");
    await cleanup(ctrl);
  });

  it("11. 角色白名单：worker 收到 child_spawned、supervisor 收到 worker_ready 都被忽略并计数", async () => {
    const ctrl = makeController();

    const workerSock = connectAndAuth(ctrl, "worker", IDS, "worker-token");
    await settle();
    feed(workerSock, {
      version: 1,
      controllerId: IDS.controllerId,
      workerId: IDS.workerId,
      id: "cs-on-worker",
      seq: 2,
      type: "child_spawned",
      payload: { pid: 999 },
    });
    await settle();

    assert.strictEqual((ctrl as any).roleRejectedEvents, 1);
    assert.strictEqual(ctrl.workerManager.getInstance()?.childPid, undefined, "childPid 不得被设置");
    assert.strictEqual(workerSock.lastFrameOfType("error"), undefined, "角色白名单拒绝不得回 error");

    const supSock = connectAndAuth(ctrl, "supervisor", IDS, "boot-token");
    await settle();
    feed(supSock, {
      version: 1,
      controllerId: IDS.controllerId,
      workerId: IDS.workerId,
      id: "wr-on-supervisor",
      seq: 2,
      type: "worker_ready",
      payload: { cwd: process.cwd(), tools: [], version: "1" },
    });
    await settle();

    assert.strictEqual((ctrl as any).roleRejectedEvents, 2);
    assert.strictEqual(ctrl.workerManager.getInstance()?.modelId, undefined, "不得写入模型状态");
    assert.strictEqual(supSock.lastFrameOfType("error"), undefined);
    await cleanup(ctrl);
  });

  it("12. stale 消息：report_committed taskId/revision/runId 不符 → 忽略并计数", async () => {
    const ctrl = makeController();
    const sock = connectAndAuth(ctrl, "worker", IDS, "worker-token");
    await settle();

    feed(sock, {
      version: 1,
      controllerId: IDS.controllerId,
      workerId: IDS.workerId,
      id: "rc-stale",
      seq: 2,
      type: "report_committed",
      payload: {
        taskId: "task-stale",
        revision: 1,
        runId: 1,
        report: { kind: "result", summary: "过时" },
      },
    });
    await settle();

    assert.strictEqual((ctrl as any).staleIgnoredEvents, 1);
    assert.strictEqual((ctrl as any).currentCommittedReport, null, "stale 回执不得写入");
    assert.notStrictEqual(ctrl.workerManager.getInstance()?.taskState, "ready_for_review");
    await cleanup(ctrl);
  });

  it("13. launch_failed 释放名额抛出 LAUNCH_FAILED；未确认失败保留占位", async () => {
    // 场景 A：supervisor 上报 launch_failed → 明确失败 → 释放名额
    const ctrl = new ControllerManager(new FakePiAPI() as any);
    ctrl.launchSpawner = (() => new EventEmitter() as any) as any;
    const ids = { controllerId: "ctrl-lf", workerId: "worker-lf", taskId: "task-lf" };
    const startPromise = ctrl.handleWorkerStart(
      { cwd: process.cwd(), title: "T", task: "干活" },
      TEST_PROBES,
      {
        ids,
        bootstrapToken: "boot-lf",
        workerToken: "work-lf",
        launchTimeoutMs: 400,
      },
    );

    await waitFor(() => ctrl.workerManager.getInstance()?.workerId === "worker-lf");
    const supSock = new FakeSocket();
    supSock.autoAckTypes = new Set(["launch"]);
    (ctrl as any).handleIncomingSocket(supSock as any);
    feed(supSock, helloFrame("supervisor", ids.controllerId, ids.workerId, "boot-lf", "hello-lf"));
    await waitFor(() => (ctrl as any).supervisorConn);

    feed(supSock, {
      version: 1,
      controllerId: ids.controllerId,
      workerId: ids.workerId,
      id: "lf-report",
      seq: 2,
      type: "launch_failed",
      payload: { error: "终端窗口创建失败: boom" },
    });

    const startErr = await startPromise.then(
      () => null,
      (e) => e as Error,
    );
    assert.ok(startErr, "明确失败必须抛错");
    assert.match(startErr!.message, /LAUNCH_FAILED/);
    // 原始失败原因不得被吞掉（此处 lifecycle 已 closed，catch 时保留已抛出的握手错误文本）
    assert.match(startErr!.message, /worker_ready/);
    assert.strictEqual(ctrl.workerManager.hasActiveInstance(), false, "明确失败必须释放单实例名额");
    await cleanup(ctrl);

    // 场景 B：握手超时（未确认）→ 保留占位、lifecycle = launch_unknown
    const ctrl2 = new ControllerManager(new FakePiAPI() as any);
    ctrl2.launchSpawner = (() => new EventEmitter() as any) as any;
    await assert.rejects(
      () =>
        ctrl2.handleWorkerStart({ cwd: process.cwd(), title: "T2", task: "干活" }, TEST_PROBES, {
          ids: { controllerId: "ctrl-to", workerId: "worker-to", taskId: "task-to" },
          bootstrapToken: "b-to",
          workerToken: "w-to",
          launchTimeoutMs: 200,
        }),
      /握手超时/,
    );
    assert.strictEqual(ctrl2.workerManager.hasActiveInstance(), true, "未确认失败必须保留占位");
    assert.strictEqual(ctrl2.workerManager.getInstance()?.lifecycleState, "launch_unknown");
    ctrl2.handleWorkerForget();
    await ctrl2.dispose();
  });

  it("14. 上一实例 launch_failed 释放名额后，新 handleWorkerStart 仍能认证新 Supervisor", async () => {
    const ctrl = new ControllerManager(new FakePiAPI() as any);
    ctrl.launchSpawner = (() => new EventEmitter() as any) as any;

    // 第一轮：supervisor 上报 launch_failed → 释放名额，但 socket 仍活、遗留 supervisorConn
    const ids1 = { controllerId: "ctrl-r1", workerId: "worker-r1", taskId: "task-r1" };
    const first = ctrl.handleWorkerStart({ cwd: process.cwd(), title: "T1", task: "干活" }, TEST_PROBES, {
      ids: ids1,
      bootstrapToken: "boot-r1",
      workerToken: "work-r1",
      launchTimeoutMs: 300,
    });
    await waitFor(() => ctrl.workerManager.getInstance()?.workerId === "worker-r1");

    const supSock1 = new FakeSocket();
    supSock1.autoAckTypes = new Set(["launch"]);
    (ctrl as any).handleIncomingSocket(supSock1 as any);
    feed(supSock1, helloFrame("supervisor", ids1.controllerId, ids1.workerId, "boot-r1", "hello-r1"));
    await waitFor(() => (ctrl as any).supervisorConn);
    feed(supSock1, {
      version: 1,
      controllerId: ids1.controllerId,
      workerId: ids1.workerId,
      id: "lf-r1",
      seq: 2,
      type: "launch_failed",
      payload: { error: "第一轮失败" },
    });

    await assert.rejects(() => first, /LAUNCH_FAILED/);
    assert.strictEqual(ctrl.workerManager.hasActiveInstance(), false, "第一轮必须释放名额");
    assert.ok((ctrl as any).supervisorConn, "第一轮遗留的 supervisorConn 应仍存在（回归前提）");

    // 第二轮：新 ids/token 的新实例必须能完成 Supervisor 握手，而不是 ALREADY_EXISTS
    const ids2 = { controllerId: "ctrl-r2", workerId: "worker-r2", taskId: "task-r2" };
    const second = ctrl.handleWorkerStart({ cwd: process.cwd(), title: "T2", task: "干活" }, TEST_PROBES, {
      ids: ids2,
      bootstrapToken: "boot-r2",
      workerToken: "work-r2",
      launchTimeoutMs: 300,
    });
    await waitFor(() => ctrl.workerManager.getInstance()?.workerId === "worker-r2");

    const supSock2 = new FakeSocket();
    supSock2.autoAckTypes = new Set(["launch"]);
    (ctrl as any).handleIncomingSocket(supSock2 as any);
    feed(supSock2, helloFrame("supervisor", ids2.controllerId, ids2.workerId, "boot-r2", "hello-r2"));
    await settle();

    const ok = supSock2.lastFrameOfType("hello_ok");
    assert.ok(ok, "新实例 Supervisor 必须拿到 hello_ok（不能被 ALREADY_EXISTS 拒绝）");
    assert.strictEqual(ok.replyTo, "hello-r2");
    assert.ok(!supSock2.lastFrameOfType("error"), "不得回 error");

    // 收尾
    feed(supSock2, {
      version: 1,
      controllerId: ids2.controllerId,
      workerId: ids2.workerId,
      id: "lf-r2",
      seq: 2,
      type: "launch_failed",
      payload: { error: "收尾" },
    });
    await assert.rejects(() => second, /LAUNCH_FAILED/);
    await cleanup(ctrl);
  });

  it("15. handleWorkerForget 之后同样能重新认证（陈旧连接引用被丢弃）", async () => {
    const ctrl = new ControllerManager(new FakePiAPI() as any);
    ctrl.launchSpawner = (() => new EventEmitter() as any) as any;

    // 先建立一个活跃实例并认证一条 supervisor 连接
    const seedIds = { controllerId: "ctrl-seed", workerId: "worker-seed", taskId: "task-seed" };
    ctrl.workerManager.acquireLaunchSlot(seedIds.controllerId, seedIds.workerId, seedIds.taskId, process.cwd(), "seed");
    (ctrl as any).expectedBootstrapToken = "boot-seed";
    (ctrl as any).expectedWorkerToken = "work-seed";
    const oldSock = new FakeSocket();
    (ctrl as any).handleIncomingSocket(oldSock as any);
    feed(oldSock, helloFrame("supervisor", seedIds.controllerId, seedIds.workerId, "boot-seed", "hello-seed"));
    await settle();
    assert.ok(oldSock.lastFrameOfType("hello_ok"));
    const oldConn = (ctrl as any).supervisorConn;
    assert.ok(oldConn);

    // force 释放名额（既有语义：不清连接）
    ctrl.handleWorkerForget();
    assert.strictEqual(ctrl.workerManager.hasActiveInstance(), false);

    // 新实例启动：应先丢弃陈旧连接引用
    const newIds = { controllerId: "ctrl-new", workerId: "worker-new", taskId: "task-new" };
    const startPromise = ctrl.handleWorkerStart({ cwd: process.cwd(), title: "TN", task: "干活" }, TEST_PROBES, {
      ids: newIds,
      bootstrapToken: "boot-new",
      workerToken: "work-new",
      launchTimeoutMs: 300,
    });
    await waitFor(() => ctrl.workerManager.getInstance()?.workerId === "worker-new");

    assert.strictEqual(oldSock.destroyed, true, "陈旧连接必须被销毁");
    assert.strictEqual((ctrl as any).supervisorConn, null, "陈旧连接字段必须被置 null");

    const newSock = new FakeSocket();
    newSock.autoAckTypes = new Set(["launch"]);
    (ctrl as any).handleIncomingSocket(newSock as any);
    feed(newSock, helloFrame("supervisor", newIds.controllerId, newIds.workerId, "boot-new", "hello-new"));
    await settle();
    assert.ok(newSock.lastFrameOfType("hello_ok"), "新 ids 的 hello 必须能重新认证");

    // 收尾
    feed(newSock, {
      version: 1,
      controllerId: newIds.controllerId,
      workerId: newIds.workerId,
      id: "lf-new",
      seq: 2,
      type: "launch_failed",
      payload: { error: "收尾" },
    });
    await assert.rejects(() => startPromise, /LAUNCH_FAILED/);
    await cleanup(ctrl);
  });

  it("16. 存在活跃实例时 handleWorkerStart 仍抛 ALREADY_EXISTS，且不得销毁活跃连接", async () => {
    const ctrl = makeController({ controllerId: "ctrl-act", workerId: "worker-act", taskId: "task-act" });
    const actIds = { controllerId: "ctrl-act", workerId: "worker-act" };
    const supSock = connectAndAuth(ctrl, "supervisor", actIds, "boot-token", "hello-act-sup");
    await settle();
    const workerSock = connectAndAuth(ctrl, "worker", actIds, "worker-token", "hello-act-work");
    await settle();
    const supConn = (ctrl as any).supervisorConn;
    const workerConn = (ctrl as any).workerConn;
    assert.ok(supConn && workerConn);

    ctrl.launchSpawner = (() => new EventEmitter() as any) as any;
    await assert.rejects(
      () =>
        ctrl.handleWorkerStart({ cwd: process.cwd(), title: "T", task: "干活" }, TEST_PROBES, {
          ids: { controllerId: "ctrl-act2", workerId: "worker-act2", taskId: "task-act2" },
          bootstrapToken: "b2",
          workerToken: "w2",
          launchTimeoutMs: 200,
        }),
      /ALREADY_EXISTS/,
    );

    assert.strictEqual(supSock.destroyed, false, "活跃 supervisor 连接不得被销毁");
    assert.strictEqual(workerSock.destroyed, false, "活跃 worker 连接不得被销毁");
    assert.strictEqual((ctrl as any).supervisorConn, supConn, "supervisorConn 不得被替换");
    assert.strictEqual((ctrl as any).workerConn, workerConn, "workerConn 不得被替换");
    await cleanup(ctrl);
  });

  it("17. worker_send / followup ACK 超时 → DELIVERY_UNKNOWN 且只发一次", async () => {
    const ctrl = makeController();
    connectAndAuth(ctrl, "worker", IDS, "worker-token");
    await settle();
    const conn = (ctrl as any).workerConn;
    assert.ok(conn);

    let calls = 0;
    conn.sendRequest = (env: any): Promise<never> => {
      calls++;
      return Promise.reject(new AckTimeoutError(env.id, 1));
    };

    const err = await ctrl
      .handleWorkerSend({
        workerId: "worker-1",
        taskId: "task-1",
        message: "补充说明",
        kind: "supplement",
      })
      .then(
        () => null,
        (e) => e as Error,
      );

    assert.ok(err, "ACK 超时必须抛错");
    assert.match(err!.message, /DELIVERY_UNKNOWN/);
    assert.strictEqual(calls, 1, "投递结果未知时绝不自动重发");
    const unknown = (ctrl as any).unknownDeliveries;
    assert.strictEqual(unknown.length, 1);
    assert.strictEqual(unknown[0].kind, "followup");
    assert.strictEqual(unknown[0].taskId, "task-1");
    assert.strictEqual((ctrl as any).currentCommittedReport, null, "旧回执已作废 (第一组语义)");
    await cleanup(ctrl);
  });

  it("18. worker_stop / abort ACK 超时 → DELIVERY_UNKNOWN、taskState=stopping、绝不 stopped", async () => {
    const ctrl = makeController();
    connectAndAuth(ctrl, "worker", IDS, "worker-token");
    await settle();
    const conn = (ctrl as any).workerConn;
    assert.ok(conn);

    let calls = 0;
    conn.sendRequest = (env: any): Promise<never> => {
      calls++;
      return Promise.reject(new AckTimeoutError(env.id, 1));
    };

    const err = await ctrl
      .handleWorkerStop({ workerId: "worker-1", reason: "停" })
      .then(
        () => null,
        (e) => e as Error,
      );

    assert.ok(err, "ACK 超时必须抛错");
    assert.match(err!.message, /DELIVERY_UNKNOWN/);
    assert.strictEqual(calls, 1);
    const unknown = (ctrl as any).unknownDeliveries;
    assert.strictEqual(unknown.length, 1);
    assert.strictEqual(unknown[0].kind, "abort");
    assert.strictEqual(ctrl.workerManager.getInstance()?.taskState, "stopping");
    assert.notStrictEqual(ctrl.workerManager.getInstance()?.taskState, "stopped");
    await cleanup(ctrl);
  });

  it("19. 初始 task ACK 超时（真实启动链路）→ DELIVERY_UNKNOWN、保持 connected、不释放名额", async () => {
    const ctrl = new ControllerManager(new FakePiAPI() as any);
    ctrl.launchSpawner = (() => new EventEmitter() as any) as any;
    const ids = { controllerId: "ctrl-task", workerId: "worker-task", taskId: "task-task" };
    const startPromise = ctrl.handleWorkerStart(
      { cwd: process.cwd(), title: "T", task: "干活" },
      TEST_PROBES,
      { ids, bootstrapToken: "boot-task", workerToken: "work-task", launchTimeoutMs: 500 },
    );

    await waitFor(() => ctrl.workerManager.getInstance()?.workerId === "worker-task");

    const supSock = new FakeSocket();
    supSock.autoAckTypes = new Set(["launch"]);
    (ctrl as any).handleIncomingSocket(supSock as any);
    feed(supSock, helloFrame("supervisor", ids.controllerId, ids.workerId, "boot-task", "hello-sup-task"));
    await waitFor(() => (ctrl as any).supervisorConn);

    const workerSock = new FakeSocket();
    (ctrl as any).handleIncomingSocket(workerSock as any);
    feed(workerSock, helloFrame("worker", ids.controllerId, ids.workerId, "work-task", "hello-work-task"));
    await waitFor(() => (ctrl as any).workerConn);

    // 缩短真实 sendRequest 的 ACK 超时，避免写入 5s 级用例
    const conn = (ctrl as any).workerConn;
    const realSend = conn.sendRequest.bind(conn);
    let taskCalls = 0;
    conn.sendRequest = (env: any, _timeout?: number): Promise<any> => {
      if (env.type === "task") taskCalls++;
      return realSend(env, 60);
    };

    // 上报 worker_ready 但不自动 ACK task
    feed(workerSock, {
      version: 1,
      controllerId: ids.controllerId,
      workerId: ids.workerId,
      id: "ready-task",
      seq: 2,
      type: "worker_ready",
      payload: { cwd: process.cwd(), tools: [], version: "1" },
    });

    const startErr = await startPromise.then(
      () => null,
      (e) => e as Error,
    );
    assert.ok(startErr, "task ACK 超时必须抛错");
    assert.match(startErr!.message, /DELIVERY_UNKNOWN/);
    assert.strictEqual(taskCalls, 1, "task 请求只发一次，绝不自动重发");
    const unknown = (ctrl as any).unknownDeliveries;
    assert.strictEqual(unknown.length, 1);
    assert.strictEqual(unknown[0].kind, "task");
    assert.strictEqual(unknown[0].taskId, "task-task");
    assert.strictEqual(unknown[0].revision, 1);
    assert.strictEqual(unknown[0].runId, 1);
    assert.strictEqual(ctrl.workerManager.hasActiveInstance(), true, "必须保留单实例名额");
    assert.strictEqual(ctrl.workerManager.getInstance()?.lifecycleState, "connected");
    assert.notStrictEqual(ctrl.workerManager.getInstance()?.lifecycleState, "launch_unknown");
    await cleanup(ctrl);
  });

  it("20. unknownDeliveries 上限 64、FIFO 淘汰计数且 worker_status 暴露", async () => {
    const ctrl = makeController();
    for (let i = 0; i < 65; i++) {
      (ctrl as any).recordUnknownDelivery({
        requestId: `req-${i}`,
        kind: "task",
        taskId: "task-1",
        revision: 1,
        runId: 1,
        at: Date.now(),
      });
    }

    const arr = (ctrl as any).unknownDeliveries;
    assert.strictEqual(arr.length, 64, "长度必须恒为 64");
    assert.strictEqual(arr[0].requestId, "req-1", "最旧一条被淘汰");
    assert.strictEqual(arr[63].requestId, "req-64");
    assert.strictEqual((ctrl as any).unknownDeliveriesDropped, 1);

    const status = await ctrl.handleWorkerStatus({ workerId: "worker-1" });
    assert.strictEqual(status.unknownDeliveries.length, 64);
    assert.strictEqual(status.unknownDeliveries[0].requestId, "req-1");
    assert.strictEqual(status.diagnostics.unknownDeliveriesDropped, 1);
    await cleanup(ctrl);
  });

  it("21. bootstrap 未认证拒绝 launch/terminate，认证后校验非法 launch（真实子进程）", async () => {
    const h = await startBootstrapShell();
    try {
      await waitFor(() => h.sockets.length > 0, 4000);
      await h.waitFrame((f) => f.type === "hello", "bootstrap hello");

      // 未认证：launch 与 terminate 都必须被拒绝、不得 spawn
      h.send(frameEnv("launch", {}, "prelaunch"));
      h.send(frameEnv("terminate", { force: false }, "preterm"));

      const launchAck = await h.waitFrame(
        (f) => f.type === "ack" && f.replyTo === "prelaunch",
        "unauthenticated launch ack",
      );
      assert.strictEqual(launchAck.payload.ok, false);
      assert.strictEqual(launchAck.payload.code, "AUTH_FAILED");
      const termAck = await h.waitFrame(
        (f) => f.type === "ack" && f.replyTo === "preterm",
        "unauthenticated terminate ack",
      );
      assert.strictEqual(termAck.payload.ok, false);
      assert.strictEqual(termAck.payload.code, "AUTH_FAILED");
      assert.strictEqual(h.frames.filter((f) => f.type === "child_spawned").length, 0);

      // 认证后发非法 payload：PROTOCOL_ERROR + launch_failed，仍不得 spawn
      h.send(frameEnv("hello_ok", {}));
      h.send(frameEnv("launch", { cwd: process.cwd() }, "badlaunch"));
      const badAck = await h.waitFrame(
        (f) => f.type === "ack" && f.replyTo === "badlaunch",
        "bad launch ack",
      );
      assert.strictEqual(badAck.payload.ok, false);
      assert.strictEqual(badAck.payload.code, "PROTOCOL_ERROR");
      const failed = await h.waitFrame((f) => f.type === "launch_failed", "launch_failed");
      assert.match(failed.payload.error, /launch payload 校验失败/);
      assert.strictEqual(h.frames.filter((f) => f.type === "child_spawned").length, 0);
    } finally {
      await stopBootstrap(h);
    }
  });

  it("22. bootstrap 重复 launch 拒绝 ALREADY_EXISTS 且只 spawn 一次（真实子进程）", async () => {
    const h = await startBootstrapShell();
    try {
      await waitFor(() => h.sockets.length > 0, 4000);
      await h.waitFrame((f) => f.type === "hello", "bootstrap hello");
      h.send(frameEnv("hello_ok", {}));

      const payload = {
        cwd: REPO_ROOT,
        nodePath: process.execPath,
        piCliPath: FIXTURE_CLI_PATH,
        extensionPath: REPO_ROOT,
        workerToken: "worker-token-boot",
        workerPipePath: h.pipePath,
      };
      h.send(frameEnv("launch", payload, "launch-1"));
      const ack1 = await h.waitFrame(
        (f) => f.type === "ack" && f.replyTo === "launch-1",
        "launch1 ack",
      );
      assert.strictEqual(ack1.payload.ok, true);

      // 夹具进程会立刻退出，尽快发第二次 launch，避免 bootstrap 退出后收不到 ACK
      h.send(frameEnv("launch", payload, "launch-2"));
      const ack2 = await h.waitFrame(
        (f) => f.type === "ack" && f.replyTo === "launch-2",
        "launch2 ack",
      );
      assert.strictEqual(ack2.payload.ok, false);
      assert.strictEqual(ack2.payload.code, "ALREADY_EXISTS");

      await h.waitFrame((f) => f.type === "child_spawned", "child_spawned");
      await h.waitFrame((f) => f.type === "child_exit", "child_exit");
      await waitChildExit(h.proc, 4000);

      assert.strictEqual(
        h.frames.filter((f) => f.type === "child_spawned").length,
        1,
        "重复 launch 不得 spawn 第二个子进程",
      );
    } finally {
      await stopBootstrap(h);
    }
  });

  it("23. bootstrap 接收缓冲超过 2 MiB → 销毁连接；无子进程时退出", async () => {
    const h = await startBootstrapShell();
    try {
      await waitFor(() => h.sockets.length > 0, 4000);
      await h.waitFrame((f) => f.type === "hello", "bootstrap hello");
      h.send(frameEnv("hello_ok", {}));

      // 2.2 MiB 无换行数据：超过接收缓冲上限
      h.send("a".repeat(2 * 1024 * 1024 + 200 * 1024));
      await waitChildExit(h.proc, 5000);
      assert.notStrictEqual(h.proc.exitCode, null, "无子进程时超过缓冲上限必须退出");
    } finally {
      await stopBootstrap(h);
    }
  });

  it("24. worker_close / close ACK 超时 → DELIVERY_UNKNOWN，未确认退出错误带上送达未知", async () => {
    const ctrl = makeController();
    ctrl.closeWaitTimeoutMs = 80;
    connectAndAuth(ctrl, "worker", IDS, "worker-token");
    await settle();
    const conn = (ctrl as any).workerConn;
    assert.ok(conn);

    let calls = 0;
    conn.sendRequest = (env: any): Promise<never> => {
      calls++;
      return Promise.reject(new AckTimeoutError(env.id, 1));
    };

    const err = await ctrl
      .handleWorkerClose({ workerId: "worker-1", disposition: "abandoned" })
      .then(
        () => null,
        (e) => e as Error,
      );

    assert.ok(err, "未确认退出必须抛错");
    assert.match(err!.message, /未确认 Worker 进程退出/);
    assert.match(err!.message, /关闭指令送达未知/);
    const unknown = (ctrl as any).unknownDeliveries;
    assert.strictEqual(unknown.length, 1);
    assert.strictEqual(unknown[0].kind, "close");
    assert.match(err!.message, new RegExp(unknown[0].requestId), "错误必须携带请求 ID");
    assert.strictEqual(calls, 1);
    assert.notStrictEqual(ctrl.workerManager.getInstance()?.lifecycleState, "closed");
    await cleanup(ctrl);
  });

  it("25. task ACK 超时同时收到 child_exit → 释放名额且错误同时含 LAUNCH_FAILED 与 DELIVERY_UNKNOWN", async () => {
    const ctrl = new ControllerManager(new FakePiAPI() as any);
    ctrl.launchSpawner = (() => new EventEmitter() as any) as any;
    const ids = { controllerId: "ctrl-task-x", workerId: "worker-task-x", taskId: "task-task-x" };
    const startPromise = ctrl.handleWorkerStart(
      { cwd: process.cwd(), title: "T", task: "干活" },
      TEST_PROBES,
      { ids, bootstrapToken: "boot-task-x", workerToken: "work-task-x", launchTimeoutMs: 500 },
    );

    await waitFor(() => ctrl.workerManager.getInstance()?.workerId === "worker-task-x");

    const supSock = new FakeSocket();
    supSock.autoAckTypes = new Set(["launch"]);
    (ctrl as any).handleIncomingSocket(supSock as any);
    feed(supSock, helloFrame("supervisor", ids.controllerId, ids.workerId, "boot-task-x", "hello-sup-x"));
    await waitFor(() => (ctrl as any).supervisorConn);

    const workerSock = new FakeSocket();
    (ctrl as any).handleIncomingSocket(workerSock as any);
    feed(workerSock, helloFrame("worker", ids.controllerId, ids.workerId, "work-task-x", "hello-work-x"));
    await waitFor(() => (ctrl as any).workerConn);

    // 缩短真实 sendRequest 的 ACK 超时，保留“先发出 task、再超时”的真实链路
    const conn = (ctrl as any).workerConn;
    const realSend = conn.sendRequest.bind(conn);
    conn.sendRequest = (env: any, _timeout?: number): Promise<any> => realSend(env, 150);

    feed(workerSock, {
      version: 1,
      controllerId: ids.controllerId,
      workerId: ids.workerId,
      id: "ready-x",
      seq: 2,
      type: "worker_ready",
      payload: { cwd: process.cwd(), tools: [], version: "1" },
    });

    // task 请求发出后立即上报 child_exit（在 ACK 超时窗口内）
    await waitFor(() => workerSock.framesOfType("task").length > 0);
    feed(supSock, {
      version: 1,
      controllerId: ids.controllerId,
      workerId: ids.workerId,
      id: "exit-x",
      seq: 2,
      type: "child_exit",
      payload: { pid: 4321, code: 1, signal: null },
    });

    const startErr = await startPromise.then(
      () => null,
      (e) => e as Error,
    );
    assert.ok(startErr, "必须抛错");
    assert.match(startErr!.message, /LAUNCH_FAILED/);
    assert.match(startErr!.message, /DELIVERY_UNKNOWN/);
    assert.strictEqual(ctrl.workerManager.hasActiveInstance(), false, "进程已确认退出必须释放名额");
    const unknown = (ctrl as any).unknownDeliveries;
    assert.strictEqual(unknown.length, 1, "退出不等于没发过，必须保留未知投递记录");
    assert.strictEqual(unknown[0].kind, "task");
    assert.match(startErr!.message, new RegExp(unknown[0].requestId), "错误必须携带任务请求 ID");

    // 名额已释放，按 cleanup 套路收尾（不再走 worker_close）
    await cleanup(ctrl);
  });
});
