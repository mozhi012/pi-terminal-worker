import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { buildTerminalLaunch, detectTerminalBackends, encodeDescriptor, validateAndPrepareLaunch, type LaunchEnvironment } from "../dist/launcher.js";
import { buildHerdrRunCommand, launchMultiplexer, runTerminalCommand, TerminalSpawnError, type TerminalCommandRunner } from "../dist/terminal-multiplexer.js";
import { ControllerManager } from "../dist/controller.js";
import { FakePiAPI } from "./fake-pi.ts";
import { closeHerdrPane, killProcessTree } from "../runtime/terminal-support.mjs";
import { buildChildEnv } from "../runtime/bootstrap-support.mjs";

const descriptor = encodeDescriptor({ version: 1, controllerId: "c", workerId: "worker-test", pipePath: "p", bootstrapToken: "t" });
const environment: LaunchEnvironment = {
  terminal: { backend: "herdr", command: "herdr" }, cwd: process.cwd(), nodePath: '/node path/quote\' & $%!.exe',
  bootstrapPath: '/bootstrap path/quote\' & $%!.mjs', extensionPath: process.cwd(), piCliPath: "fake.mjs",
};
const herdrEnv = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" };
const probes = {
  platform: "linux" as const, env: herdrEnv,
  findHerdr: () => "herdr", findTmux: () => "tmux",
  findWt: () => { throw new Error("Windows probe must not run on Linux"); },
};
function harness(shell = "bash") {
  const calls: string[][] = [];
  const run: TerminalCommandRunner = async (_command, args) => {
    calls.push(args);
    if (args[1] === "split") return JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } });
    if (args[1] === "process-info") return JSON.stringify({ result: { process_info: {
      shell_pid: 42, foreground_processes: [{ pid: 42, argv0: shell }],
    } } });
    return "";
  };
  return { calls, run };
}
function envSet(key: string, value: string | undefined) {
  const original = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  return () => { if (original === undefined) delete process.env[key]; else process.env[key] = original; };
}

describe("Linux and herdr backend selection", () => {
  it("prefers herdr inside its pane and isolates Windows detection", () => {
    assert.deepEqual(detectTerminalBackends(probes).map((x) => x.backend), ["herdr", "tmux"]);
    assert.deepEqual(detectTerminalBackends({ ...probes, env: {} }).map((x) => x.backend), ["tmux"]);
    assert.deepEqual(detectTerminalBackends({ ...probes, env: herdrEnv, findHerdr: () => null }).map((x) => x.backend), ["tmux"]);
  });
  it("does not auto-probe real multiplexers when probes are injected", () => {
    assert.deepEqual(detectTerminalBackends({ platform: "linux", env: herdrEnv }), []);
    assert.deepEqual(detectTerminalBackends({ platform: "win32", env: herdrEnv,
      findWt: () => "wt", findPowershell: () => "ps", findCmd: () => "cmd" }).map((x) => x.backend), ["wt", "powershell", "cmd"]);
  });
  it("supports forced backends, ordered lists, exclusions and explicit invalid/unavailable errors", () => {
    const detect = (setting: string) => detectTerminalBackends({ ...probes, env: { ...herdrEnv, PI_TERMINAL_WORKER_BACKEND: setting } });
    assert.deepEqual(detect("tmux,herdr").map((x) => x.backend), ["tmux", "herdr"]);
    assert.deepEqual(detect("herdr").map((x) => x.backend), ["herdr"]);
    assert.deepEqual(detect("!herdr").map((x) => x.backend), ["tmux"]);
    assert.deepEqual(detect("tmux,herdr,!herdr").map((x) => x.backend), ["tmux"]);
    assert.throws(() => detect("unknown"), /无效/);
    assert.throws(() => detect("tmux,"), /无效/);
    assert.throws(() => detect("wt"), /不可用/);
    assert.throws(() => detectTerminalBackends({ ...probes, findTmux: () => null, env: { PI_TERMINAL_WORKER_BACKEND: "tmux" } }), /不可用/);
    assert.throws(() => detectTerminalBackends({ ...probes, env: { PI_TERMINAL_WORKER_BACKEND: "herdr" } }), /HERDR_ENV/);
  });
  it("prepares a Linux launch without any Windows platform bypass", () => {
    const restore = envSet("PI_TEST_MOCK_CLI", "1");
    try { assert.equal(validateAndPrepareLaunch(process.cwd(), probes).terminal.backend, "herdr"); }
    finally { restore(); }
  });
});

describe("Multiplexer launch and cleanup", () => {
  it("builds safe commands for PowerShell, cmd and POSIX shells using env references", () => {
    const values = { path: 'quote\' & $(touch bad) %PATH%! "' };
    assert.match(buildHerdrRunCommand("C:\\Program Files\\PowerShell\\7\\pwsh.exe", values), /^& \$env:/);
    for (const shell of ["bash", "/bin/zsh", "fish"]) assert.ok(!buildHerdrRunCommand(shell, values).includes("touch"));
    for (const shell of ["-bash", "-zsh"]) assert.ok(buildHerdrRunCommand(shell, values).startsWith('"$PITW_BOOTSTRAP_NODE"'));
    assert.throws(() => buildHerdrRunCommand("cmd.exe", values), /双引号/);
    assert.match(buildHerdrRunCommand("cmd.exe", { path: "x & %y%!" }), /^"%PITW_BOOTSTRAP_NODE%"/);
    assert.throws(() => buildHerdrRunCommand("nu", values), /不支持/);
  });
  it("splits without focus, passes values as env, renames, runs and closes only once", async () => {
    const h = harness("pwsh.exe");
    const spec = buildTerminalLaunch(environment, 'worker "title" & anything', descriptor);
    const handle = await launchMultiplexer(spec, { run: h.run });
    assert.equal(handle.paneId, "w1:p2");
    assert.ok(h.calls[0].includes("--current"));
    assert.ok(h.calls[0].includes("--no-focus"));
    assert.ok(h.calls[0].includes(`PITW_BOOTSTRAP_NODE=${environment.nodePath}`));
    assert.ok(h.calls[0].includes("PITW_BOOTSTRAP_HERDR=herdr"));
    assert.ok(h.calls.find((args) => args[1] === "rename")?.includes(spec.title));
    assert.ok(!h.calls.find((args) => args[1] === "run")![3].includes(spec.title));
    await Promise.all([handle.close(), handle.close()]);
    assert.equal(h.calls.filter((args) => args[1] === "close").length, 1);
  });
  for (const failingStep of ["process-info", "run"]) {
    it(`cleans a created pane before reporting ${failingStep} failure`, async () => {
      const h = harness();
      await assert.rejects(launchMultiplexer(buildTerminalLaunch(environment, "t", descriptor), { run: async (command, args, options) => {
        if (args[1] === failingStep) throw new Error("exit code 1");
        return h.run(command, args, options);
      } }), TerminalSpawnError);
      assert.equal(h.calls.filter((args) => args[1] === "close").length, 1);
    });
  }
  it("treats malformed split responses as explicit spawn errors", async () => {
    await assert.rejects(launchMultiplexer(buildTerminalLaunch(environment, "t", descriptor), { run: async () => "{}" }), /pane_id/);
  });
  it("ignores rename errors and continues to run", async () => {
    const h = harness();
    const handle = await launchMultiplexer(buildTerminalLaunch(environment, "t", descriptor), { run: (command, args, options) => {
      if (args[1] === "rename") return Promise.reject(new Error("rename failed"));
      return h.run(command, args, options);
    } });
    assert.ok(h.calls.some((args) => args[1] === "run"));
    await handle.close();
  });
  for (const cancelledStep of ["split", "rename", "process-info", "run"]) {
    it(`cancels after ${cancelledStep} and closes its own pane without fallback`, async () => {
      const h = harness();
      let active = true;
      await assert.rejects(launchMultiplexer(buildTerminalLaunch(environment, "t", descriptor), {
        run: async (command, args, options) => {
          const result = await h.run(command, args, options);
          if (args[1] === cancelledStep) active = false;
          return result;
        }, assertActive: () => { if (!active) throw new Error("cancelled"); },
      }), /cancelled/);
      assert.equal(h.calls.filter((args) => args[1] === "close").length, 1);
      if (cancelledStep !== "run") assert.ok(!h.calls.some((args) => args[1] === "run"));
    });
  }
  for (const inside of [true, false]) {
    it(`tmux ${inside ? "new-window" : "new-session"} preserves argv and its cleanup target`, async () => {
      const restore = envSet("TMUX", inside ? "fake" : undefined);
      try {
        const spec = buildTerminalLaunch({ ...environment, terminal: { backend: "tmux", command: "tmux" } }, 'title & " $()', descriptor);
        assert.equal(spec.args[0], inside ? "new-window" : "new-session");
        assert.ok(spec.args.includes(environment.nodePath));
        assert.equal(spec.args[spec.args.length - 1], descriptor);
        const calls: string[][] = [];
        const handle = await launchMultiplexer(spec, { run: async (_command, args) => { calls.push(args); return "@7\n"; } });
        assert.equal(handle.windowId, "@7");
        await handle.close(); await handle.close();
        assert.deepEqual(calls[1], inside ? ["kill-window", "-t", "@7"] : ["kill-session", "-t", "pitw-worker-test"]);
        assert.equal(calls.length, 2);
      } finally { restore(); }
    });
  }
  it("rejects real CLI nonzero exits immediately", async () => {
    await assert.rejects(runTerminalCommand(process.execPath, ["-e", "process.exit(7)"], { cwd: process.cwd(), env: process.env }), /failed/);
  });
});

describe("Bootstrap terminal/process cleanup", () => {
  it("closes only a marked bootstrap pane and tolerates duplicate closure", () => {
    const calls: any[] = [];
    const run = (...args: any[]) => { calls.push(args); return { status: 1 }; };
    closeHerdrPane({ HERDR_PANE_ID: "w1:p2" }, run);
    assert.equal(calls.length, 0);
    closeHerdrPane({ HERDR_PANE_ID: "w1:p2", PITW_BOOTSTRAP_HERDR: "herdr" }, run);
    assert.deepEqual(calls[0].slice(0, 2), ["herdr", ["pane", "close", "w1:p2"]]);
    const child = buildChildEnv({ PITW_BOOTSTRAP_HERDR: "herdr", HERDR_PANE_ID: "w1:p2" }, {});
    assert.equal(child.PITW_BOOTSTRAP_HERDR, undefined);
    assert.equal(child.HERDR_PANE_ID, "w1:p2");
  });
  it("freezes parents, rescans for late descendants, then kills bottom-up", () => {
    const signals: Array<[number, string]> = [];
    let scan = 0;
    killProcessTree(10, {
      signal: (pid: number, signal: string) => signals.push([pid, signal]),
      list: () => ++scan === 1 ? [{ pid: 11, ppid: 10 }] : [{ pid: 11, ppid: 10 }, { pid: 12, ppid: 11 }, { pid: 99, ppid: 1 }],
    });
    assert.deepEqual(signals, [[10, "SIGSTOP"], [11, "SIGSTOP"], [12, "SIGSTOP"], [12, "SIGKILL"], [11, "SIGKILL"], [10, "SIGKILL"]]);
    assert.ok(scan >= 2);
  });
  it("still kills the frozen root if process enumeration fails", () => {
    const signals: any[] = [];
    assert.throws(() => killProcessTree(10, { list: () => { throw new Error("failed"); }, signal: (...args: any[]) => signals.push(args) }));
    assert.deepEqual(signals, [[10, "SIGSTOP"], [10, "SIGKILL"]]);
  });
});

function controllerHarness() {
  const ctrl = new ControllerManager(new FakePiAPI() as any, true);
  (ctrl as any).startServer = async () => "test-pipe";
  const connection = () => Object.assign(new EventEmitter(), { socket: { destroyed: false }, destroy() {}, nextSeq: 1, sendRequest: async () => ({ ok: true }) });
  (ctrl as any).waitForSupervisor = async () => { (ctrl as any).supervisorConn = connection(); };
  (ctrl as any).waitForWorkerReady = async () => { (ctrl as any).workerConn = connection(); };
  return ctrl;
}

describe("Controller multiplexer lifecycle", () => {
  it("publishes pane metadata and closes the pane on disposal", async () => {
    const restore = envSet("PI_TEST_MOCK_CLI", "1");
    const ctrl = controllerHarness();
    const h = harness();
    ctrl.terminalRunner = h.run;
    try {
      const started = await ctrl.handleWorkerStart({ cwd: process.cwd(), title: "t", task: "x" }, probes);
      assert.equal((await ctrl.handleWorkerStatus({ workerId: started.workerId })).worker?.terminal?.paneId, "w1:p2");
      await ctrl.dispose(); await ctrl.dispose();
      assert.equal(h.calls.filter((args) => args[1] === "close").length, 1);
    } finally { await ctrl.dispose(); restore(); }
  });
  for (const event of ["child_exit", "launch_failed", "session-switch"]) {
    it(`closes the pane after ${event}`, async () => {
      const restore = envSet("PI_TEST_MOCK_CLI", "1");
      const ctrl = controllerHarness();
      const h = harness();
      ctrl.terminalRunner = h.run;
      try {
        await ctrl.handleWorkerStart({ cwd: process.cwd(), title: "t", task: "x" }, probes);
        if (event === "session-switch") await ctrl.handleSessionStart();
        else {
          const inst = ctrl.workerManager.getInstance()!;
          const conn = (ctrl as any).supervisorConn;
          (ctrl as any).bindSupervisor(conn);
          conn.emit("message", { version: 1, controllerId: inst.controllerId, workerId: inst.workerId,
            id: "exit", seq: 1, type: event, payload: event === "child_exit" ? { pid: 42, code: 0, signal: null } : { error: "failed" } });
          await (ctrl as any).terminalClosing;
        }
        assert.equal(h.calls.filter((args) => args[1] === "close").length, 1);
      } finally { await ctrl.dispose(); restore(); }
    });
  }
  it("closes the terminal even when force-close cannot get a supervisor ACK", async () => {
    const restore = envSet("PI_TEST_MOCK_CLI", "1");
    const ctrl = controllerHarness();
    const h = harness();
    ctrl.terminalRunner = h.run;
    try {
      const started = await ctrl.handleWorkerStart({ cwd: process.cwd(), title: "t", task: "x" }, probes);
      (ctrl as any).supervisorConn.sendRequest = async () => { throw new Error("supervisor disconnected"); };
      await assert.rejects(ctrl.handleWorkerClose({ workerId: started.workerId, disposition: "abandoned", force: true }), /supervisor disconnected/);
      assert.equal(h.calls.filter((args) => args[1] === "close").length, 1);
      assert.ok(ctrl.workerManager.hasActiveInstance(), "no child_exit confirmation must retain the slot");
    } finally { await ctrl.dispose(); restore(); }
  });
  it("does not fall back after a handshake timeout", async () => {
    const restore = envSet("PI_TEST_MOCK_CLI", "1");
    const ctrl = controllerHarness();
    const h = harness();
    const commands: string[] = [];
    ctrl.terminalRunner = (command, args, options) => { commands.push(command); return h.run(command, args, options); };
    (ctrl as any).waitForSupervisor = async () => { throw new Error("handshake timeout"); };
    try {
      await assert.rejects(ctrl.handleWorkerStart({ cwd: process.cwd(), title: "t", task: "x" }, probes), /handshake timeout/);
      assert.ok(commands.every((command) => command === "herdr"));
      assert.equal(ctrl.workerManager.getInstance()!.lifecycleState, "launch_unknown");
    } finally { await ctrl.dispose(); restore(); }
  });
  it("falls back from an explicit herdr CLI failure to tmux", async () => {
    const restore = envSet("PI_TEST_MOCK_CLI", "1");
    const ctrl = controllerHarness();
    const h = harness();
    ctrl.terminalRunner = async (command, args, options) => {
      if (command === "tmux") return "@8\n";
      if (args[1] === "run") throw new Error("herdr run exit 1");
      return h.run(command, args, options);
    };
    try {
      const result = await ctrl.handleWorkerStart({ cwd: process.cwd(), title: "t", task: "x" }, probes);
      assert.equal((await ctrl.handleWorkerStatus({ workerId: result.workerId })).worker?.terminal?.backend, "tmux");
      assert.equal(h.calls.filter((args) => args[1] === "close").length, 1);
    } finally { await ctrl.dispose(); restore(); }
  });
  it("explicit CLI failure releases the launch slot instead of becoming launch_unknown", async () => {
    const restore = envSet("PI_TEST_MOCK_CLI", "1");
    const ctrl = controllerHarness();
    ctrl.terminalRunner = async () => { throw new Error("tmux exit 1"); };
    try {
      await assert.rejects(ctrl.handleWorkerStart({ cwd: process.cwd(), title: "t", task: "x" }, { ...probes, env: {} }), /LAUNCH_FAILED/);
      assert.equal(ctrl.workerManager.getInstance(), null);
    } finally { await ctrl.dispose(); restore(); }
  });
});
