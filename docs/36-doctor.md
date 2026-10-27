# `agentcorps doctor` 诊断

`doctor` 用于在第一次运行 AgentCorps 或桌面端无法连接时快速确认本地环境。它不会发送提示词，也不会把 API key 的值写入输出；它只报告是否发现对应的环境变量名称。

```bash
agentcorps doctor
agentcorps doctor --json
agentcorps doctor --strict
```

## 检查内容

- `config`：配置文件是否存在且可解析。没有配置文件时使用版本化默认配置。
- `data`：默认数据目录是否存在并可写，以及 SQLite 数据库路径。
- `gateway`：配置中的 HTTP Gateway 健康检查。默认地址为 `http://127.0.0.1:43210`。
- `agents`：每个内置 Agent 工具的可执行文件和版本探测。
- `login`：根据工具常见配置检查 API key 环境变量是否存在。交互式登录、系统钥匙串和浏览器会话不能通过不接触凭据的本地检查完全确认，因此诊断会给出登录提示而不是伪造“已登录”。
- `model`：当前工具配置的模型、全局默认模型，或 `provider default`。

`--json` 适合桌面端、脚本和 CI 读取。顶层状态为 `healthy`、`warning` 或 `error`；`--strict` 在状态不是 `healthy` 时返回退出码 `1`。没有安装所有可选外部 Agent 会产生 warning，不会阻止使用 `mock` Agent 或已安装的其他工具。

## 配置模型与工具

在 `~/.agentcorps/config.json` 中设置默认工具和模型：

```json
{
  "version": 1,
  "defaults": {
    "agent": "claude-code",
    "model": "sonnet"
  },
  "tools": {
    "claude-code": {
      "model": "sonnet"
    }
  }
}
```

不同厂商的登录命令和模型名称由厂商 CLI 决定。先按官方文档完成登录，再运行 `agentcorps doctor` 和一次低风险 `agentcorps run` 验证实际输出。诊断能确认可执行文件版本和本地配置，不能替代厂商服务端认证测试。
