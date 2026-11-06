/** Model-free real TTY e2e: npm run build && node test/e2e-terminal.mjs tmux|herdr */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ControllerManager } from "../dist/controller.js";
import { FakePiAPI } from "./fake-pi.ts";
import { findHerdr, validateAndPrepareLaunch, buildTerminalLaunch, encodeDescriptor } from "../dist/launcher.js";
import { launchMultiplexer } from "../dist/terminal-multiplexer.js";
import { getPipePath } from "../dist/transport.js";

const backend = process.argv[2] ?? "tmux";
assert.ok(["herdr", "tmux"].includes(backend));
process.env.PI_TERMINAL_WORKER_BACKEND = backend;
process.env.PI_TERMINAL_WORKER_PI_CLI_PATH = fileURLToPath(new URL("./fixtures/terminal-pi-cli.mjs", import.meta.url));
delete process.env.PI_TERMINAL_WORKER_ROLE;
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pitw-terminal-e2e-"));
const command = backend === "herdr" ? findHerdr() : process.env.PI_TERMINAL_WORKER_TMUX_PATH ?? "tmux";
const results = [];
const cli = (args) => spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 5000 });
async function until(predicate, label, timeout = 15_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timeout: ${label}`);
}
function alive(pid) {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return false;
    }
    process.kill(pid, 0); return true;
  } catch { return false; }
}
function terminalExists(terminal) {
  if (backend === "herdr") return cli(["pane", "get", terminal.paneId]).status === 0;
  return cli(terminal.sessionName ? ["has-session", "-t", terminal.sessionName]
    : ["list-panes", "-t", terminal.windowId]).status === 0;
}
try {
  for (const mode of process.argv[3] ? process.argv[3].split(",") : ["graceful", "force", "natural", "session-switch", "dispose"]) {
    if (mode === "bootstrap-exit" || mode === "owner-loss") {
      assert.equal(backend, "herdr");
      const owner = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      await new Promise((resolve, reject) => { owner.once("exit", resolve); owner.once("error", reject); });
      const descriptor = mode === "bootstrap-exit" ? "invalid" : encodeDescriptor({
        version: 1, controllerId: "orphan-controller", workerId: "orphan-worker",
        pipePath: getPipePath(`orphan-${owner.pid}`), bootstrapToken: "fixture", ownerPid: owner.pid,
      });
      const handle = await launchMultiplexer(buildTerminalLaunch(validateAndPrepareLaunch(cwd), mode, descriptor));
      try {
        await until(() => !terminalExists(handle), "bootstrap closes its own pane without Controller", 12_000);
        results.push({ mode, ok: true, paneId: handle.paneId });
        console.log(`PASS herdr ${mode}: bootstrap closed its pane without Controller cleanup`);
      } finally { await handle.close(); }
      continue;
    }
    const ctrl = new ControllerManager(new FakePiAPI(), true);
    ctrl.launchTimeoutMs = 15_000;
    let instance;
    try {
      console.log(`START ${backend} ${mode}`);
      const started = await ctrl.handleWorkerStart({ cwd, title: `pitw ${mode} & "quoted"`, task: "Return a terminal fixture report" });
      instance = started;
      const status = await until(async () => {
        const state = await ctrl.handleWorkerStatus({ workerId: started.workerId });
        return state.committedReport && state.worker.activityState === "idle" ? state : null;
      }, "committed report");
      const info = JSON.parse(status.committedReport.summary);
      const terminal = status.worker.terminal;
      assert.equal(info.tty, true);
      assert.equal(terminal.backend, backend);
      assert.ok(terminalExists(terminal));
      if (backend === "tmux") assert.equal(cli(["set-window-option", "-t", terminal.windowId, "remain-on-exit", "on"]).status, 0);
      console.log(`REPORT ${backend} ${mode}: ${JSON.stringify(info)}`);
      if (mode === "natural") process.kill(info.pid, "SIGTERM");
      else if (mode === "session-switch") await ctrl.handleSessionStart();
      else if (mode === "dispose") await ctrl.dispose();
      else await ctrl.handleWorkerClose({ workerId: started.workerId, disposition: "accepted", force: mode === "force" });
      await until(() => !terminalExists(terminal), "terminal disappears");
      await until(() => !alive(info.pid) && info.descendants.every((pid) => !alive(pid)), "process tree exits");
      results.push({ mode, ok: true, terminal, tty: true });
      console.log(`PASS ${backend} ${mode}: handshake -> task -> committed report -> close -> terminal gone`);
    } finally {
      if (ctrl.workerManager.hasActiveInstance() && instance) {
        await ctrl.handleWorkerClose({ workerId: instance.workerId, disposition: "abandoned", force: true }).catch(() => {});
      }
      await ctrl.dispose();
    }
  }
} catch (error) {
  results.push({ ok: false, error: String(error), stack: error.stack });
  console.error(error);
  process.exitCode = 1;
} finally {
  const modes = process.argv[3]?.replace(/[^a-z-]+/g, "-");
  const report = path.join(os.tmpdir(), `pitw-${backend}-e2e${modes ? `-${modes}` : ""}-result.json`);
  fs.writeFileSync(report, JSON.stringify(results, null, 2));
  fs.rmSync(cwd, { recursive: true, force: true });
  console.log(`Evidence: ${report}`);
}
