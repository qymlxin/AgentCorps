# TypeScript 高层客户端

`@agentcorps/client` 是 AgentCorps 本地网关的高层 TypeScript 客户端。它把 HTTP、鉴权、错误解析、任务轮询、事件去重和实时输出封装在一个类中，Node.js、桌面端和浏览器代码可以使用同一套接口。

## 开始使用

先启动本地网关：

```bash
pnpm install
pnpm --filter @agentcorps/cli build
node apps/cli/dist/index.js serve --data-dir ~/.agentcorps
```

在自己的 Node.js 项目中安装或引用工作区包：

```ts
import { AgentCorpsClient } from '@agentcorps/client';

const client = new AgentCorpsClient({
  apiBase: 'http://127.0.0.1:43210',
});

const result = await client.runAndWait(
  {
    prompt: '分析这个项目的测试风险，并给出可执行的修复建议',
    agent: 'mock',
    mode: 'code',
  },
  {
    onOutput(text) {
      process.stdout.write(text);
    },
  },
);

console.log(`任务状态：${result.task.status}`);
```

远程或显式认证的网关使用 Bearer token：

```ts
const client = new AgentCorpsClient({
  apiBase: 'https://agent.example.com',
  token: process.env.AGENTCORPS_TOKEN,
});
```

## 任务与会话

- `run(input)`：创建 Session 和 Task，并异步启动 Agent，立即返回 `AgentRunAccepted`。
- `runAndWait(input, handlers)`：启动任务并轮询到完成；每个事件只回调一次。
- `waitForRun(taskId, handlers)`：等待已有任务，`onOutput` 只接收 Agent 输出文本。
- `task(id)`、`tasks()`、`runEvents(id)`：读取任务和事件。
- `runAction(id, 'cancel' | 'retry')`：取消或重试任务。
- `createSession()`、`session()`、`sessionMessage()`：管理持久化会话。

当任务进入 `waiting_approval` 时，`runAndWait` 会返回当前结果，不会无限等待。调用方可以读取审批并决定：

```ts
const pending = await client.approvals();
const approval = pending.approvals.find((item) => item.status === 'pending');
if (approval) await client.approve(approval.id, 'local-user', 'Reviewed the requested operation');
const completed = await client.waitForRun(approval?.request.taskId ?? '', { onOutput: console.log });
```

## 统一控制面接口

客户端覆盖当前网关的高层接口：

- `health()`、`channels()`；
- `approvals()`、`approve()`、`deny()`；
- `memorySearch()`、`saveMemory()`；
- `files()`、`fileContent()`；
- `gitStatus()`、`gitLog()`、`gitDiff()`、`gitStage()`、`gitUnstage()`、`gitCommit()`；
- `terminalExec()`；
- `browserTabs()`、`browserSnapshot()`、`browserScreenshot()`、`browserNavigate()`、`browserClick()`、`browserFill()`；
- `usageSummary()`、`usageCalls()`；
- `events()`：通过异步迭代器消费 SSE 事件流，并可使用 `lastEventId` 断线续传。

高风险 Git、终端和浏览器操作不会被客户端绕过。网关返回 `approval_required` 时，调用方需要先批准对应记录，再把 `approvalId` 传给同一操作。

## 取消、错误和测试替身

所有读取和写入方法都接受可选 `AbortSignal`。HTTP 非成功响应会抛出 `AgentCorpsApiError`，其中包含 `status` 和服务端返回的 `body`。测试时可以注入兼容 Fetch API 的 `fetch` 实现：

```ts
const client = new AgentCorpsClient({
  apiBase: 'http://127.0.0.1:43210',
  fetch: testFetch,
});
```

客户端只负责调用控制面，不负责启动网关、安装外部 Agent 或保存 token。CLI 的 `doctor`、桌面端的自动启动逻辑和网关部署配置分别负责这些环境问题。
