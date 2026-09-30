# 多 Worker 并发：自动化覆盖与真实验收清单

> 范围：`docs/multi-worker-concurrency-plan.md` 阶段 D 自动化故障注入及真实双窗口验收。
> 状态：自动化测试通过；**2026-09-30 真实双窗口核心 E2E 通过**（慢握手、独立报告、消息路由、独立退出，证据见第 5 节）。终端回退/资源耗尽/异常关闭的扩展实机测试及 TUI 视觉检查不在本次通过范围内。

## 1. 自动化覆盖命令

在 `E:/web/pi-terminal-worker` 下依次执行（测试从 `dist/` 导入，必须先 build）：

```bash
npm run typecheck                 # tsc --noEmit
npm run build                     # tsc -> dist/
node --test test/multi-worker.test.ts   # 协调器级定向测试（含双实例故障注入）
node --test test/**/*.test.ts     # 全量测试，必须自然退出
```

判定标准：全部命令 exit 0、测试进程不超时/不挂起、`fail 0`。

本轮基线（工作区未提交的 A/B/C 改动之上）：

- `npm run typecheck`：通过。
- `npm run build`：通过。
- `node --test test/multi-worker.test.ts`：59 passed / 0 failed，退出码 0，自然退出。
- `node --test test/**/*.test.ts`：235 passed / 0 failed（含原有连接/代际/限额内核测试），退出码 0，自然退出。

> 全量用例数会随测试增删变化；以本地实际输出为准，不要照抄历史数字。

## 2. 自动化测试矩阵（test/multi-worker.test.ts）

双实例测试复用真实 `ControllerManager` + `FakeSocket`，通过公开协调器入口（`handleWorker*` / 已注册工具 / 命令）与真实 socket 帧驱动；缓存边界仅在构造满额时用内核注入，断言均落在可观察行为而非仅 Map 条数。

| 场景 | 覆盖用例 | 关键不变量 |
| --- | --- | --- |
| 跨实例认证 | `认证隔离：用另一实例的 token/workerId 认证被拒…` | A 出示 B 的 token+workerId → `AUTH_FAILED`；A 出示 A 的 token+B 的 workerId → `IDENTITY_MISMATCH`；反向同理；两侧 `workerConn` 不被覆盖；已认证连接收到携带他实例身份的帧被忽略并计数，不销毁连接、不改状态 |
| 报告交错 | `报告交错：A 的 local_input/返修不抹 B 的 committed 回执…` | A/B candidate/committed 交错互不串线；A 的 `local_input`、`revision` 只作废 A 自己的回执；B 的 committed/`ready_for_review` 保留，B 仍可 `accepted` 验收 |
| wait 隔离 | `wait 隔离：一方超时/取消不影响另一方…` | B 的事件只唤醒 B 的 waiter；A 短超时返回 `wait_timeout`；取消 A 不取消/不泄漏 B 的 waiter，B 仍可被后续事件唤醒 |
| 心跳/断连 | `心跳/断连隔离：A 失联不污染 B…` | A 心跳超时进入 `unresponsive`、双连接断开降级 `disconnected`，B 保持 `connected` 且连接对象不变，B 仍可收报告/等待事件 |
| 关闭/退出 | `关闭隔离：A 关闭超时保留占位，B 独立确认 child_exit 关闭…` | A 关闭超时保留 `closing` 占位；B 独立 `child_exit` 后成功回收；A 迟到 `child_exit` 不会被自动删除、不影响 B |
| 投递未知 | `启动故障隔离：A 初始 task ACK 超时 DELIVERY_UNKNOWN 不重派…` | A 初始 task 只发一次、登记 `unknownDeliveries`、保留占位并保持 `connected`；B 仍可启动并完成发送 |
| 收件箱限额 | `收件箱条数上限隔离…` + `收件箱字节上限隔离…` | A 收件箱按 128 条（关键事件临界）与 8 MiB 字节（`jsonByteLength` 校准的真实 payload 经 `appendInbox` 填满）分别触发 `INBOX_FULL` 且不入箱；B 的条数/字节配额与状态均不受影响；`eventId` 详情严格按 workerId 隔离 |
| 报告缓存限额 | `报告缓存条数/字节上限隔离…` | A 缓存条数填满 128，以及在清空后用 `cacheReport` 真实填充 8 条各 1 MiB（字节恰好 8 MiB）；两种情况其新回执均被 `REPORT_CACHE_FULL` 拒绝且不推进任务状态、不写缓存；B 缓存/验收不受影响 |

阶段 A/B/C 既有协调器测试（登记/路由、并发启动、同实例串行、列表/命令/会话清理/状态栏轮询、队列 guard 与生命周期串行）全部保留并继续通过。

## 3. 未覆盖 / 未验证

- 原自动化交付时真实双窗口尚未验证；用户授权增加双窗口只读测试例外并重启 Pi 后，已通过第 5 节记录的实机核心 E2E。
- 内核级连接认证、session generation、收件箱/报告缓存精确边界仍由 `test/connection.test.ts`、`test/generation.test.ts`、`test/limits.test.ts` 覆盖；本轮未为双实例再复制一套同层测试（协调器级已通过真实 socket 帧验证跨实例隔离）。
- 本次未做实机故障注入：OS 层句柄耗尽、WT/PowerShell/CMD 多窗口回退、关闭超时/迟到退出。相应隔离行为由自动化测试覆盖，不将其宣称为实机通过。未进行 TUI 状态栏、窗口标题或 WT Help 弹窗的视觉检查。
- 进程独立性已通过 Windows 进程查询验证：不同 Worker PID/不同 bootstrap 父 PID；关闭 A 不影响 B，最终四个 PID 均消失。

## 4. 真实 Windows 双窗口验收清单（可复用；本次结果见第 5 节）

前置：确认 `pi list` 指向最新安装目录。本次加载 `E:/web/ptw-installed`，其 src/dist/runtime 与开发目录 `E:/web/pi-terminal-worker` 完全一致。

1. **同时启动两个 Worker，其中一个晚完成握手（`worker_ready`）**
   - 同一批工具调用或连续两次 `worker_start`，分别记录返回的 `workerId`/`taskId`。
   - 说明：`worker_ready` 发生在初始任务投递**之前**，因此“任务本身很慢”并不能推迟 `worker_ready`；要验证晚握手，需在**启动/认证/session 准备**阶段人为延迟（例如临时本地测试钩子：延迟接受 supervisor/worker 连接、延迟 `hello_ok`/`session_start` 就绪，或延迟窗口拉起）。该钩子仅用于本地验收，**验后必须移除**；本次用 A 连接前延迟 15 秒验证，安装文件已还原。
   - 验证 B 先完成握手并收到自己任务的 ACK，A 不被 B 抢先而误判。
   - 确认两个窗口分别新开、无 WT Help 弹窗；两个 `workerId`/`taskId`/窗口标题必须不同。`cwd` 可以相同；若相同，必须为两个 Worker 划分互不冲突的写入范围（见 README「文件写入契约（非沙箱）」）。
2. **分别交付报告**
   - 两个 Worker 各自 `worker_report` 提交正式 `result`（无未解决问题、无失败测试）。
   - 用 `worker_status({ workerId })` 分别确认 `ready_for_review`、`activityState=idle`、`revision/runId` 独立；用 `worker_list` 确认两条有界摘要，且列表不含报告/事件明细。
   - 用 `worker_status({ workerId, eventId })` 交叉查询：A 的 `eventId` 在 B 上必须读不到详情。
3. **单独关闭**
   - 对 A 执行 `worker_close({ workerId: A, disposition: "accepted" })`，确认仅 A 的窗口/进程退出并释放其占位；B 仍 `connected` 且状态栏 `issue` 不增加。
   - 对 B 执行单独关闭（accepted 或 abandoned），确认 B 回收；重复 `/worker-status` 不再显示已关闭实例。
4. **异常路径抽样**
   - 对其中一个 Worker 触发关闭超时（不确认 `child_exit`），确认其保留占位、可按 ID 查询，其他 Worker 不受影响；迟到 `child_exit` 不删除占位。
   - 关闭前不要 `force` 杀进程；人工确认前不要执行 `/worker-forget`。
5. **取证**
   - 记录两个 `workerId`/`taskId`、窗口进程 PID、报告与关闭实际结果、状态栏文本，以及任何未解决项；把结果追加到本文件并明确 PASS/FAIL。

## 5. 2026-09-30 实机核心 E2E 结果：PASS

执行方式：测试前 `worker_list` 为 0；通过同一批 `worker_start` 启动两个只读测试 Worker（无手工终端启动）。主代理临时在安装副本的 Worker 初始化阶段加入按测试 cwd 区分的延迟及 JSONL 观测钩子，A 在连接前等待 15 秒，B 不延迟；不是靠慢任务模拟慢 ready。项目运行源码未修改。两个启动完成后立即还原安装副本；测试结束再次逐文件核对 src/dist/runtime 一致。

证据目录：`E:/web/ptw-e2e-20260930-104636`，包含 A/B 的 `handshake.jsonl`、`timing-validation.json`、进程/父进程查询及关闭后的进程快照；日志不含 token/凭据。备份及观测模块保留在此目录，仅用于留证，安装副本不再引用它们。

| 角色 | workerId | taskId | controllerId | Worker PID | bootstrap PID |
| --- | --- | --- | --- | --- | --- |
| A（慢） | worker-3c19d667 | task-20b676d1 | ctrl-312aff40 | 15884 | 30244 |
| B（快） | worker-5b1edf0f | task-68faed7c | ctrl-b9f53f46 | 42080 | 29316 |

握手时序（UTC）：

| 事件 | A | B |
| --- | --- | --- |
| 初始化连接前 | 02:48:47.784 | 02:48:47.812 |
| 开始连接 | 02:49:02.792 | 02:48:47.827 |
| 发出 worker_ready | 02:49:02.796 | 02:48:47.899 |
| 收到初始 task | 02:49:02.862 | 02:48:48.078 |

- A 的连接前延迟实际 **15,008 ms**；B 的 ready 比 A 早 **14,897 ms**，初始任务比 A 早 **14,784 ms**。两个 `worker_start` 均返回 ok，证明 B 不等待 A 握手结束即可完成独立任务派发/ACK。
- A/B 各自提交 `E2E_A_INITIAL` / `E2E_B_INITIAL` 正式 result，状态均为 connected / ready_for_review / idle、revision/runId=1/1；changedFiles/unresolved 均为空，pwd 校验通过。列表返回两条独立摘要。
- 报告 eventId 分别为 A `6937dd11-e866-4b51-b674-89aa185d83d6`、B `c7d73be7-3961-49a8-ad84-2471dd4bd387`；自身查询有完整 eventDetail，交叉查询均无 eventDetail。
- A 以 accepted 关闭，工具返回 ok。Windows 进程查询确认 A 的 15884/30244 均消失，B 的 42080/29316 仍存活；列表只剩 B，B 的初始报告保持完整。
- 只向 B 发送 revision 标记 `E2E_B_AFTER_A_CLOSED_7F42`，工具返回 revision=2；B 独立提交带此标记的正式 result（eventId `859dbf1c-7db6-4cad-ab48-652153d335f4`），状态 connected / ready_for_review / idle、revision/runId=2/2，证明关闭 A 后 B 的消息路由和监督仍正常。
- B 随后以 accepted 单独关闭，工具返回 ok。最终 `worker_list` total=0；Windows 进程查询 15884/30244/42080/29316 返回空数组，无本次测试遗留 Worker/bootstrap。
- 安装钩子已移除；恢复后 typecheck/build 通过，完整测试 **235/235**、exit 0、自然退出（约 11.1 秒）；`git diff --check` 通过。

范围说明：本次 PASS 指真实并发启动/慢握手、独立报告与详情、关闭后的独立消息路由、逐个验收与进程退出。异常关闭实机抽样及 TUI 视觉观察未执行，不与自动化通过混淆。

## 6. 会话与重载限制（验收时注意）

区分两种情况：

- **会话切换（`session_start`）**：旧连接失效、旧 waiters 取消，仍存活但无法确认退出的 Worker 降级为 `disconnected` 占位；**不会自动重连**，占位保留可按 ID 查询，需逐个 `/worker-status` 确认后用 `/worker-forget` 处理（forget 不杀进程）。
- **`session_shutdown` / 扩展 reload / Pi 进程重启**：进程内注册表被丢弃，**无法恢复对旧 Worker 的监督**；`session_shutdown` 会尽力发送关闭请求并清理主控资源，但不保证子进程/窗口全部退出；reload/重启也不能保证清理遗留进程，且不会自动重派。重启后应先人工确认并处理遗留进程与占位（任务管理器/窗口、必要时人工关闭），确认无活跃 Worker 后再重新 `worker_start`，**避免盲目重派造成并发写冲突或重复任务**。
