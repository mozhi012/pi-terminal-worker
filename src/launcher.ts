/**
 * 启动器：终端后端探测 (WT → PowerShell → CMD 回退)、命令行构建与描述符编码
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface WorkerDescriptor {
  version: 1;
  controllerId: string;
  workerId: string;
  pipePath: string;
  bootstrapToken: string;
}

/**
 * 可用终端后端：Windows Terminal 优先，缺失时依次回退 PowerShell 与 CMD
 */
export type TerminalBackend = "wt" | "powershell" | "cmd";

export interface TerminalBackendInfo {
  backend: TerminalBackend;
  command: string;
}

export interface LaunchEnvironment {
  terminal: TerminalBackendInfo;
  nodePath: string;
  piCliPath: string;
  extensionPath: string;
  bootstrapPath: string;
  cwd: string;
}

/**
 * 可注入的探测函数集合，便于单元测试不依赖真实环境
 */
export interface TerminalProbes {
  findWt: () => string | null;
  findPowershell: () => string | null;
  findCmd: () => string | null;
}

/**
 * 描述符 Base64Url 编码 (不包含任务文本或凭据)
 */
export function encodeDescriptor(desc: WorkerDescriptor): string {
  const json = JSON.stringify(desc);
  return Buffer.from(json, "utf8").toString("base64url");
}

/**
 * 描述符 Base64Url 解码
 */
export function decodeDescriptor(raw: string): WorkerDescriptor {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    if (
      parsed.version !== 1 ||
      typeof parsed.controllerId !== "string" ||
      typeof parsed.workerId !== "string" ||
      typeof parsed.pipePath !== "string" ||
      typeof parsed.bootstrapToken !== "string"
    ) {
      throw new Error("描述符格式不符合规范");
    }
    return parsed as WorkerDescriptor;
  } catch (err: unknown) {
    throw new Error(
      `解码 Worker 描述符失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * 寻找 Windows PowerShell (powershell.exe)
 */
export function findPowershell(): string | null {
  const override = process.env.PI_TERMINAL_WORKER_POWERSHELL_PATH;
  if (override && fs.existsSync(override)) {
    return override;
  }

  try {
    const res = spawnSync("where.exe", ["powershell.exe"], {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
    });
    if (!res.error && res.status === 0 && res.stdout) {
      const located = res.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (located) return located;
    }
  } catch {}

  const windir = process.env.WINDIR || "C:\\Windows";
  const candidate = path.join(windir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (fs.existsSync(candidate)) {
    return candidate;
  }

  return null;
}

/**
 * 寻找 CMD (comspec / System32\cmd.exe)
 */
export function findCmdShell(): string | null {
  const comspec = process.env.Comspec || process.env.COMSPEC;
  if (comspec && fs.existsSync(comspec)) {
    return comspec;
  }
  const windir = process.env.WINDIR || "C:\\Windows";
  const candidate = path.join(windir, "System32", "cmd.exe");
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return null;
}

/**
 * 按 WT → PowerShell → CMD 顺序探测终端后端；全部缺失时返回 null (由调用方报明确错误)
 */
export function detectTerminalBackends(probes: Partial<TerminalProbes> = {}): TerminalBackendInfo[] {
  const p: TerminalProbes = {
    findWt: probes.findWt ?? findWindowsTerminal,
    findPowershell: probes.findPowershell ?? findPowershell,
    findCmd: probes.findCmd ?? findCmdShell,
  };

  const backends: TerminalBackendInfo[] = [];
  const wt = p.findWt();
  if (wt) backends.push({ backend: "wt", command: wt });
  const ps = p.findPowershell();
  if (ps) backends.push({ backend: "powershell", command: ps });
  const cmd = p.findCmd();
  if (cmd) backends.push({ backend: "cmd", command: cmd });
  return backends;
}

export function detectTerminalBackend(probes: Partial<TerminalProbes> = {}): TerminalBackendInfo | null {
  return detectTerminalBackends(probes)[0] ?? null;
}

/**
 * 寻找 Windows Terminal (wt.exe)
 */
export function findWindowsTerminal(): string | null {
  if (process.env.PI_TERMINAL_WORKER_WT_PATH && fs.existsSync(process.env.PI_TERMINAL_WORKER_WT_PATH)) {
    return process.env.PI_TERMINAL_WORKER_WT_PATH;
  }

  try {
    // Do not invoke wt.exe with an unsupported probe such as --version: older
    // Windows Terminal builds open their Help dialog for unknown arguments.
    const res = spawnSync("where.exe", ["wt.exe"], {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
    });
    if (!res.error && res.status === 0 && res.stdout) {
      const located = res.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (located) return located;
    }
  } catch {}

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const defaultWt = path.join(localAppData, "Microsoft", "WindowsApps", "wt.exe");
    if (fs.existsSync(defaultWt)) {
      return defaultWt;
    }
  }

  // 尝试从常见的系统用户目录探测
  const userProfile = process.env.USERPROFILE;
  if (userProfile) {
    const userWt = path.join(
      userProfile,
      "AppData",
      "Local",
      "Microsoft",
      "WindowsApps",
      "wt.exe",
    );
    if (fs.existsSync(userWt)) {
      return userWt;
    }
  }

  return null;
}

/**
 * 寻找 Pi CLI 入口文件
 */
export function findPiCliPath(): string | null {
  if (process.env.PI_TERMINAL_WORKER_PI_CLI_PATH && fs.existsSync(process.env.PI_TERMINAL_WORKER_PI_CLI_PATH)) {
    return process.env.PI_TERMINAL_WORKER_PI_CLI_PATH;
  }

  const appData = process.env.APPDATA;
  if (appData) {
    const candidate = path.join(
      appData,
      "npm",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "bundle",
      "cli.js",
    );
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // 尝试探测全局 npm 根目录
  const prefix = process.env.PREFIX || (process.platform === "win32" ? path.join(process.env.APPDATA || "", "npm") : "/usr/local");
  const fallback = path.join(
    prefix,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "bundle",
    "cli.js",
  );
  if (fs.existsSync(fallback)) {
    return fallback;
  }

  return null;
}

/**
 * 解析包内 bootstrap.mjs 脚本绝对路径
 */
export function getBootstrapPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const pkgRoot = path.resolve(path.dirname(currentFile), "..");
  const candidate = path.join(pkgRoot, "runtime", "bootstrap.mjs");
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  throw new Error(`找不到 bootstrap.mjs 脚本: ${candidate}`);
}

/**
 * 返回与当前 Controller 相同的扩展包路径，供 Worker 显式加载。
 */
export function getExtensionPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const pkgRoot = path.resolve(path.dirname(currentFile), "..");
  const distEntry = path.join(pkgRoot, "dist", "extension.js");
  if (fs.existsSync(distEntry)) {
    return pkgRoot;
  }
  const sourceEntry = path.join(pkgRoot, "src", "extension.ts");
  if (fs.existsSync(sourceEntry)) {
    return pkgRoot;
  }
  throw new Error(`找不到扩展入口: ${pkgRoot}`);
}

/**
 * 校验并准备启动环境
 */
export function validateAndPrepareLaunch(
  targetCwd: string,
  probes: Partial<TerminalProbes> = {},
): LaunchEnvironment {
  // 1. 检查操作系统 (测试环境下允许模拟)
  const isWin = process.platform === "win32" || process.env.PI_TEST_MOCK_PLATFORM === "win32";
  if (!isWin) {
    throw new Error(
      `pi-terminal-worker 目前仅支持 Windows 平台 (当前: ${process.platform})`,
    );
  }

  // 2. 校验 CWD
  if (!path.isAbsolute(targetCwd)) {
    throw new Error(`cwd 必须是绝对路径: "${targetCwd}"`);
  }
  if (!fs.existsSync(targetCwd)) {
    throw new Error(`指定的 cwd 不存在: "${targetCwd}"`);
  }
  const stat = fs.statSync(targetCwd);
  if (!stat.isDirectory()) {
    throw new Error(`指定的 cwd 不是一个目录: "${targetCwd}"`);
  }

  // 3. 探测终端后端：WT → PowerShell → CMD，全部缺失时明确失败 (不盲目继续)
  const backends = detectTerminalBackends(probes);
  const terminal = backends[0] ?? null;
  if (!terminal) {
    if (process.env.PI_TEST_MOCK_WT) {
      // 测试环境允许模拟 WT
    } else {
      throw new Error(
        `未找到可用的终端后端 (已依次查找 wt.exe、powershell.exe、cmd.exe)。` +
          `请安装 Windows Terminal 或保留 Windows PowerShell，或通过 PI_TERMINAL_WORKER_WT_PATH 指定 wt.exe。`,
      );
    }
  }

  // 4. 校验 Node
  const nodePath = process.execPath;
  if (!fs.existsSync(nodePath)) {
    throw new Error(`未找到 Node 可执行文件: ${nodePath}`);
  }

  // 5. 校验 Pi CLI
  const piCliPath = findPiCliPath();
  if (!piCliPath && !process.env.PI_TEST_MOCK_CLI) {
    throw new Error(
      `未找到 Pi CLI 入口文件 (@earendil-works/pi-coding-agent)。请确保全局已正确安装。`,
    );
  }

  // 6. 获取 bootstrap.mjs 与当前扩展包路径
  const bootstrapPath = getBootstrapPath();
  const extensionPath = getExtensionPath();

  return {
    terminal: terminal ?? { backend: "wt", command: "wt.exe" },
    nodePath,
    piCliPath: piCliPath || "cli.js",
    extensionPath,
    bootstrapPath,
    cwd: targetCwd,
  };
}

/**
 * 构造 Windows Terminal 启动参数
 */
export function buildWtArgs(
  title: string,
  cwd: string,
  nodePath: string,
  bootstrapPath: string,
  descriptorBase64Url: string,
): string[] {
  return [
    "-w",
    "new",
    "new-tab",
    "--title",
    title,
    "-d",
    cwd,
    nodePath,
    bootstrapPath,
    "--descriptor",
    descriptorBase64Url,
  ];
}

/**
 * PowerShell 单引号字符串：仅需转义内部单引号 (成对翻倍)，
 * 天然保护空格、中文、% ! & " 换行等字符。
 */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Windows 原生引号处理 (供 PowerShell ArgumentList / CreateProcess 命令行解析)：
 * 双引号包裹 + 内部 " 转义为 \"。
 */
export function windowsQuoted(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * CMD 后端安全约束：值中不得出现双引号 / CR / LF / NUL。
 * 这些字符会破坏 start "..." 的引号结构或切断命令行，且 /c 的百分号规则与批处理不同，
 * 不尝试用 %% 或 ^ 转义任意内插字符串；原生路径中的 & % ! 在环境变量单次展开及引号内保留。
 */
export function assertCmdSafeValues(pairs: Array<[string, string]>): void {
  for (const [name, value] of pairs) {
    if (/["\r\n\0]/.test(value)) {
      throw new Error(
        `CMD 后端要求 ${name} 不含双引号/CR/LF/NUL: ${JSON.stringify(value)}`,
      );
    }
  }
}

/**
 * 统一的终端启动描述：由 buildTerminalLaunch 产出，由 launchWorkerWindow 执行
 */
export interface TerminalLaunchSpec {
  backend: TerminalBackend;
  command: string;
  args: string[];
  cwd: string;
  title: string;
  /** CMD 后端将各值放入受控 env 字段，命令串只含 %ENV_*% 占位 */
  extraEnv?: Record<string, string>;
  /** PS 后端：短命隐藏宿主 (真正的新控制台由 Start-Process 创建) */
  windowsHide?: boolean;
  /** CMD 后端：args 即完整命令行，Node 不做任何二次引号处理 */
  windowsVerbatimArguments?: boolean;
}

/**
 * 构造终端启动描述：
 * - wt：沿用 buildWtArgs (shell:false 直接传参，无注入面)；
 * - powershell：短命隐藏 PowerShell 的 EncodedCommand 执行
 *   Start-Process -FilePath node -WorkingDirectory cwd -WindowStyle Normal -ErrorAction Stop，
 *   由新控制台直接跑 bootstrap，保证 Node stdin/stdout 为真实 TTY；
 *   ArgumentList 对路径做 Windows 引号处理 (PS 的 ArgumentList 会拼成字符串)；
 * - cmd：固定命令串 start "%ENV_TITLE%" /D "%ENV_CWD%" "%ENV_NODE%" "%ENV_BOOT%" --descriptor %ENV_DESC%，
 *   值全部放受控 env 字段，/d /v:off /s /c + windowsVerbatimArguments。
 * 三种后端均为独立可交互控制台，bootstrap/子进程退出或关窗后自动关闭。
 */
export function buildTerminalLaunch(
  env: LaunchEnvironment,
  title: string,
  descriptorBase64Url: string,
): TerminalLaunchSpec {
  const t = env.terminal;

  if (t.backend === "wt") {
    return {
      backend: "wt",
      command: t.command,
      args: buildWtArgs(title, env.cwd, env.nodePath, env.bootstrapPath, descriptorBase64Url),
      cwd: env.cwd,
      title,
    };
  }

  if (t.backend === "powershell") {
    const safeTitle = title.replace(/[\r\n]+/g, " ");
    // Start-Process 的 ArgumentList 会被拼成字符串交给子进程，必须做 Windows 引号处理
    const argLine =
      `${windowsQuoted(env.bootstrapPath)} --descriptor ${descriptorBase64Url}` +
      (safeTitle ? ` --title ${windowsQuoted(safeTitle)}` : "");
    const script =
      `Start-Process -FilePath ${psQuote(env.nodePath)} ` +
      `-WorkingDirectory ${psQuote(env.cwd)} ` +
      `-WindowStyle Normal -ErrorAction Stop ` +
      `-ArgumentList ${psQuote(argLine)}`;
    return {
      backend: "powershell",
      command: t.command,
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      cwd: env.cwd,
      title,
      windowsHide: true,
    };
  }

  // cmd 后端：固定命令串 + 受控环境变量；拒绝双引号/CR/LF/NUL，不做 %% / ^ 转义
  assertCmdSafeValues([
    ["title", title],
    ["cwd", env.cwd],
    ["nodePath", env.nodePath],
    ["bootstrapPath", env.bootstrapPath],
  ]);
  const command =
    `start "%ENV_TITLE%" /D "%ENV_CWD%" "%ENV_NODE%" "%ENV_BOOT%" --descriptor %ENV_DESC%`;
  return {
    backend: "cmd",
    command: t.command,
    args: ["/d", "/v:off", "/s", "/c", command],
    cwd: env.cwd,
    title,
    extraEnv: {
      ENV_TITLE: title,
      ENV_CWD: env.cwd,
      ENV_NODE: env.nodePath,
      ENV_BOOT: env.bootstrapPath,
      ENV_DESC: descriptorBase64Url,
    },
    windowsVerbatimArguments: true,
  };
}

/**
 * 启动终端窗口。spawnFn 可注入，单元测试不实际开窗。
 */
export function launchWorkerWindow(
  spec: TerminalLaunchSpec,
  options: { spawnFn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess } = {},
): ChildProcess {
  const spawnFn = options.spawnFn ?? spawn;
  return spawnFn(spec.command, spec.args, {
    shell: false,
    windowsHide: spec.windowsHide ?? false,
    windowsVerbatimArguments: spec.windowsVerbatimArguments ?? false,
    stdio: "ignore",
    cwd: spec.cwd,
    env: spec.extraEnv ? { ...process.env, ...spec.extraEnv } : undefined,
  });
}
