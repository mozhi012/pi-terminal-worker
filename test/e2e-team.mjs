/**
 * team.yaml 端到端验证：开真实窗口、调用真实模型，确认模型配置和写权限在 Worker 进程里生效。
 *
 * 结论以磁盘上的文件和 Worker 上报的模型为准，不采信模型的自述。
 * 运行：npm run build && node test/e2e-team.mjs [provider] [model]
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MultiWorkerCoordinator } from "../dist/multi-worker.js";
import { findPiCliPath } from "../dist/launcher.js";
import { FakePiAPI } from "./fake-pi.ts";

const provider = process.argv[2] ?? "magpie";
const model = process.argv[3] ?? "antigravity/gemini-3.8-flash";
const WAIT_MS = 300_000;

process.env.E2E_REAL_PI_CLI = findPiCliPath();
process.env.PI_TERMINAL_WORKER_PI_CLI_PATH = fileURLToPath(new URL("./fixtures/isolated-pi-cli.mjs", import.meta.url));

// 工作目录不能有 .pi：否则 Worker 会停在项目信任确认上，验证结果也就依赖人工点击
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "team-e2e-"));
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-e2e-agent-"));
if (process.env.PI_CODING_AGENT_DIR) process.env.E2E_REAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const skillDir = path.join(agentDir, "skills", "e2e");
fs.mkdirSync(skillDir, { recursive: true });
fs.mkdirSync(path.join(cwd, "allowed"));
fs.writeFileSync(path.join(cwd, "input.txt"), "secret-word-7391\n");
fs.writeFileSync(path.join(skillDir, "team.yaml"), `version: 1
limits:
  maxConcurrent: 2
roles:
  reviewer:
    provider: ${provider}
    model: ${model}
    thinking: low
    write: none
    max: 1
  implementer:
    provider: ${provider}
    model: ${model}
    thinking: low
    write: scoped
    max: 1
`);

const exists = (name) => fs.existsSync(path.join(cwd, name));
const results = [];
function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function waitForReport(coordinator, workerId, taskId) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    let res;
    try {
      res = await coordinator.handleWorkerWait({ workerId, timeoutMs: 30_000 });
    } catch (err) {
      if (/超时|timeout/i.test(String(err))) continue;
      throw err;
    }
    console.log(`事件: ${res.event.type} (${res.currentTaskState}/${res.currentLifecycleState})`);
    if (res.event.type === "report_committed") return res.event;
    // 模型有时只提交 progress 就停下，和真实主控一样催一次
    if (res.event.type === "report_missing") {
      await coordinator.handleWorkerSend({
        workerId,
        taskId,
        kind: "supplement",
        message: "你还没有提交正式回执。不要重做任何步骤，直接调用 worker_report(kind=\"result\")，summary 写明刚才的结果。",
      });
    }
    if (["launch_failed", "child_exit", "disconnected"].includes(res.event.type)) {
      throw new Error(`Worker 异常: ${res.event.type} ${res.event.summary}`);
    }
  }
  throw new Error(`等待 ${workerId} 回执超时`);
}

async function runScenario(coordinator, teamRole, allowedPaths, task, verify) {
  console.log(`\n--- ${teamRole} ---`);
  const startedAt = Date.now();
  const started = await coordinator.handleWorkerStart({
    team: "e2e",
    teamRole,
    cwd,
    title: `team e2e ${teamRole}`,
    task,
    allowedPaths,
  });
  console.log(`启动耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  check(`${teamRole}: 返回值带解析出的模型`, started.team?.model === model && started.team?.provider === provider, `${started.team?.provider}/${started.team?.model}`);

  const report = await waitForReport(coordinator, started.workerId, started.taskId);
  const status = await coordinator.handleWorkerStatus({ workerId: started.workerId });
  const inst = status.worker ?? {};
  check(`${teamRole}: Worker 实际运行的模型来自 team.yaml`, inst.modelId === model && inst.provider === provider, `${inst.provider}/${inst.modelId}`);
  console.log(`回执: ${report.summary}`);
  await verify(report.summary);
  await coordinator.handleWorkerClose({ workerId: started.workerId, disposition: "abandoned", force: true });
}

const coordinator = new MultiWorkerCoordinator(new FakePiAPI(), { strictProtocol: true });
try {
  await runScenario(
    coordinator,
    "reviewer",
    [],
    [
      "这是权限测试。按顺序各尝试一次，失败或被拦截也继续下一步，不要改用其他写法绕过，也不要反复重试：",
      "1. 用 read 工具读取 input.txt，记下内容。",
      "2. 用 bash 执行：echo blocked > ro-redirect.txt",
      "3. 用 bash 执行：touch ro-touch.txt",
      "4. 用 bash 执行：git --version",
      "5. 如果当前有 write 工具，用它写 ro-write.txt，内容 x；没有就跳过。",
      "6. 如果当前有 codemode 工具，用它运行：await tools.bash({command:'touch ro-codemode.txt'})；没有就跳过。",
      "7. 如果当前有 codemode 工具，再用它运行：await tools.write({path:'ro-codemode-write.txt',content:'x'})；没有就跳过。",
      "最后用 worker_report(kind=\"result\") 提交，summary 写明 input.txt 的内容，以及每一步是成功、被拦截还是跳过。",
    ].join("\n"),
    async (report) => {
      for (const name of ["ro-redirect.txt", "ro-touch.txt", "ro-write.txt", "ro-codemode.txt", "ro-codemode-write.txt"]) {
        check(`reviewer: 没有写出 ${name}`, !exists(name));
      }
      check("reviewer: 只读操作仍然可用", report.includes("secret-word-7391"));
    },
  );

  await runScenario(
    coordinator,
    "implementer",
    ["allowed/**"],
    [
      "这是权限测试。按顺序各尝试一次，失败或被拦截也继续下一步，不要改用其他写法绕过，也不要反复重试：",
      "1. 用 write 工具写 allowed/in-scope.txt，内容 ok。",
      "2. 用 write 工具写 out-of-scope.txt，内容 x。",
      "3. 用 write 工具写 allowed/../escape.txt，内容 x。",
      "最后用 worker_report(kind=\"result\") 提交，summary 写明每一步是成功还是被拦截。",
    ].join("\n"),
    async () => {
      check("implementer: 范围内写入成功", exists("allowed/in-scope.txt"));
      check("implementer: 范围外写入被拦截", !exists("out-of-scope.txt"));
      check("implementer: ../ 穿越被拦截", !exists("escape.txt"));
    },
  );
} catch (err) {
  check("场景正常结束", false, String(err));
} finally {
  // 启动失败的实例会保留占位和窗口，这里必须强制关掉，否则窗口和进程会残留
  for (const workerId of coordinator.listWorkerIds()) {
    await coordinator.handleWorkerClose({ workerId, disposition: "abandoned", force: true }).catch((err) => console.error("关闭失败:", err));
  }
  await coordinator.dispose().catch((err) => console.error("dispose 失败:", err));
  // Worker 窗口可能还没退出，目录被占用时只提示，不掩盖验证结果
  for (const dir of [cwd, agentDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {
      console.log(`临时目录未能删除: ${dir}`);
    }
  }
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
