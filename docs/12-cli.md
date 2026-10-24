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
agentcorps task run TASK_ID --data-dir ~/.agentcorps
agentcorps task cancel TASK_ID --data-dir ~/.agentcorps
agentcorps task retry TASK_ID --data-dir ~/.agentcorps
```

任务和事件由所有 CLI 进程共享同一个 SQLite 数据库，因此重新打开终端后仍能查看历史；会话、消息和记忆也使用这个数据库。原始 JSONL 存储仍可用于迁移和调试；`data migrate` 会把旧版本的 `memory.jsonl` 与 `sessions.jsonl` 复制到 SQLite，`data backup` 和 `data restore` 用于离线文件级备份恢复。当前 `task run` 使用 mock Agent 验证生命周期，真实 Agent 适配器接入和 Agent 选择策略仍在后续功能中。

## 启动本地控制面

```bash
agentcorps serve --port 43210 --data-dir ~/.agentcorps
```

```bash
agentcorps data migrate --data-dir ~/.agentcorps
agentcorps data backup --data-dir ~/.agentcorps --output ~/agentcorps-backup.db
agentcorps data restore --data-dir ~/.agentcorps --input ~/agentcorps-backup.db
```

恢复前应停止正在使用该数据目录的 AgentCorps 进程；恢复后重新启动 Gateway。网关默认只绑定 `127.0.0.1`。在远程认证、签名和权限实现完成前，不要把端口绑定到公网或局域网。
