/** Terminal/process cleanup shared by supervisor and focused tests. */
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

export function closeHerdrPane(env = process.env, run = spawnSync) {
  // Only the bootstrap launched by our herdr backend gets this marker.
  if (!env.PITW_BOOTSTRAP_HERDR || !env.HERDR_PANE_ID) return;
  try {
    run(env.PITW_BOOTSTRAP_HERDR, ["pane", "close", env.HERDR_PANE_ID], {
      env, stdio: "ignore", windowsHide: true, shell: false, timeout: 3000,
    });
  } catch { /* Already closed is success; Controller also has a cleanup handle. */ }
}

export function listProcessParents(platform = process.platform) {
  if (platform === "linux") {
    const result = [];
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
        // comm may contain spaces and parentheses; fields after its final ')' are stable.
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        result.push({ pid: Number(entry), ppid: Number(fields[1]) });
      } catch { /* Process exited during enumeration. */ }
    }
    return result;
  }
  const result = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8", timeout: 3000 });
  if (result.error || result.status !== 0) throw new Error("无法枚举进程树");
  return result.stdout.trim().split("\n").map((line) => {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    return { pid, ppid };
  });
}

/** Freeze parents before rescanning, then kill descendants bottom-up without detaching from the TTY. */
export function killProcessTree(pid, { list = listProcessParents, signal = process.kill } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  const ordered = [pid];
  const known = new Set(ordered);
  const send = (target, name) => { try { signal(target, name); } catch { /* exited or inaccessible */ } };
  send(pid, "SIGSTOP");
  try {
    // Once a discovered parent is frozen it cannot fork new descendants.
    for (let pass = 0; pass < 64; pass++) {
      const snapshot = list();
      let added = false;
      for (let index = 0; index < ordered.length; index++) {
        for (const process of snapshot) {
          if (process.ppid !== ordered[index] || known.has(process.pid)) continue;
          known.add(process.pid);
          ordered.push(process.pid);
          send(process.pid, "SIGSTOP");
          added = true;
        }
      }
      if (!added) break;
    }
  } finally {
    for (const target of ordered.reverse()) send(target, "SIGKILL");
  }
}
