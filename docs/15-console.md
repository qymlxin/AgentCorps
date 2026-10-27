# Signal Room 控制台

> 版本：0.1.0
> 目录：`apps/console`

## 技术与结构

管理端采用 **React 19 + TypeScript + Vite**，沿用深色控制台视觉和原生 CSS，不依赖额外 UI 组件库。Vitest、jsdom 和 React Testing Library 覆盖接口、实时连接、状态刷新和组件交互。

- `src/App.tsx`：页面导航、连接设置、任务与审批操作。
- `src/components/`：任务、事件、审批、会话和表单对话框。
- `src/api.ts`：类型化网关客户端、认证、错误处理和连接配置。
- `src/events.ts`：WebSocket、带认证的 SSE 降级、事件游标和重连。
- `src/useDashboard.ts`：快照刷新、请求合并、事件去重和批量更新。
- `public/`：PWA manifest 和生产环境 service worker。

领域模型使用工作区内的 TypeScript 类型导入；服务端 SQLite 等实现不会被打包到浏览器中。

## 运行

在仓库根目录安装依赖并构建服务端包：

```bash
pnpm install
pnpm build
```

启动本地网关，显式指定令牌和控制台来源：

```bash
node apps/cli/dist/index.js serve \
  --port 43210 \
  --data-dir ~/.agentcorps \
  --token YOUR_LONG_RANDOM_TOKEN \
  --cors-origin http://127.0.0.1:4173
```

在另一个终端启动 Vite 开发服务器：

```bash
pnpm --filter @agentcorps/console dev
```

浏览器打开 `http://127.0.0.1:4173`，在右上角设置中填写相同令牌。默认 API 地址为 `http://127.0.0.1:43210`。已有浏览器中的 API 地址和令牌继续沿用原来的存储键。

远程网关应使用 HTTPS，并配置与控制台地址精确匹配的 CORS 来源。令牌仅存于当前浏览器的 localStorage，不写入代码或 URL；共享设备上应清空令牌。只读令牌可以浏览数据，写操作遇到 403 时会显示错误。

## 构建与测试

```bash
pnpm --filter @agentcorps/console typecheck
pnpm --filter @agentcorps/console test
pnpm --filter @agentcorps/console build
pnpm --filter @agentcorps/console preview
```

生产构建输出至 `apps/console/dist`，部署该目录即可。相对资源路径支持子目录部署；`preview` 仅用于本地检查构建结果。

全仓 `pnpm typecheck` 会包含 React 生产构建，`pnpm test` 会自动包含前端测试，现有 CI 因而覆盖前端，无需单独运行前端流水线。

## 已实现

- 任务、会话、观察到的事件数量和待审批数量。
- 新建任务、选择已有会话、运行、取消与重试任务。
- 会话列表与消息内容浏览，切换会话时取消旧请求。
- WebSocket 实时事件、认证 SSE 降级、带游标的断线重连，以及 5 秒一次的快照兜底。
- 事件按 100 毫秒批量渲染，保留最近 200 条，界面展示最近 40 条；最近 5,000 个事件 ID 用于重放去重。事件计数是当前连接观察到的累计值，不是数据库总数。
- 快照请求合并，避免高频事件引发请求堆积；任务操作期间禁用对应按钮。
- 审批队列、命令预览、批准和拒绝；审批服务未启用时显示独立提示，不影响任务浏览。
- 设置、表单、权限、网络错误提示；键盘焦点、原生模态对话框和窄屏布局。
- 切换网关或离开页面时关闭旧 WebSocket，取消 SSE/快照请求并清除定时器。

## PWA 与桌面

生产环境在 HTTPS 或 localhost 下注册 service worker，仅缓存静态页面、带内容哈希的 JS/CSS 和 manifest。缓存版本随构建产物变化；不缓存网关响应、任务数据或带认证的请求。首次联网加载成功后，可离线打开控制台外壳，离线期间仍会显示网关不可用。开发模式会注销旧 service worker，以免缓存干扰热更新。

`apps/desktop` 提供 Tauri 2 桌面应用，直接复用 React 的 `dist` 产物。桌面应用启动时会通过 Tauri 原生命令检查 `127.0.0.1:43210`；端口没有健康网关时，它会优先启动仓库内的 `apps/cli/dist/index.js`，也支持通过 `AGENTCORPS_CLI` 指定 CLI 可执行文件。桌面进程负责子进程生命周期，关闭桌面应用时会回收它启动的网关；如果检测到已有网关，则不会接管或关闭已有进程。自动启动的网关使用桌面进程生成的临时令牌，控制台会自动接收，不需要手工填写。

```bash
pnpm --filter @agentcorps/desktop dev
pnpm --filter @agentcorps/desktop build:desktop
```

桌面启动失败时，界面会显示可读错误并提示运行 `agentcorps doctor`。

桌面打包需要 Rust 和对应平台工具（macOS 需要 Xcode 工具链）。桌面版仍需独立启动本地网关，不会自动运行 Agent 或后台服务。生产桌面内容安全策略当前只允许默认本地网关 `127.0.0.1:43210`；如需远程网关，必须先显式调整 `tauri.conf.json` 的允许来源并重新打包。开发策略额外允许 Vite 热更新，生产策略不放宽内联脚本。

## 设计方向

酸绿色表示可操作和在线状态，橙色表示风险或异常，衬线大标题将长期上下文与密集事件数据区分开。布局优先展示任务状态和事件证据，而不是聊天气泡。
