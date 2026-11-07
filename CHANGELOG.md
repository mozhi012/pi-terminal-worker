# 更新记录

## Unreleased

- 修复非强制关闭 Worker 等待退出确认超时后，终端已关闭但状态仍停在 `closing`、名额未释放的问题；关闭结果明确提示进程退出未确认。
- 修复 herdr 将 `-bash`、`-zsh` 等登录 shell 误判为不支持的 shell 的问题。
