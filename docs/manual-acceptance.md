# pi-terminal-worker 人工验收与端到端测试指南

## 1. 简介

`pi-terminal-worker` 是一个 Pi (Coding Agent) 扩展，实现了主从 Pi 架构：
- **主 Pi (Controller)**：负责理解、设计、派发和验收。
- **执行 Pi (Worker)**：在 Windows Terminal 的独立新窗口中运行交互式会话，可实时观察与人工干预。
- **通信机制**：通过 Windows 命名管道（`\\.\pipe\pi-terminal-worker-<id>`）双向 JSONL 通信，不依赖临时任务文件，不篡改原生终端 stdin/stdout。

---

## 2. 自动化测试验证

在项目目录下执行：

```bash
npm run build
npm test
```

包含 6 个测试套件，16 项测试，覆盖：
1. 协议定义、JSONL 分帧、多字节 UTF-8 切块与 Token 时序安全比较。
2. 命名管道传输、请求-ACK、超时与去重。
3. Windows Terminal 参数构造与路径安全校验。
4. 控制端单实例互斥状态机、收件箱游标及验收门槛拦截。
5. 执行端候选回执流转、工具调用作废、人工干预识别与消息排队。
6. 会话代际隔离与资源幂等释放。

---

## 3. Windows Terminal 端到端人工验收流程

### 步骤 1：本地加载扩展

在主会话中临时启用此扩展：

```bash
pi -e E:/web/pi-terminal-worker
```

### 步骤 2：主代理派发任务

在主会话中由模型或用户调用：
- `worker_start`：
  - `cwd`: 当前目标项目绝对路径
  - `title`: "Worker - 任务测试"
  - `task`: "修改 hello.txt，添加一句话并运行测试"

观察：
- Windows Terminal 自动弹出新标签页或新窗口。
- 窗口内为常规交互式 Pi 界面，保留完整 TUI。
- 执行端不指定模型，默认使用新会话配置。

### 步骤 3：交互与回执

- Worker 端模型执行代码修改与测试。
- 完成后 Worker 调用 `worker_report` 工具提交结果。
- 主端通过 `worker_wait` 或 `/worker-status` 接收到 `ready_for_review` 状态。

### 步骤 4：主端审核与验收

- 主代理检查实际 diff 与测试记录。
- 验收通过后调用 `worker_close(disposition="accepted")`。
- Worker 窗口正常退出，名额释放。
