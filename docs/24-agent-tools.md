# 外部工具接入与验证

所有工具共享 `--role`、`--role-file` 和 `--instructions`，通过提示词传入预设角色；角色不是权限隔离。新增七个工具默认使用 `developer`，显式角色或角色文件会替换这一默认值，而不是叠加冲突角色。新增工具只需注册定义及必要的输出解码器，CLI 自动支持列表、探测、执行和工具声明支持的模型选择。配置扩展格式见 [适配器](07-agent-adapters.md)。

## Kimi Code

```bash
agentcorps task probe --agent kimi
agentcorps task run TASK_ID --agent kimi --role reviewer --instructions "用中文报告问题"
```

默认调用 `kimi --output-format stream-json --prompt PROMPT`，支持 `--model`。解码 assistant 的字符串和文本块，工具结果与隐藏推理不会当作最终回复。凭据使用 Kimi 自身登录或 provider 配置；AgentCorps 不代为登录或改写配置。

面向当前 [Kimi Code 官方 CLI 文档](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html)。旧 Python `kimi-cli` 的 print 模式另需 `--print`；可用显式 `--agent-arg --print --agent-arg --output-format=stream-json --agent-arg -p` 覆盖参数。当前 Kimi 非交互 prompt 模式默认自动处理工具权限，这不是沙箱；只在受控工作区运行，必要时显式启用外部沙箱。

## 千问 Qwen Code

```bash
agentcorps task run TASK_ID --agent qwen --model qwen3-coder-plus --role tester
```

默认调用 `qwen --output-format stream-json --prompt PROMPT`。依据 [官方 headless 协议](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/) 提取 assistant 文本，跳过初始化、工具和推理事件，避免重复显示相同的最终 result；结构化失败即使退出码为 0 也判失败。默认不请求 partial 消息，避免与完整消息重复。通过千问自身配置完成鉴权，不自动开启 `--yolo` 或改写系统提示词。

## GLM / ZCode CLI

```bash
agentcorps task probe --agent zcode
agentcorps task run TASK_ID --agent zcode --role planner
```

使用智谱开源的 [ZCode CLI](https://github.com/zai-org/ZCode/tree/main/apps/zcode-cli)，默认调用 `zcode --output-format stream-json --no-color --prompt PROMPT`。根据其真实协议读取终结 `result.response`，而不是其他工具的 `result` 字段；多回合工作流只显示最后结算后的回答，暂不转发中间文本事件。

模型和 provider 由 ZCode 自身配置管理。官方 CLI 当前不支持 `--model`，因此 AgentCorps 会明确拒绝为此工具传入 `--model`，不会伪造参数。源码构建要求以官方文档为准；也可通过 `--agent-command /absolute/path/to/zcode` 使用独立二进制。

**权限注意：** ZCode 的 `--prompt` 模式缺省为 `yolo`，角色 `planner` / `reviewer` 不会降低权限。需要原生 plan 模式时，完整覆盖参数，例如 `--agent-arg --mode --agent-arg plan --agent-arg --output-format --agent-arg stream-json --agent-arg --no-color --agent-arg --prompt`；或者使用受控外部沙箱。工具权限拒绝后仍可能正常结束，不等价于任务通过验收。

## DeepSeek Harness

```bash
agentcorps task probe --agent deepseek-harness
agentcorps task run TASK_ID --agent deepseek-harness --role developer --instructions "先运行测试再修改"
```

使用 [DeepSeek 官方 Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `dsh --profile headless PROMPT`：创建一次持久化会话，打印最终文本并退出。`sdk`、`acp`、`web` 是不同的持久服务入口，不会误当一次性任务命令启动。官方包为 `@deepseek-ai/dsh`，AgentCorps 不自动安装或初始化个人配置。

首次运行可能自动初始化 headless profile；模型、凭据和插件通过 Harness 自身 profile 配置管理，此适配器不声明未验证的 `--model` 参数。项目仍处于 developer preview，升级后需复验命令接口。执行前阅读其 [安全说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)，角色提示词不能代替插件权限和进程隔离。

## OpenCode

```bash
agentcorps task run TASK_ID --agent opencode --model PROVIDER/MODEL --role reviewer
```

默认调用 `opencode run --format json PROMPT`，模型使用其原生 `provider/model` 标识。提取 `text.part.text`，跳过工具、步骤元数据与 reasoning；将嵌套 `error.data.message` 传播为任务失败。输出协议对照 [OpenCode 1.x v1.2.27 源码](https://github.com/anomalyco/opencode/blob/v1.2.27/packages/opencode/src/cli/cmd/run.ts)，命令参数见 [官方文档](https://opencode.ai/docs/cli/)。2.x 或其他破坏性协议变更需另行复验，不能仅凭版本探测宣称兼容。

使用 OpenCode 原生 provider 鉴权，不自动开启权限全批准、共享会话或续接旧会话。可移植角色通过任务提示词传递，与 OpenCode 原生 `--agent` 配置相互独立。

## Gemini CLI

```bash
agentcorps task run TASK_ID --agent gemini --role security --instructions "重点检查凭据泄露"
```

默认调用 `gemini --output-format stream-json --prompt PROMPT`，支持 `--model`。依据 [官方 headless 文档](https://geminicli.com/docs/cli/headless/) 和 [事件类型定义](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/output/types.ts) 转发 assistant message 文本，忽略用户输入回显、工具结果和统计；warning 保留为 stderr 诊断，error 或最终失败状态使任务失败。

本机 Gemini CLI `0.23.0` 已实际验证版本及帮助参数，接受上述输出格式、prompt 和 model 参数；该版本提示 `--prompt` 未来可能移除，升级时须复验。尚未执行带账号的模型调用。鉴权使用 Gemini 自身配置，不自动添加 `--yolo`。

## Aider

```bash
agentcorps task run TASK_ID --agent aider --model PROVIDER/MODEL --role developer
```

根据 [官方脚本模式](https://aider.chat/docs/scripting.html)，使用 `aider --no-auto-commits --no-dirty-commits --no-stream --no-pretty --no-gitignore --message PROMPT`，支持 `--model`。关闭 Aider 自主提交和修改 `.gitignore`，避免干扰项目的小步提交策略。不会自动添加全部确认参数；需要人工确认的操作可能被拒绝，或需要通过原生配置显式授权。

Aider 没有在此接口提供统一结构化结果，保留纯文本输出并依据进程退出状态判断执行失败；文本里的“失败”描述不能可靠自动分类。仍应独立检查补丁和测试结果。鉴权、可编辑文件范围、历史文件均由 Aider 原生配置控制。

## 验证边界

每个内置工具都有独立测试，使用真实本地子进程核对默认参数、模型参数、角色与记忆提示词、输出协议和错误传播。测试不需要厂商账号，不能代替已安装厂商 CLI 的鉴权、额度、网络和真实模型调用验收。`task probe` 仅运行版本命令，也不证明模型调用成功。兼容性以链接中的官方接口为准，升级 CLI 后应重新执行最小任务。
