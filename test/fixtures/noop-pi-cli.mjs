/**
 * 测试夹具：极简 no-op "Pi CLI"。
 * bootstrap 子进程测试用它作为 piCliPath，只打印一行并立即退出，
 * 绝不真的启动 Pi。忽略传入的 CLI 参数。
 */
console.log("[noop-pi-cli] fixture started");
process.exit(0);
