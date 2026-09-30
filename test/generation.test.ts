import { describe, it } from "node:test";
import * as assert from "node:assert";
import { EventEmitter } from "node:events";
import * as net from "node:net";
import { ControllerManager } from "../dist/controller.js";
import { CleanupRegistry } from "../dist/lifecycle.js";
import { ProtocolErrorCode } from "../dist/protocol.js";
import { AckTimeoutError, getPipePath } from "../dist/transport.js";
import { FakePiAPI } from "./fake-pi.ts";

/** 固定终端探测，避免测试依赖真实 where 探测 */
const START_PROBES = {
  findWt: () => "wt.exe" as string | null,
  findPowershell: () => null as string | null,
  findCmd: () => null as string | null,
};

/**
 * 轻量假管道 Socket：实现 JsonlConnection 所需的最小接口。
 * 本文件独立复制了 test/connection.test.ts 里的 harness 思路，
 * 不跨文件 import 其私有 helper。
 */
class FakeSocket extends EventEmitter {
  public destroyed = false;
  public written: string[] = [];
  /** 需要自动回 ACK 的请求类型；为空表示不自动回。 */
  public autoAckTypes = new Set<string>();
  /** destroy() 调用次数，用于断言“只销毁一次” */
  public destroyCount = 0;

  public write(data: unknown, encoding?: unknown, cb?: unknown): boolean {
    const str = typeof data === "string" ? data : Buffer.from(data as any).toString("utf8");
    this.written.push(str);
    const callback = typeof encoding === "function" ? encoding : cb;
    // 真实 socket 的写回调是异步的
    if (typeof callback === "function") {
      queueMicrotask(() => (callback as (e: null) => void)(null));
    }

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
    this.destroyCount++;
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
}

const IDS = { controllerId: "ctrl-1", workerId: "worker-1" };

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

function makeController(): ControllerManager {
  const ctrl = new ControllerManager(new FakePiAPI() as any);
  ctrl.workerManager.acquireLaunchSlot("ctrl-1", "worker-1", "task-1", process.cwd(), "T");
  (ctrl as any).expectedBootstrapToken = "boot-token";
  (ctrl as any).expectedWorkerToken = "worker-token";
  return ctrl;
}

function connectAndAuth(
  ctrl: ControllerManager,
  role: "supervisor" | "worker",
  token: string,
): FakeSocket {
  const sock = new FakeSocket();
  (ctrl as any).handleIncomingSocket(sock as any);
  feed(sock, helloFrame(role, IDS.controllerId, IDS.workerId, token));
  return sock;
}

async function settle(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => unknown, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("等待条件超时");
}

/** 清理控制器，避免 dispose 等待不会到来的 close ACK */
async function cleanup(ctrl: ControllerManager): Promise<void> {
  (ctrl as any).workerConn = null;
  (ctrl as any).supervisorConn = null;
  await ctrl.dispose();
}

/** 建立一个普通 EventEmitter 形式的连接，避免 JsonlConnection.destroy 后无法再投递消息 */
function makeConn(): EventEmitter & {
  socket: { destroyed: boolean };
  destroy: () => void;
  nextSeq: number;
} {
  const conn = new EventEmitter() as any;
  conn.socket = { destroyed: false };
  conn.destroy = () => {};
  conn.nextSeq = 1;
  return conn;
}

function reportCommittedEnv(seq = 2): any {
  return {
    version: 1,
    controllerId: IDS.controllerId,
    workerId: IDS.workerId,
    id: "rc-" + seq,
    seq,
    type: "report_committed",
    payload: {
      taskId: "task-1",
      revision: 1,
      runId: 1,
      report: { kind: "result", summary: "late" },
    },
  };
}

describe("第三组第一半：session generation 与幂等清理", () => {
  it("1. handleSessionStart 结束旧会话 waiters（会话已切换）", async () => {
    const ctrl = makeController();
    const pending = ctrl.handleWorkerWait({
      workerId: "worker-1",
      afterCursor: 0,
      timeoutMs: 60000,
    });
    await settle();
    assert.strictEqual((ctrl as any).waiters.length, 1, "应有一个挂起的 waiter");

    await ctrl.handleSessionStart();

    const err = await pending.then(
      () => null,
      (e) => e as Error,
    );
    assert.ok(err, "waiter 必须被拒绝而不是挂起");
    assert.match(err!.message, /会话已切换/);
    assert.strictEqual((ctrl as any).waiters.length, 0);
    assert.strictEqual(ctrl.sessionGen.generation, 1);
    await cleanup(ctrl);
  });

  it("2. 旧 generation 的 worker 消息晚到不污染新会话，且新 generation 仍可写入", async () => {
    const ctrl = makeController();
    const conn = makeConn();
    (ctrl as any).workerConn = conn;
    (ctrl as any).bindWorker(conn);
    assert.strictEqual(ctrl.workerManager.getInstance()?.lifecycleState, "connected");

    await ctrl.handleSessionStart();

    // 旧 generation 的监听器：身份与实例都匹配，但仍必须被忽略
    conn.emit("message", reportCommittedEnv(2));
    assert.strictEqual((ctrl as any).currentCommittedReport, null, "旧回执不得写入");
    assert.strictEqual((ctrl as any).inbox.length, 0, "旧事件不得进入收件箱");
    assert.ok((ctrl as any).staleCallbacksIgnored >= 1, "必须计入 staleCallbacksIgnored");
    assert.notStrictEqual(ctrl.workerManager.getInstance()?.taskState, "ready_for_review");

    // 反向对照：新 generation 的同一条消息必须正常生效（证明检查不是死代码）
    const conn2 = makeConn();
    (ctrl as any).workerConn = conn2;
    (ctrl as any).bindWorker(conn2);
    conn2.emit("message", reportCommittedEnv(3));
    const report = (ctrl as any).currentCommittedReport;
    assert.ok(report, "新 generation 的回执必须写入");
    assert.strictEqual(report.summary, "late");
    await cleanup(ctrl);
  });

  it("3. 旧 generation 心跳失效：不再 ping、也不再写 unresponsive", async () => {
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const callbacks: Array<() => void> = [];
    (globalThis as any).setInterval = (fn: any) => {
      callbacks.push(() => fn());
      return { fakeTimer: true };
    };
    (globalThis as any).clearInterval = () => {};
    try {
      const ctrl = makeController();
      const sock = connectAndAuth(ctrl, "worker", "worker-token");
      await settle();
      assert.strictEqual(callbacks.length, 1, "绑定 worker 应启动一次心跳");

      // 当前 generation：心跳按时发送 ping
      (ctrl as any).lastActivityTime = Date.now();
      callbacks[0]();
      await settle();
      assert.ok(sock.framesOfType("ping").length >= 1, "当前会话心跳应发送 ping");

      await ctrl.handleSessionStart();
      const before = sock.written.length;
      (ctrl as any).lastActivityTime = Date.now() - 10 * 60 * 1000;
      callbacks[0]();
      await settle();
      assert.strictEqual(sock.written.length, before, "旧 generation 心跳不得再写连接");
      assert.notStrictEqual(ctrl.workerManager.getInstance()?.lifecycleState, "unresponsive");
      await cleanup(ctrl);
    } finally {
      (globalThis as any).setInterval = realSetInterval;
      (globalThis as any).clearInterval = realClearInterval;
    }
  });

  it("4. dispose() 幂等：重复调用不抛、连接各 destroy 一次、close 指令只发一次", async () => {
    const ctrl = makeController();
    const supSock = connectAndAuth(ctrl, "supervisor", "boot-token");
    const workerSock = connectAndAuth(ctrl, "worker", "worker-token");
    await settle();
    assert.ok((ctrl as any).supervisorConn && (ctrl as any).workerConn);

    const workerConn = (ctrl as any).workerConn;
    let closeCalls = 0;
    const realSendRequest = workerConn.sendRequest.bind(workerConn);
    workerConn.sendRequest = (env: any, timeout?: number) => {
      if (env.type === "close") closeCalls++;
      // 不等待 5s ACK，直接用短超时（FakeSocket 不会回 ACK）
      return realSendRequest(env, 50);
    };

    await ctrl.dispose();
    await ctrl.dispose();

    assert.strictEqual(closeCalls, 1, "close 指令只能发送一次");
    assert.strictEqual(workerSock.destroyCount, 1, "worker 连接只能 destroy 一次");
    assert.strictEqual(supSock.destroyCount, 1, "supervisor 连接只能 destroy 一次");
  });

  it("5. CleanupRegistry 幂等、size 正确、reset 后可再次注册并清理", async () => {
    const registry = new CleanupRegistry();
    let a = 0;
    let b = 0;
    const unregisterA = registry.register(() => {
      a++;
    });
    registry.register(async () => {
      b++;
    });
    assert.strictEqual(registry.size, 2);

    await registry.disposeAll();
    await registry.disposeAll();
    assert.strictEqual(a, 1);
    assert.strictEqual(b, 1);
    assert.strictEqual(registry.size, 0);

    // reset 之后重新注册的新 disposer 必须能被下一次 disposeAll 执行
    registry.reset();
    let c = 0;
    registry.register(() => {
      c++;
    });
    assert.strictEqual(registry.size, 1);
    await registry.disposeAll();
    assert.strictEqual(c, 1);
    await registry.disposeAll();
    assert.strictEqual(c, 1);

    // 反注册后 size 立即减少，且不会再被执行
    void unregisterA;
    const fresh = new CleanupRegistry();
    let d = 0;
    const unregisterD = fresh.register(() => {
      d++;
    });
    unregisterD();
    assert.strictEqual(fresh.size, 0);
    await fresh.disposeAll();
    assert.strictEqual(d, 0);
  });

  it("6. closing 不被 disconnected 覆盖并追加 conn_closed；connected 时仍写 disconnected", async () => {
    const ctrl = makeController();
    const conn = makeConn();
    (ctrl as any).workerConn = conn;
    (ctrl as any).bindWorker(conn);
    ctrl.workerManager.setChildPid(4321);
    ctrl.workerManager.updateLifecycleState("closing");

    conn.emit("close", false);
    assert.strictEqual(ctrl.workerManager.getInstance()?.lifecycleState, "closing");
    const ev = (ctrl as any).inbox.find((e: any) => e.type === "conn_closed");
    assert.ok(ev, "必须追加 conn_closed 诊断事件");
    assert.strictEqual(ev.payload.role, "worker");
    assert.strictEqual(ev.payload.previousState, "closing");
    assert.strictEqual(ev.payload.pid, 4321);
    assert.strictEqual((ctrl as any).inbox.some((e: any) => e.type === "disconnected"), false);

    // 反向对照：connected 时断连仍写 disconnected
    const ctrl2 = makeController();
    const conn2 = makeConn();
    (ctrl2 as any).workerConn = conn2;
    (ctrl2 as any).bindWorker(conn2);
    ctrl2.workerManager.updateLifecycleState("connected");
    conn2.emit("close", false);
    assert.strictEqual(ctrl2.workerManager.getInstance()?.lifecycleState, "disconnected");
    assert.ok((ctrl2 as any).inbox.some((e: any) => e.type === "disconnected"));

    await cleanup(ctrl2);
    await cleanup(ctrl);
  });

  it("7. 双连接丢失且无 child_exit → child_exit_unconfirmed；有 child_exit 则不追加", async () => {
    // 场景 A：closing 状态下 worker 与 supervisor 都断开，且无 child_exit
    const ctrl = makeController();
    const workerConn = makeConn();
    (ctrl as any).workerConn = workerConn;
    (ctrl as any).bindWorker(workerConn);
    const supConn = makeConn();
    (ctrl as any).supervisorConn = supConn;
    (ctrl as any).bindSupervisor(supConn);

    ctrl.workerManager.setChildPid(4321);
    ctrl.workerManager.updateLifecycleState("closing");

    workerConn.emit("close", false);
    assert.strictEqual(ctrl.workerManager.getInstance()?.lifecycleState, "closing");
    assert.strictEqual((ctrl as any).workerConn, null);

    supConn.emit("close", false);
    assert.strictEqual(ctrl.workerManager.getInstance()?.lifecycleState, "closing");
    assert.strictEqual(ctrl.workerManager.hasActiveInstance(), true, "绝不释放名额");

    const ev = (ctrl as any).inbox.find((e: any) => e.type === "child_exit_unconfirmed");
    assert.ok(ev, "必须追加 child_exit_unconfirmed 诊断");
    assert.strictEqual(ev.payload.pid, 4321);
    assert.strictEqual(ev.payload.workerConnAlive, false);
    assert.strictEqual(ev.payload.supervisorConnAlive, false);
    assert.strictEqual(typeof ev.payload.taskState, "string");
    await cleanup(ctrl);

    // 场景 B：先收到 child_exit（已确认退出）再断开 supervisor
    const ctrl2 = makeController();
    const workerConn2 = makeConn();
    (ctrl2 as any).workerConn = workerConn2;
    (ctrl2 as any).bindWorker(workerConn2);
    const supConn2 = makeConn();
    (ctrl2 as any).supervisorConn = supConn2;
    (ctrl2 as any).bindSupervisor(supConn2);
    ctrl2.workerManager.setChildPid(4321);
    ctrl2.workerManager.updateLifecycleState("closing");

    supConn2.emit("message", {
      version: 1,
      controllerId: IDS.controllerId,
      workerId: IDS.workerId,
      id: "exit-confirmed",
      seq: 2,
      type: "child_exit",
      payload: { pid: 4321, code: 0, signal: null },
    });
    assert.strictEqual(ctrl2.workerManager.getInstance()?.lifecycleState, "closed");
    assert.strictEqual((ctrl2 as any).childExitConfirmed, true);

    workerConn2.emit("close", false);
    supConn2.emit("close", false);
    assert.strictEqual(
      (ctrl2 as any).inbox.some((e: any) => e.type === "child_exit_unconfirmed"),
      false,
      "已确认退出后不得再追加 child_exit_unconfirmed",
    );
    await cleanup(ctrl2);
  });

  it("8. 关闭顺序交错三种：只释放一次名额且都能成功返回", async () => {
    const orderings: Array<"ack-exit-socket" | "exit-socket" | "socket-exit"> = [
      "ack-exit-socket",
      "exit-socket",
      "socket-exit",
    ];

    for (const order of orderings) {
      const ctrl = makeController();
      ctrl.closeWaitTimeoutMs = 400;
      const supSock = connectAndAuth(ctrl, "supervisor", "boot-token");
      const workerSock = connectAndAuth(ctrl, "worker", "worker-token");
      await settle();

      let releaseCount = 0;
      const realRelease = ctrl.workerManager.releaseSlot.bind(ctrl.workerManager);
      (ctrl.workerManager as any).releaseSlot = (force?: boolean) => {
        releaseCount++;
        return realRelease(force);
      };

      if (order === "ack-exit-socket") {
        workerSock.autoAckTypes = new Set(["close"]);
      } else {
        const workerConn = (ctrl as any).workerConn;
        workerConn.sendRequest = (env: any) => {
          if (env.type === "close") {
            return new Promise((_resolve, reject) =>
              setTimeout(() => reject(new AckTimeoutError(env.id, 40)), 40),
            );
          }
          return Promise.resolve({ ok: true });
        };
      }

      const p = ctrl.handleWorkerClose({ workerId: "worker-1", disposition: "abandoned" });

      if (order === "ack-exit-socket") {
        await settle(30);
        feed(supSock, {
          version: 1,
          controllerId: IDS.controllerId,
          workerId: IDS.workerId,
          id: "exit-a",
          seq: 2,
          type: "child_exit",
          payload: { pid: 4321, code: 0, signal: null },
        });
        await settle(10);
        workerSock.emit("close", false);
      } else if (order === "exit-socket") {
        feed(supSock, {
          version: 1,
          controllerId: IDS.controllerId,
          workerId: IDS.workerId,
          id: "exit-b",
          seq: 2,
          type: "child_exit",
          payload: { pid: 4321, code: 0, signal: null },
        });
        await settle(10);
        workerSock.emit("close", false);
      } else {
        workerSock.emit("close", false);
        await settle(10);
        feed(supSock, {
          version: 1,
          controllerId: IDS.controllerId,
          workerId: IDS.workerId,
          id: "exit-c",
          seq: 2,
          type: "child_exit",
          payload: { pid: 4321, code: 0, signal: null },
        });
      }

      const res = await p;
      assert.strictEqual(res.ok, true, `顺序 ${order} 必须成功关闭`);
      assert.strictEqual(releaseCount, 1, `顺序 ${order} 只能释放一次名额`);
      assert.strictEqual(ctrl.workerManager.hasActiveInstance(), false);
      await cleanup(ctrl);
    }
  });

  it("9. 并发 handleWorkerClose：同 disposition 复用结果，不同 disposition 抛 INVALID_STATE", async () => {
    const ctrl = makeController();
    ctrl.closeWaitTimeoutMs = 400;
    connectAndAuth(ctrl, "supervisor", "boot-token");
    const workerSock = connectAndAuth(ctrl, "worker", "worker-token");
    workerSock.autoAckTypes = new Set(["close"]);
    await settle();

    let releaseCount = 0;
    const realRelease = ctrl.workerManager.releaseSlot.bind(ctrl.workerManager);
    (ctrl.workerManager as any).releaseSlot = (force?: boolean) => {
      releaseCount++;
      return realRelease(force);
    };

    const p1 = ctrl.handleWorkerClose({ workerId: "worker-1", disposition: "abandoned" });
    const p2 = ctrl.handleWorkerClose({ workerId: "worker-1", disposition: "abandoned" });
    await assert.rejects(
      () => ctrl.handleWorkerClose({ workerId: "worker-1", disposition: "accepted" }),
      (err: Error) => err.message.includes(`[${ProtocolErrorCode.INVALID_STATE}]`),
    );

    await waitFor(() => workerSock.framesOfType("close").length === 1);

    // 通过 supervisor 注入 child_exit 确认退出
    const supConn = (ctrl as any).supervisorConn;
    supConn.emit("message", {
      version: 1,
      controllerId: IDS.controllerId,
      workerId: IDS.workerId,
      id: "exit-concurrent",
      seq: 2,
      type: "child_exit",
      payload: { pid: 4321, code: 0, signal: null },
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.deepStrictEqual(r1, r2, "同 disposition 必须得到相同结果");
    assert.strictEqual(releaseCount, 1, "releaseSlot 只能调用一次");
    assert.strictEqual(workerSock.framesOfType("close").length, 1, "close 只发送一次");
    assert.strictEqual(ctrl.workerManager.hasActiveInstance(), false);
    await cleanup(ctrl);
  });
});

describe("启动代际防护：start 在会话切换/释放后不得继续或改写状态", () => {
  function makeStartController(suffix: string): { ctrl: ControllerManager; ids: any } {
    const ctrl = new ControllerManager(new FakePiAPI() as any);
    ctrl.launchSpawner = (() => new EventEmitter() as any) as any;
    ctrl.launchTimeoutMs = 30000;
    const ids = {
      controllerId: `ctrl-${suffix}`,
      workerId: `worker-${suffix}`,
      taskId: `task-${suffix}`,
    };
    return { ctrl, ids };
  }

  it("startServer listen 晚于会话切换：关闭局部 srv、不注册 stale server，start 快速失败", async () => {
    const { ctrl, ids } = makeStartController("gen1");
    const settled = ctrl
      .handleWorkerStart({ cwd: process.cwd(), title: "T", task: "干活" }, START_PROBES as any, {
        ids,
      })
      .then(
        () => "resolved",
        (e) => (e as Error).message,
      );

    // 立即切换会话：startServer 的 listen 回调必然看到过期 gen
    await ctrl.handleSessionStart();

    const outcome = await settled;
    assert.notStrictEqual(outcome, "resolved", "过期 gen 下 start 不得成功");
    assert.match(String(outcome), /取消|会话已切换/);
    assert.strictEqual((ctrl as any).server, null, "stale server 不得注册到 this.server");
    assert.strictEqual((ctrl as any).pipePath, null, "stale pipePath 不得残留");
    assert.strictEqual(
      ctrl.workerManager.getInstance()?.lifecycleState,
      "disconnected",
      "stale catch 不得改写为 launch_unknown",
    );
    await cleanup(ctrl);
  });

  it("握手等待中切换会话：快速取消且不写 launch_unknown", async () => {
    const { ctrl, ids } = makeStartController("gen2");
    const settled = ctrl
      .handleWorkerStart({ cwd: process.cwd(), title: "T", task: "干活" }, START_PROBES as any, {
        ids,
      })
      .then(
        () => "resolved",
        (e) => (e as Error).message,
      );

    await waitFor(() => (ctrl as any).server !== null);
    await settle(30); // 进入 waitForSupervisor 等待

    await ctrl.handleSessionStart();
    const outcome = await settled;
    assert.notStrictEqual(outcome, "resolved");
    assert.match(String(outcome), /取消|会话已切换/);
    assert.notStrictEqual(
      ctrl.workerManager.getInstance()?.lifecycleState,
      "launch_unknown",
      "会话切换后的失败不得写 launch_unknown",
    );
    await cleanup(ctrl);
  });

  it("dispose 后晚到的 startServer listen 不得复活 server/cleanup 句柄", async () => {
    const { ctrl, ids } = makeStartController("gen3");
    const settled = ctrl
      .handleWorkerStart({ cwd: process.cwd(), title: "T", task: "干活" }, START_PROBES as any, {
        ids,
      })
      .then(
        () => "resolved",
        () => "rejected",
      );

    await ctrl.dispose();
    assert.strictEqual(await settled, "rejected", "dispose 后的在途 start 必须失败");
    assert.strictEqual((ctrl as any).server, null, "dispose 后不得有存活的 server 引用");
    assert.strictEqual((ctrl as any).cleanupRegistry.size, 0, "dispose 后不得留下清理器");
    await cleanup(ctrl); // 幂等
  });

  it("会话切换后 listen error 竞态：stale 也必须 reject，不能永久挂起", async () => {
    const controllerId = "ctrl-listen-err";
    const pipePath = getPipePath(controllerId);
    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(pipePath, () => resolve());
    });

    try {
      const ctrl = new ControllerManager(new FakePiAPI() as any);
      ctrl.launchSpawner = (() => new EventEmitter() as any) as any;
      ctrl.launchTimeoutMs = 30000;
      const settled = ctrl
        .handleWorkerStart({ cwd: process.cwd(), title: "T", task: "干活" }, START_PROBES as any, {
          ids: { controllerId, workerId: "worker-listen-err", taskId: "task-listen-err" },
        })
        .then(
          () => "resolved",
          (e) => (e as Error).message,
        );

      // 先让代际失效，保证 listen 的 EADDRINUSE error 回调在 stale 状态下触发
      await ctrl.handleSessionStart();

      const outcome = await Promise.race([
        settled,
        new Promise((r) => setTimeout(() => r("__timeout__"), 2000)),
      ]);
      assert.notStrictEqual(outcome, "__timeout__", "stale listen error 必须 reject 本次 Promise");
      assert.match(String(outcome), /命名管道监听失败|取消/);
      assert.strictEqual((ctrl as any).server, null, "监听失败不得留下 server 引用");
      await cleanup(ctrl);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("旧会话 task ACK 超时不得写入新会话 unknownDeliveries", async () => {
    const ctrl = new ControllerManager(new FakePiAPI() as any);
    ctrl.launchSpawner = (() => new EventEmitter() as any) as any;
    ctrl.launchTimeoutMs = 30000;
    const settled = ctrl
      .handleWorkerStart({ cwd: process.cwd(), title: "T", task: "干活" }, START_PROBES as any, {
        ids: { controllerId: IDS.controllerId, workerId: IDS.workerId, taskId: "task-1" },
        bootstrapToken: "boot-token",
        workerToken: "worker-token",
      })
      .then(
        () => "resolved",
        (e) => (e as Error).message,
      );

    await waitFor(() => (ctrl as any).server !== null);
    const supSock = connectAndAuth(ctrl, "supervisor", "boot-token");
    // 让 supervisor 自动回 launch ACK，否则初始任务永远不会开始
    supSock.autoAckTypes = new Set(["launch"]);
    await waitFor(() => (ctrl as any).supervisorConn);
    const workerSock = connectAndAuth(ctrl, "worker", "worker-token");
    await waitFor(() => (ctrl as any).workerConn);

    // 拦截初始 task 的 ACK：让它在本会话失效后才 reject
    let rejectTask!: (e: unknown) => void;
    let taskPending = false;
    const workerConn = (ctrl as any).workerConn;
    workerConn.sendRequest = (env: any) => {
      if (env?.type === "task") {
        taskPending = true;
        return new Promise((_resolve, reject) => {
          rejectTask = reject;
        });
      }
      return Promise.resolve({ ok: true, id: env?.id });
    };

    feed(workerSock, {
      version: 1,
      controllerId: IDS.controllerId,
      workerId: IDS.workerId,
      id: "ready-1",
      seq: 2,
      type: "worker_ready",
      payload: { cwd: process.cwd(), tools: [], version: "1" },
    });
    await waitFor(() => taskPending && (ctrl as any).workerReadyReceived === true);

    // 会话切换（会清空 unknownDeliveries），然后旧 task ACK 才超时失败
    await ctrl.handleSessionStart();
    assert.strictEqual((ctrl as any).unknownDeliveries.length, 0, "切换时已清空未知投递");
    rejectTask(new AckTimeoutError("req-stale", 50));

    const outcome = await settled;
    assert.notStrictEqual(outcome, "resolved");
    assert.strictEqual(
      (ctrl as any).unknownDeliveries.length,
      0,
      "旧会话 task ACK 超时不得污染新会话 unknownDeliveries",
    );
    assert.strictEqual((ctrl as any).unknownDeliveriesDropped, 0);

    supSock.destroy();
    workerSock.destroy();
    await cleanup(ctrl);
  });
});
