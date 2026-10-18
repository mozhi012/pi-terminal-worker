import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getPipePath } from "../dist/transport.js";
import { validateDescriptor, monitorOwner, isProcessAlive } from "../runtime/bootstrap-support.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const bootstrap = fileURLToPath(new URL("../runtime/bootstrap.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/role-pi-cli.mjs", import.meta.url));
const noop = fileURLToPath(new URL("./fixtures/noop-pi-cli.mjs", import.meta.url));
const base = { version: 1, controllerId: "c", workerId: "w", pipePath: "p", bootstrapToken: "t" };
async function waitFor(predicate: () => unknown, timeout = 6500) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("等待 bootstrap 条件超时");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
function hasExited(proc: ChildProcess) { return proc.exitCode !== null || proc.signalCode !== null; }

async function startBootstrap(role: unknown, ownerPid?: number, cli = fixture) {
  const pipePath = getPipePath("lead-bootstrap-" + crypto.randomUUID().slice(0, 8));
  const frames: any[] = [];
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        const env = JSON.parse(line);
        frames.push(env);
        if (env.type === "hello") {
          const send = (type: string, payload: any) => socket.write(JSON.stringify({
            ...base, id: crypto.randomUUID(), seq: 1, type, payload,
          }) + "\n");
          send("hello_ok", {});
          send("launch", {
            cwd: root, nodePath: process.execPath, piCliPath: cli, extensionPath: root,
            workerToken: "test-token", workerPipePath: pipePath,
          });
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(pipePath, resolve));
  const descriptor = { ...base, pipePath, ...(role === undefined ? {} : { role }), ...(ownerPid === undefined ? {} : { ownerPid }) };
  const proc = spawn(process.execPath, [bootstrap, "--descriptor", Buffer.from(JSON.stringify(descriptor)).toString("base64url")], {
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PI_TERMINAL_WORKER_ROLE: "inherited-role-must-not-leak" },
  });
  let output = "";
  let errors = "";
  proc.stdout!.on("data", (d) => { output += d.toString(); });
  proc.stderr!.on("data", (d) => { errors += d.toString(); });
  async function cleanup() {
    // 正常终止指令由 supervisor 回收 child，再退出自身。
    if (!hasExited(proc) && sockets[0] && !sockets[0].destroyed) {
      sockets[0].write(JSON.stringify({ id: "cleanup", type: "terminate", payload: { force: true } }) + "\n");
      await waitFor(() => hasExited(proc));
    }
    if (!hasExited(proc)) { proc.kill(); await waitFor(() => hasExited(proc)); }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return { proc, frames, sockets, output: () => output, errors: () => errors, cleanup };
}

describe("bootstrap role whitelist and owner monitoring", () => {
  it("运行时描述符角色白名单和 owner 正整数校验与 TS 侧一致", () => {
    for (const role of [undefined, "worker", "lead"]) assert.equal(validateDescriptor({ ...base, role }).role, role);
    for (const role of [null, "", "controller", 1, {}]) assert.throws(() => validateDescriptor({ ...base, role }), /role/);
    for (const ownerPid of [null, 0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => validateDescriptor({ ...base, ownerPid }), /ownerPid/);
    }
    assert.equal(validateDescriptor({ ...base, ownerPid: process.pid }).ownerPid, process.pid);
    assert.equal(isProcessAlive(process.pid), true);
  });

  it("注入时钟：无 owner 不设 timer，owner 死亡只清理和终止一次，正常 child exit 可取消", () => {
    let callback = () => {};
    let alive = true;
    let scheduled = 0;
    let cancelled = 0;
    let lost = 0;
    const timer = { unref() {} };
    const options = {
      isAlive: (pid: number) => { assert.equal(pid, 123); return alive; },
      schedule: (fn: () => void, ms: number) => { assert.equal(ms, 4000); callback = fn; scheduled++; return timer; },
      cancel: (value: unknown) => { assert.equal(value, timer); cancelled++; },
    };
    monitorOwner(undefined, () => lost++, options)();
    assert.equal(scheduled, 0);
    const stop = monitorOwner(123, () => lost++, options);
    callback();
    assert.equal(lost, 0);
    alive = false;
    callback(); callback(); stop();
    assert.equal(lost, 1);
    assert.equal(cancelled, 1);
    alive = true;
    const stopOnChildExit = monitorOwner(123, () => lost++, options);
    stopOnChildExit();
    alive = false;
    callback();
    assert.equal(lost, 1);
    assert.equal(cancelled, 2);
  });

  for (const role of [undefined, "worker", "lead"]) {
    it(`真实 bootstrap 以 ${role ?? "default worker"} 角色启动子进程，覆盖继承 ROLE`, async () => {
      const h = await startBootstrap(role);
      try {
        await waitFor(() => h.output().includes("\n"));
        assert.equal(JSON.parse(h.output().trim()).role, role ?? "worker");
        assert.ok(!hasExited(h.proc));
        assert.equal(h.frames.filter((e) => e.type === "child_spawned").length, 1);
      } finally { await h.cleanup(); }
    });
  }

  for (const role of ["worker", "lead"]) {
    it(`顶层 ${role} 无 owner：断管道仍保持本地 child`, async () => {
      const h = await startBootstrap(role);
      let childPid: number | undefined;
      try {
        await waitFor(() => h.frames.some((e) => e.type === "child_spawned"));
        childPid = h.frames.find((e) => e.type === "child_spawned").payload.pid;
        for (const socket of h.sockets) socket.destroy();
        await new Promise((resolve) => setTimeout(resolve, 60));
        assert.equal(hasExited(h.proc), false);
        assert.equal(isProcessAlive(childPid), true);
      } finally {
        if (childPid && isProcessAlive(childPid)) process.kill(childPid, "SIGTERM");
        await waitFor(() => hasExited(h.proc));
        await h.cleanup();
      }
    });
  }

  it("真实 bootstrap 拒绝非法角色，不握手、不创建 child", async () => {
    const h = await startBootstrap("controller");
    try {
      await waitFor(() => hasExited(h.proc));
      assert.equal(h.proc.exitCode, 1);
      assert.match(h.errors(), /role/);
      assert.equal(h.frames.length, 0);
      assert.equal(h.output(), "");
    } finally { await h.cleanup(); }
  });

  it("正常 child exit 清除 owner timer，bootstrap 随后退出", async () => {
    const h = await startBootstrap("worker", process.pid, noop);
    try {
      await waitFor(() => hasExited(h.proc));
      assert.equal(h.proc.exitCode, 0);
      assert.ok(h.frames.some((e) => e.type === "child_exit"));
    } finally { await h.cleanup(); }
  });

  it("lead owner 消失后真实 bootstrap 终止 L2 child 并退出", async () => {
    const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { owner.once("spawn", resolve); owner.once("error", reject); });
    const h = await startBootstrap("worker", owner.pid);
    try {
      await waitFor(() => h.frames.some((e) => e.type === "child_spawned"));
      const childPid = h.frames.find((e) => e.type === "child_spawned").payload.pid;
      assert.equal(isProcessAlive(childPid), true);
      owner.kill();
      await waitFor(() => hasExited(owner));
      await waitFor(() => hasExited(h.proc));
      assert.equal(isProcessAlive(childPid), false);
      assert.ok(h.frames.some((e) => e.type === "child_exit"));
    } finally {
      if (!hasExited(owner)) owner.kill();
      await h.cleanup();
    }
  });
});
