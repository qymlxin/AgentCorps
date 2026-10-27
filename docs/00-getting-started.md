# AgentCorps 开箱即用指南

这份指南从空目录开始，带你启动 AgentCorps、运行第一个 Agent、在终端 TUI（文本用户界面）和桌面端中继续会话，并在需要时处理审批。仓库当前提供的是本地优先产品：数据默认写入本机 `~/.agentcorps`，外部 Agent 的登录仍由对应厂商工具负责。

## 1. 环境要求

- Node.js 22 或更高版本
- pnpm 10
- 使用真实 Agent 时，先按厂商文档安装并登录对应 CLI
- 构建桌面端时需要 Rust、Xcode Command Line Tools 和 Tauri 依赖；只使用 CLI 或浏览器控制台时不需要 Rust

检查版本：

```bash
node --version
pnpm --version
```

## 2. 安装、构建和验证

在仓库根目录执行：

```bash
pnpm install
pnpm typecheck
pnpm test
```

构建 CLI：

```bash
pnpm --filter @agentcorps/cli build
```

构建完成后，下面的命令都可以把 `node apps/cli/dist/index.js` 替换成已安装的 `agentcorps` 命令。

## 3. 第一次运行：先用 mock Agent 验证环境

`mock` Agent 是本地测试适配器，不需要 API Key，也不会调用外部服务：

```bash
node apps/cli/dist/index.js run \
  "分析这个仓库的主要模块，并列出测试建议" \
  --agent mock \
  --data-dir ~/.agentcorps
```

查看持久化任务：

```bash
node apps/cli/dist/index.js task list --data-dir ~/.agentcorps
node apps/cli/dist/index.js doctor
```

`doctor --json` 可以给桌面端、脚本或 CI 使用；`doctor --strict` 会在状态不是 `healthy` 时返回退出码 1。

## 4. 配置默认 Agent

创建 `~/.agentcorps/config.json`。配置只描述工具路径、模型、工作目录和提示词，不保存 API Key：

```json
{
  "version": 1,
  "paths": {
    "dataDir": "~/.agentcorps",
    "workspaceRoot": "~/workspace"
  },
  "defaults": {
    "agent": "claude-code",
    "model": "sonnet",
    "role": "developer",
    "instructions": "优先使用中文；完成后列出实际运行过的验证命令"
  },
  "tools": {
    "claude-code": {
      "cwd": "~/workspace",
      "timeoutMs": 600000
    }
  }
}
```

如果厂商 CLI 不在默认 PATH，加入 `command`；如果需要自定义工具，使用 `toolDefinitions`。完整字段和安全边界见 [统一配置](25-config.md)。

检查工具是否可执行：

```bash
node apps/cli/dist/index.js agents
node apps/cli/dist/index.js doctor --json
```

然后运行一次低风险任务：

```bash
node apps/cli/dist/index.js run \
  "只读取 README，并用三句话总结项目" \
  --agent claude-code \
  --role reviewer \
  --data-dir ~/.agentcorps
```

## 5. 终端 TUI

启动交互式终端客户端：

```bash
node apps/cli/dist/index.js tui --data-dir ~/.agentcorps
```

启动时可临时覆盖配置：

```bash
node apps/cli/dist/index.js tui \
  --agent codex \
  --model YOUR_MODEL \
  --role developer \
  --data-dir ~/.agentcorps
```

输入任务后回车即可运行；输出会实时写入终端，并且会保存到同一个 SQLite 数据库。内置命令：

- `/help`：显示帮助；
- `/new`：创建新的会话；
- `/history`：查看当前会话消息；
- `/approvals`：查看待审批操作；
- `/approve ID`：批准并恢复对应的等待任务；
- `/deny ID`：拒绝审批；
- `/cancel`：取消当前会话中的活动任务；
- `/quit` 或 `/exit`：退出。

非交互式脚本或另一终端可以使用持久任务命令：

```bash
node apps/cli/dist/index.js task create \
  --title "Release review" \
  --objective "检查发布计划和回归风险" \
  --data-dir ~/.agentcorps
node apps/cli/dist/index.js task show TASK_ID --data-dir ~/.agentcorps
node apps/cli/dist/index.js task follow TASK_ID --data-dir ~/.agentcorps
```

`task follow` 从已提交事件中恢复输出，因此运行进程退出后仍可查看历史。

## 6. 启动本地 Gateway 和浏览器控制台

Gateway 是 CLI、桌面端、PWA 和 TypeScript 客户端共用的 HTTP、SSE（Server-Sent Events，服务端推送事件）和 WebSocket 控制面：

```bash
node apps/cli/dist/index.js serve \
  --host 127.0.0.1 \
  --port 43210 \
  --data-dir ~/.agentcorps
```

在另一个终端启动控制台：

```bash
pnpm --filter @agentcorps/console dev
```

打开 `http://127.0.0.1:4173`。默认地址是 `http://127.0.0.1:43210`；本地无令牌时可直接使用。远程或非本机访问必须显式启用 Bearer token、HTTPS、精确 CORS 来源和适当的只读/写入角色。

控制台支持任务、会话、事件、文件浏览、Git、终端、浏览器、用量和审批队列。高风险 Git、终端和浏览器写操作仍由 Gateway 策略决定，客户端不会绕过审批。

## 7. 桌面端

桌面端复用浏览器控制台界面，并在启动时自动检查本地 Gateway；端口不可用时会尝试启动本地 CLI Gateway，关闭桌面应用时回收它启动的子进程：

```bash
pnpm --filter @agentcorps/desktop build:desktop
open apps/desktop/src-tauri/target/release/bundle/macos/AgentCorps.app
```

开发模式：

```bash
pnpm --filter @agentcorps/desktop dev
```

桌面端无法启动时先执行：

```bash
node apps/cli/dist/index.js doctor
```

桌面端只自动管理它自己启动的 Gateway；如果检测到已有 Gateway，不会关闭已有进程。生产桌面配置默认只允许本机 Gateway，远程连接需要修改 Tauri 内容安全策略并重新打包。

## 8. TypeScript 高层客户端

工作区包 `@agentcorps/client` 将鉴权、HTTP 错误、任务轮询、事件去重、输出回调、审批、记忆、文件、Git、终端和浏览器控制封装成一个类型安全接口：

```ts
import { AgentCorpsClient } from '@agentcorps/client';

const client = new AgentCorpsClient({
  apiBase: 'http://127.0.0.1:43210',
  token: process.env.AGENTCORPS_TOKEN,
});

const run = await client.startRun({
  prompt: '检查当前项目的测试风险，并给出可执行的修复建议',
  agent: 'mock',
  mode: 'code',
});

const result = await run.wait({
  onOutput(text) {
    process.stdout.write(text);
  },
});

console.log(`完成状态：${result.task.status}`);
```

需要人工审批时，`wait()` 会在 `waiting_approval` 返回当前快照；调用方批准后可以继续等待：

```ts
const pending = (await client.approvals()).approvals.find((item) => item.status === 'pending');
if (pending) {
  await client.approve(pending.id, 'local-user', '已检查本次操作');
  const result = await run.wait({ onOutput: (text) => process.stdout.write(text) });
  console.log(result.task.status);
}
```

`AgentRunHandle` 还提供 `snapshot()`、`events()`、`cancel()` 和 `retry()`。所有方法都支持 `AbortSignal`；网关非 2xx 响应会抛出带 `status` 和服务端响应体的 `AgentCorpsApiError`。完整接口列表见 [TypeScript 高层客户端](37-client-sdk.md)。

## 9. 数据、备份和恢复

停止正在使用该目录的 AgentCorps 进程后备份 SQLite 数据库：

```bash
node apps/cli/dist/index.js data backup \
  --data-dir ~/.agentcorps \
  --output ~/agentcorps-backup.db
node apps/cli/dist/index.js data export \
  --data-dir ~/.agentcorps \
  --output ~/agentcorps-export.json
```

恢复前关闭 CLI、Gateway 和桌面端：

```bash
node apps/cli/dist/index.js data restore \
  --data-dir ~/.agentcorps \
  --input ~/agentcorps-backup.db
```

导出数据包含版本、事件、会话消息和未删除记忆；它不包含外部厂商的 API Key。

## 10. 常见问题

### Gateway 无法连接

确认 Gateway 正在运行、端口一致，并执行 `doctor`。如果端口已被其他程序占用，使用新的端口启动 Gateway，并在控制台连接设置中填写相同地址。

### 真实 Agent 没有输出

先执行 `agents` 和 `doctor --json`，确认可执行文件、版本和登录提示。AgentCorps 不替代厂商登录流程，也不会读取或复制 API Key 的值。

### 出现 `waiting_approval`

这是预期的安全状态。使用控制台审批队列、`approval list`，或 TUI 的 `/approvals` 查看请求；批准后重新运行等待任务，或在 TUI 中使用 `/approve ID` 自动恢复。

### 如何确认当前版本可交付

在仓库根目录执行：

```bash
pnpm typecheck
pnpm test
pnpm audit:release
pnpm --filter @agentcorps/desktop build:desktop
```

这些命令分别覆盖类型和生产构建、全量测试、发布审计以及桌面打包。真实厂商 Agent、浏览器 DevTools 端点、容器/macOS 沙箱和生产渠道凭据仍需在目标机器上单独验证。
