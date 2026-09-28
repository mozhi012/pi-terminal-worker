# pi-terminal-worker

> 独立 Windows Terminal 窗口中的受控执行端 Pi 扩展，通过原生命名管道实现双向闭环通信与单实例监督调度。

## 特性

- **独立终端交互**：使用 `wt.exe` 启动独立的交互式 Pi 窗口，保留原生 TUI，随时供人工观察与随时接管。
- **纯内存管道通讯**：通过 Windows 原生命名管道（`\\.\pipe\...`）实现双向 JSONL 通信，不在磁盘生成任何临时任务文件（不写 `pi-tasks/`、`task.md`、`result.md`）。
- **默认配置与安全隔离**：执行端使用默认模型配置，不继承主端临时模型；严格限制单实例名额与递归派发防线。
- **状态三维分离**：严格区分生命周期（`launching/connected/closed` 等）、任务状态（`created/running/ready_for_review/accepted` 等）与 Pi 活动状态（`idle/busy`）。
- **健全的回执与验收闭环**：候选回执在稳定边界确认；存在未解决问题或测试失败时严格拒绝验收。
- **人工介入识别**：实时识别执行窗口的人工敲键盘干预，自动作废候选回执并暂停后续排队派发。

## 安装

```bash
pi install npm:pi-terminal-worker
```

或者本地开发加载：

```bash
pi -e E:/web/pi-terminal-worker
```

## 工具与命令

### 主控侧工具 (LLM 可调用)
- `worker_start`：在独立 WT 窗口启动 Worker 并派发初始任务。
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

## 许可

[MIT](LICENSE)
