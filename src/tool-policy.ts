/**
 * Worker 侧工具策略：由主控在启动时写入环境变量，在 tool_call 钩子里强制执行。
 *
 * 这是防止模型误操作的护栏，不是安全沙箱：write / edit / code_rewrite 按路径精确判断，
 * bash 只能用启发式识别常见写命令，python -c、node -e 等解释器内的写入无法识别。
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export const TOOL_POLICY_ENV = "PI_TERMINAL_WORKER_TOOL_POLICY";
/** Windows 单个环境变量上限约 32K 字符，这里留足余量 */
export const MAX_TOOL_POLICY_SIZE = 16 * 1024;

export type WriteMode = "none" | "scoped" | "any";

export interface ToolPolicy {
  /** 错误提示中展示的来源，如 dev-small/reviewer */
  label: string;
  write: WriteMode;
  /** Worker 工作目录，用于解析相对路径 */
  cwd: string;
  /** write=scoped 时允许写入的绝对路径 */
  allowedPaths: string[];
  /** 额外禁用的工具名，支持 * 通配 */
  denyTools: string[];
}

export function encodeToolPolicy(policy: ToolPolicy): string {
  const encoded = JSON.stringify(policy);
  if (encoded.length > MAX_TOOL_POLICY_SIZE) {
    throw new Error(`工具策略超过 ${MAX_TOOL_POLICY_SIZE} 字符上限，请减少 allowedPaths 或 denyTools`);
  }
  return encoded;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function decodeToolPolicy(raw: string): ToolPolicy {
  const value = JSON.parse(raw) as Partial<ToolPolicy> | null;
  if (
    !value ||
    typeof value.label !== "string" ||
    !["none", "scoped", "any"].includes(value.write as string) ||
    typeof value.cwd !== "string" ||
    !isStringArray(value.allowedPaths) ||
    !isStringArray(value.denyTools)
  ) {
    throw new Error("工具策略字段非法");
  }
  return value as ToolPolicy;
}

/** 策略环境变量损坏时按只读处理，绝不退化成不受限 */
export function loadToolPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): ToolPolicy | null {
  const raw = env[TOOL_POLICY_ENV];
  if (!raw) return null;
  try {
    return decodeToolPolicy(raw);
  } catch (err: unknown) {
    console.error("[Worker] 工具策略解析失败，按只读处理:", err);
    return { label: "invalid-policy", write: "none", cwd: process.cwd(), allowedPaths: [], denyTools: [] };
  }
}

export function toolNameMatches(pattern: string, toolName: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[\\^$.+?()[\]{}|]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(toolName);
}

/** 解析为绝对路径，并沿最近的已存在祖先目录解开符号链接，防止经链接写到范围外 */
export function physicalPath(raw: string, cwd: string): string {
  // 与 pi 内置文件工具的路径约定保持一致：@ 前缀与 ~ 展开
  const unprefixed = raw.startsWith("@") ? raw.slice(1) : raw;
  const expanded =
    unprefixed === "~" || unprefixed.startsWith("~/") || unprefixed.startsWith("~\\")
      ? path.join(homedir(), unprefixed.slice(1))
      : unprefixed;
  const absolute = path.resolve(cwd, expanded);
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function isPathWithin(target: string, root: string, platform = process.platform): boolean {
  const fold = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const relative = path.relative(fold(root), fold(target));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

const BASH_WRITE_COMMANDS = new Set([
  "rm", "rmdir", "mv", "cp", "mkdir", "touch", "chmod", "chown", "chgrp", "ln",
  "tee", "dd", "truncate", "shred", "install", "unlink", "rsync", "patch",
]);
const GIT_WRITE_SUBCOMMANDS = new Set([
  "commit", "push", "pull", "add", "rm", "mv", "reset", "checkout", "switch", "restore",
  "merge", "rebase", "cherry-pick", "revert", "clean", "apply", "am",
]);

function commandName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? word).replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

function gitWriteSubcommand(words: string[]): string | undefined {
  let index = 1;
  while (index < words.length && words[index].startsWith("-")) {
    // -C <path>、-c <key=value> 带独立参数，其余全局选项不带
    index += words[index] === "-C" || words[index] === "-c" ? 2 : 1;
  }
  const sub = words[index];
  if (sub === undefined) return undefined;
  if (GIT_WRITE_SUBCOMMANDS.has(sub)) return `git ${sub}`;
  if (sub === "stash" && !["list", "show"].includes(words[index + 1] ?? "")) return "git stash";
  if (sub === "worktree" && ["add", "remove", "move"].includes(words[index + 1] ?? "")) return `git worktree ${words[index + 1]}`;
  return undefined;
}

/** 单条简单命令是否为写操作；返回命中的命令名 */
function segmentWriteCommand(segment: string): string | undefined {
  let words = segment.trim().split(/\s+/).filter(Boolean);
  // 跳过前导环境变量赋值，以及只负责转发命令的 sudo / env / xargs
  for (;;) {
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words = words.slice(1);
    const head = commandName(words[0] ?? "");
    if (head !== "sudo" && head !== "env" && head !== "xargs") break;
    words = words.slice(1);
    while (words.length > 0 && words[0].startsWith("-")) words = words.slice(1);
  }
  if (words.length === 0) return undefined;

  const name = commandName(words[0]);
  if (BASH_WRITE_COMMANDS.has(name)) return name;
  if (name === "git") return gitWriteSubcommand(words);
  if ((name === "sed" || name === "perl") && words.some((w) => /^-[a-zA-Z]*i|^--in-place/.test(w))) return `${name} -i`;
  if (name === "find") {
    if (words.includes("-delete")) return "find -delete";
    const exec = words.findIndex((w) => w === "-exec" || w === "-execdir");
    if (exec >= 0 && BASH_WRITE_COMMANDS.has(commandName(words[exec + 1] ?? ""))) return `find -exec ${commandName(words[exec + 1])}`;
  }
  return undefined;
}

/** 启发式识别 bash 写操作：引号内容先剥离，避免 rg "a > b" 这类只读命令误报 */
export function bashWriteReason(command: string): string | undefined {
  const unquoted = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""');

  for (const match of unquoted.matchAll(/(?:\d|&)?>>?\|?\s*(&\d+|[^\s;&|()<>]+)?/g)) {
    const target = match[1];
    const harmless = target !== undefined && (target.startsWith("&") || /^(\/dev\/null|nul)$/i.test(target));
    if (!harmless) return `输出重定向 ${match[0].trim()}`;
  }
  for (const segment of unquoted.split(/&&|\|\||[;&|\n(]|\$\(|`/)) {
    const hit = segmentWriteCommand(segment);
    if (hit) return hit;
  }
  return undefined;
}

/** 返回拦截原因；放行时返回 undefined */
export function evaluateToolCall(policy: ToolPolicy, toolName: string, input: unknown): string | undefined {
  const prefix = `team.yaml 角色 ${policy.label}`;
  if (policy.denyTools.some((pattern) => toolNameMatches(pattern, toolName))) {
    return `${prefix} 禁用了工具 ${toolName}。如果任务确实需要，请用 worker_report 报告 blocked。`;
  }
  if (policy.write === "any") return undefined;

  const args = (input ?? {}) as Record<string, unknown>;
  const isFileWrite = toolName === "write" || toolName === "edit";
  const isRewrite = toolName === "code_rewrite" && args.dry_run === false;

  if (policy.write === "none") {
    if (isFileWrite || isRewrite) {
      return `${prefix} 是只读角色 (write: none)，不能调用 ${toolName}。如果任务确实需要改动，请用 worker_report 报告 blocked。`;
    }
    if (toolName === "bash" && typeof args.command === "string") {
      const reason = bashWriteReason(args.command);
      if (reason) {
        return `${prefix} 是只读角色 (write: none)，已拦截写操作：${reason}。只读命令可以继续；如果任务确实需要改动，请用 worker_report 报告 blocked。`;
      }
    }
    return undefined;
  }

  // write=scoped：只有文件类工具能精确判断路径；bash 不做路径判断
  if (!isFileWrite && !isRewrite) return undefined;
  if (typeof args.path !== "string" || args.path === "") {
    return `${prefix} 只能写入 allowedPaths 范围内的路径，${toolName} 必须明确给出 path。`;
  }
  const target = physicalPath(args.path, policy.cwd);
  if (policy.allowedPaths.some((root) => isPathWithin(target, physicalPath(root, policy.cwd)))) return undefined;
  return `${prefix} 不允许写入 ${args.path}。允许范围：${policy.allowedPaths.join("、")}。如果确实需要扩大范围，请用 worker_report 报告 blocked。`;
}

/** 启动时从工具列表中隐藏的工具，让模型一开始就看不到不能用的写工具 */
export function isToolHidden(policy: ToolPolicy, toolName: string): boolean {
  if (policy.denyTools.some((pattern) => toolNameMatches(pattern, toolName))) return true;
  return policy.write === "none" && (toolName === "write" || toolName === "edit");
}
