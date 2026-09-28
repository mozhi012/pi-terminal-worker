/**
 * 端到端实机验证脚本
 */

import { ControllerManager } from "../dist/controller.js";
import { FakePiAPI } from "./fake-pi.ts";

async function main() {
  console.log("=== 开始执行 pi-terminal-worker 实机连通性验证 ===");
  const fakePi = new FakePiAPI();
  const ctrl = new ControllerManager(fakePi);

  try {
    console.log("1. 正在启动 Windows Terminal Worker 并建立命名管道握手...");
    const res = await ctrl.handleWorkerStart({
      cwd: process.cwd(),
      title: "Worker 实机测试窗口",
      task: "请输出一段问候语，并通过 worker_report 报告完成",
    });

    console.log("2. Worker 启动成功并已成功派发任务:", res);

    console.log("3. 正在等待 Worker 返回事件...");
    const waitRes = await ctrl.handleWorkerWait({
      workerId: res.workerId,
      timeoutMs: 15000,
    });
    console.log("4. 收到 Worker 事件:", waitRes);

    console.log("5. 正在关闭测试 Worker 实例...");
    const closeRes = await ctrl.handleWorkerClose({
      workerId: res.workerId,
      disposition: "abandoned",
      force: true,
    });
    console.log("6. Worker 关闭成功:", closeRes);
    console.log("=== 实机连通性端到端验证通过 ===");
    process.exit(0);
  } catch (err) {
    console.error("实机验证异常:", err);
    await ctrl.dispose();
    process.exit(1);
  }
}

main();
