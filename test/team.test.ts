import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { MultiWorkerCoordinator } from "../dist/multi-worker.js";
import { WorkerManager } from "../dist/worker.js";
import { getPipePath } from "../dist/transport.js";
import { normalizeAllowedPaths, parseTeamConfig, resolveTeamStart, teamConfigPath } from "../dist/team-config.js";
import {
  TOOL_POLICY_ENV,
  bashWriteReason,
  decodeToolPolicy,
  encodeToolPolicy,
  evaluateToolCall,
  isPathWithin,
  isToolHidden,
  loadToolPolicyFromEnv,
  type ToolPolicy,
} from "../dist/tool-policy.js";
import { buildChildEnv } from "../runtime/bootstrap-support.mjs";
import { FakePiAPI, FakePiContext } from "./fake-pi.ts";

const VALID_YAML = `
version: 1
limits:
  maxConcurrent: 2
roles:
  reviewer:
    provider: magpie
    model: antigravity/gemini-4-argon
    thinking: high
    write: none
    max: 1
  implementer:
    provider: magpie
    model: codex/gpt-6.1-sol
    thinking: high
    write: scoped
    denyTools: ["mcp__*__execute_sql"]
  lead:
    tier: lead
    provider: magpie
    model: claude/claude-opus-5-5
    thinking: high
    write: any
`;

const tempDirs: string[] = [];
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
function writeSkillConfig(agentDir: string, team: string, yaml: string): void {
  const skillDir = path.join(agentDir, "skills", team);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "team.yaml"), yaml);
}
/** 把配置写进临时 agent 目录并指向它，返回同时用作工作目录的路径 */
function makeProject(yaml = VALID_YAML, team = "demo"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-test-"));
  tempDirs.push(dir);
  writeSkillConfig(dir, team, yaml);
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}
afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function readonlyPolicy(overrides: Partial<ToolPolicy> = {}): ToolPolicy {
  return { label: "demo/reviewer", write: "none", cwd: process.cwd(), allowedPaths: [], denyTools: [], ...overrides };
}

describe("parseTeamConfig", () => {
  it("解析角色并补默认层级", () => {
    const config = parseTeamConfig(VALID_YAML, "team.yaml");
    assert.equal(config.maxConcurrent, 2);
    assert.equal(config.roles.get("reviewer")?.tier, "worker");
    assert.equal(config.roles.get("lead")?.tier, "lead");
    assert.deepEqual(config.roles.get("implementer")?.denyTools, ["mcp__*__execute_sql"]);
  });

  const invalid: Array<[string, string, RegExp]> = [
    ["版本不对", "version: 2\nroles: {a: {provider: p, model: m, thinking: high, write: none}}", /version 必须是 1/],
    ["顶层未知字段", "version: 1\nmaxConcurent: 1\nroles: {a: {provider: p, model: m, thinking: high, write: none}}", /未知字段 "maxConcurent"/],
    ["角色未知字段", "version: 1\nroles: {a: {provider: p, model: m, thinking: high, write: none, maxx: 1}}", /未知字段 "maxx"/],
    ["缺模型", "version: 1\nroles: {a: {provider: p, thinking: high, write: none}}", /model 必须是非空字符串/],
    ["写权限非法", "version: 1\nroles: {a: {provider: p, model: m, thinking: high, write: readonly}}", /write 必须是/],
    ["思考级别非法", "version: 1\nroles: {a: {provider: p, model: m, thinking: huge, write: none}}", /thinking 必须是/],
    ["层级非法", "version: 1\nroles: {a: {tier: boss, provider: p, model: m, thinking: high, write: none}}", /tier 必须是/],
    ["上限非正整数", "version: 1\nroles: {a: {provider: p, model: m, thinking: high, write: none, max: 0}}", /max 必须是正整数/],
    ["角色名非法", "version: 1\nroles: {Bad Name: {provider: p, model: m, thinking: high, write: none}}", /角色名/],
    ["没有角色", "version: 1\nroles: {}", /至少要定义一个角色/],
    ["不是 YAML 对象", "- a\n- b", /必须是对象/],
    ["YAML 语法错误", "version: [1", /不是合法的 YAML/],
  ];
  for (const [name, text, pattern] of invalid) {
    it(`拒绝：${name}`, () => assert.throws(() => parseTeamConfig(text, "team.yaml"), pattern));
  }
});

describe("resolveTeamStart", () => {
  it("未使用 team 时返回 null，保持原有行为", () => {
    assert.equal(resolveTeamStart({ cwd: process.cwd(), model: "x" }), null);
  });

  it("从 team.yaml 解析模型和策略", () => {
    const cwd = makeProject();
    const res = resolveTeamStart({ team: "demo", teamRole: "reviewer", cwd });
    assert.equal(res?.provider, "magpie");
    assert.equal(res?.model, "antigravity/gemini-4-argon");
    assert.equal(res?.thinkingLevel, "high");
    assert.equal(res?.policy.write, "none");
    assert.equal(res?.policy.label, "demo/reviewer");
    assert.equal(res?.maxConcurrent, 2);
    assert.equal(res?.maxForRole, 1);
  });

  it("team 和 teamRole 必须成对", () => {
    assert.throws(() => resolveTeamStart({ team: "demo", cwd: process.cwd() }), /必须同时提供/);
    assert.throws(() => resolveTeamStart({ teamRole: "a", cwd: process.cwd() }), /必须同时提供/);
  });

  for (const field of ["role", "provider", "model", "thinkingLevel"] as const) {
    it(`使用 team 时不能覆盖 ${field}`, () => {
      const cwd = makeProject();
      assert.throws(
        () => resolveTeamStart({ team: "demo", teamRole: "reviewer", cwd, [field]: "worker" }),
        new RegExp(`不能同时传 ${field}`),
      );
    });
  }

  it("team 名不能用于路径穿越", () => {
    assert.throws(() => resolveTeamStart({ team: "../evil", teamRole: "a", cwd: process.cwd() }), /team 名称/);
  });

  it("cwd 必须是绝对路径", () => {
    assert.throws(() => resolveTeamStart({ team: "demo", teamRole: "a", cwd: "relative" }), /绝对路径/);
  });

  it("配置不存在时报出查找路径", () => {
    const cwd = makeProject();
    assert.throws(
      () => resolveTeamStart({ team: "missing", teamRole: "a", cwd }, { PI_CODING_AGENT_DIR: cwd }),
      /找不到 team "missing"/,
    );
  });

  it("角色不存在时列出可用角色；原型属性名不算角色", () => {
    const cwd = makeProject();
    assert.throws(() => resolveTeamStart({ team: "demo", teamRole: "nope", cwd }), /可用角色：reviewer, implementer, lead/);
    assert.throws(() => resolveTeamStart({ team: "demo", teamRole: "constructor", cwd }), /没有角色/);
  });

  it("scoped 必须给 allowedPaths，none 不能给", () => {
    const cwd = makeProject();
    assert.throws(() => resolveTeamStart({ team: "demo", teamRole: "implementer", cwd }), /必须提供非空的 allowedPaths/);
    assert.throws(() => resolveTeamStart({ team: "demo", teamRole: "implementer", cwd, allowedPaths: [] }), /必须提供非空的 allowedPaths/);
    assert.throws(() => resolveTeamStart({ team: "demo", teamRole: "reviewer", cwd, allowedPaths: ["src"] }), /不能提供 allowedPaths/);
    assert.equal(resolveTeamStart({ team: "demo", teamRole: "reviewer", cwd, allowedPaths: [] })?.write, "none");
  });

  it("配置路径在用户级 skill 目录下", () => {
    const agentDir = path.join(os.tmpdir(), "agent-dir");
    assert.equal(
      teamConfigPath("demo", { PI_CODING_AGENT_DIR: agentDir }),
      path.join(path.resolve(agentDir), "skills", "demo", "team.yaml"),
    );
  });

  it("工作目录下的 .pi 配置不能决定模型和权限", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-agent-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "team-cwd-"));
    tempDirs.push(agentDir, cwd);
    writeSkillConfig(path.join(cwd, ".pi"), "demo", VALID_YAML.replaceAll("write: none", "write: any"));
    const env = { PI_CODING_AGENT_DIR: agentDir };
    assert.throws(() => resolveTeamStart({ team: "demo", teamRole: "reviewer", cwd }, env), /找不到 team "demo"/);

    writeSkillConfig(agentDir, "demo", VALID_YAML);
    const res = resolveTeamStart({ team: "demo", teamRole: "reviewer", cwd }, env);
    assert.equal(res?.write, "none");
    assert.equal(res?.configPath, path.join(agentDir, "skills", "demo", "team.yaml"));
  });

  it("策略过大时在启动前失败", () => {
    const cwd = makeProject();
    const allowedPaths = Array.from({ length: 200 }, (_, i) => `${"d".repeat(100)}${i}`);
    assert.throws(() => resolveTeamStart({ team: "demo", teamRole: "implementer", cwd, allowedPaths }), /字符上限/);
  });
});

describe("normalizeAllowedPaths", () => {
  const cwd = path.resolve("/repo");
  it("接受文件、目录和目录通配后缀", () => {
    assert.deepEqual(normalizeAllowedPaths(["src", "src/", "src/*", "src/**", "a.ts"], cwd), [
      path.join(cwd, "src"), path.join(cwd, "src"), path.join(cwd, "src"), path.join(cwd, "src"), path.join(cwd, "a.ts"),
    ]);
  });
  it("拒绝无法精确校验的通配符", () => {
    for (const bad of ["src/*.ts", "**/x", "a?", "{a,b}", "", "*"]) {
      assert.throws(() => normalizeAllowedPaths([bad], cwd), /无法精确校验/, bad);
    }
  });
});

describe("bashWriteReason", () => {
  const readOnly = [
    "git diff HEAD~1",
    "git -C E:/web/x log --oneline -3",
    "git --no-pager show HEAD",
    "git status --short 2>/dev/null",
    "git stash list",
    "git branch",
    "rg 'a > b' src",
    'rg "rm -rf" src',
    "cat a.txt | head -5",
    "npm test 2>&1 | tail -20",
    "ls > /dev/null",
    "ls &>/dev/null",
    "echo ok >&2",
    "ls 2>NUL",
    "find . -name '*.ts'",
    "sed -n 1,5p a.txt",
    "FOO=1 node --test",
    "xargs cat",
  ];
  for (const command of readOnly) {
    it(`放行：${command}`, () => assert.equal(bashWriteReason(command), undefined));
  }

  const writes: Array<[string, RegExp]> = [
    ["rm -rf src", /^rm$/],
    ["echo x > a.txt", /重定向/],
    ["echo x >> a.txt", /重定向/],
    ["cat a 2> err.log", /重定向/],
    ["echo x >", /重定向/],
    ["ls && rm a", /^rm$/],
    ["ls; mv a b", /^mv$/],
    ["ls | tee a.txt", /^tee$/],
    ["(cd x && touch a)", /^touch$/],
    ["echo $(rm a)", /^rm$/],
    ["FOO=1 rm a", /^rm$/],
    ["sudo rm a", /^rm$/],
    ["/usr/bin/rm a", /^rm$/],
    ["rm.exe a", /^rm$/],
    ["find . | xargs rm", /^rm$/],
    ["xargs -0 rm", /^rm$/],
    ["find . -delete", /find -delete/],
    ["find . -exec rm {} ;", /find -exec rm/],
    ["sed -i s/a/b/ f", /sed -i/],
    ["sed -i.bak s/a/b/ f", /sed -i/],
    ["perl -pi -e s/a/b/ f", /perl -i/],
    ["git commit -m x", /git commit/],
    ["git -C repo push", /git push/],
    ["git -c a=b checkout main", /git checkout/],
    ["git --no-pager reset --hard", /git reset/],
    ["git stash", /git stash/],
    ["git stash pop", /git stash/],
    ["git worktree add ../x", /git worktree add/],
  ];
  for (const [command, pattern] of writes) {
    it(`拦截：${command}`, () => assert.match(bashWriteReason(command) ?? "", pattern));
  }
});

describe("evaluateToolCall", () => {
  it("write:none 拦截文件写工具和 bash 写命令，放行只读调用", () => {
    const policy = readonlyPolicy();
    assert.match(evaluateToolCall(policy, "write", { path: "a" }) ?? "", /只读角色/);
    assert.match(evaluateToolCall(policy, "edit", { path: "a" }) ?? "", /只读角色/);
    assert.match(evaluateToolCall(policy, "code_rewrite", { dry_run: false }) ?? "", /只读角色/);
    assert.match(evaluateToolCall(policy, "bash", { command: "rm a" }) ?? "", /已拦截写操作：rm/);
    assert.equal(evaluateToolCall(policy, "code_rewrite", { dry_run: true }), undefined);
    assert.equal(evaluateToolCall(policy, "code_rewrite", {}), undefined);
    assert.equal(evaluateToolCall(policy, "bash", { command: "git diff" }), undefined);
    assert.equal(evaluateToolCall(policy, "read", { path: "a" }), undefined);
    assert.equal(evaluateToolCall(policy, "worker_report", { kind: "result" }), undefined);
  });

  it("write:scoped 只允许范围内路径", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "team-scope-"));
    tempDirs.push(cwd);
    const policy = readonlyPolicy({ write: "scoped", cwd, allowedPaths: [path.join(cwd, "src")] });
    assert.equal(evaluateToolCall(policy, "write", { path: "src/a.ts" }), undefined);
    assert.equal(evaluateToolCall(policy, "edit", { path: path.join(cwd, "src", "deep", "a.ts") }), undefined);
    assert.equal(evaluateToolCall(policy, "code_rewrite", { path: "src", dry_run: false }), undefined);
    assert.match(evaluateToolCall(policy, "write", { path: "other/a.ts" }) ?? "", /不允许写入/);
    assert.match(evaluateToolCall(policy, "write", { path: "src/../other/a.ts" }) ?? "", /不允许写入/);
    assert.match(evaluateToolCall(policy, "write", { path: "src2/a.ts" }) ?? "", /不允许写入/);
    assert.match(evaluateToolCall(policy, "write", { path: "~/a.ts" }) ?? "", /不允许写入/);
    assert.match(evaluateToolCall(policy, "write", { path: "@other/a.ts" }) ?? "", /不允许写入/);
    assert.match(evaluateToolCall(policy, "write", {}) ?? "", /必须明确给出 path/);
    assert.match(evaluateToolCall(policy, "code_rewrite", { dry_run: false }) ?? "", /必须明确给出 path/);
    // bash 无法按路径判断，scoped 不拦截
    assert.equal(evaluateToolCall(policy, "bash", { command: "rm other/a.ts" }), undefined);
  });

  it("write:scoped 不能经符号链接写到范围外", (t) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "team-link-"));
    tempDirs.push(cwd);
    fs.mkdirSync(path.join(cwd, "src"));
    fs.mkdirSync(path.join(cwd, "outside"));
    try {
      fs.symlinkSync(path.join(cwd, "outside"), path.join(cwd, "src", "link"), "junction");
    } catch {
      t.skip("当前环境无法创建链接");
      return;
    }
    const policy = readonlyPolicy({ write: "scoped", cwd, allowedPaths: [path.join(cwd, "src")] });
    assert.match(evaluateToolCall(policy, "write", { path: "src/link/a.ts" }) ?? "", /不允许写入/);
    assert.equal(evaluateToolCall(policy, "write", { path: "src/real/a.ts" }), undefined);
  });

  it("write:any 不限制写入，但 denyTools 仍生效", () => {
    const policy = readonlyPolicy({ write: "any", denyTools: ["mcp__*__execute_sql", "subagent"] });
    assert.equal(evaluateToolCall(policy, "write", { path: "/anywhere" }), undefined);
    assert.equal(evaluateToolCall(policy, "bash", { command: "rm a" }), undefined);
    assert.match(evaluateToolCall(policy, "mcp__db__execute_sql", {}) ?? "", /禁用了工具/);
    assert.equal(evaluateToolCall(policy, "mcp__db__get_tables", {}), undefined);
  });

  it("隐藏只读角色的写工具和被禁用的工具", () => {
    const policy = readonlyPolicy({ denyTools: ["mcp__*"] });
    assert.equal(isToolHidden(policy, "write"), true);
    assert.equal(isToolHidden(policy, "edit"), true);
    assert.equal(isToolHidden(policy, "mcp__x"), true);
    assert.equal(isToolHidden(policy, "bash"), false);
    assert.equal(isToolHidden(readonlyPolicy({ write: "scoped" }), "write"), false);
  });
});

describe("isPathWithin", () => {
  it("Windows 下大小写不敏感，且不把同前缀目录算作范围内", () => {
    const root = path.resolve("/Repo/src");
    assert.equal(isPathWithin(path.resolve("/repo/SRC/a.ts"), root, "win32"), true);
    assert.equal(isPathWithin(path.resolve("/repo/src"), root, "win32"), true);
    assert.equal(isPathWithin(path.resolve("/repo/src2/a.ts"), root, "win32"), false);
    assert.equal(isPathWithin(path.resolve("/repo/..src/a.ts"), root, "win32"), false);
  });
});

describe("策略传递", () => {
  it("编码后可还原", () => {
    const policy = readonlyPolicy();
    assert.deepEqual(decodeToolPolicy(encodeToolPolicy(policy)), policy);
  });

  it("环境变量损坏时按只读处理，没有变量时不限制", () => {
    assert.equal(loadToolPolicyFromEnv({}), null);
    for (const raw of ["{not json", "null", '{"write":"any"}', '{"label":"a","write":"root","cwd":"c","allowedPaths":[],"denyTools":[]}']) {
      const policy = loadToolPolicyFromEnv({ [TOOL_POLICY_ENV]: raw });
      assert.equal(policy?.write, "none", raw);
    }
  });

  it("子进程不继承上级的策略", () => {
    const base = { PATH: "x", [TOOL_POLICY_ENV]: "parent-policy" };
    const ids = { controllerId: "c", workerId: "w", workerPipePath: "p", workerToken: "t" };
    assert.equal(buildChildEnv(base, ids)[TOOL_POLICY_ENV], undefined);
    assert.equal(buildChildEnv(base, { ...ids, toolPolicy: "own" })[TOOL_POLICY_ENV], "own");
    assert.equal(buildChildEnv(base, ids).PATH, "x");
    assert.equal(buildChildEnv(base, ids).PI_TERMINAL_WORKER_ROLE, "worker");
  });
});

/** 只记录调用参数的控制器桩，不开窗 */
function makeCoordinator() {
  const calls: Array<{ params: any; internal: any }> = [];
  const instances: Array<{ taskState: string }> = [];
  const coordinator = new MultiWorkerCoordinator(new FakePiAPI() as any, {
    controllerFactory: () => {
      const instance = { taskState: "running" };
      instances.push(instance);
      return {
        workerManager: { getInstance: () => instance, hasActiveInstance: () => true },
        handleWorkerStart: async (params: any, _probes: any, internal: any) => {
          calls.push({ params, internal });
          return { ok: true, revision: 1, message: "ok" };
        },
        dispose: async () => {},
      } as any;
    },
  });
  return { coordinator, calls, instances };
}

describe("MultiWorkerCoordinator + team", () => {
  const roleEnv = "PI_TERMINAL_WORKER_ROLE";
  const savedRole = process.env[roleEnv];
  afterEach(() => {
    if (savedRole === undefined) delete process.env[roleEnv];
    else process.env[roleEnv] = savedRole;
  });

  it("模型和策略来自 team.yaml，并在返回值和列表中可见", async () => {
    const cwd = makeProject();
    const { coordinator, calls } = makeCoordinator();
    const res = await coordinator.handleWorkerStart({ team: "demo", teamRole: "reviewer", cwd, title: "T", task: "x" });

    assert.equal(calls[0].params.provider, "magpie");
    assert.equal(calls[0].params.model, "antigravity/gemini-4-argon");
    assert.equal(calls[0].params.thinkingLevel, "high");
    assert.equal(calls[0].params.team, undefined);
    assert.equal(calls[0].internal.toolPolicy.write, "none");
    assert.equal(res.team?.role, "reviewer");
    assert.equal(res.team?.model, "antigravity/gemini-4-argon");
    assert.equal(res.team?.write, "none");

    const list = await coordinator.handleWorkerList();
    assert.equal(list.workers[0].team, "demo");
    assert.equal(list.workers[0].teamRole, "reviewer");
  });

  it("不用 team 时保持原有行为，也没有策略", async () => {
    const { coordinator, calls } = makeCoordinator();
    const res = await coordinator.handleWorkerStart({ cwd: process.cwd(), title: "T", task: "x", model: "m" });
    assert.equal(calls[0].params.model, "m");
    assert.equal(calls[0].internal.toolPolicy, undefined);
    assert.equal(res.team, undefined);
  });

  it("工具入参无法伪造策略", async () => {
    const { coordinator, calls } = makeCoordinator();
    await coordinator.handleWorkerStart({
      cwd: process.cwd(), title: "T", task: "x",
      toolPolicy: { write: "any" },
    } as any);
    assert.equal(calls[0].internal.toolPolicy, undefined);
  });

  it("配置错误时不创建实例", async () => {
    const { coordinator, calls } = makeCoordinator();
    await assert.rejects(
      () => coordinator.handleWorkerStart({ team: "demo", teamRole: "reviewer", cwd: makeProject("version: 1\nroles: {}"), title: "T", task: "x" }),
      /至少要定义一个角色/,
    );
    assert.equal(calls.length, 0);
    assert.equal(coordinator.size, 0);
  });

  it("并发启动也不会突破角色上限，实例结束后释放名额", async () => {
    const cwd = makeProject();
    const { coordinator, calls, instances } = makeCoordinator();
    const params = { team: "demo", teamRole: "reviewer", cwd, title: "T", task: "x" };
    const results = await Promise.allSettled([
      coordinator.handleWorkerStart(params),
      coordinator.handleWorkerStart(params),
    ]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    assert.match(String((results[1] as PromiseRejectedResult).reason), /TEAM_LIMIT_REACHED.*max=1/);
    assert.equal(calls.length, 1);

    instances[0].taskState = "accepted";
    await coordinator.handleWorkerStart(params);
    assert.equal(calls.length, 2);
  });

  it("team 总上限跨角色累计，其他 team 不受影响", async () => {
    const cwd = makeProject();
    writeSkillConfig(cwd, "other", VALID_YAML);
    const { coordinator } = makeCoordinator();
    const implementer = { team: "demo", teamRole: "implementer", cwd, title: "T", task: "x", allowedPaths: ["src"] };
    await coordinator.handleWorkerStart(implementer);
    await coordinator.handleWorkerStart(implementer);
    await assert.rejects(() => coordinator.handleWorkerStart(implementer), /limits\.maxConcurrent=2/);
    await coordinator.handleWorkerStart({ team: "other", teamRole: "reviewer", cwd, title: "T", task: "x" });
  });

  it("lead 层级来自配置，且 lead 不能再启动 lead", async () => {
    const cwd = makeProject();
    const { coordinator, calls } = makeCoordinator();
    delete process.env[roleEnv];
    await coordinator.handleWorkerStart({ team: "demo", teamRole: "lead", cwd, title: "T", task: "x" });
    assert.equal(calls[0].params.role, "lead");

    process.env[roleEnv] = "lead";
    await assert.rejects(() => coordinator.handleWorkerStart({ team: "demo", teamRole: "lead", cwd, title: "T", task: "x" }), /lead/);
    assert.equal(calls.length, 1);
  });

  it("worker_start 工具 schema 暴露 team 参数", () => {
    const pi = new FakePiAPI();
    new MultiWorkerCoordinator(pi as any).registerToolsAndCommands();
    const properties = (pi.tools.get("worker_start") as any).parameters.properties;
    assert.ok(properties.team);
    assert.ok(properties.teamRole);
  });
});

describe("WorkerManager 执行策略", () => {
  const envKeys = [TOOL_POLICY_ENV, "PI_TERMINAL_WORKER_CONTROLLER_ID", "PI_TERMINAL_WORKER_WORKER_ID", "PI_TERMINAL_WORKER_PIPE_PATH", "PI_TERMINAL_WORKER_TOKEN"];

  async function startWorker(policy?: ToolPolicy) {
    const pipePath = getPipePath("team-worker-" + crypto.randomUUID().slice(0, 8));
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => {
      sockets.push(socket);
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
          const env = JSON.parse(line);
          if (env.type === "hello") {
            socket.write(JSON.stringify({ version: 1, controllerId: "c", workerId: "w", id: crypto.randomUUID(), replyTo: env.id, seq: 1, type: "hello_ok", payload: {} }) + "\n");
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(pipePath, resolve));
    const saved = new Map(envKeys.map((key) => [key, process.env[key]]));
    process.env.PI_TERMINAL_WORKER_CONTROLLER_ID = "c";
    process.env.PI_TERMINAL_WORKER_WORKER_ID = "w";
    process.env.PI_TERMINAL_WORKER_PIPE_PATH = pipePath;
    process.env.PI_TERMINAL_WORKER_TOKEN = "t";
    if (policy) process.env[TOOL_POLICY_ENV] = encodeToolPolicy(policy);
    else delete process.env[TOOL_POLICY_ENV];

    const pi = new FakePiAPI();
    for (const name of ["read", "bash", "write", "edit", "mcp__db__execute_sql"]) pi.registerTool({ name } as any);
    const ctx = new FakePiContext();
    const worker = new WorkerManager(pi as any);
    await worker.init();
    return {
      pi,
      ctx,
      cleanup: async () => {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  it("只读角色隐藏写工具并在 tool_call 拦截", async () => {
    const h = await startWorker(readonlyPolicy({ denyTools: ["mcp__*__execute_sql"] }));
    try {
      await h.pi.emitPiEvent("session_start", {}, h.ctx);
      const active = h.pi.getActiveTools();
      assert.ok(!active.includes("write"));
      assert.ok(!active.includes("edit"));
      assert.ok(!active.includes("mcp__db__execute_sql"));
      assert.ok(active.includes("read"));
      assert.ok(active.includes("worker_report"));

      const blocked = await h.pi.emitPiEvent("tool_call", { toolName: "bash", input: { command: "rm a" } }, h.ctx);
      assert.equal(blocked.block, true);
      assert.match(blocked.reason, /已拦截写操作：rm/);
      assert.equal(await h.pi.emitPiEvent("tool_call", { toolName: "bash", input: { command: "git diff" } }, h.ctx), undefined);
    } finally {
      await h.cleanup();
    }
  });

  it("会话就绪前也不能绕过策略", async () => {
    const h = await startWorker(readonlyPolicy());
    try {
      const blocked = await h.pi.emitPiEvent("tool_call", { toolName: "write", input: { path: "a" } }, h.ctx);
      assert.equal(blocked.block, true);
    } finally {
      await h.cleanup();
    }
  });

  it("没有策略时不影响现有行为", async () => {
    const h = await startWorker();
    try {
      await h.pi.emitPiEvent("session_start", {}, h.ctx);
      assert.ok(h.pi.getActiveTools().includes("write"));
      assert.equal(await h.pi.emitPiEvent("tool_call", { toolName: "write", input: { path: "a" } }, h.ctx), undefined);
    } finally {
      await h.cleanup();
    }
  });
});
