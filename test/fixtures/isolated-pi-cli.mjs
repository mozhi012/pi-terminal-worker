/**
 * 真实 Pi CLI 的包装：关闭扩展发现，只加载 -e 指定的开发版本扩展。
 * 用于端到端验证，避免和已安装的同名插件重复加载。
 * 通过 PI_TERMINAL_WORKER_PI_CLI_PATH 指向本文件，真实 CLI 路径由 E2E_REAL_PI_CLI 提供。
 */
import { pathToFileURL } from "node:url";

const realCli = process.env.E2E_REAL_PI_CLI;
if (!realCli) throw new Error("缺少 E2E_REAL_PI_CLI");
// 内置 codemode 也要加载，用来验证嵌套工具调用同样受策略约束
process.argv.splice(2, 0, "--no-extensions", "-e", "builtin:codemode", "--tools", "+codemode");
process.argv[1] = realCli;
// 测试把 PI_CODING_AGENT_DIR 指向临时目录来放 team.yaml；Worker 仍要用真实目录里的模型和凭据
if (process.env.E2E_REAL_AGENT_DIR) process.env.PI_CODING_AGENT_DIR = process.env.E2E_REAL_AGENT_DIR;
else delete process.env.PI_CODING_AGENT_DIR;
await import(pathToFileURL(realCli).href);
