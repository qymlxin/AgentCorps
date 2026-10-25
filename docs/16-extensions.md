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

注册时会验证类型、版本、权限、事件和冲突声明。加载未知权限会失败，而不是静默丢弃。目录扫描会保留来源路径并为原始清单计算 SHA-256 内容哈希；同一 ID 的不同版本或内容会显式冲突，不会静默覆盖。来源优先级用于确定性排序，但冲突仍要求调用方解决。正文是上下文数据，不是宿主进程代码；插件和 hook 的执行器仍必须通过独立进程和 `packages/security` 策略接入。

## 与供应商生态的关系

Codex 的 skills/AGENTS.md、Claude Code 的 CLAUDE.md/skills/subagents/hooks、Cursor 的 rules/skills/commands/hooks 等可以通过专用扫描器转换为清单，但文件命名和目录布局不写入核心注册表。适配器必须记录原始路径、工具版本和导入时间，便于供应商升级后重新验证。

## 当前接口

`scanMarkdownExtensions` 递归扫描目录，`ExtensionRegistry.registerAll` 按来源优先级确定性注册并拒绝内容冲突。命令参数 schema 使用 frontmatter 中的 JSON 对象保存，供上层命令入口做进一步校验。插件和 hook 的实际执行依旧必须由调用方选择沙箱、审批和失败策略。
