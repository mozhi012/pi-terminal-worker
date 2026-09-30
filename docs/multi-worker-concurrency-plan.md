# 多 Worker 并发支持实施方案（仅设计，未实施）

> 状态：待评审。本文不授权实施；未修改任何运行代码。
> 适用范围：当前 `pi-terminal-worker` 的 controller 角色。一个主 Pi 可按需调用多次 `worker_start`，同时监督多个独立窗口中的 Worker；Worker 本身仍不得派生 Worker。

## 1. 目标、边界与决策

### 目标

1. 主代理通过调用 `worker_start` 决定启动多少个 Worker；无扩展内固定的“只能有一个”限制。启动中的 Worker 也占用一个独立实例记录。
2. 不同 Worker 的任务、连接、token、报告、游标、心跳、关闭、异常诊断互不串线；同一 Worker 内维持现有状态机与验收规则。
3. 同一批模型工具调用里的多个 `worker_start` 可以真正并行等待握手，先完成的不必等后完成的启动结束；后续 `send/wait/status/stop/close` 按 `workerId` 精确定位。
4. 一个 Worker 退出、超时或断线，不阻止其他 Worker 的正常工作；除已确认退出外，不自动删除占位或重复派发任务。
5. 原有单 Worker 使用方式保持可用，现有协议版本与 Worker/Bootstrap 端原则上不变。

### 暂不做

- 不允许 Worker 嵌套派发，不增加跨主 Pi 进程的全局协调或进程重启后的自动恢复。
- 不自动划分文件写入权限、不自动生成 worktree、不自动合并并发修改，也不因 `allowedPaths` 文本声明而宣称文件系统隔离。主代理必须给并行任务划定不冲突的写入范围并负责验收。
- 不将 `worker_wait` 变成自动唤醒主代理的后台调度器；仍由主代理选择等待对象和时间。
- 不在第一版引入批量启动、群发消息、群关、任意 Worker 数量上限配置。操作系统资源耗尽应清楚报错且不能污染其他 Worker。

### 关键架构决策：每 Worker 一个现有 ControllerManager，外层增加注册表

当前 `ControllerManager`（`src/controller.ts`）不只是调度入口，也承载单实例的 pipe server、两条连接、两个 token、报告缓存、游标收件箱、心跳及清理器。**不把这些字段逐个改成全局 Map，也不将所有 Worker 强制复用一条 pipe。** 推荐保留它作为单 Worker 的会话控制器，新增一个主控协调器（下文记 `MultiWorkerCoordinator`）：

```text
主 Pi 扩展入口（仅注册一次工具、命令及 session 事件）
└── MultiWorkerCoordinator
    ├── Map<workerId, WorkerEntry>（先登记，后开始异步启动）
    │   ├── workerId / taskId / controllerId
    │   └── ControllerManager（现有单实例控制器）
    │       ├── SingleWorkerManager（只对本实例互斥）
    │       ├── 独立 pipe server / supervisorConn / workerConn / tokens
    │       ├── 独立 inbox / reports / heartbeat / cleanup
    │       └── 独立 generation / start / close in-flight
    └── 一次性注册工具、命令与状态栏摘要
```

选择理由：`getPipePath(controllerId)` 已为每次启动生成不同地址，Bootstrap descriptor 和 Worker 环境变量已经接收 pipe 地址及身份 ID；协议信封已有 `controllerId/workerId/taskId`。各实例保留自己的管道，无需在同一 server 上实现复杂的跨连接复用与认证路由。这样对现有约 2400 行 controller 的改动更集中，也能继续复用单实例的防护测试。代价是每 Worker 一个监听管道、心跳定时器与缓存；并发数由主代理决定，相关资源使用按实例线性增长，需在文档中说明。

**设计约束**：`SingleWorkerManager` 名称与行为保留，但只作为单个 `WorkerEntry` 的内核；不能把一个 `ControllerManager` 继续当作整个主 Pi 的唯一控制器。`MultiWorkerCoordinator` 必须从 `workerId` 查找实例并拥有其生命周期，不允许通过“最近启动的 Worker”隐式路由。

## 2. 当前基线与迁移位置

| 现有位置 | 现状 | 改动方向 |
| --- | --- | --- |
| `src/controller.ts` | `ControllerManager` 包含单 Worker 所有资源，`worker_start` 会清空当前实例状态 | 保留为每 Worker 独立对象；抽离工具/命令注册到协调器，确保只注册一次 |
| `src/lifecycle.ts` | `SingleWorkerManager.currentInstance` 与互斥锁 | 每个 `ControllerManager` 一个；仅必要时增加枚举/诊断接口，不强行改成全局多实例管理器 |
| `src/transport.ts` / `src/launcher.ts` / `runtime/bootstrap.mjs` / `src/worker.ts` | 握手中已有实例 ID，管道路径随 controllerId 变化 | 默认不改协议；需要时仅补最小兼容修复和对应测试 |
| `src/extension.ts` | controller 角色仅实例化一个 `ControllerManager` | 改为实例化一个协调器；会话事件委托其广播给所有被托管实例 |
| `src/ui.ts` | 只展示一个实例 | 汇总活跃/待审/异常数量；明细通过命令查询 |
| `test/*.test.ts` | 大量单实例测试直接构造 `ControllerManager`、测试从 `dist` 导入 | 原测试不删除；新增协调器级并发、隔离与故障测试 |

现有 `ControllerManager.registerToolsAndCommands()` 捕获 `this`；不能对 N 个实例调用它，否则会重复注册同名工具。协调器统一负责公开入口，单实例控制器保留 `handleWorker*` 实现供路由调用。其内部私有测试夹具可以先维持原接口，迁移完成后再清理重复注册代码。

## 3. 身份、登记、启动和并发

### 登记时机与路由

- `worker_start` 在协调器内先做参数验证/准备 ID，产生不可复用的 `workerId`、`taskId` 和 `controllerId`，**同步**把 `WorkerEntry` 插入 Map，然后调用单实例 `handleWorkerStart`。不得等窗口启动成功才登记，否则同批并发调用之间会出现无法查询、无法清理的空窗。
- 将预生成的 ID 传入底层现有测试注入入口（或收敛为显式受控的内部启动选项）。生产路径禁止由 LLM 提供或覆盖身份 ID/token；实例 ID 用安全随机来源生成，碰撞时重新生成；不得复用已确认关闭实例的旧 ID。
- `workerId` 是公开查询键；`taskId` 仍由 `worker_send` 校验。向不存在/已移除实例发送工具调用返回 `NOT_FOUND`，绝不自动选取另一实例。
- Map 登记与删除不跨任何 `await`，以免多个 `start` 或同一个 Worker 的 `close` 和重试交错。异步完成回调再次核对 `entry` 引用及 generation，不能删掉新实例。
- 并行启动时每个底层控制器独立执行 `startServer`、等待 supervisor、等待 worker_ready、投递初始任务；一个启动失败不关闭另一条 pipe，也不清空另一实例报告。

### 工具执行模式

- 当前六个主控工具都声明 `executionMode: "sequential"`。Pi 的工具执行类型支持 `"sequential" | "parallel"`，且同一批调用**只要有一个 sequential 工具就会按顺序执行整批**。因此 `worker_start` 与不依赖跨 Worker 全局顺序的其余主控工具应使用 `"parallel"`，否则模型同批启动依旧被串行化。
- 不能把 `parallel` 当作并发安全保障；同一个 Worker 上的 `send/stop/close` 仍需该 Worker 的本地串行化/状态检查。特别是两个相同 workerId 的 `send` 不得先更新 revision/runId 后乱序投递、或在一个 `close` 进入 `closing` 后再接纳 `send`。设计 per-worker 小型异步操作队列或在关键入口加本地 in-flight 锁；等待握手、socket ACK、`worker_wait` 不持全局锁。
- `worker_wait` 不应占住该 Worker 的修改队列，等待事件期间 `send/stop/close` 必须能执行；连接事件回调可推进状态并唤醒等待者。`worker_status` 为只读快照，不阻塞其他实例。
- 若主 Pi 的全局 `toolExecution` 模式被用户配置为 sequential，扩展无法强制并行，应在文档中说明，按多轮调用仍可形成生命周期重叠的多个 Worker。

### 启动失败判定

| 情况 | 本实例记录 | 其他实例 |
| --- | --- | --- |
| 参数验证失败，未创建任何进程 | 不登记或立即删除 | 不变 |
| 已确认 `launch_failed/child_exit` | 先保留错误诊断供本次调用返回，确认本实例已释放并清理后从 Map 删除 | 不变 |
| 握手超时/投递未知/启动事实未知 | 保留占位，可按 ID 查状态；**不自动重试或删除** | 不变 |
| 会话切换期间启动回调晚到 | 按 generation 拒绝旧结果，保留异常占位以待人工确认 | 不变 |

底层当前启动错误分支可能已释放 `SingleWorkerManager` 名额；协调器应依据**明确退出确认**决定是否清理 Map 与 pipe，不能仅因为 `handleWorkerStart` throw 就删除。测试必须覆盖不同 Worker 同时成功/失败的组合。

## 4. 状态与资源所有权

### WorkerEntry 与单实例内核

建议 `WorkerEntry` 至少包含 `workerId`, `taskId`, `controllerId`, `controller: ControllerManager`, `createdAt`。实例元数据由 `controller.workerManager.getInstance()` 提供，避免维护两份可变的 taskState/revision。可另存协调器级操作队列/标志（仅用于本实例的并发保护），**不可**把任一实例的连接、报告、关闭状态提到全局单份字段。

- `worker_status(workerId)`、`worker_wait(workerId, afterCursor)` 的游标和事件详情都只属于指定 entry。同一个 cursor 在两个 Worker 上可以重复（各自从 0 开始），只能与对应 workerId 一起解释。
- 当前单实例收件箱上限（128 条/8 MiB）与报告缓存上限（128 条/8 MiB）按 Worker 独立计算；总内存约随实例数增长，文档标明资源约束，不暗中复用一个全局列表。
- 同一实例的 `currentCommittedReport`、`currentCandidateReport` 与 `revision/runId` 一起推进；一个 Worker 的 `local_input` 或返修绝不能作废另一个 Worker 的可验收回执。
- token、nonce、每连接 seq、心跳、`closeInFlight` 与异常诊断均保留在对应底层控制器内；close/dispose 不得误清理其他底层控制器的资源。

### 关闭、停止、人工解除占位

- `worker_stop(workerId)` 只给目标 Worker 的连接发送 abort；不释放占位。
- `worker_close(workerId)` 只关闭目标 Worker；保持现有 accepted 验收规则（稳定 idle、有效 committed result、无未解决项和失败测试）。**仅收到确认 `child_exit` 并且该实例 close 成功后**，协调器才从 Map 删除并清理本实例 server/连接/计时器。
- `worker_close` 的同实例并发同 disposition 复用 in-flight promise；不同 disposition 拒绝。不同 workerId 可以同时 close。
- 异常关闭超时/断线但进程退出未确认时，该 Worker 继续占位、可查状态。`worker-forget` 只支持用户按指定 workerId 二次确认解除该实例；它不杀进程，须销毁其旧管道/连接并标明潜在孤儿进程。**不提供模型可调用的 force/forget**。
- 不在单 Worker 确认关闭后抹除其他 Worker 的事件或报告。

### 会话切换、卸载与重载

- `session_start` 由协调器调用所有 entry 的 `handleSessionStart()`：遵循原语义，旧连接失效、旧 waiters 被取消，仍存活但无法确认退出的实例标记 disconnected 并保留占位。禁止因其中一个失败就跳过其余实例的清理，逐个收集错误并汇报。
- 现有单实例实现**不支持自动重连并恢复主控监督**；本文也不引入恢复协议。因此切会话后活着的 Worker 可能成为不可继续监督的占位，用户须逐个确认关闭或 forget。不得在 UI 中把 disconnected 显示成已释放。
- `session_shutdown`/`dispose` 对所有实例尽力发 close 并销毁资源，按实例幂等；即便某一个 ACK 超时，其他实例也必须被清理。若扩展被 reload 替换进程内状态，不能保证重建旧 Map；在文档和操作说明中显式提醒用户先处理活跃 Worker。
- generation 是单实例控制器已有的会话防线；协调器自身也维护 epoch，避免会话切换后旧的 start/close promise 写入或删除新 epoch 的注册表。

## 5. 对外接口与交互规则

### 模型工具

- 保留 `worker_start` 入参和 `{ workerId, taskId, revision, ... }` 出参；每次调用创建一个独立窗口，不增加 `count` 参数，数量由主代理选择调用次数。
- 保留 `worker_send`, `worker_wait`, `worker_status`, `worker_stop`, `worker_close` 的 `workerId` 必填语义；所有操作在协调器中按 ID 查找，然后委托给对应单实例控制器。对 `eventId` 的详情读取必须先定位该 `workerId`，防止跨实例越权读取。
- 新增轻量 `worker_list`（无参数）：返回活跃和未确认退出的 Worker ID、任务 ID、标题、cwd、生命周期/任务/活动状态、创建时间、模型摘要；结果限制长度与条数，避免多实例状态一次塞满上下文。**列表不直接替代 `worker_status`**；需要错误、报告及事件详情时按 ID 查。
- 工具结果包括目标 `workerId`；不改变 `worker_report` 的 Worker 侧语义，也不开放 Worker 侧 `worker_start`。

### 用户命令与状态栏

- `/worker-status` 无参数列出所有当前实例摘要；有 `workerId` 显示单实例明细。0 个实例显示清晰的空状态。
- `/worker-stop <workerId>`、`/worker-close <workerId>`、`/worker-forget <workerId>` 明确要求 ID；只有恰好 1 个可选实例时可以沿用无参快捷操作。多于 1 个且未指定时只列 ID 并提示用法，不按最近创建的实例猜测目标。
- `/worker-forget` 继续保留人工二次确认，提示不会自动杀死进程及目标 ID。
- 状态栏只展示汇总计数（例如 `Workers 3 | running 2 | review 1 | issue 0`），非详情；每个状态变化应刷新，或者明确定义仅命令与会话事件刷新（避免只在 `session_start` 更新一次导致旧状态）。UI 在非交互模式下保持可用，不依赖 TUI。
- README/现有设计文档更新“单实例”说明并注明该方案替换哪些历史限制，不必大规模重写旧设计原文。

## 6. 分阶段实施与验收门槛

**执行原则**：先由主代理确认本方案；确认后一次只派发一个执行 Worker，阶段完成后主代理审 diff、复跑测试、决定是否进入下一阶段。Worker 只实施已批准阶段；模型/供应商/思考强度使用扩展默认值。当前文档阶段不派发任何实现任务。

### 阶段 A：协调器注册表与路由骨架（保持启动顺序）

- 新增 `src/multi-worker.ts`（实际命名实施时统一）：注册一次工具，封装 `Map<workerId, WorkerEntry>`；不重写 `SingleWorkerManager`。使入口使用协调器，并为每个 start 创建底层单实例控制器。
- 初期可暂保留 sequential 执行模式，先验收两个**先后**启动但同时存活的 Worker 的 start/status/send/wait 隔离；不做命令/UI 行为变化。
- 增加协调器级测试；原有所有单实例测试保持通过。
- 门槛：启动第二个 Worker 不会触发第一个实例的 `resetSessionScopedState()`/`startServer()`；两个 pipe 路径和 token 独立。

### 阶段 B：真正并发启动及同实例竞态控制

- 将独立 Worker 操作的工具声明改为 `parallel`，保证 Map 预登记和失败回收具备并发安全性；对同一 Worker 的 mutating 操作建立本地同步点。
- 测试人为延迟 A 握手时 B 仍可完成；同批同时 `start` 两个得到不同 ID、独立 pipe；A 失败/超时/ACK 未知不伤 B；重复发送/关闭同 Worker 的冲突行为明确。
- 门槛：没有串线的握手、重复派发、跨实例清理或未确认退出误释放。

### 阶段 C：命令、列表、UI、会话切换和清理

- 加 `worker_list`、用户命令参数解析及多实例状态栏；协调器统一调用每个 entry 的 `handleSessionStart`/`dispose`，确保一个失败不影响其它实例。
- 测试同时 stop/close 两个 Worker、忘记一个保留另一个、session_start 中止所有 waiters、dispose 多实例幂等、在途回调不能修改新会话。
- 门槛：多 Worker 时无歧义的用户操作；所有残存占位均可按 ID 诊断和人工处理。

### 阶段 D：故障注入、真实终端验证、文档

- 扩展 `test/connection.test.ts`、`test/generation.test.ts` 和新协调器测试，覆盖认证错 token/错 workerId、不同 Worker 报告交错、心跳超时、断线、退出确认、投递未知以及缓存上限。
- `npm run build`、`npm run typecheck`、`npm test` 全过；Windows 实机启动两个窗口（其中一个晚到 `worker_ready`）、分别交付并单独关闭；真实验证无法运行时明确列为未验证，不能当作通过。
- 更新 README 的工具说明、数量与资源约束、并发文件写入风险、异常处理；必要时标注历史设计文档已被本文的新决策覆盖。
- 门槛：同时多实例端到端可复现，单实例用例无回归，用户文档与实际命令一致。

## 7. 必测不变量与测试矩阵

| 场景 | 不变量 |
| --- | --- |
| A、B 同时 start，A 慢/B 快 | B 可先 ready；两次 start 各自收到自己任务的 ACK |
| A 认证时使用 B 的 token/workerId | A 拒绝且不覆盖 B 的 supervisor/worker 连接 |
| A 和 B 同时报告 | 报告、revision/runId、inbox/eventId 查询不交叉；A 人工输入不抹 B 的交付 |
| 同时 `wait(A)`、`wait(B)` | A 事件只唤醒 A；各 cursor 独立；一个 waiter 超时不取消另一 waiter |
| A report accepted 后 B launch_failed | A 仍可验收；B 已确认退出可清理；不会误关 A |
| A close 超时而 B 可正常退出 | A 保留异常占位；B 可独立释放；A 的后续 child_exit 不影响 B |
| A 启动投递结果未知 | 不自动重新派发 A；B 的新启动仍允许 |
| A、B 同时 `send`/`close` | 不互相阻塞；同 worker 冲突遵循本地状态门槛，不乱序递增 runId |
| 会话切换、dispose、手动 forget | 每个 Worker 都有可诊断结局；无跨 worker 的 stale callback 或泄漏计时器 |
| 多 Worker CLI 无参 stop/close/forget | 不会猜目标；提示 ID；一个 Worker 时保留便捷行为 |

现有连接/代际/限制测试会直读底层私有字段；这些测试仍可用于每 Worker 控制器内核。新测试应针对协调器公开 API 与双实例真实/假 socket 事件进行验证，不仅断言 Map 长度。

## 8. 风险、成本与验收方式

- **核心风险**：同实例的 `send/close` 在 Pi `parallel` 模式下交错、启动失败误释放、session 切换后旧回调错误地删掉新 Map、多个实例同目录并行写文件产生合并冲突。
- **安全边界**：多个窗口等于多个独立 Pi 进程，可能并发访问相同 cwd。`allowedPaths` 是对 Worker 的任务契约，不是沙箱；主代理应划分文件范围，完成后逐个审查 diff 和测试。
- **资源成本**：每实例一个 Pi 进程、bootstrap、窗口、监听 pipe、两连接、心跳与缓存；延迟、费用及内存随数量增长。第一版不硬编码最大 Worker 数，OS/终端启动失败明确逐实例回报，主代理负责控制数量。
- **实施量级**：协调器+路由+UI/命令+测试是中等工作量；相较对 `ControllerManager` 逐字段 Map 化风险更低。实际工时须以 A 阶段测试结果校准，不以预估替代验收。
- **人工验收顺序**：每阶段看实际 diff -> 跑本阶段测试 -> 跑全量构建/测试 -> 复核本节不变量 -> 确认下一阶段。任何阶段不能用“能启动两个窗口”代替报告/关闭/异常路径验收。
