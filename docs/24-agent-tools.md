# 外部工具接入与验证

所有工具共享 `--role`、`--role-file` 和 `--instructions`，通过提示词传入预设角色；角色不是权限隔离。新增工具只需注册定义及必要的输出解码器，CLI 自动支持列表、探测、模型选择和执行。配置扩展格式见 [适配器](07-agent-adapters.md)。

## Kimi Code

```bash
agentcorps task probe --agent kimi
agentcorps task run TASK_ID --agent kimi --role reviewer --instructions "用中文报告问题"
```

默认调用 `kimi --output-format stream-json --prompt PROMPT`，支持 `--model`。解码 assistant 的字符串和文本块，工具结果与隐藏推理不会当作最终回复。凭据使用 Kimi 自身登录或 provider 配置；AgentCorps 不代为登录或改写配置。

面向当前 [Kimi Code 官方 CLI 文档](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html)。旧 Python `kimi-cli` 的 print 模式另需 `--print`；可用显式 `--agent-arg --print --agent-arg --output-format=stream-json --agent-arg -p` 覆盖参数。当前 Kimi 非交互 prompt 模式默认自动处理工具权限，这不是沙箱；只在受控工作区运行，必要时显式启用外部沙箱。

## 验证边界

每个内置工具都有独立测试，使用真实本地子进程核对默认参数、模型参数、角色与记忆提示词、输出协议和错误传播。测试不需要厂商账号，不能代替已安装厂商 CLI 的鉴权、额度、网络和真实模型调用验收。`task probe` 仅运行版本命令，也不证明模型调用成功。兼容性以链接中的官方接口为准，升级 CLI 后应重新执行最小任务。
