# 扩展生态清单

> 版本：0.1.0

## 统一清单

`packages/extensions` 把不同 Agent 产品里的扩展概念映射成统一的 `ExtensionManifest`：

- `plugin`：可组合的功能包
- `skill`：可复用的领域指令和流程
- `rule`：持续适用的约束
- `command`：用户显式触发的命令模板
- `hook`：监听生命周期事件的处理器

每个清单至少包含 ID、类型、名称、语义化版本、描述、来源、权限和事件。Markdown 扩展使用 YAML 风格 frontmatter 加正文，适合导入 `SKILL.md`、规则文件和命令模板。

## 安全策略

注册时会验证类型、版本和权限。加载未知权限会失败，而不是静默丢弃。来源只用于追踪，不能因为来源是 workspace 或 remote 就自动获得执行权限。正文是上下文数据，不是宿主进程代码；插件和 hook 的执行器需要后续通过独立进程和 `packages/security` 策略接入。

## 与供应商生态的关系

Codex 的 skills/AGENTS.md、Claude Code 的 CLAUDE.md/skills/subagents/hooks、Cursor 的 rules/skills/commands/hooks 等可以通过专用扫描器转换为清单，但文件命名和目录布局不写入核心注册表。适配器必须记录原始路径、工具版本和导入时间，便于供应商升级后重新验证。

## 后续工作

- workspace/user/builtin/remote 多来源扫描与优先级
- 签名、哈希和来源锁定
- rule 冲突检测与命令参数 schema
- hook 事件过滤、超时、失败策略和审计
- 插件隔离进程与能力代理
