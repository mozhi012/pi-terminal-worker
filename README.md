# pi-terminal-worker

> 独立 Windows Terminal 窗口中的受控执行端 Pi 扩展，通过原生命名管道实现双向闭环通信与单实例监督调度。

## 特性

- **独立终端交互**：优先用 `wt.exe` 启动独立交互窗口；WT 缺失时自动回退 PowerShell (EncodedCommand 新控制台)，再回退 `cmd.exe /d /v:off`；均缺失时明确报错失败，不写任何临时任务文件。
- **纯内存管道通讯**：通过 Windows 原生命名管道（`\\.\pipe\...`）实现双向 JSONL 通信，不在磁盘生成任何临时任务文件（不写 `pi-tasks/`、`task.md`、`result.md`）。
- **默认模型可配置**：Worker 默认使用 `deepseek` / `deepseek-flash` / `thinking=high`（`worker_start` 未显式传参时生效）；可用环境变量 `PI_TERMINAL_WORKER_DEFAULT_PROVIDER` / `PI_TERMINAL_WORKER_DEFAULT_MODEL` / `PI_TERMINAL_WORKER_DEFAULT_THINKING` 覆盖。只影响新拉起的 Worker，不改动全局 Pi 设置、也不影响主 Pi 会话自身模型。
- **模型状态实时上报**：Worker 在 `worker_ready` 上报实际 provider/modelId/thinkingLevel；会话内 `/model`、`/thinking` 切换后自动刷新主控端状态。
- **状态三维分离**：严格区分生命周期（`launching/connected/closed` 等）、任务状态（`created/running/ready_for_review/accepted` 等）与 Pi 活动状态（`idle/busy`）。
- **健全的回执与验收闭环**：候选回执在稳定边界确认；存在未解决问题或测试失败时严格拒绝验收。
- **人工介入识别**：实时识别执行窗口的人工敲键盘干预，自动作废候选回执并暂停后续排队派发。
- **启动竞态防护**：主控端等待真实 `worker_ready`（而非仅管道连接）后才派发初始任务；Worker 侧 `session_start` 会补派发早到队列中的任务。

## 安装

```bash
pi install npm:@mozhi0012/pi-terminal-worker
```

或者本地开发加载：

```bash
pi -e E:/web/pi-terminal-worker
```

> 注意：Pi 会话会缓存启动时加载的扩展源码。修改源码后需重启 Pi（新会话）才能加载新版本。

## 终端后端与回退

`worker_start` 启动窗口时的探测顺序：

1. **Windows Terminal**（`wt.exe`，PATH 或 `WindowsApps` 标准目录；可用 `PI_TERMINAL_WORKER_WT_PATH` 显式指定）；
2. **PowerShell**（短命隐藏宿主 `powershell.exe -NoProfile -EncodedCommand`，脚本内 `Start-Process -FilePath node -WorkingDirectory cwd -WindowStyle Normal -ErrorAction Stop` 新建控制台直接跑 bootstrap，保证 Node stdin/stdout 为真实 TTY；`ArgumentList` 对 bootstrap 路径做 Windows 引号处理，PS 单引号段内 `& % !` 空格中文均为字面量）；
3. **CMD**（`comspec` / `System32\cmd.exe`，固定命令串 `start "%ENV_TITLE%" /D "%ENV_CWD%" "%ENV_NODE%" "%ENV_BOOT%" --descriptor %ENV_DESC%` + `/d /v:off /s /c` + `windowsVerbatimArguments`，各值放受控环境变量、单次展开；拒绝值中的双引号/CR/LF/NUL，不做 `%%`/`^` 转义，原生路径的 `& % !` 在引号内保留）。

三者都是独立可交互控制台，bootstrap/子进程退出或手动关窗后自动关闭。握手超时时**不会盲目重开窗口**，会报明确错误并保留单实例占位（可用 `/worker-forget` 人工解除）。

Worker 侧握手时序防护：`worker_ready` 必须等 `hello_ok` 认证确认且 `session_start` 就绪后发送，两者无论谁先到均保证发送一次，不会把 ready 丢在认证前。

## 工具与命令

### 主控侧工具 (LLM 可调用)
- `worker_start`：在独立终端窗口启动 Worker 并派发初始任务；可选模型参数：
  - `provider`：限定 `--model` 查找的 provider（需与 `model` 配合）；
  - `model`：模型 ID 或模糊匹配模式（可含 `provider/id` 与 `:<thinking>` 后缀）；
  - `thinkingLevel`：`off | minimal | low | medium | high | xhigh | max`。
  - 三者均为可选；**不传时使用 Worker 默认配置：`deepseek` / `deepseek-flash` / `thinking=high`**（可用环境变量 `PI_TERMINAL_WORKER_DEFAULT_PROVIDER` / `_DEFAULT_MODEL` / `_DEFAULT_THINKING` 覆盖，不改全局 Pi 设置，也不影响主 Pi 会话）。
  - 示例（显式覆盖）：`worker_start({ cwd: "E:/web/proj", title: "Worker", task: "...", provider: "local", model: "Qwen3.8-27B", thinkingLevel: "medium" })`。
- `worker_send`：发送补充说明、回复提问或发起返修 (`revision`)。
- `worker_wait`：等待执行端关键事件到达（游标收件箱机制）。
- `worker_status`：查询状态或分页拉取超长详情。
- `worker_stop`：合作式中止任务。
- `worker_close`：任务验收通过 (`accepted`) 或放弃 (`abandoned`) 并确认关闭。

### 主控侧命令
- `/worker-status`：查看当前运行状态与进度。
- `/worker-stop`：中止当前 Worker 运行。
- `/worker-close`：关闭 Worker 窗口。
- `/worker-forget`：人工强制解除占位。

### 执行侧工具与命令
- `worker_report`：执行模型提交进展、提问、阻碍或完成交付报告。
- `/worker-status`：执行端查看受控连接状态。
- `/worker-detach`：执行端人工脱钩，转为完全独立运行。

### Worker 窗口内的模型切换

Worker 窗口是完整交互 Pi，可用 Pi 原生命令调整模型与思考级别：

- `/model`：选择模型；在该界面按 `Ctrl+S` 可保存为新会话默认模型。
- `/thinking`：选择当前模型支持的思考级别；`Ctrl+S` 保存为启动级别。
- 切换后主控端会自动收到 `model_changed` 上报，`worker_status` 中 provider/model/thinkingLevel 即时刷新，无需重启 Worker。

## 限制

- 目前仅支持 Windows。
- 单主控同一时间仅允许一个 Worker 实例。

## 许可

[MIT](LICENSE)
