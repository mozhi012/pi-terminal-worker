/**
 * 启动器：Windows 路径检查、WT 命令行参数构建与描述符编码
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ProtocolErrorCode } from "./protocol.js";

export interface WorkerDescriptor {
  version: 1;
  controllerId: string;
  workerId: string;
  pipePath: string;
  bootstrapToken: string;
}

export interface LaunchEnvironment {
  wtPath: string;
  nodePath: string;
  piCliPath: string;
  bootstrapPath: string;
  cwd: string;
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
 * 寻找 Windows Terminal (wt.exe)
 */
export function findWindowsTerminal(): string | null {
  if (process.env.PI_TERMINAL_WORKER_WT_PATH && fs.existsSync(process.env.PI_TERMINAL_WORKER_WT_PATH)) {
    return process.env.PI_TERMINAL_WORKER_WT_PATH;
  }

  // 1. 优先尝试直接在 PATH 中调用 wt.exe (WindowsApps 别名通常在 PATH 中可直接执行)
  try {
    const res = spawnSync("wt.exe", ["--version"], { shell: false });
    if (!res.error && (res.status === 0 || res.status === null)) {
      return "wt.exe";
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
 * 校验并准备启动环境
 */
export function validateAndPrepareLaunch(targetCwd: string): LaunchEnvironment {
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

  // 3. 校验 wt.exe (非 mock 环境下必须存在)
  const wtPath = findWindowsTerminal();
  if (!wtPath && !process.env.PI_TEST_MOCK_WT) {
    throw new Error(
      `未找到 Windows Terminal (wt.exe)。请确保已安装并在 PATH 或标准应用目录中。`,
    );
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

  // 6. 获取 bootstrap.mjs
  const bootstrapPath = getBootstrapPath();

  return {
    wtPath: wtPath || "wt.exe",
    nodePath,
    piCliPath: piCliPath || "cli.js",
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
