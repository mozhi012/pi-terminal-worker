# pi-terminal-worker：独立终端子代理扩展设计与实施方案

> **历史设计文档（部分已被覆盖）**：本文记录的是最初的单实例设计与实施方案（第 5 条“单个主控会话最多拥有一个执行实例”等限制）。多 Worker 并发支持以 [`docs/multi-worker-concurrency-plan.md`](./multi-worker-concurrency-plan.md) 为准：详见其中的目标/非目标、`MultiWorkerCoordinator` 架构、状态与资源所有权、对外接口及分阶段验收。本文保留为历史背景，不再逐条维护，也不再作为并发行为的依据。

> 状态：待评审，尚未实现或完成端到端验证。
> 基线：本机 Pi `0.87.1` 的文档、类型声明与扩展示例。
> 暂定名称：`pi-terminal-worker`，不覆盖或修改第三方 `pi-subagent` 源码。

## 1. 目标与关键决策

实现一个自用 Pi 扩展：主 Pi 负责理解、设计、派发和验收；执行 Pi 在 Windows Terminal 的独立窗口中工作，可以直接观察和人工接管。

确定的设计：

1. 使用 `wt.exe` 打开独立窗口，执行普通交互式 Pi，不使用 JSON/print/RPC 模式。
2. 执行 Pi 不指定模型、provider 或 thinking，使用新会话的默认配置；不继承主会话临时选择的模型。
3. 主执行两端通过 Windows 命名管道双向通信，不用文件充当邮箱或状态通道。
4. 不创建 `pi-tasks/`、`task.md`、`result.md`、`status.json` 或临时任务脚本。
5. 单个主控会话最多拥有一个执行实例，包含启动中、运行中、待验收和断线未确认退出的实例。此限制不是跨所有独立主 Pi 的机器级锁。
6. 任务上下文由主代理明确提供，不自动复制整段会话历史。
7. 执行结果必须显式上报；Pi 空闲、窗口关闭、进程退出都不等于任务成功。
8. 保留 Pi 自身的会话保存功能。这里的“无文件”指不新增任务通讯文件，不是禁止代码、测试输出和原生会话写盘。
9. 第一版使用明确的发送/等待工具，不自动让两个模型无限互相唤醒。
10. 正常返修复用仍存活的执行会话；不做崩溃后的透明恢复。

### 1.1 第一版非目标

- 多执行代理、递归派发、跨机器通信、跨主控全局调度。
- 自建模型调用层、重写 Pi TUI 或解析终端输出。
- 自动 Git worktree、自动合并和自动提交。
- 任意第三方工具状态的完整继承，尤其是主会话临时激活的 MCP 工具。
- 消息和执行任务的跨进程重启恢复、后台守护服务。
- 恶意同用户进程隔离、文件系统沙箱。
- 运行中强行插入 steering 消息。第一版先实现可靠的跟进排队和显式停止，再考虑 steering。

## 2. 已核对的能力与边界

### 2.1 Pi 官方扩展接口

| 需求 | 已核对接口 | 设计用途 |
|---|---|---|
| 模型调用工具 | `pi.registerTool()` | start/send/wait/status/stop/close/report |
| 用户直接控制 | `pi.registerCommand()` | 状态、停止、关闭、人工接管 |
| 注入任务或回复 | `pi.sendUserMessage()` | 向执行会话提交文本 |
| 自定义会话记录 | `pi.sendMessage()` | 可选的人类可见说明，不用于传输 IPC |
| 忙闲状态 | `ctx.isIdle()`、`ctx.hasPendingMessages()` | 调度前检查 |
| 中止当前运行 | `ctx.abort()` | 合作式停止 |
| 正常退出 | `ctx.shutdown()` | 关闭受控执行进程 |
| 稳定边界 | `agent_settled` | 提交最终回执、安排下一条消息 |
| 活动观察 | `agent_start`、`tool_execution_start/end` | UI 状态，不等同成功 |
| 用户输入来源 | `input` 事件的 `source` | 识别人工介入 |
| 生命周期 | `session_start`、`session_shutdown` | 建连、关闭和释放资源 |
| 原生界面 | `ctx.ui.setStatus/setWidget/notify` | 显示连接、任务和异常 |

特别注意：

- 扩展 factory 只注册接口，不打开服务器、启动进程或创建长生命周期定时器。
- `agent_end` 后仍可能重试、压缩或继续处理排队消息，不能用它判定交付。
- `agent_settled` 是通知边界，不在该 handler 中返回 continuation；后续任务通过独立调度 tick 发起，并重新检查会话有效性和忙闲状态。
- `sendUserMessage()` 返回 `void`。调用成功只说明已经交给 Pi，不代表模型执行完成。
- `waitForIdle()` 是命令上下文专属能力，不能假设 socket 回调或工具上下文可以调用。
- 扩展本身运行在 Pi 进程中；`pi.events` 只是扩展间事件总线，不是跨进程 IPC。

### 2.2 与现有 pi-subagent 的差别

本机第三方扩展使用 `pi --mode json -p --session <file>`，任务先写临时文件，以 `@file` 输入；子进程 stdout 作为 JSONL 事件流，stdin 为 ignore。恢复任务时再次启动进程，不是持续双向会话。

新扩展保留执行 Pi 的终端 stdin/stdout，另建命名管道传业务消息，因此不需要接管终端输入，也不依赖临时任务文件。

### 2.3 本机已有 Windows 风险记录

同目录已有《2026-09-10-pi-subagent-Windows监听EACCES修复备忘录.md》：普通 `C:\\...\\coordinator.sock` 路径不能替代 Windows 命名管道地址。

本方案使用 Node `net` 和运行时形式 `\\.\pipe\pi-terminal-worker-<随机ID>`；不得沿用 Unix socket 临时文件实现。服务器与连接对象都必须安装 error handler，监听失败应成为工具错误，不得击穿主 Pi。

## 3. 总体架构

```text
主 Pi
└─ controller 扩展
   ├─ 工具、单实例状态机、事件收件箱
   ├─ Node net 命名管道服务器
   └─ child_process.spawn(wt.exe, argv, shell=false)
                           │
                           ▼
Windows Terminal 新窗口
└─ bootstrap.mjs（随扩展安装的固定程序）
   ├─ supervisor 连接：启动确认、子进程退出、关闭协调
   └─ spawn(node.exe, [pi-cli.js, ...], stdio=inherit)
       └─ 普通交互式 Pi
           └─ worker 扩展
               ├─ worker 连接：任务、回复、回执、状态
               ├─ Pi 消息注入与生命周期桥接
               └─ worker_report 工具
```

bootstrap 是安装包内固定代码，不是每个任务生成的文件。采用两条认证连接的原因：

- worker 扩展负责 Pi 语义，包括运行、回执和中止。
- bootstrap 负责进程事实，包括 Pi 启动失败和进程退出。
- 不把 `wt.exe` 退出码当作执行 Pi 退出码。
- worker 连接中断时，仍有机会通过 bootstrap 确认 Pi 是否存活。

第一版只支持 Windows + 可解析的 Node.js/Pi CLI 安装。Bun 打包单文件、远程终端等不做隐式兼容，报明确错误。

## 4. Windows 启动与握手

### 4.1 启动前检查

`worker_start` 在持有互斥锁时检查：

1. 当前角色是 controller、当前 Pi 会话仍有效。
2. 没有现存 worker，含连接丢失但退出未确认的 worker。
3. cwd 是存在的绝对目录；根目录由主代理明确指定，不执行不可信字符串拼接。
4. `wt.exe`、Node 可执行文件、Pi CLI JS 入口、扩展入口、bootstrap 文件存在。
5. 主控和执行端使用同一扩展版本与协议主版本。
6. 扩展全局安装或显式 `-e` 加载策略确定，不能指望新窗口继承当前会话的临时工具注册状态。

路径解析优先使用已验证的当前 Node/Pi 入口；无法可靠解析时，要求配置绝对路径。不得默认 `process.execPath` 一定是 Node，也不得把 `.cmd` 当普通 exe 用 `shell:false` 直接执行。

### 4.2 启动步骤

1. 锁定实例名额，生成 `controllerId`、`workerId`、`taskId`、256-bit 随机 bootstrap token。
2. 命名管道监听成功后再启动 WT；监听失败释放未启动名额并返回错误。
3. 调用 `spawn(wtExe, argv, { shell: false })`。目标参数结构为：
   `-w new new-tab --title <标题> -d <cwd> <nodeExe> <bootstrap.mjs> --descriptor <base64url描述符>`。
4. descriptor 只包含协议版本、管道地址、bootstrap token 和实例 ID；不含任务正文、代码、用户凭据。
5. bootstrap 连接并认证，从主控接收实际 cwd、Pi/扩展入口路径和独立 worker token。
6. bootstrap 使用 `stdio: "inherit"` 启动 Node + Pi CLI，设置 `PI_TERMINAL_WORKER_ROLE=worker`、管道地址和连接标识等私有环境变量。
7. 子进程参数不包含 `--model`、`--provider`、`--models`、`--thinking`、`--continue`、`--resume`；不带初始任务文本，不启用 print/json/rpc。
8. worker 的 `session_start` 连接认证，发送 `worker_ready`：实际 cwd、session ID、模型 ID、thinking、工具列表摘要和版本。
9. controller 验证 worker PID 与 bootstrap 报告一致、cwd 一致，然后发送初始任务。
10. `worker_start` 等待任务 accepted 后返回 worker/task ID。握手超时不等于进程没启动，按异常状态保留名额，先确认退出再重试。

Node 直接 spawn 不是 Bash 内联命令；这样不用为每个任务生成 `launch.sh`，也不依赖 Windows Terminal 复用窗口时是否继承了新环境变量。涉及手工 shell 命令仍遵守 Git Bash 书写规则。

WT 的参数边界、中文路径和已有 WT 实例的行为必须通过第一阶段真实验证，验证前不宣称此启动链路已可用。

## 5. 通讯协议 v1

### 5.1 编码和安全

- 使用命名管道上的 UTF-8 JSONL。正文中的换行由 JSON 转义，不以终端输出作为协议来源。
- 使用流式 UTF-8 解码，正确处理中文跨 chunk；处理半包、粘包和 CRLF。
- 一帧最多 1 MiB；任务文本最多 256 KiB；单条 report 最多 64 KiB，按 UTF-8 字节计算。
- 单连接未认证超时 5 秒，启动握手默认 30 秒，普通 ACK 默认 5 秒。
- 256-bit 随机 token，以定时安全比较进行认证；token 永不写日志、工具结果或模型上下文。
- bootstrap token 经命令行短暂传递，不能防御能读取同用户进程命令行的攻击者；这是明确的信任边界，不包装成强隔离。
- worker token 经已认证管道发给 bootstrap，再通过子进程环境变量传递，不放任务或启动工具结果中。
- 只接受预期 bootstrap 和 worker 各一条连接；拒绝重放 hello、错误实例、错误 token 和协议版本。
- 不开放 TCP 端口；命名管道仍不能被宣传为自动拥有理想 ACL 或抵御远程 SMB 的安全沙箱。更强隔离需单独审查 Windows ACL 和系统网络策略。
- 使用严格 schema、字段长度限制、连接数量限制和发送背压。socket write 返回 false 时等待 drain，不无限缓存。

### 5.2 消息信封

```typescript
interface Envelope {
  version: 1;
  controllerId: string;
  workerId: string;
  taskId?: string;
  revision?: number;
  id: string;           // 发送方生成的唯一消息 ID
  replyTo?: string;    // ACK/响应对应请求 ID
  seq: number;         // 当前连接内递增序号
  type: string;
  payload: unknown;    // 按 type 严格校验
}
```

`seq` 在同一连接内必须严格递增：重复或倒退的 `seq` 在严格模式下触发 `PROTOCOL_ERROR`，接收方回送 `error` envelope 并销毁连接；允许跳号（缺口仅作诊断，不代表丢帧语义）。

身份来自握手绑定的连接，不仅相信消息里的 ID。时间戳只用于展示，不用于排序；事件顺序采用主控分配的 cursor。

### 5.3 消息类型

| 方向 | 类型 | 用途 |
|---|---|---|
| 双向 | `hello / hello_ok` | 认证和协议协商 |
| 双向 | `ping / pong` | 活性检测，不触发模型 |
| 双向 | `ack / error` | 接收确认或明确拒绝 |
| controller → bootstrap | `launch / terminate` | 启动、显式强制终止请求 |
| bootstrap → controller | `child_spawned / child_exit / launch_failed` | 进程事实 |
| worker → controller | `worker_ready` | Pi 可接收任务 |
| controller → worker | `task / followup` | 初始任务、补充说明、返修 |
| controller → worker | `abort / close` | 中止当前任务、退出受控 Pi |
| worker → controller | `activity` | 忙闲、工具、等待人工 UI、模型变化等 |
| worker → controller | `report_candidate / report_committed` | 模型提交候选回执及稳定后确认 |
| worker → controller | `stopped / report_missing / local_input` | 特殊状态 |

### 5.4 确认语义

严格区分：

1. `accepted`：通过校验且进入内存队列。
2. `dispatched`：已调用 Pi 注入接口。
3. `agent_start`：Pi 开始运行，不一定能一对一映射到原始消息。
4. `report_committed`：这一 revision 的明确回执已在稳定边界确认。
5. 主代理验收：检查 diff 和测试后，通过 `worker_close(disposition="accepted")` 表达。

ACK 超时后的结果是 `delivery_unknown`，不是“对方没收到”。主控保留请求 ID；同一活连接允许用相同 ID 查询或重发，接收方返回缓存 ACK 而不再次执行。拒绝相同 ID 不同正文。去重记录存活期间不能静默淘汰后重执行；达到上限则拒绝新请求。

不承诺跨进程重启的 exactly-once。连接丢失后不自动重连和重发任务。

Worker 侧任务迁移规则（生产入口固定开启严格协议校验）：初始 `task` 只能在没有当前任务绑定时被接受，已绑定后再来初始 `task` 一律拒绝；`followup` 必须匹配当前 `taskId`，且 `(revision, runId)` 必须相对当前绑定推进（`revision` 更大，或 `revision` 相同且 `runId` 更大）。不匹配时回送带 `IDENTITY_MISMATCH` / `INVALID_STATE` 的失败 ACK，且不得修改当前任务绑定（`currentTaskId` / `currentRevision` / `currentRunId`）。

### 5.5 默认限额

- 心跳：5 秒；连续 20 秒无消息进入 `unresponsive`，仍不释放实例名额。
- 待发 followup 队列：最多 8 条，总计不超过 1 MiB。
- 普通控制请求去重记录：每实例最多 1024 条；满后拒绝新 task/followup，但为 abort/close/terminate 和状态查询保留独立控制通道额度，不能因容量耗尽而无法停止。心跳不进入任务去重表，不自动淘汰旧任务后重跑。
- 活动事件可合并，只保留最近工具与状态，不转发全部 token 和思考内容。
- 关键报告内存缓存：最多 128 条或 8 MiB，达到限额明确拒绝新报告并显示错误，不静默丢交付结果。
- `worker_wait` 单次最多返回约 16 KiB 文本；超出部分保留内存并提供 event ID，通过 `worker_status` 的分页读取参数获取。

## 6. 工具接口

所有会变更状态的主控工具声明顺序执行，并额外使用本地互斥锁；不能只依赖模型不并发调用。锁只覆盖原子状态转换，不跨握手、网络 ACK 或 wait 等待持锁，否则事件回调无法推进状态，会形成死锁。worker_report 同样声明顺序执行，避免和同批其他工具交错提交候选。

### 6.1 主控侧

| 工具 | 参数 | 行为 |
|---|---|---|
| `worker_start` | `cwd, title, task, context?, allowedPaths?, acceptanceCriteria?` | 新建一个实例与任务，握手和 accepted 后返回 |
| `worker_send` | `workerId, taskId, message, kind: supplement/reply/revision` | 发给同一存活会话；默认扩展排队 |
| `worker_wait` | `workerId, afterCursor?, timeoutMs?` | 等待 question/blocked/result/error/stopped/连接变化等重要事件 |
| `worker_status` | `workerId, eventId?, offset?, limit?` | 查询状态、模型、队列和完整报告分段 |
| `worker_stop` | `workerId, reason?` | 清空未派发队列并请求合作式 abort；不关闭窗口 |
| `worker_close` | `workerId, disposition: accepted/abandoned, force?: boolean` | 正常退出或明确的强制终止；确认退出才释放名额 |

约束：

- `worker_start` 不提供 model 参数，避免调度工具绕过默认模型要求。
- `allowedPaths` 是任务契约，不是假冒沙箱；任意 bash 仍可能越界，最终必须审查 diff。
- `worker_send(kind=revision)` 只在任务稳定且待验收时接受，revision 加一；旧 revision 结果不能覆盖新版状态。
- question/blocked 状态可收到 `reply`；failed/idle_unreported 状态可收到明确的恢复或补报说明；已停止可收到新说明继续同一任务，但不能自动恢复被丢弃的旧队列。每次真正派发生成递增 runId，candidate 绑定 taskId/revision/runId，防止同一 revision 多轮交互时旧回执迟到串轮。
- 主控进入 accepted 前必须确认当前 revision 的 committed result 仍有效、Pi 空闲、扩展队列为空，且之后没有 local_input 或新派发；条件不满足时拒绝 accepted。
- 初始任务应包含目标、背景、已确定方案、范围、测试要求、禁止再派发和 report 要求。
- `worker_wait` 默认 30 秒，范围 1～60 秒；超时返回当前状态，不停止执行端。
- wait 的 AbortSignal 只取消这次等待，不中止执行任务。
- wait 先原子检查收件箱并注册 waiter，防止“结果先到、随后永远等不到”。
- cursor 只标识已观察到的事件；重复读取同一 cursor 返回同一报告，不自动消费删除。
- 第一版主控只通过工具结果获得关键内容。UI 可以主动通知，但不自动 `triggerTurn` 唤醒主模型，防止与 wait 返回双重注入。
- force 关闭涉及杀进程树，必须在主 TUI 进行确认；没有可确认 UI 时拒绝，不偷偷降级为强杀。

### 6.2 执行侧

仅新增一个模型工具：

```typescript
worker_report({
  kind: "progress" | "question" | "blocked" | "result" | "failed",
  summary: string,
  changedFiles?: string[],
  validation?: Array<{
    command: string,
    outcome: "passed" | "failed" | "not_run",
    note?: string
  }>,
  unresolved?: string[],
  question?: string
})
```

- taskId/revision 从扩展当前状态附加，不由模型填写，避免串任务。
- progress 可立即发送，不触发主模型自动回复。
- question/blocked/result/failed 是本轮候选终结回执，先记录 candidate，在 `agent_settled` 后再 committed。
- report 工具返回“回执候选已记录，本轮不要继续操作”。工具 execute 不等待本轮 settled，避免等待自身完成造成死锁。
- candidate 之后若继续执行任何工具、出现新的用户输入、收到 stop 或任务异常，则候选失效；不得把旧结果作为已稳定交付。
- Pi settled 但没有有效回执时，自动发送 `report_missing`，状态为 `idle_unreported`。主代理可发消息要求补报，不伪造 result。
- result 可以描述部分完成，但存在失败测试或未解决阻塞时主控不得验收为 accepted。
- 报告属于执行模型自述，验证命令和测试结论仍需主代理核实。

### 6.3 用户命令

主端：`/worker-status`、`/worker-stop`、`/worker-close`、`/worker-forget`。最后一个仅供用户在 disconnected/detached/unknown 状态下人工确认解除占位，不暴露给模型；必须二次确认并说明可能打破单实例保证。

执行端：`/worker-status`、`/worker-detach`。

`/worker-detach` 表示用户接管，断开调度并进入 detached 状态。主控不再有资格把它当作安全退出，保留占位；确认退出或明确的人工解除占位后才能再次派发。解除占位需醒目提示“旧进程可能仍运行”，不伪装成正常完成。

## 7. 状态机与单实例保证

分离三个维度，避免用一个状态字段混淆连接、运行与验收：

### 7.1 实例生命周期

```text
none → launching → connected → closing → closed
                  ↘ disconnected / unresponsive / detached / launch_unknown
```

只有已确认未启动或 bootstrap 明确报告 child_exit，才能自动进入 closed 并释放名额。丢失连接、启动超时、WT 返回成功均不能释放名额。

### 7.2 任务状态

```text
created → queued → running
                    ├─ waiting_reply
                    ├─ blocked
                    ├─ ready_for_review
                    ├─ failed
                    ├─ idle_unreported
                    └─ stopping → stopped

waiting_reply / blocked / stopped → queued → running
ready_for_review → revision + 1 → queued → running
ready_for_review → 主代理验收 → accepted
任何未完成状态 → 明确放弃 → abandoned
```

只有有效 committed result 才可进入 ready_for_review。只有主端可以 accepted。

### 7.3 Pi 活动状态

`idle | busy | waiting_ui | unknown`，独立于任务状态。

UI 等待时心跳仍正常；长时间没有模型输出不构成死亡判据。实际模型变化应更新状态，但不强制改回默认模型，保留用户在执行窗口人工切换的能力。

## 8. 消息排队、停止和人工操作

### 8.1 默认排队策略

不直接把所有 followup 塞入 Pi 内部队列。扩展维护自己的有界队列：

1. 若 Pi 稳定空闲且没有内部 pending 消息，提交一条消息。
2. 若 Pi 正忙，仅发送 accepted，并保持在扩展队列。
3. 收到 `agent_settled` 后，独立 tick 再检查状态并提交下一条。若仍有未派发 followup，旧 result 即使已 committed 也只保留为阶段报告，不进入可验收状态；新一轮派发立即使上一轮候选和 ready_for_review 失效。只有队列清空后的最新稳定 result 才允许验收。
4. 注入时关闭命令/模板扩展：使用 `expandPromptTemplates: false`，避免通信正文变成 slash command。
5. 保留 input 来源信息并标记本扩展注入，避免把自己的消息误判成人工操作。

这样 stop 可以丢弃尚未交给 Pi 的消息，不依赖未公开的清理内部队列 API。`steer` 模式不属于 v1。

### 8.2 停止语义

- `worker_stop` 先建立调度屏障并清空扩展排队内容，再通过 worker 调用 `ctx.abort()`。
- 收到 ACK 仅表示停止请求被接受。
- 等到 Pi settled 且无待处理操作，才回传 stopped。
- 中止不等于回滚文件，也不保证任意第三方扩展启动的后台进程已结束。
- 如用户或其他扩展已有内部排队消息，可能再次启动模型；此时状态重新显示 busy，不声称已稳定停止。
- 需要确认整个执行 Pi 退出时调用 close；强制终止由 bootstrap 对它持有的实际子进程执行，不能凭任意消息里的 PID 调用 taskkill。

### 8.3 人工介入

- worker 的 input 事件识别人类输入，发送 local_input 和状态变更。
- 人工输入使尚未 committed 的结果候选失效，并暂停自动派发已有 followup，防止需求顺序混乱。
- 主端显示“用户正在执行窗口干预”；恢复派发由明确的新 send 或用户命令确认，不自动重放旧队列。
- 人工在执行窗口发起的新一轮工作会使已待验收结果变为过时；主端必须等待新回执再验收。
- 原有安全审批留在执行 Pi 本身，不绕过、不自动批准，也不在第一版复制原扩展的审批代理协议。

## 9. 生命周期与失败处理

| 情况 | 必须行为 |
|---|---|
| 服务器 listen 失败 | 工具报错、幂等清理，不让主 Pi 崩溃 |
| WT 不存在或启动报错 | 如已确认未启动则释放名额，否则保留 unknown |
| worker 扩展没加载 | ready 超时，借助 bootstrap 检查/关闭子进程，不重复开窗 |
| Pi 缺少默认模型凭据 | 状态/窗口明确提示，未生成回执不算完成 |
| 管道断开但进程存活 | disconnected，停止派发，不自动重连重跑 |
| 主 Pi 意外退出 | worker 检测 EOF，停止接收远程任务并尽力 abort，通知用户，保留终端供检查 |
| 执行窗口关闭 | bootstrap 报告退出；若也同时断线且退出无法确认，进入 unknown |
| 扩展 reload、/new、/resume | 旧会话资源停止且等待者结束，不把旧连接挂接到新会话 |
| 主端优雅退出 | 有界发送 abort/close，关闭 socket/定时器，不能无限阻塞退出 |
| worker session 被用户切换 | 断开旧任务绑定，不向新 session 注入旧消息 |
| 模型不调用 report | idle_unreported，由主端明确要求补报 |
| 回执过大 | schema 拒绝并指导摘要化，不能悄悄丢尾部测试信息 |
| 报告已收到但 wait 超时竞争 | 通过原子收件箱与 cursor 消除漏报 |

清理函数需幂等，覆盖工具取消、socket 错误、session_shutdown 和进程退出。每个异步回调检查捕获的 session generation；旧上下文失效后不得再调用 Pi API。

角色环境变量来自受信 bootstrap。执行角色不注册任何 worker_start/send 等派发工具；同时禁用已知第三方 subagent 工具并用 tool_call 防线拒绝调用。此限制仅约束扩展工具，不是 OS 沙箱，bash 启动其他代理仍需规则约束和验收。

## 10. 代码组织与依赖

建议独立项目，不直接在全局安装目录开发：

```text
pi-terminal-worker/
  package.json
  tsconfig.json
  README.md
  src/
    extension.ts             # 角色识别、工具/命令/事件注册
    controller.ts            # 主端状态机、收件箱、单实例互斥
    worker.ts                # 执行端、消息调度、候选回执
    protocol.ts              # 消息 schema、版本、错误码
    transport.ts             # JSONL framing、认证、超时和背压
    launcher.ts              # Windows 路径验证、WT 参数生成
    lifecycle.ts             # generation、关闭、幂等清理
    ui.ts                    # 原生 status/widget/notify
  runtime/
    bootstrap.mjs            # 固定 supervisor 程序，无临时脚本
  test/
    protocol.test.ts
    controller.test.ts
    worker.test.ts
    lifecycle.test.ts
    launch-args.test.ts
    ipc-windows.test.ts
    fake-pi.ts
  docs/
    manual-acceptance.md
```

依赖原则：

- 运行时优先使用 Node 内建 `net`、`crypto`、`child_process`、`path` 等。
- Pi API 与 TypeBox 按本机官方示例导入；Pi 包声明 peerDependencies，不捆绑第二份 Pi。
- 开发依赖可使用 TypeScript、tsx、@types/node；使用 Node test runner，不引入大型测试框架。
- 扩展由 Pi 的 TS 加载器加载；bootstrap 使用普通 `.mjs`，不要求 Node 直接执行 node_modules 中 TS。
- package.json 的 `pi.extensions` 指向唯一入口；开发阶段使用显式 `-e`，确保不会全局发现加显式参数重复注册。
- 初期锁定并验证 Pi 0.87.1；升级后重新核对接口，不能直接承诺所有 Pi 版本兼容。

## 11. 分阶段实施与交付门槛

### P0：最小能力验证，先解决不确定性

范围：不修改全局规则、不替换现有扩展、不执行真实代码修改任务。

验证：

1. 主端与第二个 Pi 通过命名管道认证并交换 ping。
2. Node → WT → bootstrap → 普通 Pi 的启动链路正常。
3. 两端在有空格、中文、括号、`&`、`;` 的目录中仍正确启动，不被解释成新命令。
4. 命令行和日志不含任务正文；worker token 不出现在 WT 参数里。
5. worker 的 `sendUserMessage` 能提交一个“只回复 hello”的任务，保留正常 TUI。
6. `agent_settled`、report candidate、UI 输入来源和 stop 的真实语义与方案相符。
7. 关闭窗口、执行 `/reload`、主 Pi 退出时能观察到预期断连/退出事件。

门槛：记录实际 Pi/Node/WT 版本和真实结果。任一关键 API 与假设不符，先修改设计，不进入完整实现。

### P1：可靠协议和状态机

实现 schema、framing、认证、ACK/去重、背压、限额、心跳、互斥锁、cursor 收件箱和 fake Pi。

门槛：协议、状态机和故障注入自动化测试全部通过，不依赖模型。

### P2：主执行两端工具与回执闭环

实现全部工具、执行角色限制、followup 队列、revision、candidate/committed、停止屏障和原生 UI。

门槛：实际完成 task → question → reply → result → revision → result → accepted → close；同一执行窗口返修，无任务文件。

### P3：Windows 生命周期和异常加固

实现 supervisor 退出确认、launch_unknown、合作停止、明确强杀确认、人工介入、session generation 和 reload 清理。

门槛：异常不会自动重复任务，不会错误释放单实例名额，不会把连接断开显示成成功。

### P4：安装、迁移与验收

1. 安装本地开发包到个人 Pi 配置，重启主会话。
2. 禁用旧 `pi-subagent` 的扩展加载或移除对应包，操作前由用户确认。
3. 将全局 AGENTS 的“文件派发方案”替换成 worker 工具约定；默认模型和单实例要求不变。
4. 检查项目内 AGENTS 是否还含旧调度规则。本仓库 `工具/pi/AGENTS.md` 存有旧 subagent 规则，不能只改全局文件而忽略项目覆盖。
5. 真实项目做一次范围有限、可验证的改动任务，主代理独立检查 diff 和测试。
6. 保存测试记录与回滚步骤，但不启用运行时任务文件通讯。

旧扩展不必立刻卸载；试用时通过选择性禁用避免双调度。不得为隔离旧扩展而全局 `--no-extensions`，导致 MCP 或其他必要扩展一起丢失。

## 12. 自动化与人工验收清单

### 12.1 协议测试

- JSON 分片、多帧粘包、UTF-8 中文切分、无换行 EOF。
- 错 token、旧版本、重复认证、多余连接、错误角色和任务 ID。
- 同 ID 同正文返回缓存 ACK；同 ID 不同正文拒绝；去重容量耗尽拒绝新任务。
- ACK 丢失时保持 unknown 而非自动新建任务。
- 超大帧、异常 JSON、缓慢发送和 write 背压。

### 12.2 调度与生命周期测试

- 两个同时 start，只能有一个成功占位。
- 超时/断线/待验收时第二个 start 仍被拒绝。
- 成功 report 先到后 wait，仍可获取；重复 wait 不丢事件。
- report 后继续工具调用，不能生成过早 committed。
- agent_end 后自动继续，不得误判完成。
- revision 升级后迟到旧回执不会覆盖状态。
- stop 清空扩展队列，取消 wait 不停止 worker。
- 人工输入暂停队列，使旧 candidate 或待验收结果过时。
- reload/session switch 后异步回调不能向新会话注入内容。
- Pi 退出由 supervisor 确认，而不是 wt.exe 退出。
- session_shutdown 重复调用不会重复 resolve/reject、泄露 socket 或 timer。

### 12.3 真实 Windows 验收

- 原来已有 WT 窗口与完全未运行 WT 两种场景。
- 主 Pi 的当前模型不同于默认模型，执行端确实选择默认配置。
- 主 Pi 和执行 Pi 均保留完整 TUI，人工可以输入、停止、查看历史。
- question 经 wait 到达主模型，reply 到达执行模型，整个过程无任务文件。
- 执行端缺少某个 MCP 工具时明确报告，而不是假装继承成功。
- 主 Pi 关闭、worker 窗口关闭、断线、模型报错、等待 UI 的故障场景。
- 一次小型代码改动加测试，由主代理核验实际 diff。
- 检查项目目录与临时目录：不生成任务/结果/状态通讯文件；原生 Pi 会话和测试正常产物不算违规。

建议脚本：`npm run typecheck`、`npm test`、`npm run test:windows`。这些命令在实现项目中创建后才能执行；当前文档不声称测试已运行。

## 13. 完成定义与回滚

### 完成定义

以下条件必须同时成立：

- 安装扩展后，仅凭 worker 工具即可完成派发、询问、回复、返修、验收与关闭。
- 不依赖任务文件、模拟键盘输入、剪贴板或终端屏幕抓取。
- 默认模型、独立可交互窗口、单实例限制均有真实测试证据。
- 明确区分通信成功、模型交付、进程退出和主代理验收。
- 断线与失败不会被吞掉或造成重复执行。
- 全局和相关项目规则迁移一致，旧扩展不会抢占派发职责。

### 回滚

1. 停止或人工确认所有执行 Pi 已结束。
2. 禁用新扩展并重启主 Pi，避免旧 socket/callback 留在内存中。
3. 按用户选择恢复旧扩展及其规则，或恢复人工派发；不自动切换。
4. 新方案不生成任务目录，无需清理运行时任务文件；保留原生会话供检查。

## 14. 实施顺序建议

先做 P0，尤其是“普通 TUI 中通过扩展注入任务”和“WT 子进程退出确认”两个实验。它们决定主架构是否成立。

确认后按 P1 → P2 → P3 → P4 实施。单实例要求下，不值得先做复杂服务端、自动恢复或多代理协议。第一版应保持：一个主控、一个执行窗口、一个在内存中维护的任务、明确的发送/等待与验收。

## 15. 本地核对来源

以下文件已用于方案核对，均位于本机安装目录或当前笔记目录，不依赖网络搜索结论：

- `C:/Users/mozhi012/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- 同目录文档：`tui.md`、`packages.md`、`cli.md`、`models.md`、`cli-integration.md`。
- Pi 包内 `dist/core/extensions/types.d.ts`：消息 API、context、agent_settled、工具执行模式。
- Pi 包内 `dist/core/session-manager.d.ts`：session ID 等只读访问接口。
- Pi 包内 `examples/extensions/send-user-message.ts`、`examples/extensions/hello.ts`。
- `C:/Users/mozhi012/.pi/agent/npm/node_modules/@nilskluewer/pi-subagent/README.md`。
- 同包 `extensions/subagent/subagent-tool.ts`：约 664 行参数构造、1071 行 spawn、1141 行 stdout 解析。
- 当前目录《2026-09-10-pi-subagent-Windows监听EACCES修复备忘录.md》。

这些来源确认了基础接口和已有实现事实；本方案的协议、bootstrap、状态机与工具名称是新设计，必须通过上述阶段验证，不代表现成功能。
