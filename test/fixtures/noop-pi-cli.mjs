/**
 * 测试夹具：极简 no-op "Pi CLI"。
 * bootstrap 子进程测试用它作为 piCliPath，只打印一行并立即退出，
 * 绝不真的启动 Pi。检查扩展加载参数以防回归。
 */
import assert from "node:assert/strict";

const args = process.argv.slice(2);
assert.ok(!args.includes("--no-extensions"), "Worker must retain normal extension loading");
assert.strictEqual(args[0], "-e", "Worker communication extension must be explicitly loaded");
assert.ok(args[1], "Worker extension path must be provided");

console.log("[noop-pi-cli] fixture started");
process.exit(0);
