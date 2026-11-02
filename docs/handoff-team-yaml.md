# 交接：多 Agent 协作方案（team.yaml）

更新于 2026-11-02。新会话从这里接手，不需要重读旧对话。使用说明见同目录的 `team-yaml-guide.md`。

## 背景与已定决策

用户想找多 Agent 协作的最佳实践，现有方案是 `pi-terminal-worker` 插件 + `dev-small` / `dev-medium` / `dev-large` 三个 skill + 本地文件共享上下文。

调研后的结论（用户已同意）：

- **主线是方案一**：继续用现有方案，把配置从提示词里抽出来，由插件强制执行。
- **herdr 不替代**：它管终端和 Agent 托管，不管派单、回执和验收。将来需要跨机器或 Linux 时，可以作为启动后端。
- **DeepSeek Harness（dsh）暂不迁移**：开发者预览版，会有破坏性变更；官方 Team 不支持嵌套；Windows 沙箱会改目录 ACL。
- **skill 不当唯一配置**：流程写在 `SKILL.md`（模型遵守），角色、模型、权限写在 `team.yaml`（插件强制）。
- **不追求 Worker 之间直接通信**：有需要时再按"正文写文件、消息只传路径、抄送上级"做。

## 当前状态

| 项 | 状态 |
|---|---|
| 插件 0.3.0 | 已提交 `732784a`，已发布 npm（`latest`），已用 `pi update` 装到本机 |
| GitHub | 已推送到 `origin/main` |
| 本文档和 `team-yaml-guide.md` | 已提交并推送 |
| `dev-small` | 已切换到 `team.yaml`（`~/.pi/agent/skills/dev-small/`，该目录不在 git 里） |
| `dev-medium` / `dev-large` | 未改，仍显式传模型，不受影响 |
| 流程配置、每任务一个目录 | 未做 |

**这次切换后要重启 Pi 才生效。** 运行中的会话缓存的是启动时加载的插件。在旧会话里用 `/skill:dev-small`，启动后会因返回值没有 `team` 字段而停下。

## 已验证与未验证

已验证：

- `npm test`：357 个全部通过。
- `node test/e2e-team.mjs`：13/13，真实窗口、真实模型（`gemini-3.8-flash`），无人工操作。
- 已安装的 0.3.0 + 真实 `pi -p` 主控：8 项通过。Worker 实际模型 `magpie/antigravity/gemini-4-argon`、思考级别 `high`、`touch` 被拦截、第二个审查 Worker 被 `TEAM_LIMIT_REACHED` 拒绝、验收关闭后无残留进程。结论来自 Worker 会话日志和磁盘。

未验证：

- **完整的 `/skill:dev-small` 流程**（方案审查 → 实施 → 复审）没有跑过。
- **强制关闭后窗口是否真的消失**。bootstrap 退出码已确认为 0，但窗口肉眼看不到，需要用户下次留意。

## 下一步（按顺序）

1. 让用户重启 Pi，用一个小改动真实跑一次 `/skill:dev-small`。
2. 推广到 `dev-medium`、`dev-large`，先解决下面的设计问题。
3. 做方案一剩下的部分：流程配置、每任务一个目录。
4. 可选：`dsh-agent-teams` 限时对比试用（同一 `dev-medium` 规模任务，比较返修次数、人工介入、token 成本、中断恢复）。放在一次性目录副本里跑，因为 dsh 的沙箱可能改 ACL。

### 推广前要解决的设计问题

- **`dev-medium` 的备用模型**：它在 `gpt-6.1-sol` 不可用时切到 `shuaiapi/gpt-6.1-sol`（`SKILL.md` 第 26 行）。`team.yaml` 没有备用模型字段，要么加字段，要么写成第二个角色。
- **`dev-large` 的配置来源冲突**：现在"以用户确认的 `plan.md` 为准"，和 `team.yaml` 作为唯一来源冲突，要定谁优先。
- **执行 Worker "不 commit"无法强制**：`scoped` 不检查 `bash`，`git commit` 拦不住。只读角色才会拦。
- **lead 的权限**：lead 要改状态文件并提交，大概只能用 `write: any`。
- **上限的作用域**：`limits` 按主控会话计算，每个 lead 有自己的协调器，不是全局上限。

## 改动位置

插件仓库 `E:/web/pi-terminal-worker`：

| 文件 | 内容 |
|---|---|
| `src/team-config.ts` | 解析和校验 `team.yaml`，`resolveTeamStart` |
| `src/tool-policy.ts` | 策略编码、路径判断、bash 写命令识别、`evaluateToolCall` |
| `src/multi-worker.ts` | `worker_start` 的 `team`/`teamRole` 参数、数量上限、返回值 |
| `src/controller.ts` | 通过内部参数传策略，写入 `launch` 载荷 |
| `src/worker.ts` | `tool_call` 钩子执行策略，隐藏工具 |
| `runtime/bootstrap.mjs`、`bootstrap-support.mjs` | 策略写入环境变量（不继承上级）、主控要求终止时以 0 退出 |
| `test/team.test.ts`、`test/e2e-team.mjs` | 单元测试、真实窗口验证 |

策略传递路径：`team.yaml` → 协调器 → `launch` 载荷 → bootstrap 设置 `PI_TERMINAL_WORKER_TOOL_POLICY` → Worker 的 `tool_call` 钩子。不走工具入参，模型无法伪造。

本机：`~/.pi/agent/skills/dev-small/{team.yaml,SKILL.md}`。

## 踩过的坑

- **Pi 项目信任弹窗**：工作目录含 `.pi/` 且未被信任时，Worker 卡在确认上，表现为 30 秒 `worker_ready` 握手超时。测试目录不能有 `.pi/`。曾因此得出无效的 12/12（用户手动点了 Trust），也误判过是冷启动编译或 `--tools` 的问题。
- **项目级 `team.yaml` 已去掉**：主控读取时目标目录可能未被信任，不能让项目文件决定模型和写权限。e2e 通过 `PI_CODING_AGENT_DIR` 指向临时目录放配置，`isolated-pi-cli.mjs` 再恢复真实目录。
- **纯 Node 无法加载已安装包的 `dist`**：`typebox` 由 Pi 运行时提供。要验证已安装版本，请启动真实 `pi -p`。
- **Windows 上 `spawnSync(..., { shell: true })` 会截断多行参数**：直接用 `node <pi 的 dist/bundle/cli.js>`，不经过 shell。
- **模型可能只交 `kind="progress"` 就停下**：插件会判定为 `report_missing`，这是正确行为。脚本和主控要催一次。
- **`npm view` 发布后要等一会儿才更新**：`pi update --extension npm:@mozhi0012/pi-terminal-worker` 要等 `latest` 变了再跑。
- **启动失败的 Worker 窗口不会自动关**：占位和窗口都保留，要 `worker_close(force: true)`，否则进程残留并占用目录。

## 已知限制（P2，未修）

- `bash` 写命令识别是启发式的，`python -c`、`bash -c "..."`、`npm run` 脚本内的写入拦不住。
- 模型不传 `team` 时仍可自选模型，只能靠 skill 约束。
- 未信任且含 `.pi/` 的目录启动 Worker 会卡到超时（插件原有行为）。
- `pi-antigravity` 依赖的 `undici` 有高危漏洞（`npm audit` 报告），与本插件无关，未处理。

## 用户偏好

- 中文回答，简洁，先给结论。
- 说清实际验证了什么、没验证什么。
- 代码不自动提交；发布、推送要明确授权。
- 其余规则见 `~/.pi/agent/AGENTS.md`：Review 只修 P0/P1，联网用 Exa，派 Worker 前先列方案确认，shell 是 Git Bash。

## 常用命令

```bash
cd E:/web/pi-terminal-worker
npm run build && npm test                # 单元测试，约 15 秒
node test/e2e-team.mjs                   # 真实窗口验证，约 1 分钟，会弹窗并调用模型
pi update --extension npm:@mozhi0012/pi-terminal-worker   # 发布后更新本机
```
