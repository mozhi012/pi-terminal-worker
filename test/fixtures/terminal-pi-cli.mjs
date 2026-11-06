/** Model-free interactive Pi fixture using the real WorkerManager and report protocol. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WorkerManager } from "../../dist/worker.js";
import { FakePiAPI, FakePiContext } from "../fake-pi.ts";

if (process.argv.includes("--descendant")) {
  const leaf = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  leaf.once("spawn", () => process.send({ leafPid: leaf.pid }));
  const stop = () => { leaf.kill(); setTimeout(() => process.exit(0), 50); };
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  setInterval(() => {}, 1000);
} else {
  assert.equal(process.stdin.isTTY, true, "Pi stdin must be a real TTY");
  assert.equal(process.stdout.isTTY, true, "Pi stdout must be a real TTY");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--descendant"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const leafPid = await new Promise((resolve, reject) => {
    child.once("message", (value) => resolve(value.leafPid));
    child.once("error", reject);
  });
  const pi = new FakePiAPI();
  const ctx = new FakePiContext();
  const worker = new WorkerManager(pi, true);
  ctx.shutdown = () => {
    try { process.kill(leafPid); } catch {}
    child.kill();
    setTimeout(async () => { await pi.emitPiEvent("session_shutdown", {}, ctx); process.exit(0); }, 150);
  };
  process.on("SIGTERM", () => ctx.shutdown());
  process.on("SIGHUP", () => ctx.shutdown());
  pi.sendUserMessage = () => {
    setTimeout(async () => {
      try {
        await pi.tools.get("worker_report").execute("terminal-e2e-report", {
          kind: "result", summary: JSON.stringify({ tty: true, pid: process.pid, descendants: [child.pid, leafPid] }),
          validation: [{ command: "interactive fixture", outcome: "passed" }],
        });
        await pi.emitPiEvent("agent_settled", {}, ctx);
      } catch (error) { console.error(error); process.exit(2); }
    }, 100);
  };
  await worker.init();
  await pi.emitPiEvent("session_start", {}, ctx);
}
