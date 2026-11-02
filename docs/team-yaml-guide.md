# 用 team.yaml 编排多 Agent 协作

本文介绍 `pi-terminal-worker` 0.3.0 起的角色配置方案，以及如何在自己的 skill 里使用它。

## 方案概览

多 Agent 协作要回答三个问题：谁来做（角色）、怎么协调（流程和通信）、靠什么共享信息（上下文）。这个方案把它们分到四层，每层只管一件事：

| 层 | 负责 | 由谁保证 |
|---|---|---|
| `SKILL.md` | 流程、派单模板、回执要求 | 模型遵守 |
| `team.yaml` | 角色对应的模型、写权限、数量上限 | 插件校验并强制执行 |
| `pi-terminal-worker` | 启动 Worker、通信、回执与验收 | 插件代码 |
| 本地文件 | 需求、决策、代码事实等共享上下文 | 约定 |

分层的原因是：写在提示词里的规则，模型可能读错或跳过。必须成立的约束（模型、权限、数量）交给代码，需要判断的部分（流程）留给模型。

```text
主代理                                      Worker 窗口
  │  worker_start({team, teamRole, ...})        │
  ├─ 读取 skill 目录下的 team.yaml               │
  ├─ 校验配置，检查数量上限                       │
  ├─ 用配置里的模型启动 ───────────────────────> │ 模型、工具策略在启动时固定
  │                                             │ 每次工具调用先过策略检查
  │ <──────────── 回执（交付/提问/阻塞）──────── │
  └─ 验收、返修或关闭                            │
```

## 快速开始

需要 `pi-terminal-worker` 0.3.0 或更高版本。升级后要**重启 Pi**，运行中的会话不会加载新版本。

```bash
pi update --extension npm:@mozhi0012/pi-terminal-worker
```

**第 1 步：** 在 skill 目录下新建 `team.yaml`。

```yaml
# ~/.pi/agent/skills/my-skill/team.yaml
version: 1
roles:
  reviewer:
    provider: magpie
    model: antigravity/gemini-4-argon
    thinking: high
    write: none
```

**第 2 步：** 在 `SKILL.md` 里引用角色，不要再写模型。

```text
用 worker_start 启动审查 Worker，传 team: "my-skill"、teamRole: "reviewer"、cwd、title、task。
不要传 provider、model、thinkingLevel。

检查返回值的 team 字段。没有这个字段，说明插件低于 0.3.0，用 worker_close 关闭并告诉用户升级。
```

最后这条检查不能省：旧版插件会忽略 `team` 参数，并用默认模型启动。

**第 3 步：** 运行 skill。`worker_start` 的返回值会带上解析结果：

```json
{
  "ok": true,
  "workerId": "worker-fca3b4c8",
  "team": {
    "name": "my-skill",
    "role": "reviewer",
    "provider": "magpie",
    "model": "antigravity/gemini-4-argon",
    "thinkingLevel": "high",
    "write": "none",
    "configPath": "C:\\Users\\...\\skills\\my-skill\\team.yaml"
  }
}
```

`worker_list` 也会显示每个实例的 `team` 和 `teamRole`。

## team.yaml 参考

**位置：** `~/.pi/agent/skills/<team>/team.yaml`。设置了 `PI_CODING_AGENT_DIR` 时以它为准。`team` 参数就是这个目录名。

插件不读工作目录下的 `.pi`。启动 Worker 时目标目录可能尚未被信任，项目文件不能决定模型和写权限。

**生效时机：** 每次 `worker_start` 都重新读取，改完下一次启动就生效。

```yaml
version: 1                # 必填，目前只能是 1
limits:                   # 可选
  maxConcurrent: 3        # 本 team 同时存活的实例上限
roles:                    # 必填，至少一个角色
  implementer:            # 角色名：小写字母开头，可含数字、- 和 _
    tier: worker          # 可选：worker（默认）或 lead
    provider: magpie      # 必填
    model: codex/gpt-6.1-sol   # 必填
    thinking: high        # 必填：off | minimal | low | medium | high | xhigh | max
    write: scoped         # 必填：none | scoped | any
    max: 2                # 可选：本角色同时存活的实例上限
    denyTools:            # 可选：额外禁用的工具，支持 * 通配
      - "mcp__*__execute_sql"
```

未知字段和非法取值会让启动直接失败，不会被静默忽略，所以拼错的限制项不会悄悄失效。

**数量上限：** 按当前主控会话计算，已验收、已放弃或已退出的实例不占名额。上限不是全局的，每个 lead 都有自己的计数。

**tier：** `lead` 可以继续派发 Worker，只有顶层主代理能启动，lead 不能再启动 lead。

## 写权限

| `write` | `write` / `edit` | `code_rewrite`（`dry_run: false`） | `bash` | 适合 |
|---|---|---|---|---|
| `none` | 拦截，且从工具列表隐藏 | 拦截 | 拦截识别出的写操作 | 审查、探索 |
| `scoped` | 只允许 `allowedPaths` 内 | 只允许 `allowedPaths` 内 | **不检查** | 执行 |
| `any` | 不限 | 不限 | 不限 | lead |

`denyTools` 在三档下都生效。被拦截时，模型会收到原因，并被提示用 `worker_report` 报告 `blocked`。

### allowedPaths

- `write: scoped` 时必须提供，`write: none` 时不能提供。
- 相对路径按 `cwd` 解析。
- 可写文件、目录，也可带 `/`、`/*`、`/**` 后缀，三者都表示整个目录。
- 其他通配符（如 `src/*.ts`）无法精确校验，会被拒绝。
- 判断时会解开符号链接，`../` 穿越和指向范围外的链接都会被拦住。

### 只读角色的 bash 拦截范围

会拦截：

- 输出重定向（到 `/dev/null`、`NUL` 或 `>&2` 除外）。
- `rm`、`mv`、`cp`、`mkdir`、`touch`、`tee`、`chmod`、`dd`、`rsync`、`patch` 等写命令，包括前面带 `sudo`、`env`、`xargs` 或环境变量赋值的情况。
- `sed -i`、`perl -i`、`find -delete`，以及 `find -exec` 后接写命令。
- `git commit`、`push`、`pull`、`add`、`rm`、`mv`、`reset`、`checkout`、`switch`、`restore`、`merge`、`rebase`、`cherry-pick`、`revert`、`clean`、`apply`、`am`，以及 `git stash`（`list`、`show` 除外）和 `git worktree add/remove/move`。

不会拦截：`git diff`、`git log`、`rg`、`cat`、`npm test` 这类只读或测试命令。

## 这不是安全沙箱

权限策略用来防止模型误操作，挡不住有意绕过：

- `python -c`、`node -e`、`bash -c "..."` 以及 `npm run` 脚本内部的写入识别不到。
- `write: scoped` 不检查 `bash`，所以执行 Worker 的 `git commit` 拦不住。"不要提交"这类规则还要写在 skill 里。
- 模型不传 `team` 时仍可自选模型。"必须用 team"也要写在 skill 里。

要防范不可信代码，请使用操作系统层面的隔离。

## 错误与排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `[TEAM_CONFIG_ERROR] 找不到 team` | 配置路径不对 | 核对错误信息里的路径 |
| `[TEAM_CONFIG_ERROR] 含未知字段` 等 | 配置有误 | 按错误信息修改 `team.yaml` |
| `使用 team 时不能同时传 model` | 调用时又传了模型 | 去掉参数，要改就改 `team.yaml` |
| `[TEAM_LIMIT_REACHED]` | 达到数量上限 | 关闭已有实例或调大上限 |
| 返回值没有 `team` 字段 | 插件低于 0.3.0 或会话未重启 | 升级插件并重启 Pi |
| `worker_ready` 握手超时 | 多半是 Worker 卡在项目信任确认上（目录含 `.pi/` 且未被信任） | 看新窗口；先在该目录信任一次 |
| 启动失败后窗口还在 | 插件为避免重复派发，保留占位 | `/worker-forget` 或强制关闭 |
| `report_missing` | Worker 停下了但没交正式回执 | 用 `worker_send` 催它提交 `kind="result"` |

Worker 正常结束或被主控关闭时，窗口会自动关闭。Worker 崩溃时窗口会留着，方便查看错误。

## 共享上下文的约定

插件不管这部分，以下是建议做法，和 `dev-large` 的 `workflow/<slug>/` 思路一致：

- 每个任务一个目录，放需求、计划、决策和报告。
- **不要复制代码片段**，代码一改副本就过期。只记 `文件:行号`、基线提交和结论。
- **每个文件只有一个写入者**。比如需求和决策由主代理写，Worker 只写自己的报告。这样不用加锁，也不会互相覆盖。

## 参考：dev-small 的配置

一个只读审查 Worker，全程只允许一个实例：

```yaml
version: 1
limits:
  maxConcurrent: 1
roles:
  reviewer:
    provider: magpie
    model: antigravity/gemini-4-argon
    thinking: high
    write: none
    max: 1
```

主代理自己写代码，方案审查和代码复审都发给这个 Worker。完整流程见 `~/.pi/agent/skills/dev-small/SKILL.md`。

## 不用 team.yaml 的情况

`team` 是可选的。不传时和之前完全一样：可以显式传 `provider`、`model`、`thinkingLevel`，也可以用默认配置，且不受写权限限制。`dev-medium` 和 `dev-large` 目前还是这种用法。
