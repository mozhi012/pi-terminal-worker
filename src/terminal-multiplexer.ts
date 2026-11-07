/** Multi-step CLI launchers. The Windows launchWorkerWindow API remains synchronous. */
import { execFile } from "node:child_process";
import { assertCmdSafeValues, type TerminalLaunchSpec } from "./launcher.js";

export class TerminalSpawnError extends Error {
  constructor(public readonly backend: string, public readonly cause: Error) {
    super(`终端后端 ${backend} 启动失败: ${cause.message}`);
    this.name = "TerminalSpawnError";
  }
}

export type TerminalCommandRunner = (
  command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<string>;

export const runTerminalCommand: TerminalCommandRunner = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, args, { ...options, shell: false, windowsHide: true, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 },
    (error, stdout, stderr) => error ? reject(new Error(`${error.message}${stderr ? `: ${stderr.trim()}` : ""}`)) : resolve(stdout));
});

export interface TerminalHandle {
  backend: "herdr" | "tmux";
  paneId?: string;
  windowId?: string;
  sessionName?: string;
  close: () => Promise<void>;
}

/** Only controlled variable references are sent to the interactive shell. */
export function buildHerdrRunCommand(shellName: string, values: Record<string, string>): string {
  const shell = shellName.replace(/\\/g, "/").split("/").pop()!.replace(/^-/, "").toLowerCase().replace(/\.exe$/, "");
  if (shell === "powershell" || shell === "pwsh") {
    return "& $env:PITW_BOOTSTRAP_NODE $env:PITW_BOOTSTRAP_FILE --descriptor $env:PITW_BOOTSTRAP_DESC";
  }
  if (shell === "cmd") {
    assertCmdSafeValues(Object.entries(values));
    return '"%PITW_BOOTSTRAP_NODE%" "%PITW_BOOTSTRAP_FILE%" --descriptor %PITW_BOOTSTRAP_DESC%';
  }
  if (["bash", "zsh", "sh", "dash", "ksh", "fish"].includes(shell)) {
    return '"$PITW_BOOTSTRAP_NODE" "$PITW_BOOTSTRAP_FILE" --descriptor "$PITW_BOOTSTRAP_DESC"';
  }
  throw new Error(`不支持的 herdr pane shell: ${shellName}`);
}

export async function launchMultiplexer(
  spec: TerminalLaunchSpec,
  { run = runTerminalCommand, assertActive = () => {} }: {
    run?: TerminalCommandRunner;
    assertActive?: () => void;
  } = {},
): Promise<TerminalHandle> {
  const options = { cwd: spec.cwd, env: { ...process.env } };
  let handle: TerminalHandle | undefined;
  function makeHandle(data: Omit<TerminalHandle, "close">, closeArgs: string[]): TerminalHandle {
    let closing: Promise<void> | undefined;
    return { ...data, close: () => closing ??= run(spec.command, closeArgs, options).then(() => {}, () => {}) };
  }
  try {
    assertActive();
    if (spec.backend === "tmux") {
      const output = await run(spec.command, spec.args, options);
      const windowId = output.trim();
      // A new session's name is already known, including if output parsing fails.
      if (spec.tmuxSession) handle = makeHandle({ backend: "tmux", sessionName: spec.tmuxSession, windowId }, ["kill-session", "-t", spec.tmuxSession]);
      else if (/^@\d+$/.test(windowId)) handle = makeHandle({ backend: "tmux", windowId }, ["kill-window", "-t", windowId]);
      assertActive();
      if (!/^@\d+$/.test(windowId)) throw new Error(`tmux 未返回窗口 ID: ${output}`);
      return handle!;
    }
    if (spec.backend !== "herdr" || !spec.workerCommand) throw new Error("缺少 herdr 启动描述");
    const values = {
      PITW_BOOTSTRAP_NODE: spec.workerCommand[0],
      PITW_BOOTSTRAP_FILE: spec.workerCommand[1],
      PITW_BOOTSTRAP_DESC: spec.workerCommand[3],
      PITW_BOOTSTRAP_HERDR: spec.command,
    };
    // Fixed right split preserves focus and avoids a separate layout race/CLI round-trip.
    const split = await run(spec.command, ["pane", "split", "--current", "--direction", "right", "--cwd", spec.cwd,
      "--no-focus", ...Object.entries(values).flatMap(([key, value]) => ["--env", `${key}=${value}`])], options);
    const paneId = JSON.parse(split)?.result?.pane?.pane_id;
    if (typeof paneId !== "string" || !paneId) throw new Error("herdr split 未返回 pane_id");
    handle = makeHandle({ backend: "herdr", paneId }, ["pane", "close", paneId]);
    assertActive();
    try { await run(spec.command, ["pane", "rename", paneId, spec.title], options); } catch { /* title is cosmetic */ }
    assertActive();
    let shell: string | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      const output = await run(spec.command, ["pane", "process-info", "--pane", paneId], options);
      assertActive();
      const info = JSON.parse(output)?.result?.process_info;
      const process = info?.foreground_processes?.find((p: { pid: number }) => p.pid === info.shell_pid);
      shell = process?.argv0 ?? process?.name;
      if (shell) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
      assertActive();
    }
    if (!shell) throw new Error("herdr pane shell 尚未就绪");
    const command = buildHerdrRunCommand(shell, values);
    await run(spec.command, ["pane", "run", paneId, command], options);
    assertActive();
    return handle;
  } catch (error) {
    if (handle) await handle.close();
    // A cancellation must never turn into a fallback launch in a new session.
    assertActive();
    throw new TerminalSpawnError(spec.backend, error instanceof Error ? error : new Error(String(error)));
  }
}
