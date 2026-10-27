# CLI 使用指南

> 版本：0.1.0

## 安装与构建

```bash
pnpm install
pnpm build
```

开发时可以使用 `pnpm --filter @agentcorps/cli dev demo`，构建后使用 `node apps/cli/dist/index.js`，安装包发布后命令名为 `agentcorps`。

## 持久任务

默认数据目录是 `~/.agentcorps`，也可以通过 `--data-dir` 指定隔离目录：

```bash
agentcorps task create \
  --title "Review repository" \
  --objective "Inspect tests and report risks" \
  --mode code \
  --data-dir ~/.agentcorps
agentcorps task list --data-dir ~/.agentcorps
agentcorps task show TASK_ID --data-dir ~/.agentcorps
agentcorps task follow TASK_ID --interval 250 --data-dir ~/.agentcorps
agentcorps task run TASK_ID --data-dir ~/.agentcorps
agentcorps task cancel TASK_ID --data-dir ~/.agentcorps
agentcorps task retry TASK_ID --data-dir ~/.agentcorps
```

`task follow` 会从持久化 SQLite 事件中恢复已提交的输出，因此可以在另一个终端跟踪正在运行的任务；它会在 `succeeded`、`failed` 或 `cancelled` 时退出，并在失败或取消时返回非零退出码。`--interval` 的单位是毫秒，默认值为 250。

任务和事件由所有 CLI 进程共享同一个 SQLite 数据库，因此重新打开终端后仍能查看历史；会话、消息、记忆、审批、渠道去重、渠道会话和投递状态也使用这个数据库。原始 JSONL 存储仍可用于迁移和调试；`data migrate` 会把旧版本的 `memory.jsonl` 与 `sessions.jsonl` 复制到 SQLite，`data backup` 和 `data restore` 用于离线文件级备份恢复。`task run` 默认使用 mock Agent 仅用于演示；CLI 也支持 `codex`、`claude-code`、`cursor` 和受沙箱约束的 `command` 适配器，正式部署应通过 `--agent` 明确选择并按需配置审批。

## 启动本地控制面

```bash
agentcorps serve --port 43210 --data-dir ~/.agentcorps
```

```bash
agentcorps data migrate --data-dir ~/.agentcorps
agentcorps data backup --data-dir ~/.agentcorps --output ~/agentcorps-backup.db
agentcorps data restore --data-dir ~/.agentcorps --input ~/agentcorps-backup.db
```

绑定外部渠道身份（绑定前，启用 `--identity-required` 的网关会拒绝该用户）：

```bash
agentcorps device provision --label channel-device --data-dir ~/.agentcorps
agentcorps identity bind --channel feishu --external-user-id EXTERNAL_ID --device-id DEVICE_ID --role user --data-dir ~/.agentcorps
agentcorps identity list --data-dir ~/.agentcorps
agentcorps identity revoke --channel feishu --external-user-id EXTERNAL_ID --data-dir ~/.agentcorps
```

恢复前应停止正在使用该数据目录的 AgentCorps 进程；恢复后重新启动 Gateway。网关默认只绑定 `127.0.0.1`；需要远程绑定时必须提供 Bearer token，并建议同时配置 TLS、CORS 和外部身份绑定：

```bash
agentcorps serve --host 0.0.0.0 --token TOKEN --identity-required --data-dir ~/.agentcorps
```
