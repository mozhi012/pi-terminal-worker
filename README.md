# pi-terminal-worker

> 独立 Windows Terminal 窗口中的受控执行端 Pi 扩展，通过原生命名管道实现双向闭环通信与多实例监督调度。

## 特性

- **多 Worker 并发**：主代理可按需多次调用 `worker_start`，同一主 Pi 会话同时监督多个独立窗口中的 Worker；每个 Worker 拥有独立的窗口/进程、命名管道、两条连接、token、收件箱、报告缓存、心跳与关闭流程，互不串线。一个 Worker 失败、超时、断连或退出不影响其他 Worker。
- **独立终端交互**：优先用 `wt.exe` 启动独立交互窗口；WT 缺失时自动回退 PowerShell (EncodedCommand 新控制台)，再回退 `cmd.exe /d /v:off`；均缺失时明确报错失败，不写任何临时任务文件。
- **纯内存管道通讯**：通过 Windows 原生命名管道（`\\.\pipe\...`）实现双向 JSONL 通信，不在磁盘生成任何临时任务文件（不写 `pi-tasks/`、`task.md`、`result.md`）。
- **默认模型可配置**：Worker 默认使用 `deepseek` / `deepseek-flash` / `thinking=high`（`worker_start` 未显式传参时生效）；可用环境变量 `PI_TERMINAL_WORKER_DEFAULT_PROVIDER` / `PI_TERMINAL_WORKER_DEFAULT_MODEL` / `PI_TERMINAL_WORKER_DEFAULT_THINKING` 覆盖。只影响新拉起的 Worker，不改动全局 Pi 设置、也不影响主 Pi 会话自身模型。
- **模型状态实时上报**：Worker 在 `worker_ready` 上报实际 provider/modelId/thinkingLevel；会话内 `/model`、`/thinking` 切换后自动刷新主控端状态。
- **状态三维分离**：严格区分生命周期（`launching/connected/closed` 等）、任务状态（`created/running/ready_for_review/accepted` 等）与 Pi 活动状态（`idle/busy`）。
- **健全的回执与验收闭环**：候选回执在稳定边界确认；存在未解决问题或测试失败时严格拒绝验收。
- **主动事件通知（默认不需要轮询）**：关键事件（交付回执、提问、阻塞、停止、断连/失联、启动失败、进程退出等）写入收件箱后会主动通过 `pi.sendMessage` 唤醒主代理——空闲时开新轮、忙碌时 `followUp` 排队。普通进度（活动状态、候选回执、启动成功等）不会推送，避免噪声。`worker_wait` 仅作为恢复/诊断/同步等待兜底。
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

七个工具由协调器只注册一次；除 `worker_start`/`worker_list` 外均要求显式 `workerId`，按 ID 精确路由，绝不隐式选择“最近创建”的实例（未知/已移除 ID 返回 `NOT_FOUND`）。

- `worker_start`：在独立终端窗口启动 Worker 并派发初始任务；每次调用新建一个独立实例，不提供 `count` 参数。可选模型参数：
  - `provider`：限定 `--model` 查找的 provider（需与 `model` 配合）；
  - `model`：模型 ID 或模糊匹配模式（可含 `provider/id` 与 `:<thinking>` 后缀）；
  - `thinkingLevel`：`off | minimal | low | medium | high | xhigh | max`。
  - 三者均为可选；**不传时使用 Worker 默认配置：`deepseek` / `deepseek-flash` / `thinking=high`**（可用环境变量 `PI_TERMINAL_WORKER_DEFAULT_PROVIDER` / `_DEFAULT_MODEL` / `_DEFAULT_THINKING` 覆盖，不改全局 Pi 设置，也不影响主 Pi 会话）。
  - 返回值包含本次实例的 `workerId` / `taskId` / `revision`，后续所有操作都以 `workerId` 定位。
  - 示例（显式覆盖）：`worker_start({ cwd: "E:/web/proj", title: "Worker", task: "...", provider: "local", model: "Qwen3.8-27B", thinkingLevel: "medium" })`。
- `worker_list`：**无参数**列出当前活跃或未确认退出实例的有界摘要（`workerId` / `taskId` / 标题 / `cwd` / 生命周期 / 任务 / 活动状态 / 创建时间 / 模型摘要），单次最多返回 20 条并报告 `total`/`truncated`，标题/cwd/模型等长文本均截断为有界内容。列表只用于概览，**不替代** `worker_status`；错误、报告与事件明细仍须按 `workerId` 查。
- `worker_send`：向指定 `workerId` 发送补充说明、回复提问或发起返修 (`revision`)；发送后无需连续等待，后续关键事件会自动唤醒本会话。
- `worker_wait`：同步等待指定 `workerId` 的可操作关键事件——**仅作为恢复/诊断/同步等待兜底**。只匹配关键事件（普通进度不唤醒）；默认从该实例上次已消费游标之后匹配（不重复返回同一事件），显式传 `afterCursor` 可重放；默认等待 5 分钟，上限 10 分钟（显式短 `timeoutMs` 兼容，最小 1 秒）。不同 Worker 的游标/事件互不影响。
- `worker_status`：按 `workerId` 查询状态或分页拉取超长详情；`eventId` 详情读取先定位该 `workerId`，不会跨实例读取。
- `worker_stop`：合作式中止指定 `workerId` 的任务，不释放占位。
- `worker_close`：对指定 `workerId` 完成任务验收 (`accepted`) 或放弃 (`abandoned`) 并确认关闭；只有确认 `child_exit` 且关闭成功后才回收该实例。模型工具不允许 `force` 强杀。

### 主控侧命令

命令只注册一次；显式 `workerId` 优先，恰好一个活跃实例时仍保留无参快捷语义，多实例且未指定时只列出 ID 并提示用法，绝不按“最近创建”猜测目标。

- `/worker-status`：无参数列出所有实例摘要；传 `workerId` 查看单实例明细；无实例显示空状态。
- `/worker-stop [workerId]`：中止指定实例（多实例时必须显式 ID）。
- `/worker-close [workerId]`：关闭指定实例（多实例时必须显式 ID）。
- `/worker-forget [workerId]`：人工强制解除指定实例占位；**保留二次确认**，确认文案明确目标 `workerId`，且**不会自动杀死可能仍存活的子进程**，只销毁该实例的管道/连接/定时器；非交互模式无法确认时拒绝执行。

### 执行侧工具与命令
- `worker_report`：执行模型提交进展、提问、阻碍或完成交付报告。
- `/worker-status`：执行端查看受控连接状态。
- `/worker-detach`：执行端人工脱钩，转为完全独立运行。

### Worker 窗口内的模型切换

Worker 窗口是完整交互 Pi，可用 Pi 原生命令调整模型与思考级别：

- `/model`：选择模型；在该界面按 `Ctrl+S` 可保存为新会话默认模型。
- `/thinking`：选择当前模型支持的思考级别；`Ctrl+S` 保存为启动级别。
- 切换后主控端会自动收到 `model_changed` 上报，`worker_status` 中 provider/model/thinkingLevel 即时刷新，无需重启 Worker。

## 主动通知与等待语义

主代理无需高频 `worker_wait`。以下可操作关键事件写入收件箱后会主动通知：

| 类别 | 事件 |
|---|---|
| 交付/回执 | `report_committed`（交付、提问、阻塞、失败）、`report_missing` |
| 生命周期/连接 | `stopped`、`disconnected`、`unresponsive`、`child_exit`、`launch_failed`、`child_exit_unconfirmed` |
| 协议异常 | `report_rejected`、`inbox_rejected` |

通知机制：

- 调用 `pi.sendMessage` 注入 custom message（`customType: pi-terminal-worker:event`），携带 `workerId/taskId/revision/runId/cursor/eventId` 与**有界摘要**；
- 使用 `{ triggerTurn: true, deliverAs: "followUp" }`：主代理空闲时开启新轮，忙碌时作为 follow-up 排队；
- 普通过程性事件（`activity` / `model_changed` / `report_candidate` / `task_accepted` / `followup_accepted` / `local_input` / 启动成功等）**绝不推送**；
- 主动 `worker_close` 正在等待时的正常退出（`code: 0`、`signal: null`）仅入箱并唤醒显式等待者，关闭结果由工具返回，不额外触发模型轮次；非主动退出、异常退出及关闭超时后的退出仍主动通知；
- 通知失败（包括 `pi.sendMessage` 抛错）不会破坏收件箱写入/ACK 协议，也不阻塞后续处理；始终保留 `worker_wait` 兜底；
- 通知严格绑定当前会话 generation，会话切换后的晚到事件绝不推送到新会话。

典型用法：`worker_start` / `worker_send` 后直接结束当前轮，关键事件到达时会自动唤醒；收到通知后用 `worker_status({ workerId, eventId })` 拉取完整详情并按需处理，不要连续调用 `worker_wait` 轮询。

## 多 Worker 并发

### 并发启动与执行模式

- 七个主控工具均声明 `executionMode: "parallel"`，同一批模型工具调用里的多个 `worker_start` 可真正并行等待握手，先完成的不必等后完成的。
- 若用户在 Pi 全局把 `toolExecution` 配置为 `sequential`，同一批调用会被整体串行化，扩展无法强制并行；此时按多轮调用仍可形成多个 Worker 生命周期重叠。
- 同一 Worker 内的 `send/stop/close` 由本地队列串行化，保证 `runId/revision` 不乱序；不同 Worker 的修改操作互不阻塞。`worker_wait/status` 不占用该队列。

### 文件写入契约（非沙箱）

`allowedPaths` 只是交给 Worker 的任务契约，**不是文件系统沙箱**。多个 Worker 等于多个可并发访问同一 `cwd` 的独立 Pi 进程；并行派发任务时，主代理必须自行划分不冲突的写入范围，并在每个 Worker 完成后逐个复核 diff 与测试结果。

### 资源开销（按实例线性增长）

每个 Worker 各自占用：一个 Pi 进程、一个 bootstrap、一个终端窗口、一个监听命名管道、supervisor/worker 两条连接、两枚 token、一个心跳定时器，以及各自独立的收件箱与报告缓存（各 128 条 / 8 MiB 上限）。总内存和延迟随实例数增长；第一版不硬编码最大 Worker 数，由主代理控制同时运行的数量。

### 异常、关闭与占位诊断

- 终端/OS 启动失败、握手超时、投递结果未知（`DELIVERY_UNKNOWN`）均**逐实例**回报，不会自动重试、不会重派任务、也不清理其他实例。
- `worker_close` 只有确认 `child_exit` 并关闭成功后才回收该实例；关闭超时或未确认退出时保留可查询占位（`lifecycleState=closing` 等），用户可用 `/worker-status <workerId>` 与 `/worker-forget <workerId>` 逐个人工处理。
- 会话切换（`session_start`）会逐实例失效旧连接、取消旧 waiters，仍存活但无法确认退出的实例标记为 `disconnected` 占位并**保留可按 ID 查询**，但**不自动重连**；需逐个 `/worker-status` 确认后用 `/worker-forget` 处理（forget 不杀进程）。
- `session_shutdown` / 扩展 reload / Pi 进程重启会丢弃进程内注册表，**无法恢复对旧 Worker 的监督**；`session_shutdown` 会尽力发送关闭请求并清理主控资源，但不保证所有子进程/窗口退出；reload/重启无法保证清理遗留进程，也不会自动重派。重启后应先人工确认并处理遗留进程与占位（任务管理器/窗口），确认无活跃 Worker 后再 `worker_start`，避免盲目重派导致并发写冲突或重复任务。

### 状态栏

状态栏只展示汇总计数，例如 `Workers 3 | running 2 | review 1 | issue 0`。除工具结束、`turn_end`、`agent_settled` 与 `session_*` 事件触发刷新外，会话活跃期间还会以 1 秒（`WORKER_STATUS_POLL_INTERVAL_MS`）短周期轮询兜底，确保主 Pi 空闲时到达的异步报告/断连也能及时刷新；定时器不阻止进程退出，会话关闭时清理。

## 限制

- 目前仅支持 Windows。
- 单个协调器同时管理多个 Worker；如需单实例限制，由调用方按 `workerId` 自行控制，并在 `/worker-status` 查看当前实例。
- 不自动划分文件写入权限、不自动生成 worktree、不自动合并并发修改。
- 不支持跨 Pi 进程的全局协调；`session_shutdown`/reload/进程重启后无法恢复旧注册表或监督，需先处理遗留进程再重新启动 Worker。

## 许可

[MIT](LICENSE)
