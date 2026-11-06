# pi-terminal-worker 项目规则

## 验证

改动后必须全部通过：

```bash
npm run typecheck
npm test
```

涉及终端后端（herdr / tmux / wt / powershell / cmd）或 `runtime/` 的改动，尽量补做对应后端的端到端验证（参考 `test/e2e-terminal.mjs`）。herdr 实测只能用独立命名的会话（如 `herdr --session pitw-test`），不得操作用户默认的 herdr 会话。

## 提交与推送

- 本仓库没有 CI 部署，推送 main 不会影响任何线上环境。
- **验证通过后直接提交并推送到 main**，不建分支，不再询问。
- 只提交本次任务改动的文件；工作区里任务开始前已有的未提交改动保持原样，不纳入提交。

## 发布 npm

- 包名 `@mozhi0012/pi-terminal-worker`，用户通过 npm 安装使用；只推 main 不会让用户用上新代码。
- 发布只在用户明确要求时进行：按语义化版本修改 `package.json` 的 `version`（`npm version <x.y.z> --no-git-tag-version`），验证通过后提交推送，再执行 `npm publish`（`prepublishOnly` 会自动构建）。
- 发布后提醒用户运行 `pi update --extensions` 并重启 pi。
