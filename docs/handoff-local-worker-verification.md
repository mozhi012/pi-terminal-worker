# pi-terminal-worker 修复交接（2026-09-29）

> **最新状态（2026-09-29 深夜，接管前必读）**：
> - 三组必须完成的功能**全部实现并验收**：第一组（限额/内存边界）、第二组 2A + 2B 两个半（协议严格校验、连接接受与身份校验、delivery-unknown、bootstrap 加固）、第三组 2A 两个半（Controller / Worker 侧 session generation 与幂等清理）。
> - 当前测试基线：`npm run build` 干净 + `timeout 180s npm test` → **135 passed / 0 failed / suites 21**；`git diff --check` exit 0。
> - 主代理用一次性探针直接驱动 `dist/` 里的新代码，完成 **4 轮真实 Windows Terminal + 真实 Worker 端到端验收**（round 6/7/8/9 全 PASS，含默认模型与显式模型参数两条路径，命令行与 `worker_status` 均已取证），探针脚本已删除。
> - 期间发现并修复一个**真实环境才暴露的严重回归**：第三组第二半一度用跨事件 ctx 身份比较判断会话归属，而 Pi 每次事件都新建 ctx 对象 → Worker 永不提交回执；已修复并新增可复现该回归的用例。详见文末「本轮续接完整记录（2026-09-29 深夜）」。
> - 仍未验证：无 WT 机器上的 PowerShell/CMD 真实端到端开窗（本机装有 WT）；以及**重启 Pi 后由扩展正常路径**再做一轮 `worker_start`（当前主 Pi 会话加载的仍是改动前的扩展实例）。
> - 未提交任何代码；工作区保护照旧（`docs/manual-acceptance.md` 删除、未跟踪设计文档、`docs/verification/` 均保留）。
> - **已打包并安装到 Pi 供用户自测**：`package.json` 的 `files` 补上 `src`、新增 `prepack`；`npm pack` 产物 `E:\web\mozhi0012-pi-terminal-worker-0.1.0.tgz` 解包到 `E:\web\ptw-installed`，并用 `pi install`/`pi remove` 把全局 `settings.json` 的包项从工作区路径 `E:\web\pi-terminal-worker` 换成打包安装目录 `E:\web\ptw-installed`（其余设置未动，备份在 `/tmp/settings.json.bak`）。详见文末「打包与安装（供用户自测，2026-09-29）」。

## 目标与当前结论

目标不变：主 Pi 用 `worker_start` 新开独立 Windows Terminal 窗口，在其中运行可交互的普通 Pi Worker；命名管道负责通信，主端负责验收与关闭。

本地代码已有未提交修复，最近一次 `npm run build && timeout 25s npm test && git diff --check` 通过（22 tests passed，0 failed；约 5.7 秒）。**重启后的本地扩展已通过两轮真实 Windows Worker 任务、回执、验收及进程退出验证，第二轮另通过一次 revision 返修验证。用户随后确认两轮独立窗口显示正常、没有 WT Help 弹窗；这两轮 WT 正常路径验收已完成。完整设计验收仍未完成。** 详细证据见文末重启后记录。

## 已修改（未提交）

- `src/launcher.ts`：去掉会使部分 WT 弹出 Help 的 `wt.exe --version` 探测，改为 `where.exe wt.exe`。
- `src/controller.ts`：`worker_wait` 按 workerId/taskId 过滤旧事件；新 Worker 清空旧回执；回执按 taskId/revision/runId 匹配；人工输入及 followup 作废旧回执（包括 ACK 超时送达未知时）；任务上下文上限 256 KiB；验收要求正式 result、有效连接及 Worker 空闲；关闭未确认子进程退出时保留占位并报错；模型工具拒绝 `force: true`；主控 dispose 尝试发送非强制 close。
- `src/worker.ts`：Worker 隐藏已知 subagent 工具并在 `tool_call` 阻断；报告上限 64 KiB；`agent_settled` 且无排队消息时上报 idle。
- `src/lifecycle.ts`、`src/protocol.ts`：占位锁与 JSON 字节数辅助函数。
- `test/controller.test.ts`、`test/worker.test.ts`、`test/fake-pi.ts`：覆盖旧事件、回执失效、超限、递归派发、验收、关闭超时等。测试须带外部 timeout，之前 Fake Pi 不支持 `setActiveTools` 导致 socket 留存并挂起，此问题已修复。

## 工作区保护

先运行 `git status --short`。交接前观察到 `docs/manual-acceptance.md` **已删除**，另有未跟踪的 `docs/pi-terminal-worker-扩展设计与实施方案.md`；两者均不要擅自还原/删除。已修改的源码和测试也都未提交。方案文档是设计参考，开头“尚未实现”描述已过时。

全局 Pi 设置 `C:/Users/mozhi012/.pi/agent/settings.json` 已从 `git:github.com/mozhi012/pi-terminal-worker` 更新为本地路径 `E:\\web\\pi-terminal-worker`。`C:/Users/mozhi012/.pi/agent/git/github.com/mozhi012/pi-terminal-worker` 仍是旧的 Git 安装缓存，不要覆盖、删除或把它当作当前版本证据。当前会话可能仍持有旧扩展实例；必须重启 Pi 后，新会话才会加载本地工作区。新 Worker 的 `runtime/bootstrap.mjs` 会显式以 `--no-extensions -e <extensionPath>` 加载同一份本地扩展，避免混入旧安装版或重复注册。

## 下一会话行动

新 Pi 会话应先确认自己已经加载本地扩展，再开始真实验收：

1. 在新会话中确认当前扩展来源为 `E:\\web\\pi-terminal-worker`；不要使用仍在运行的旧会话作为证据。必要时执行 `pi list`，应看到本地路径而不是 `git:github.com/mozhi012/pi-terminal-worker`。
2. 核对 `git status --short`，保留 `docs/manual-acceptance.md` 的删除和未跟踪的 `docs/pi-terminal-worker-扩展设计与实施方案.md`，不要擅自还原、删除或覆盖。复跑 `npm run build && timeout 25s npm test && git diff --check`。
3. 记录第一轮实际路径、Worker ID、Task ID、窗口是否新开、是否出现 WT Help 弹窗；调用 `worker_start` 时使用当前仓库作为 `cwd`，任务应要求 Worker 修改一个安全且可验证的小目标，提交正式 `result` 回执并运行验证命令。
4. 第一轮按 `worker_start → worker_wait/status → committed result + idle → 审核 → worker_close(accepted) → child_exit` 完成。验收前确认正式 result、无失败/未解决问题、Worker 连接有效且 activity 为 idle；关闭后确认子进程退出并释放占位。
5. 第二轮使用新的 `worker_start`，确认生成新的 Worker ID/Task ID，`worker_wait` 不返回第一轮事件或回执；重复完整流程。确认第二个窗口也正常启动、无 Help 弹窗，并在验收后关闭。
6. 如任一步失败，记录实际状态和事件，不盲目重复开窗；关闭超时会保留单实例占位。不要使用 `force: true` 绕过验证，也不要未经人工确认强制杀 Worker。
7. 测试完成后，把两轮实际结果、路径和未解决项追加到本文件，再决定是否提交源码改动。

当前限额只覆盖初始任务及 report，方案中的 inbox 总字节限额、完整 schema/session generation/异常链路并未全部落地，不要把“22 tests passed”当完整设计验收。

## 本次续接记录（2026-09-29）

- `npm run build && timeout 25s npm test && git diff --check` 通过：22 tests passed，0 failed。
- 确认全局安装副本 `C:/Users/mozhi012/.pi/agent/git/github.com/mozhi012/pi-terminal-worker` 与本地工作区不同，未覆盖、未修改安装副本。
- 修复 Worker 加载路径：Controller 将当前扩展包根路径加入 `LaunchPayload`；`runtime/bootstrap.mjs` 启动子 Pi 时使用 `--no-extensions -e <extensionPath>`，避免 Worker 混入旧安装版或重复注册扩展。
- CLI 预检通过：`node .../cli.js --no-extensions -e E:/web/pi-terminal-worker --help` 能正常加载参数（仅有当前模型配置警告）。
- Pi 个人配置已更新：`C:/Users/mozhi012/.pi/agent/settings.json` 的 package 项为 `E:\\web\\pi-terminal-worker`；`pi list` 已确认解析到 `E:\\web\\pi-terminal-worker`。
- 当前旧 Pi 会话尚未重启，因此尚未执行真实 Windows Terminal 连续两次验收。重启后新对话必须先确认扩展路径，再执行上面的两轮流程。

## 新会话回填区（重启后，2026-09-29）

- 主 Pi：用户确认已重启；`pi list` 显示本地包 `E:\web\pi-terminal-worker`。两轮真实子进程命令行均为 `"D:\Program Files\nodejs\node.exe" C:\Users\mozhi012\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js --no-extensions -e E:\web\pi-terminal-worker`，与当前 Controller 传递本地包路径的实现相符。未使用或改动旧 Git 安装缓存。
- 基础检查：`npm run build && timeout 25s npm test && git diff --check` 全部通过，22 passed / 0 failed，测试约 5.7 秒；仅有 Git LF/CRLF 提示。
- 第一轮：Worker `worker-e688ceac`，Task `task-03581e96`，Controller `ctrl-94c5c207`；Worker PID `7680`，Supervisor PID `18664`。`worker_start` 成功，`worker_wait(afterCursor=0)` 返回 cursor `1` 的 `child_spawned`。正式 `committedReport.kind=result`，`ready_for_review + connected + idle`，revision/runId 均为 `1`，无未解决问题。主端读取并独立断言验证 `docs/verification/local-worker-round-1.json` 后，`worker_close(accepted, force=false)` 成功，系统进程查询确认 PID 7680 已退出。
- 第二轮：Worker `worker-fa9857e3`，Task `task-62a5d804`，Controller `ctrl-b4680767`；Worker PID `27220`，Supervisor PID `30888`。新启动成功，证明第一轮名额已释放。`worker_wait(afterCursor=0)` 返回本轮 cursor `14` 的 `child_spawned`，下一事件为本轮 cursor `15` 的 `worker_ready`；未返回第一轮旧事件。运行初期 `committedReport=null`、`candidateReport=null`，未继承第一轮回执。
- 第二轮审核与返修：文件内容正确，但首次 result 的 `validation.command` 含说明占位符，主端在 `ready_for_review` 下发送 `worker_send(kind=revision)`，要求重跑并提交完整可复制命令。随后收到 revision `2` / runId `2` 的正式 result，`connected + idle + ready_for_review`，validation passed、unresolved 为空。主端独立验证两轮 JSON 精确文本（含末尾换行）及 deepEqual 均通过，再 `worker_close(accepted, force=false)` 成功。
- 退出证据：关闭实现必须收到 Supervisor `child_exit` 更新 lifecycle 为 `closed` 后才能成功返回并释放占位；两次 close 均成功，因此按该实现确认退出握手完成，但未单独导出原始 `child_exit` 事件。末次系统查询确认 `7680 / 27220 / 18664 / 30888` 四个进程均不存在。没有使用强制终止。
- Worker 工具集：两轮均只有 `read / bash / edit / write / worker_report`，未暴露 Worker 派发或 subagent 工具。此次未实测恶意直接调用阻断，也未覆盖全部异常链路。
- 窗口/Help 确认：两轮均通过 WT 启动链路、完成 Supervisor 与 Worker 握手及任务；实际代码使用 `-w new new-tab`。主端未采集截图，用户随后明确确认两轮独立新窗口正常、没有 Help 弹窗，此项以用户现场观察为依据通过。
- 工作区：保留 `docs/manual-acceptance.md` 删除、原未跟踪设计文档及所有原源码/测试变更。本次只新增两个安全验证 JSON，并更新本交接文档；未提交代码。最终 `git diff --check` 通过。
## 下一窗口交接（先重启 Pi，再继续）

### 当前已完成

- 已执行 `npm run build`，TypeScript 构建通过；`pi list` 确认全局扩展来源仍为 `E:\web\pi-terminal-worker`。重启 Pi 后应再次运行 `pi list`，确认不是旧的 Git 安装缓存。
- 已保留并构建当前未提交实现：
  - `src/launcher.ts`：WT → PowerShell → CMD 探测；PowerShell 使用隐藏宿主 + `Start-Process` 创建真实新控制台；CMD 使用 `start`、受控环境变量和 `windowsVerbatimArguments`。
  - `src/controller.ts`：可选 `provider` / `model` / `thinkingLevel`，等待真实 `worker_ready`，模型状态更新，现有验收和关闭逻辑。
  - `runtime/bootstrap.mjs`：通过参数数组追加 `--provider` / `--model` / `--thinking`，不传则保持 Pi 默认配置。
  - `src/worker.ts`：上报实际模型/思考级别，监听 `/model`、`/thinking` 对应事件；修复早到任务队列和 `hello_ok` 时序。
  - `README.md` 与新增测试已修改。
- 当前用户配置已经是本地包路径，不要覆盖或删除旧缓存：`C:\Users\mozhi012\.pi\agent\git\github.com\mozhi012\pi-terminal-worker`。
- Worker `worker-4b07f6f1` 已请求停止，尚未作为本轮实现验收证据；不要继续向它派发任务。工作区修改必须保留。

### 下一窗口第一步

1. 重启 Pi，使主会话重新加载本地 `E:\web\pi-terminal-worker`。
2. 运行并记录：
   ```bash
   pi list
   git status --short
   npm run build
   timeout 35s npm test
   git diff --check
   ```
   预期现有测试至少 `32 passed / 0 failed`；若数量或结果不同，先审查失败，不要真实开窗。
3. 确认 `docs/manual-acceptance.md` 的删除、未跟踪设计文档、`docs/verification/` 和本交接文档都保留，不要恢复或删除。

### 必须先做的代码审查

1. 检查 `src/controller.ts` 和 `src/launcher.ts`：当前实现是否真的支持“WT 启动失败后回退到 PowerShell、PowerShell 启动失败后回退到 CMD”。仅有后端探测不等于启动失败回退；必须审查 `spawn` 的 `error` / `exit` 监听和 Supervisor 握手前后的边界。握手超时或结果未知时不能盲目重开。
2. 检查 PowerShell 生成的 `Start-Process -ArgumentList` 和 CMD `start` 命令，确认交互式 TTY、工作目录、标题及包含空格/中文/`&`/`%`/`!`/引号/换行的参数安全。
3. 检查 `runtime/bootstrap.mjs`：默认参数不能添加任何选模参数；显式参数必须使用 `shell:false` 参数数组，不得拼接 shell 命令。
4. 检查 `worker_ready` 是否只在 `hello_ok` 和 `session_start` 两者都完成后发送一次；确认 `workerReadyReceived` 每次启动重置。
5. 检查 Worker 实际模型状态字段来自 `ctx.model` / `pi.getThinkingLevel()`，而不是只回显启动请求；确认 `/model` 或 `/thinking` 切换后主端 `worker_status` 更新。

### 已做但不等于完整验收的验证

- Worker 报告过：`npm run build` 通过、`timeout 35s npm test` 为 32 passed / 0 failed、`git diff --check` 通过。主代理必须重新复跑并审查实际 diff，不能只相信回执。
- 主代理已独立运行 `node docs/verification/native-shell-check.mjs`，原生 PowerShell/CMD 参数解析通过；该脚本不打开终端、不启动 Worker。
- 之前两轮 WT 正常路径真实验收已通过；用户已确认独立窗口正常且没有 Help 弹窗。这不能替代 PowerShell/CMD 无 WT 实机验证。

### 实机验收顺序

1. 先在 WT 正常环境用新的 `worker_start` 做一轮小任务，参数不指定模型，确认使用 Pi 默认 `local / Qwen3.8-27B / medium`（实际值以 `worker_status` 为准），并确认没有启动竞态。
2. 再指定模型参数做一轮，例如 `provider: "local"`、`model: "Qwen3.8-27B"`、`thinkingLevel: "low"`，确认 Worker 命令行包含对应 CLI 参数且 `worker_status` 显示实际值。
3. PowerShell/CMD 回退优先做可控测试：临时通过探测注入或测试桩验证选择；真实无 WT 机器再验证新窗口、TTY、握手、模型参数和正常关闭。不要为了测试删除系统组件，也不要强制终止 Worker。
4. 每轮严格执行 `worker_start → worker_wait/status → 正式 result + idle → 审查 → worker_close(accepted) → child_exit`；失败时保留状态和证据，不盲目重复开窗。

### 交付边界

- 通过基础测试不代表 PowerShell/CMD 回退已完成真实端到端验收。
- 不要提交代码，除非用户另行要求；本轮目标是完成审查、修复必要问题、重新测试，并把最终结果继续回填到本文件。
- 不要修改全局 `settings.json`；默认模型由用户 Pi 设置决定，`worker_start` 的模型参数只覆盖单次 Worker 启动。

- 新开发 Worker：`worker-4b07f6f1` / `task-5de5d53c`，PID `33588`。
- 初始 `task_accepted` 的 cursor 为 `33`，后续 `worker_ready` 的 cursor 为 `34`。管道已连接，但 Worker 持续没有调用工具；检查实现发现 Controller 的 `waitForWorkerReady` 只等待连接，早到任务因 `currentContext=null` 排队，`session_start` 没有补派发，导致任务无法自动开始。
- 本次恢复方式：同一实例内 `worker_stop` 清空旧队列，再 `worker_send(kind=supplement)` 发送完整任务，随后观察到实际工具执行。没有重复开窗或强杀。
- 该竞态纳入终端回退/模型参数这轮修复：等待真正 ready、补派发早到任务，并覆盖会话初始化与管道认证的两种顺序。实现与最终验证结果待本轮开发完成后补充。

## 本次续接记录（重启后继续，2026-09-29）

- 新会话来源确认：`pi list` 显示用户包为 `E:\\web\\pi-terminal-worker`，未使用旧 Git 安装缓存。
- 基础验证：`npm run build && timeout 35s npm test && git diff --check` 通过，**35 passed / 0 failed**；`node docs/verification/native-shell-check.mjs` 通过。该脚本仍只验证 PowerShell/CMD 参数解析，不启动终端或 Worker。
- 代码审查发现并修复真实缺口：原实现只有后端探测，没有在 `spawn` 明确失败时回退。现在 `detectTerminalBackends` 保留 WT → PowerShell → CMD 候选，Controller 仅在收到明确 `spawn error` 时尝试后续候选；Supervisor 握手超时或结果未知不会自动重开，仍保留占位并报错。新增后端候选测试，基础测试由 34 增至 35。
- 第一轮默认模型验收：Worker `worker-e9baf202`，Task `task-c071e73c`，Controller `ctrl-c43c9e0e`，PID `35752`；事件 cursor 从本轮 `1` 开始，未继承上一轮事件。收到 `worker_ready` 后状态为 `provider=local`、`modelId=Qwen3.8-27B`、`thinkingLevel=medium`，工具为 `read / bash / edit / write / worker_report`；随后收到正式 `result`、`idle`。主端独立读取 `docs/verification/local-worker-round-3.json`，精确内容及末尾换行正确；`worker_status` 为 `ready_for_review + connected + idle`，`unresolved=[]`。`worker_close(accepted, force=false)` 成功。
- 第二轮显式模型验收：Worker `worker-82c2c1b9`，Task `task-754f5641`，Controller `ctrl-b319fe6e`，PID `29724`；使用 `provider=local`、`model=Qwen3.8-27B`、`thinkingLevel=low`。收到全新本轮 cursor `15` 的 `child_spawned` 和 cursor `16` 的 `worker_ready`，未返回第一轮旧事件；实际状态为 `local / Qwen3.8-27B / low`。正式 `result`、`idle`、独立 JSON 核对 `docs/verification/local-worker-round-4.json`、`unresolved=[]` 均通过，随后 `worker_close(accepted, force=false)` 成功。
- 两轮均通过 WT 正常启动链路；继承先前用户对独立新窗口、无 WT Help 弹窗的现场确认。两次 close 均走非强制退出握手并成功释放单实例名额；本轮没有使用 `force=true`。未单独导出原始 `child_exit` 事件，也未在无 WT 机器上做 PowerShell/CMD 真实端到端开窗验收。
- 当前仍保留：`docs/manual-acceptance.md` 删除、未跟踪设计文档、源码/测试未提交改动，以及 `docs/verification/` 和本交接文档。未修改全局 `settings.json`。

### 下一会话待完成任务

以下三组功能必须在提交和推送前完成。当前源码仍未提交，不要把现有 35 个测试通过误认为完整设计验收通过。

#### 第一组：限额与内存边界

> 状态（2026-09-29）：✅ 已实现并通过自动化验证（`test/limits.test.ts` 14 个测试，全量 49 passed / 0 failed）。实现细节、设计取舍与验证证据见文末「第一组实现记录（2026-09-29）」。真实 Worker 端到端复验随第二、三组之后统一做（当前 Pi 会话仍持有改动前的扩展实例）。

目标：把设计文档第 5.5 节的内存和队列限额真正落地，并补自动化测试。

- `src/controller.ts` 的 inbox 不能只按事件数量清理；必须按 `JSON.stringify(payload)` 的 UTF-8 字节数维护总量，最多保留 `MAX_INBOX_EVENTS` 和 `MAX_INBOX_BYTES` 双重边界。
- 不能静默丢失关键交付结果。对普通活动事件可以按设计合并或淘汰；对关键报告、报告事件和等待所需的事件，达到上限时应明确拒绝或返回可诊断错误。
- Worker followup 队列除最多 8 条外，增加总字节上限 1 MiB；超限必须拒绝新消息，不能无限排队。
- 关键报告缓存按设计限制最多 128 条或 8 MiB；若当前架构只保留单个 current report，需要明确补足缓存或记录设计取舍，并为 overflow 写测试。
- 检查 `MAX_INBOX_BYTES` 当前虽已定义但未实际用于 `appendInbox()` 的问题。

验收：补充超大 payload、总字节累计、边界恰好等于限额、超过限额、关键事件不可静默丢失、followup 队列总字节超限测试。

#### 第二组：协议、容量和异常链路

> 状态（2026-09-29）：🟡 进行中。**2A**（协议 schema 严格校验、传输层背压/去重容量、Worker 接收侧身份与去重）已完成并验收；**2B**（Controller 连接接受与身份校验、delivery-unknown、`launch_failed` 释放名额、bootstrap 最小加固）**已中止且未落盘任何改动**，需要重新派发。详见文末「子代理默认模型变更与第二组进度（2026-09-29）」。

目标：补齐协议层和 Controller/Worker 的故障保护，避免重复任务、错误身份和无法关闭 Worker。

- 为 Envelope 和各类 payload 增加严格 schema/字段长度/类型校验；拒绝错误协议版本、错误角色、错误 Worker/Task ID、重放 hello 和重复认证。
- 检查 Controller 是否只接受预期的 bootstrap 和 worker 各一条连接；多余连接必须拒绝，不得覆盖当前连接。
- 完善 ACK/去重容量：普通 task/followup 达到每实例 1024 条时拒绝新请求；abort、close、terminate 和状态查询必须保留独立控制额度，不能因普通请求容量耗尽而无法停止。
- 验证同 ID 同正文返回缓存 ACK，同 ID 不同正文拒绝；ACK 丢失时必须保持 unknown，不得自动重发或创建新任务。
- 检查 JSONL 对异常 JSON、超大帧、慢速发送和 socket `write()` 返回 false 的处理；需要有界发送背压，等待 `drain`，不能无限缓存。
- 补齐 socket error、认证超时、worker 断连、Supervisor `launch_failed`、child exit、worker_ready 超时、close ACK 超时等异常测试；异常状态不能误报成功，也不能自动重复派发任务。

验收：新增故障注入测试覆盖错误 token/版本/角色、重复连接、重复请求、容量耗尽、ACK 丢失、异常 JSON、超大帧、慢发送/backpressure、断连和关闭竞态。

#### 第三组：session generation 与幂等清理

目标：防止 Pi reload、session 切换、socket 关闭和子进程退出时，旧异步回调污染新 Worker 或继续调用旧 Pi API。

- 让每次 Controller/Worker 会话启动捕获当前 generation；所有延迟 timer、socket 回调、Supervisor/Worker 事件、waiter 和关闭流程在执行前检查 generation 是否仍有效。
- session 切换或 reload 后，旧任务、旧连接、旧 waiters、旧 heartbeat 和旧 report 不能写入新实例状态，也不能向新 session 注入消息。
- `CleanupRegistry` 必须覆盖 socket、server、timer、child/supervisor 监听和等待器，且重复执行安全；dispose、session_shutdown、socket error、child exit 各路径都要验证。
- 检查 Worker 的 `session_start`、`session_shutdown`、agent settled 和 queued followup 回调，旧 context 失效后不得继续调用 Pi API。
- 确认关闭流程在 ACK、child_exit、socket close 任意顺序下只完成一次；未确认退出时保留占位，不释放单实例锁。

验收：补充 reload/session 切换、旧回调晚到、socket error 与 child exit 竞态、重复 dispose、关闭顺序交错、旧 Worker 事件污染新 Worker 等测试。

### 推荐实施顺序与提交边界

1. 先完成第一组限额，运行完整自动化测试。
2. 再完成第二组协议和异常链路，重点审查 `transport.ts` 与 `controller.ts` 的共享状态。
3. 最后完成第三组 generation/清理，并运行完整故障注入测试。
4. 重新运行 `npm run build && timeout 35s npm test && git diff --check`，再做两轮真实 Worker 验收：默认模型和显式模型参数。
5. 主代理审查完整 diff 后，才允许提交和推送。不要修改全局 `settings.json`，不要恢复 `docs/manual-acceptance.md`，不要删除未跟踪设计文档或已有 `docs/verification/` 证据。

### 下一会话启动检查

- 先运行 `pi list`，确认扩展来源是 `E:\\web\\pi-terminal-worker`。
- 运行 `git status --short`，确认当前源码改动、`docs/manual-acceptance.md` 删除、设计文档和验证文件均保留。
- 阅读本节及设计文档第 5.1、5.2、5.5、6、10、11、12 节后再实施。
- 当前没有提交或推送本轮源码改动；上一轮真实 Worker 验收已经完成，但上述三组功能仍是提交前阻塞项。

## 第一组实现记录（2026-09-29）

### 范围与改动文件

第一组「限额与内存边界」已实现。改动仅限契约内 4 个文件，仓库其他文件（含 `docs/`、`README.md`、`package.json`、`tsconfig.json`）未被本组触碰：

- `src/protocol.ts`：新增 `MAX_FOLLOWUP_QUEUE_BYTES = 1 MiB`、`MAX_REPORT_CACHE_SIZE = 128`、`MAX_REPORT_CACHE_BYTES = 8 MiB`；`ProtocolErrorCode` 新增 `QUEUE_BYTES_EXCEEDED`、`REPORT_CACHE_FULL`。现有 `MAX_INBOX_EVENTS = 128`、`MAX_INBOX_BYTES = 8 MiB` 取值不变。
- `src/controller.ts`：`appendInbox()` 改为条数 + 字节双重边界；新增 `InboxCapacityError` / `ReportCacheFullError`、`CachedReportEntry`、`evictInboxForCapacity()`、`cacheReport()`、`handleReportCacheRejected()`、`reportEnvelopeRejected()`、`sendConnError()`、`getInboxStats()`、`getReportCacheStats()`、`wait_timeout` 诊断计数、`worker_status` 的 `inbox` / `reportCache` 字段。
- `src/worker.ts`：followup 队列新增 1 MiB 总字节上限（`followupQueueBytes`、`shiftQueueItem()`、`clearQueue()`）；修复 ACK 顺序（先入队/派发成功后才 ACK `ok=true`，失败只回一条 `ok=false`）。
- `test/limits.test.ts`（新增，534 行）：14 个测试，覆盖收件箱边界、报告缓存边界、诊断输出、Worker 队列边界与管道集成。

### 关键语义（实现契约，后续组不要改坏）

- **可淘汰事件集合**：`activity` / `model_changed` / `task_accepted` / `followup_accepted` / `inbox_rejected` / `report_rejected`。这些允许被最旧优先淘汰，或在仍无法容纳时静默丢弃并累计 `droppedInboxEvents`。其余事件类型一律视为关键事件。d
- **关键事件不静默丢失**：容量不足时先淘汰最旧可淘汰事件；仍不足则抛 `InboxCapacityError`（`limitType: "events" | "bytes"`），**不写入、不递增 `inboxBytes`、不唤醒 waiter**。恰好等于限额（`count === 128` 或 `bytes === 8 MiB`）必须允许写入。
- **socket 回调不得被击穿**：`bindWorker` / `bindSupervisor` 的消息处理体已用 `try/catch` 包住，统一由 `reportEnvelopeRejected()` 出口：`INBOX_FULL` / `REPORT_CACHE_FULL` / `PROTOCOL_ERROR` 三类显式 `error` envelope 回送 Worker，并累计 `inboxRejectedEvents` / `reportCacheRejected`；异常不再逃逸到 socket 回调。
- **报告缓存只增不淘汰**：`report_candidate` / `report_committed` 先 `cacheReport()`；达到 128 条或 8 MiB 时抛 `ReportCacheFullError`，该回执被显式拒绝且**不更新** `taskState` / `currentCommittedReport` / `currentCandidateReport`（缓存满时 `report_committed` 绝不进入 `ready_for_review`）。这是设计文档 5.5 节「达到限额明确拒绝新报告」的直译；代价是长会话第 65 轮左右返修后需要重启 Worker 实例。
- **状态推进先于收件箱写入**（有意取舍）：`local_input` / `report_missing` / `stopped` / `report_committed` 的状态转换发生在 `appendInbox()` 之前。因此当收件箱满而事件被拒时，状态仍反映真实现实（例如 `report_missing` 依然会作废旧回执，`local_input` 依然让任务回到 `running`），只是主端需要靠 `worker_status` 的 `committedReport` 与诊断计数获取信息，而不是靠 `worker_wait` 事件。方向是保守的：不会把过时结果留成可验收状态。
- **新实例从干净状态开始**：`handleWorkerStart()` 重置 `inbox` / `cursorCounter` / `inboxBytes` / 三个诊断计数 / `reportHistory`，`dispose()` 清空收件箱与报告缓存。
- **wait 诊断**：`worker_wait` 的 `wait_timeout` 事件 payload 现携带 `droppedInboxEvents` / `inboxRejectedEvents` / `reportCacheRejected`，超时不再是不可诊断的静默。

### 验证证据（主代理实跑，非仅采信回执）

- 实现方：Worker `worker-451adff7` / Task `task-52c8e36f`（默认模型 `local / Qwen3.8-27B / medium`），提交正式 `result` 后 `ready_for_review + connected + idle`，`unresolved=[]`，已 `worker_close(accepted)` 释放名额。
- `npm run build`：通过，无 TypeScript 错误。
- `timeout 60s npm test`：**tests 49 / pass 49 / fail 0 / cancelled 0 / skipped 0**，`suites 11`，`duration_ms ≈ 6250`；单独跑 `node --test test/limits.test.ts` 为 14 passed / 0 failed。
- `git diff --check`：exit 0，仅有既有 Git LF/CRLF 提示，无空白错误。
- `git status --short` 与派发前一致，仅多出未跟踪的 `test/limits.test.ts`；40 分钟内被修改的文件只有 `src/controller.ts`、`src/protocol.ts`、`src/worker.ts`、`test/limits.test.ts`（`docs/handoff-local-worker-verification.md` 行数与内容未变，仍是 183 行）。
- 主代理另写一次性探针脚本直连 `dist/` 独立复验（脚本已删除，工作区无残留）：
  1. 用 8 条 1 MiB 可淘汰事件把字节精确顶到 `8388608`，再入一条关键事件 → 靠**字节维度**淘汰腾空间成功，`bytes` 仍 ≤ 8 MiB、条数不变；
  2. 收件箱变成全关键事件且字节满后，再入关键事件 → 抛 `InboxCapacityError`（`limitType="bytes"`, `code=INBOX_FULL`），拒绝前后 `count`/`bytes` 完全不变；
  3. 经 `bindWorker` 的 socket 路径投递关键事件 → 回送 `error` envelope（`code=INBOX_FULL`, `replyTo` 对应请求），`inboxRejectedEvents=1`，收件箱状态不变；
  4. 随后 `worker_wait` 超时事件的 payload 三项诊断计数与实际一致。

### 仍未验证 / 风险

- **真实端到端未复验**：本 Pi 会话加载的是改动前的扩展实例，本组只做了自动化与 `dist/` 探针验证。改动要等重载（重启 Pi）后才在新会话生效，届时按文末计划做默认模型 + 显式模型两轮真实 Worker 验收，再判定是否可提交。
- 报告缓存「只增不淘汰」在超长单实例会话下会让 Worker 无法再交付回执（需重启实例），这是设计取舍而非遗漏；若后续认为不可接受，应在方案层面重新决策，不要偷偷改成静默淘汰。
- 未被本组覆盖（属第二、三组）：去重容量 1024 条与独立控制通道额度、Envelope schema 严格校验、连接数量限制、JSONL 背压 `drain`、session generation 与幂等清理。
- 工作区保护照旧：未恢复 `docs/manual-acceptance.md` 删除、未删除未跟踪设计文档与 `docs/verification/`、未改动全局 `settings.json`、未提交任何代码。

## 子代理默认模型变更与第二组进度（2026-09-29）

### A. 子代理（Worker）默认模型改为 deepseek-flash / high

用户要求：`worker_start` 拉起的 Worker 默认使用 `deepseek-flash [deepseek]`、思考强度 `high`。已实现（只改扩展自身，不动全局 Pi 设置、不影响主 Pi 会话自身默认模型）：

- `src/controller.ts` 新增 `DEFAULT_WORKER_PROVIDER = "deepseek"`、`DEFAULT_WORKER_MODEL = "deepseek-flash"`、`DEFAULT_WORKER_THINKING_LEVEL = "high"`，以及两个纯函数：
  - `resolveWorkerModelDefaults(env)`：读环境变量覆盖（`PI_TERMINAL_WORKER_DEFAULT_PROVIDER` / `_DEFAULT_MODEL` / `_DEFAULT_THINKING`），空串回落常量，非法 thinkingLevel 直接报错；
  - `resolveWorkerModelParams(params, defaults)`：显式参数优先、两侧空白裁剪、空白串视为未指定、显式非法 thinkingLevel 报错（不静默回落）。
- `handleWorkerStart()` 改为 `const modelParams = resolveWorkerModelParams(params)`，因此 launch payload **总是**带 `provider`/`model`/`thinkingLevel`，bootstrap 会追加 `--provider deepseek --model deepseek-flash --thinking high` 给 Worker CLI。
- `worker_start` 工具的三条参数描述、`README.md`（特性 + 工具说明）已同步改写，明确“默认 = deepseek/deepseek-flash/high，可用环境变量覆盖”。
- 显式传参仍然可覆盖单次启动；`worker_status` 仍上报 Worker 侧**实际**模型，便于核验。

验证证据（主代理实跑）：
- `npm run build`：通过，无 TS 错误。
- `timeout 90s npm test`：**tests 93 / pass 93 / fail 0 / suites 18 / duration_ms ≈ 6393**（原 90 + 新增 3 个默认模型用例，在 `test/controller.test.ts` 的「Worker (子代理) 默认模型配置」describe 内）。
- `git diff --check`：exit 0（仅既有 LF/CRLF 提示）。
- 模型可解析性：`node <pi-cli> --no-extensions --list-models deepseek-flash` 输出 `deepseek  deepseek-flash  1M  384K  thinking: yes  images: yes`，证明 provider/model 与 thinking 均受支持。
- 安装/加载确认：`pi list` 仍解析到 `E:\web\pi-terminal-worker`（本地路径包），`dist/controller.js` 已含新的默认常量；**无需重新安装，重启 Pi 即可生效**。

未验证（下一会话第一件事）：真实 Worker 是否以 `deepseek / deepseek-flash / high` 成功启动。做法：`worker_start` 不传模型参数 → `worker_status` 必须显示 `provider=deepseek`、`modelId=deepseek-flash`、`thinkingLevel=high`，并在该轮完成后按 `worker_close(accepted)` 正常关闭。

### B. 第二组进度

- **2A 已完成并验收**（Worker `worker-ad5996a6`，revision 2）：
  - `src/protocol.ts`：23 类型白名单 + `isKnownMessageType`、`validateEnvelope` 加固（id/type/taskId/revision/replyTo 长度与类型）、`validatePayload`（23 类型逐字段校验）、`validateWorkerReport`（kind/summary/changedFiles/validation/unresolved/question + 64 KiB 总量）、`ProtocolValidationError(code)`，新增 `MAX_ID_LENGTH`/`MAX_TYPE_LENGTH`/`MAX_ERROR_MESSAGE_SIZE`/`MAX_FOLLOWUP_MESSAGE_SIZE`/`MAX_REPORT_SUMMARY_SIZE`/`MAX_PATH_FIELD_SIZE`/`MAX_SEND_BUFFER_BYTES`/`MAX_CONTROL_DEDUP_SIZE`。
  - `src/transport.ts`：收到一行后 `validateEnvelope`→`validatePayload`，失败即“回送 `error`（带 replyTo）+ `emitError` + 销毁连接”；`writeRaw` 串行化 + `queuedWriteBytes` 记账（超 4 MiB 抛 `SendBufferFullError`/`QUEUE_BYTES_EXCEEDED`），`doWrite` settle-once（对端关闭以 `PEER_DISCONNECTED` reject，不挂起、不泄漏 listener）；`checkDedup` 普通表 1024 / 控制表 256 独立额度（控制请求永不因容量被拒，FIFO 淘汰最旧控制条目）；`AckTimeoutError(TIMEOUT, deliveryUnknown=true)`；`getDedupStats()`。
  - `src/worker.ts`：`handleControllerEnvelope` 身份校验（controllerId/workerId 不匹配→忽略并回 `error`）；task/followup 走 `dedupGate(..., false)`、abort/close 走 `isControl=true`；`sendAck(..., code?)`。
  - 主代理探针发现并由 revision 修复的两个真实缺陷：① 未挂 `"error"` 监听时协议违规会以 uncaughtException 击穿进程 → 新增 `emitError()` 降级 `console.warn`；② MISMATCH 分支 `recordDedup` 覆盖缓存，导致重发原始正文再也查不回缓存 ACK → 改为不覆盖（保留原条目）。修复后探针复验：`uncaught=0` 且 `destroyed=true`、原始正文仍返回缓存 `ok:true`。
  - 证据：`npm run build` 通过；`timeout 60s npm test` **90 passed / 0 failed**；`git diff --check` exit 0；新增 `test/fault-injection.test.ts`，`test/transport.test.ts` 的占位类型 `test_req`/`silent_req` 改成真实类型 `ping`。
- **2B 已中止、未落盘**（Worker `worker-2fbc6871` 在用户要求切换默认模型时被关闭；中止时它尚未写任何文件，仓库无半成品）：
  - 待办（原 2B 规格，重新派发时按当前源码重述）：`handleIncomingSocket` 认证重写（只接受 bootstrap/worker 各一条连接、拒绝重放 hello/认证前非 hello/错误 token/跨实例 controllerId+workerId/角色冲突覆盖引用；认证超时用可注入 `authTimeoutMs`，socket close 时清 timer）；`bindSupervisor`/`bindWorker` 增角色消息类型白名单 + 实例身份校验（身份不符→回 `error` 且忽略、不销毁连接；stale taskId/revision/runId 忽略并计数）；`handleWorkerStart` catch 中若 lifecycle 已是 `closed`（supervisor 已报 `launch_failed`/`child_exit`）→ `releaseSlot()` 并抛含 `LAUNCH_FAILED` 与失败原因的错，否则保留 `launch_unknown`；`unknownDeliveries`（上限 `MAX_UNKNOWN_DELIVERIES=64`）记录 ACK 超时的 launch/task/followup/abort/close，`worker_send` 超时抛“投递结果未知”且不自动重发，`worker_status` 暴露 `unknownDeliveries`；测试接缝 `launchTimeoutMs` 与 `handleWorkerStart(params, probes, internal?.ids)`；`runtime/bootstrap.mjs` 最小加固（launch payload 严格校验、重复 launch 拒绝 `ALREADY_EXISTS`、未认证拒绝 launch/terminate、接收缓冲 2 MiB 上限）；新建 `test/connection.test.ts`（假管道 harness + 13 条链路用例 + 2 条 bootstrap 子进程用例），并需要给 `test/controller.test.ts`、`test/limits.test.ts` 里 `conn.emit("message", ...)` 的假 envelope 补上当前实例的 `controllerId`/`workerId`（**只补字段，不得削弱既有断言**）。
  - 注意：本次默认模型改动动了 `handleWorkerStart` 的模型参数解析（已抽成 `resolveWorkerModelParams` 纯函数），重新派发 2B 时不要改回该语义。
- 第三组（session generation 与幂等清理）尚未开始。

### C. 本次观察到的关闭握手问题（第三组输入）

关闭 `worker-2fbc6871` 时实际发生：Worker 子进程与其 supervisor 进程都已从系统中消失（`tasklist` 查不到 PID，`Win32_Process` 也无 `bootstrap.mjs`/`--no-extensions -e ...` 进程），但 Controller **始终没收到 `child_exit`**，于是 lifecycle 卡在 `closing`、占位不释放，`worker_close` 反复报“未确认 Worker 进程退出；保留单实例占位”，只能靠 `/worker-forget` 人工解除（重启 Pi 也会清空内存占位）。
另外注意 `bindWorker` 的 `conn.on("close")` 会在 `lifecycleState !== "closed"` 时把状态写成 `disconnected`——它会把 `closing` 覆盖掉，掩盖“正在关闭”中间态。
建议第三组处理：① 关闭中间态不被 `disconnected` 覆盖（或区分 `closing` 与断连）；② 同时失去 worker 与 supervisor 连接且无 `child_exit` 时给出明确诊断（不擅自释放名额，但要让主代理/用户看到“exit 未确认”的证据，例如记录最后一次连接状态与 pid）；③ `/worker-forget` 之外的自动恢复保持“明确人工确认”原则。

### D. 工作区状态（本次交接时）

- 未提交任何代码；`docs/manual-acceptance.md` 删除、未跟踪设计文档、`docs/verification/` 全部保留。
- 本轮新增未跟踪文件：`test/limits.test.ts`、`test/fault-injection.test.ts`。
- 一次性探针脚本（`.probe-*.mjs`）均已删除，`git status` 中无残留。
- 未修改全局 `settings.json`；`deepseek/deepseek-flash` 本就在 `enabledModels` 中。

---

## 本轮续接完整记录（2026-09-29 深夜）

本节是本次会话（以交接文档为入口继续）的完整工作记录，供下一次接管直接使用。

### 1. 启动检查（全部通过）

- `pi list`：用户包解析到本地路径 `E:\web\pi-terminal-worker`，未使用旧 Git 安装缓存。
- `git status --short`：保留 `docs/manual-acceptance.md` 删除、未跟踪设计文档、`docs/verification/`、本交接文档；源码/测试改动全部保留。
- 基线：`npm run build` 干净、`timeout 120s npm test` **93 passed / 0 failed**、`git diff --check` exit 0。
- 确认 `dist/` 构建时间晚于所有 `src/` 改动（当前会话加载的是最新扩展实例）。

### 2. 默认模型真实验收（round 5，经扩展正常路径）

- 仍在使用改动前构建的主 Pi 会话内直接 `worker_start`（不传模型参数）：Worker `worker-82e3e6e0` / `task-b7433c8c` / `ctrl-ea832d52`，PID `41180`，Supervisor PID `21024`（父进程 `WindowsTerminal.exe`）。
- `worker_wait(afterCursor=0)` 从本轮 cursor `1` 开始，依次拿到 `child_spawned` → `worker_ready`（`provider=deepseek`、`modelId=deepseek-flash`、`thinkingLevel=high`，工具仅 `read/bash/edit/write/worker_report`）→ `activity` → `report_candidate` → `report_committed`。
- 主代理独立读取并逐字节核对 `docs/verification/local-worker-round-5.json`（含末尾单换行），并复跑 Worker 回执里的完整 `node -e ...` 校验命令，输出 `OK round=5 ...`。`worker_status` = `ready_for_review + connected + idle`、`unresolved=[]`；`worker_close(accepted, force=false)` 成功；系统查询确认 PID 41180/21024 均已退出。

### 3. 第二组 2B 第一半（Controller 连接接受与身份校验）

- 派发 → Worker `worker-986a519a` 实现 → 主代理审查 → **revision 1** 修掉「新实例无法接管上一实例遗留连接引用」的真实回归（`launch_failed` 释放名额或 `/worker-forget` 后 `supervisorConn`/`workerConn` 仍非 null，新实例 hello 会被 `ALREADY_EXISTS` 挡死 → 单实例锁卡死）→ 重新提交 → 验收通过、`worker_close(accepted)`、PID 29572 确认退出。
- 落地内容：`handleIncomingSocket` 认证重写（每角色一条连接、拒绝重放 hello/未认证非 hello/错误 token/跨实例 controllerId+workerId/角色非法；认证超时 `authTimeoutMs` 可注入并在 close 时清 timer）；`bindSupervisor`/`bindWorker` 角色消息类型白名单 + 每帧实例身份校验（不符回 `IDENTITY_MISMATCH` 且忽略、不销毁连接）+ stale `taskId/revision/runId` 忽略计数；`handleWorkerStart` 失败路径「lifecycle 已 closed → `releaseSlot()` + 抛含 `LAUNCH_FAILED`」；新增 `ProtocolErrorCode.IDENTITY_MISMATCH`、`resetStaleConnections()`、`worker_status.diagnostics`（6 项诊断计数）；`handleWorkerStart(params, probes, internal)` 测试接缝。
- 测试：新增 `test/connection.test.ts`（25 例）；`test/controller.test.ts`、`test/limits.test.ts` 的假 envelope 只补 `controllerId`/`workerId` 字段，未弱化任何既有断言。此步后全量 **109 passed**。

### 4. 第二组 2B 第二半（delivery-unknown + bootstrap 加固）

- 派发 → Worker `worker-c2a6d346` 实现 8 条新用例 → 主代理审查 → **revision 1** 修掉「`handleWorkerStart` catch 把『进程已确认退出』误判成『投递未知』」的顺序缺陷（child_exit 已上报时若因任务 ACK 超时保留名额，会把 lifecycle 卡在 closed 且 `worker_close` 永久失败，只能 `/worker-forget`）→ 验收通过、PID 38988 与 Supervisor 26724 确认退出。
- 落地内容：`MAX_UNKNOWN_DELIVERIES=64`、`ProtocolErrorCode.DELIVERY_UNKNOWN`、`UnknownDeliveryEntry`、`DeliveryUnknownError`、`recordUnknownDelivery()`（按 requestId 去重、FIFO 淘汰并计 `unknownDeliveriesDropped`）；四条链路（初始 task / followup / abort / close）ACK 超时一律登记并抛含 `[DELIVERY_UNKNOWN]` 的错误，绝不自动重发；`worker_stop` 超时仍置 `stopping` 但不报 `stopped`；`worker_start` 初始任务超时且连接存活时保持 `connected` 且不释放名额；`worker_close` 超时登记后在未确认退出的错误里附「关闭指令送达未知 (req: …)」。
- `runtime/bootstrap.mjs` 加固：未认证拒绝 `launch`/`terminate`（`AUTH_FAILED`）；`launchRequested` 独立布尔使重复 launch 回 `ALREADY_EXISTS` 且不 spawn 第二个子进程；`launch` payload 严格校验（失败回 `PROTOCOL_ERROR` + `launch_failed`，不 spawn）；接收缓冲超 2 MiB 停累积并销毁连接（无子进程时 `exit(1)`）。
- 测试：`test/connection.test.ts` 追加 8 例（含两个真实 bootstrap 子进程用例，使用新夹具 `test/fixtures/noop-pi-cli.mjs`，不启动真 Pi）。此步后全量 **118 passed**。

### 5. 第三组第一半（Controller 侧 session generation 与幂等清理）

- 派发 → Worker `worker-0be419c7` 实现 → 主代理审查通过 → 验收、`worker_close(accepted)`、PID 22740 确认退出。
- 落地内容：`handleSessionStart()`（递增 generation、销毁上一会话连接/server、`rejectWaiters("会话已切换…")`、活动实例降级 `disconnected` 但**绝不释放名额**、清会话级状态、`cleanupRegistry.disposeAll()+reset()`）；所有可能跨会话的异步回调（conn 消息、心跳、`waitForSupervisor`/`waitForWorkerReady`、`worker_wait` 超时、`worker_close` 等待循环、`stop/send/close` 的 await 之后）捕获 generation 并校验，失效计入 `staleCallbacksIgnored`；`CleanupRegistry` 新增 `reset()`/`size`；`dispose()` 幂等且覆盖 socket/server/timer/waiters、不释放名额；`bindWorker` 的 close 在 `closing` 时不再覆盖为 `disconnected`（追加 `conn_closed` 诊断）；双连接丢失且无 child_exit 时追加 `child_exit_unconfirmed`（含 pid/连接状态/taskState）且不释放名额；`handleWorkerClose` 用 `closeInFlight` 保证「ACK→child_exit→socket close」任意顺序只完成一次、`releaseSlot()` 只调用一次；`extension.ts` 改为 `await controller.handleSessionStart()`。
- 测试：新增 `test/generation.test.ts`（9 例）。此步后全量 **127 passed**。

### 6. 第三组第二半（Worker 侧 generation 防护）与随之发现的严重回归

- 派发 → Worker `worker-855b4b34` 实现 7 例 → 主代理审查通过 → 验收、`worker_close(accepted)`、PID 32988 确认退出。
- 落地内容：`WorkerManager` 引入 `SessionGenerationManager`/`activeGeneration`/`staleCallbacksIgnored`；`session_start` 区分「启动竞态」（`previousContext === null` → adopt 早到队列）与「真实会话切换」（清队列、作废候选、断开任务绑定）；followup 队列条目带 `sessionGeneration`；`dispatchUserMessage(text, ctx, gen)` 显式传 ctx/gen；`session_shutdown` 幂等（先递增 generation、清 context/队列/候选，conn 只 destroy 一次）。此步后全量 **134 passed**。
- **回归（真实环境才暴露）**：该实现用 `ctx !== this.currentContext`（以及 setImmediate 续段里的 `this.currentContext !== ctx`）判断会话归属。主代理用一次性探针直接驱动 `dist/` 起真实 WT + 真实 Worker（round 6 首跑）后复现：认证与 `worker_ready` 正常（deepseek/deepseek-flash/high）、任务派发正常、Worker **写完并自验证文件成功**，但主控 10 分钟收不到 `report_committed`，任务卡死 `busy`、诊断计数全 0。
- 根因（读 Pi 源码确认）：`.../pi-coding-agent/dist/core/extensions/runner.js` 的 `async emit(event)` 每次都是 `const ctx = this.createContext()` → **每个事件都是新的 ctx 对象**，跨事件身份比较恒为真，`agent_settled` 被静默忽略。
- 修复（Worker `worker-10528fd8`，独立复核通过）：删除全部跨事件 ctx 身份比较（`trySendWorkerReady`/`sendModelChanged`/`dispatchUserMessage`/`agent_settled` 及其 setImmediate 续段/`worker_report` 工具/close 的延迟 shutdown），保护条件统一为「generation 有效 + `currentContext` 非空」；`agent_settled` 入口在通过校验后把本次事件 ctx 记为 `currentContext`；真实会话切换额外清 `currentTaskId`（断开旧任务绑定，避免旧 settled 发 `report_missing`）；新增关键回归用例「session_start 与 agent_settled 传不同 ctx 对象时回执仍必须提交」（Worker 报告：临时还原身份比较后该用例确实失败，恢复修复版后通过）。此步后全量 **135 passed**。
- 该修复 Worker 自己的回执恰好也卡在 `report_candidate`（它的 Pi 进程在 21:58 启动，早于 21:59:52 落盘的修复，因此仍跑着旧代码）——这本身就是该回归的现场二次确认；主代理确认修复已在磁盘并通过全量测试后，用 `worker_close(abandoned)` 正常关闭它（close 路径不依赖 `agent_settled`，PID 32716 确认退出）。

### 7. 修复后的真实端到端验收（探针直连 `dist/`，共 4 轮全 PASS）

探针脚本（临时 `.probe-real-launch.mjs`，验证后已删除）直接 `import dist/controller.js`，构造 `ControllerManager`（pi 用最小 stub）→ `await handleSessionStart()` → `handleWorkerStart` → 轮询 `worker_wait`/`worker_status` → 独立校验 JSON → 等 `activity=idle` → `worker_close(accepted)`。

| 轮次 | worker_start 参数 | 实际 worker_status 模型 | Worker 命令行（系统查询原文） | 结果 |
|---|---|---|---|---|
| 6（修复后复跑） | 不传模型参数 | `deepseek / deepseek-flash / high` | （该轮未采集命令行，见第 9 轮同路径） | PASS |
| 7 | provider=deepseek, model=deepseek-flash, thinkingLevel=low | `deepseek / deepseek-flash / low` | 见第 8 轮 | PASS |
| 8 | provider=deepseek, model=deepseek-flash, thinkingLevel=low | `deepseek / deepseek-flash / low` | `"D:\Program Files\nodejs\node.exe" ...\dist\bundle\cli.js --no-extensions -e E:\web\pi-terminal-worker --provider deepseek --model deepseek-flash --thinking low` | PASS |
| 9 | 不传模型参数 | `deepseek / deepseek-flash / high` | 同上路径，末尾为 `--provider deepseek --model deepseek-flash --thinking high` | PASS |

每轮记录（事件与状态）：

- `worker_start` → cursor `1` `child_spawned`（各轮 Worker PID：round 6 复跑 `23612`、round 7 `23224`、round 8 `33012`、round 9 `41392`）→ `worker_ready`（工具集恒为 `read/bash/edit/write/worker_report`，未暴露派发/subagent 工具）→ `task_accepted` → `activity`（busy/toolName）→ `report_candidate` → `report_committed`（`taskState=ready_for_review`）→ `activity idle`。
- 每轮 `diagnostics` 全 0（`droppedInboxEvents`/`inboxRejectedEvents`/`reportCacheRejected`/`identityRejectedEvents`/`staleIgnoredEvents`/`roleRejectedEvents`/`unknownDeliveriesDropped`/`staleCallbacksIgnored`），`unknownDeliveries` 为空。
- 每轮 `committedReport.kind=result`、`validation` 含可复跑命令（原文含 `node -e ...` 与 `PASS round-<N>` 输出）、`unresolved=[]`；主代理独立核对 `docs/verification/local-worker-round-6/7/8/9.json`（精确内容 + 末尾恰好一个换行）全部 PASS。
- 每轮 `worker_close(accepted)` 返回 `ok=true`，`hasActiveInstance() === false`（名额已释放）；末次系统查询确认无残留 `runtime/bootstrap.mjs` 进程。
- 说明：探针修复前的首跑（round 6 attempt 1，Worker PID 17412，跑的是修复前的 buggy worker.ts）失败：Worker 写完并自验证文件成功，但主控收不到 `report_committed`；该轮遗留的孤儿 Worker + Supervisor 由主代理用 `Stop-Process` 清理（见第 6 节）。修复后的 round 6 复跑及后续各轮均 PASS。
- 说明：round 6 复跑时探针在 `report_committed` 后立刻尝试验收，因 `activityState` 仍为 `busy`（`idle` 事件尚在途中）被验收门禁正确拒绝；探针改为「等 `activity=idle`」后通过。这属于探针自身的时序问题，不是产品缺陷——门禁行为符合设计（`result + idle + connected` 才允许 accepted）。此后所有轮次都以 `worker_close(accepted)` 正常收敛，未再使用强杀。

### 8. 当前工作区与交付边界

- 最终基线：`npm run build` 干净、`timeout 180s npm test` → **135 passed / 0 failed / suites 21 / skipped 0**、`git diff --check` exit 0（仅 Git LF/CRLF 提示）。
- 新增文件：`test/connection.test.ts`(25)、`test/generation.test.ts`(9)、`test/worker-generation.test.ts`(8)、`test/limits.test.ts`(14)、`test/fault-injection.test.ts`、`test/fixtures/noop-pi-cli.mjs`、`docs/verification/local-worker-round-5..9.json`。
- 修改文件：`src/controller.ts`、`src/worker.ts`、`src/protocol.ts`、`src/transport.ts`、`src/launcher.ts`、`src/lifecycle.ts`、`src/extension.ts`、`runtime/bootstrap.mjs`、`README.md` 及既有测试。
- 一次性探针（`.probe-*.mjs`）已删除，`git status` 无残留；未 `git add/commit/push`；未修改全局 `settings.json`；未恢复 `docs/manual-acceptance.md`；未删除未跟踪设计文档与 `docs/verification/`。

### 9. 仍未验证 / 下一次接管建议

1. **重启 Pi 后的扩展正常路径验收**：当前主 Pi 会话加载的仍是改动前的扩展实例，本轮的 `worker_start`（round 5）只覆盖了旧构建；新代码的端到端证据来自探针直连 `dist/`（round 6/7/8/9）。建议用户重启 Pi 后，用扩展正常路径各做一轮「默认模型」和「显式模型参数」`worker_start` 复验（命令行应分别出现 `--thinking high` 与显式参数）。
2. **无 WT 机器上的 PowerShell/CMD 回退**：本机装有 WT，`detectTerminalBackends` 只有探测/参数解析级的测试（`test/launcher.test.ts`、`docs/verification/native-shell-check.mjs`），未做真实回退开窗端到端验收。
3. **`worker_close(accepted)` 门禁与 `unresolved` 的关系**：门禁要求回执 `unresolved` 为空数组。若后续把「跨组待办」写进 `unresolved`，验收会被拒绝；现有约定是跨组事项写在 `summary` 的独立小节。
4. **PowerShell `Start-Process`/CMD `start` 的复杂参数**：沿用上一轮结论（含空格/中文/`&`/`%`/`!` 的路径未做真实端到端，仅脚本级校验）。
5. 提交与推送仍未进行：三组功能已全部落地并通过自动化 + 真实探针验收，是否 `git commit` 由用户决定。

---

## 打包与安装（供用户自测，2026-09-29）

### 1. 打包改动（`package.json`，本仓新增的未提交改动）

1. `files` 从 `["dist", "runtime", "README.md", "LICENSE"]` 改为 `["dist", "runtime", "src", "README.md", "LICENSE"]`。原因：`pi.extensions` 指向 `./src/extension.ts`（文档示例中的推荐 TS 入口形式），旧 `files` 不包含 `src`，打包后 Pi 会找不到扩展入口 → 安装即坏。
2. 新增 `"prepack": "npm run build"`，保证 `npm pack` 时 `dist/` 一定是刚从 `src/` 构建出来的，不会把旧构建打进包。
3. 其余字段（`main`/`exports`/`peerDependencies`/`pi.extensions`）未动；`runtime/bootstrap.mjs` 随包分发不变。

验证：`git diff --stat -- package.json` → 仅 2 行新增。`npm run build` 干净、全量测试仍 **135 passed / 0 failed**。

### 2. 打包与安装过程

```bash
cd E:/web/pi-terminal-worker
npm run build && npm pack --pack-destination /tmp
# 产物：mozhi0012-pi-terminal-worker-0.1.0.tgz（44 个文件：dist 32 / src 8 / runtime 1 / package.json / README.md / LICENSE）
cp /tmp/mozhi0012-pi-terminal-worker-0.1.0.tgz E:/web/mozhi0012-pi-terminal-worker-0.1.0.tgz
rm -rf E:/web/ptw-installed && mkdir -p E:/web/ptw-installed
tar -xzf E:/web/mozhi0012-pi-terminal-worker-0.1.0.tgz -C E:/web/ptw-installed --strip-components=1
pi install 'E:\web\ptw-installed'      # 写入 ~/.pi/agent/settings.json
pi remove  'E:\web\pi-terminal-worker'  # 移除旧的本地路径项，避免同一扩展被加载两次
pi list                                  # 确认只剩 E:\web\ptw-installed 一个 pi-terminal-worker 项
```

`settings.json` 变更（仅 packages 数组一行，其他字段与顺序未变，原文件已备份到 `/tmp/settings.json.bak`）：

```diff
-    "E:\\web\\pi-terminal-worker"
+    "E:\\web\\ptw-installed"
```

安装目录 `E:\web\ptw-installed` 内容与 tarball 一致（`dist/`、`src/`、`runtime/`、`package.json`、`README.md`、`LICENSE`），**没有 node_modules**——这是正确的：Pi 的扩展加载器把 `typebox` 和 `@earendil-works/pi-*` 映射到自带副本（见 `pi-coding-agent/dist/core/extensions/loader.js` 与 `virtual-modules.js`）。

### 3. 打包产物真实验收证据

1. **真实端到端（探针）**：从安装目录加载 `dist/controller.js` 启动一轮真实 WT + 真实 Worker，Worker 由该安装目录加载（命令行原文）：
   `"D:\Program Files\nodejs\node.exe" ...\pi-coding-agent\dist\bundle\cli.js --no-extensions -e E:\web\ptw-installed --provider deepseek --model deepseek-flash --thinking high`
   结果：`worker_ready`（`deepseek/deepseek-flash/high`，工具 `read/bash/edit/write/worker_report`）→ `report_committed` → 独立核对 `docs/verification/local-worker-round-10.json` PASS → `activity idle` → `worker_close(accepted)` OK、名额释放。**RESULT: PASS**，无残留进程。探针脚本在仓库外，验证后已删除。
2. **Pi 自身加载检查**：`node <pi-cli> -e 'E:\web\ptw-installed' --list-models deepseek-flash` 正常输出且无扩展加载错误；`node <pi-cli> -e 'E:\web\ptw-installed' --no-session --no-builtin-tools --tools worker_status -p "只回复 ok"` 正常返回 `ok`（若 `worker_status` 未注册，Pi 会因未知工具报错）。

### 4. 用户自测步骤（重启 Pi 后）

1. 完全退出并重启 Pi（旧会话仍持有改动前的扩展实例）；启动后用 `pi list` 确认包项是 `E:\web\ptw-installed`。
2. 随便说一句让小任务，例如：「用 worker_start 在 E:\web\pi-terminal-worker 里做一个 xxx，要求 Worker 提交正式 result 回执」。
3. 期望观察：新 WT 窗口 + 独立 Worker Pi（默认 `deepseek / deepseek-flash / high`，可在 `worker_status` 里核对）、`worker_wait` 依次出现 `child_spawned → worker_ready → activity → report_candidate → report_committed`、`worker_status` 为 `ready_for_review + connected + idle`、`worker_close(accepted)` 成功。
4. 如需复现「会话切换」行为：在 Worker 窗口里 `/new`，主控侧应看到实例转为 `disconnected` 且**不释放名额**（需 `/worker-forget` 或正常 close 后重来）。

### 5. 回到开发模式 / 重新打包

- 想继续用工作区源码（改了代码立刻生效）：`pi install 'E:\web\pi-terminal-worker'` 然后 `pi remove 'E:\web\ptw-installed'`，重启 Pi。
- 想更新打包版本：在仓库里改代码 → `npm run build && npm test` → `npm pack`（`prepack` 会自动 build）→ 把 tarball 重新解包**覆盖** `E:\web\ptw-installed`（`rm -rf` + `tar -xzf ... --strip-components=1`）→ 重启 Pi。注意不要带 `node_modules`（不需要），也不要解包出多一层 `package/` 目录。
- 回滚到本轮安装之前的状态：恢复 `/tmp/settings.json.bak`（或执行上面第 5 节第一条命令）。

## 严格协议模式接入生产入口 + 安装目录更新（2026-09-29 深夜，本轮）

### 1. 本轮改动（仍未提交）

针对上一轮 review 遗留的两项「中风险」问题收尾：

- `src/extension.ts`：新增导出 `STRICT_PROTOCOL = true` 与 `createControllerManager(pi)` / `createWorkerManager(pi)` 两个工厂（都传入 `STRICT_PROTOCOL`），默认导出的两个分支改走工厂。**生产入口固定开启严格协议**（入站 seq 严格递增 + Worker 任务身份/版本校验）；`ControllerManager` / `WorkerManager` 构造参数默认值仍为 `false`，只给测试桩用。
- `src/worker.ts`：`validateTaskTransition()` 的 4 处拒绝改为抛 `ProtocolValidationError(INVALID_STATE / IDENTITY_MISMATCH)`（错误文本不变）；task / followup 两处 `catch` 把错误码传给 `sendAck`，失败 ACK 现在带结构化 `code`。拒绝仍发生在修改 `currentTaskId/currentRevision/currentRunId` 之前。
- 新增测试：`test/extension.test.ts`（`STRICT_PROTOCOL===true`、两个工厂产出的实例 `strictProtocol===true`）；`test/transport.test.ts` 新增「入站 seq 严格递增校验」3 例（重复 seq、倒退 seq 均回 `PROTOCOL_ERROR` 并销毁连接；跳号 1/100/500 全部接受且连接存活）；`test/fault-injection.test.ts` 新增「2B: Worker 任务身份与版本校验」3 例（旧 taskId followup→`IDENTITY_MISMATCH`、旧 revision/runId→`INVALID_STATE`、已绑定后再来初始 task→`INVALID_STATE`；每例都断言内部任务状态与派发数未被污染）。
- 3 个既有用例按新协议语义修正（未削弱任何校验）：`limits.test.ts` 管道集成改为「1 task + 8 followup(runId 2..9)」，第 9 条消息 `QUEUE_FULL`；`worker-generation.test.ts`「真实会话切换」把发送的 taskId 对齐当前绑定并删掉冗余 no-op 行；「启动竞态」第二条改为同 taskId 的 followup(runId=2)。
- 设计文档 `docs/pi-terminal-worker-扩展设计与实施方案.md`：5.2 补 seq 严格递增/重复倒退即拒/允许跳号；5.4 补 Worker 侧任务迁移规则与失败 ACK 错误码、且不得修改当前绑定。

### 2. 验证证据（主代理实跑，非仅采信回执）

- `npm run build` → 退出码 0。
- `timeout 300 npm test` → **tests 144 / suites 24 / pass 144 / fail 0**（上一轮基线 135 passed；本轮净增 9 例，另修正 3 例）。
- `git diff --check` → 无空白错误输出（仅有既有 `core.autocrlf` CRLF warning）。
- 反向验证（主代理独立复现，证明新用例不是恒真）：把 `dist/transport.js` 里严格判定临时改为 `if (false)` 后只跑 transport 测试 → **pass 14 / fail 2**，失败恰为「重复 seq」「倒退 seq」（等待条件超时），跳号用例仍 pass；随后重跑 `npm run build` 并确认 `dist/transport.js` 与改动前逐字节相同（`DIST_RESTORED_IDENTICAL`），全量测试回到 144 pass / 0 fail。
- 本轮实现由受控 Worker（默认 `deepseek/deepseek-flash/high`）完成，主代理逐项复核 diff、复跑上述命令，并对两处「指令偏差」做了判定（均为下发指令自相矛盾，实测行为符合协议语义，无需返修）。

### 3. 安装目录已更新到本轮代码

```bash
cd E:/web/pi-terminal-worker && npm pack --pack-destination /tmp
# 产物 mozhi0012-pi-terminal-worker-0.1.0.tgz，44 个文件，sha1 62221059e7e53442190047e7441e357160b616ab
cp /tmp/mozhi0012-pi-terminal-worker-0.1.0.tgz E:/web/mozhi0012-pi-terminal-worker-0.1.0.tgz
rm -rf E:/web/ptw-installed && mkdir -p E:/web/ptw-installed
tar -xzf E:/web/mozhi0012-pi-terminal-worker-0.1.0.tgz -C E:/web/ptw-installed --strip-components=1
```

- `diff -r <tarball 解包树> E:/web/ptw-installed` 无差异；`src/extension.ts`、`src/worker.ts`、`src/transport.ts`、`dist/extension.js`、`dist/worker.js`、`dist/transport.js`、`runtime/bootstrap.mjs`、`package.json` 与工作区逐字节相同。
- `settings.json` 未改动，仍指向 `E:\web\ptw-installed`；安装目录仍不带 `node_modules`。
- 注意：直接 `node` 导入 `E:\web\ptw-installed\dist\controller.js` 会因缺少 `typebox` 报 `ERR_MODULE_NOT_FOUND`（Pi 加载器才做虚拟模块映射）。需要跑独立探针时，把同一个 tarball 解包到仓库内临时目录（父目录能找到 `node_modules`）即可。

### 4. 严格模式真实端到端验收（round 11，RESULT: PASS）

- 探针从与安装目录逐字节相同的 tarball 解包副本加载 `dist/controller.js`，显式 `new ControllerManager(fakePi, true)`（严格模式开启）；真实 Windows Terminal 窗口 + 真实 Worker 从同一副本加载，默认 `deepseek / deepseek-flash / high`。
- 事件链（`worker_wait` 实收）：`child_spawned(pid 3716)` → `worker_ready` → `task_accepted` → `activity(busy: bash/write/bash)` → `report_candidate` → `report_committed` → `activity(idle)`；最终 `worker_state = ready_for_review + connected + idle`，`diagnostics` 全 0，`unknownDeliveries` 为空。**严格 seq 校验没有破坏真实 bootstrap/supervisor/worker 握手链路。**
- Worker 写入 `docs/verification/local-worker-round-11.json`，主代理独立 `JSON.parse` 校验 `round=11`、`strictTransport=true` 后才验收；`worker_close(accepted)` 成功，PID 3716 已退出、名额释放。
- 探针脚本与临时解包目录均已删除；`git status --short` 与验证前一致（仅多出 `test/extension.test.ts` 与 round-11 证据文件）。

### 5. 仍未做

- **未 commit / 未 push**，保持未提交工作区现状。
- 需要用户重启 Pi 后，由扩展正常路径（`E:\web\ptw-installed`）再跑一轮 `worker_start`：当前主 Pi 会话里加载的仍是改动前的扩展实例。

### 6. 重启后的正常路径验收（round 12，RESULT: PASS）

- 用户重启 Pi 后，`pi list` 确认当前扩展源为 `E:\web\ptw-installed`，其 `src/extension.ts`、`src/worker.ts`、`src/transport.ts` 与已提交的 `0ebe2d2` 逐字节一致。
- 通过扩展正常路径（主控 `worker_start` 工具，生产入口 `STRICT_PROTOCOL=true`）启动真实 Windows Terminal + 真实 Worker，默认 `deepseek / deepseek-flash / high`。
- 事件链：`child_spawned(pid 39720)` → `worker_ready` → `task_accepted` → `activity(busy: bash×3/write/bash)` → `report_candidate` → `report_committed`（`ready_for_review + connected + idle`）；`diagnostics` 全 0，`unknownDeliveries` 为空。
- Worker 创建 `docs/verification/local-worker-round-12.json`（294 字节，单行，LF），主代理独立 `JSON.parse` 校验 `round=12`、`strictTransport=true`、`extensionSource="E:\\web\\ptw-installed"`、无 CR；`git status --short` 仅多出该一个文件，无其他改动。
- `worker_close(accepted)` 成功，PID 39720 已退出、名额释放。**结论：严格协议模式在生产入口默认开启后，扩展正常路径完全可用。**

### 7. 提交与推送

- 上述三组功能 + 本轮严格模式收尾已作为一个提交落地：`0ebe2d2`（38 files, +9169/-495），并推送到 `origin/main`（`ae99de7..0ebe2d2`）。
- 工作区仅保留 round-12 验收证据文件（见上节），其余全部已提交。

