/**
 * team.yaml：把角色的模型、权限和数量上限从 skill 提示词中分离，由插件校验并强制执行。
 *
 * 每次 worker_start 都重新读取文件，修改后下一次启动立即生效，不做缓存。
 *
 * 只读取用户级 skill 目录，不读取工作目录下的 .pi：主控启动 Worker 时目标目录可能尚未被信任，
 * 项目文件不能决定模型和写权限。
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { THINKING_LEVELS, type WorkerRole } from "./protocol.js";
import { encodeToolPolicy, type ToolPolicy, type WriteMode } from "./tool-policy.js";

export const TEAM_CONFIG_FILE = "team.yaml";
const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ROLE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const WRITE_MODES: readonly WriteMode[] = ["none", "scoped", "any"];

export interface TeamRoleConfig {
  tier: WorkerRole;
  provider: string;
  model: string;
  thinking: string;
  write: WriteMode;
  /** 本角色同时存活的实例上限 */
  max?: number;
  denyTools: string[];
}

export interface TeamConfig {
  /** 本 team 在当前主控会话内同时存活的实例上限 */
  maxConcurrent?: number;
  roles: Map<string, TeamRoleConfig>;
}

/** worker_start 中与 team 相关的入参 */
export interface TeamStartParams {
  team?: string;
  teamRole?: string;
  role?: WorkerRole;
  cwd: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  allowedPaths?: string[];
}

export interface ResolvedTeamStart {
  team: string;
  teamRole: string;
  configPath: string;
  tier: WorkerRole;
  provider: string;
  model: string;
  thinkingLevel: string;
  write: WriteMode;
  maxConcurrent?: number;
  maxForRole?: number;
  policy: ToolPolicy;
}

function configError(message: string): Error {
  return new Error(`[TEAM_CONFIG_ERROR] ${message}`);
}

function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configError(`${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw configError(`${label} 含未知字段 "${key}"，可用字段：${allowed.join(", ")}`);
    }
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw configError(`${label} 必须是非空字符串`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw configError(`${label} 必须是正整数`);
  }
  return value as number;
}

function parseRole(value: unknown, label: string): TeamRoleConfig {
  const raw = requirePlainObject(value, label);
  rejectUnknownKeys(raw, ["tier", "provider", "model", "thinking", "write", "max", "denyTools"], label);

  const tier = raw.tier ?? "worker";
  if (tier !== "worker" && tier !== "lead") {
    throw configError(`${label}.tier 必须是 worker 或 lead`);
  }
  const thinking = requireNonEmptyString(raw.thinking, `${label}.thinking`);
  if (!(THINKING_LEVELS as readonly string[]).includes(thinking)) {
    throw configError(`${label}.thinking 必须是以下之一：${THINKING_LEVELS.join(" | ")}`);
  }
  if (!WRITE_MODES.includes(raw.write as WriteMode)) {
    throw configError(`${label}.write 必须是以下之一：${WRITE_MODES.join(" | ")}`);
  }
  const denyTools = raw.denyTools ?? [];
  if (!Array.isArray(denyTools) || !denyTools.every((item) => typeof item === "string" && item !== "")) {
    throw configError(`${label}.denyTools 必须是非空字符串数组`);
  }
  return {
    tier,
    provider: requireNonEmptyString(raw.provider, `${label}.provider`),
    model: requireNonEmptyString(raw.model, `${label}.model`),
    thinking,
    write: raw.write as WriteMode,
    max: optionalPositiveInteger(raw.max, `${label}.max`),
    denyTools: denyTools as string[],
  };
}

/** 严格解析：未知字段一律报错，防止拼错的限制项被静默忽略 */
export function parseTeamConfig(text: string, source: string): TeamConfig {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err: unknown) {
    throw configError(`${source} 不是合法的 YAML：${err instanceof Error ? err.message : String(err)}`);
  }
  const raw = requirePlainObject(parsed, source);
  rejectUnknownKeys(raw, ["version", "limits", "roles"], source);
  if (raw.version !== 1) {
    throw configError(`${source} 的 version 必须是 1`);
  }

  let maxConcurrent: number | undefined;
  if (raw.limits !== undefined) {
    const limits = requirePlainObject(raw.limits, `${source} 的 limits`);
    rejectUnknownKeys(limits, ["maxConcurrent"], `${source} 的 limits`);
    maxConcurrent = optionalPositiveInteger(limits.maxConcurrent, `${source} 的 limits.maxConcurrent`);
  }

  const rawRoles = requirePlainObject(raw.roles, `${source} 的 roles`);
  const roles = new Map<string, TeamRoleConfig>();
  for (const [name, value] of Object.entries(rawRoles)) {
    if (!ROLE_NAME_PATTERN.test(name)) {
      throw configError(`${source} 的角色名 "${name}" 非法，只能用小写字母、数字、- 和 _，且以字母开头`);
    }
    roles.set(name, parseRole(value, `${source} 的 roles.${name}`));
  }
  if (roles.size === 0) {
    throw configError(`${source} 至少要定义一个角色`);
  }
  return { maxConcurrent, roles };
}

function agentDir(env: NodeJS.ProcessEnv): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return path.join(homedir(), ".pi", "agent");
  if (configured === "~") return homedir();
  return configured.startsWith("~/") || configured.startsWith("~\\")
    ? path.join(homedir(), configured.slice(2))
    : path.resolve(configured);
}

export function teamConfigPath(team: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(agentDir(env), "skills", team, TEAM_CONFIG_FILE);
}

/** 允许目录写法 dir、dir/、dir/*、dir/**；其他通配符无法精确校验，直接拒绝 */
export function normalizeAllowedPaths(paths: readonly string[], cwd: string): string[] {
  return paths.map((raw) => {
    const stripped = raw.trim().replace(/[\\/]\*{1,2}$/, "");
    if (stripped === "" || /[*?[\]{}]/.test(stripped)) {
      throw configError(`allowedPaths 项 "${raw}" 无法精确校验，请使用文件或目录路径（可带 /** 后缀）`);
    }
    return path.resolve(cwd, stripped);
  });
}

/**
 * 解析 worker_start 的 team 参数。未使用 team 时返回 null，保持原有行为。
 * 文件读取是同步的：调用方可以在同一轮事件循环内完成名额检查与登记，避免并发超限。
 */
export function resolveTeamStart(
  params: TeamStartParams,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTeamStart | null {
  const { team, teamRole } = params;
  if (team === undefined && teamRole === undefined) return null;
  if (!path.isAbsolute(params.cwd)) {
    throw configError(`cwd 必须是绝对路径: "${params.cwd}"`);
  }
  if (team === undefined || teamRole === undefined) {
    throw configError("team 和 teamRole 必须同时提供");
  }
  if (!TEAM_NAME_PATTERN.test(team)) {
    throw configError(`team 名称 "${team}" 非法，应为 skill 目录名`);
  }
  // 模型和层级以 team.yaml 为唯一来源，调用方不能在单次调用里覆盖
  for (const field of ["role", "provider", "model", "thinkingLevel"] as const) {
    if (params[field] !== undefined) {
      throw configError(`使用 team 时不能同时传 ${field}，请修改 team.yaml`);
    }
  }

  const configPath = teamConfigPath(team, env);
  if (!fs.existsSync(configPath)) {
    throw configError(`找不到 team "${team}" 的配置：${configPath}`);
  }
  const config = parseTeamConfig(fs.readFileSync(configPath, "utf8"), configPath);
  const role = config.roles.get(teamRole);
  if (!role) {
    throw configError(`${configPath} 没有角色 "${teamRole}"，可用角色：${[...config.roles.keys()].join(", ")}`);
  }

  const allowedPaths = normalizeAllowedPaths(params.allowedPaths ?? [], params.cwd);
  if (role.write === "scoped" && allowedPaths.length === 0) {
    throw configError(`角色 ${team}/${teamRole} 是 write: scoped，必须提供非空的 allowedPaths`);
  }
  if (role.write === "none" && allowedPaths.length > 0) {
    throw configError(`角色 ${team}/${teamRole} 是只读角色 (write: none)，不能提供 allowedPaths`);
  }

  const policy: ToolPolicy = {
    label: `${team}/${teamRole}`,
    write: role.write,
    cwd: params.cwd,
    allowedPaths,
    denyTools: role.denyTools,
  };
  // 在开窗之前发现超限，而不是启动到一半才失败
  encodeToolPolicy(policy);

  return {
    team,
    teamRole,
    configPath,
    tier: role.tier,
    provider: role.provider,
    model: role.model,
    thinkingLevel: role.thinking,
    write: role.write,
    maxConcurrent: config.maxConcurrent,
    maxForRole: role.max,
    policy,
  };
}
