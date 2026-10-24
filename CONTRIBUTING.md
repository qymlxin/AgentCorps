# AgentCorps 贡献与本地开发

## 环境

- Node.js 22+
- pnpm 9+
- macOS、Linux、Windows 均为目标平台；第一阶段优先验证 macOS

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## 原则

先更新 `docs/` 中的需求、架构或决策，再引入跨模块行为变化。提交前运行类型检查、测试和文档链接/图表检查。外部 Agent、MCP 服务、插件和渠道都属于不可信边界，不能直接获得宿主进程权限。
