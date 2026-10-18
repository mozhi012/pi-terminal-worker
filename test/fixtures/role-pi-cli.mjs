/** bootstrap 测试夹具：报告实际角色并保持运行直到 supervisor 终止。 */
console.log(JSON.stringify({ role: process.env.PI_TERMINAL_WORKER_ROLE, pid: process.pid }));
setInterval(() => {}, 1000);
