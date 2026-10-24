# 持久化与事件存储

> 版本：0.1.0

## SQLite

`SqliteEventStore` 使用 Node.js 22 内置的 SQLite 能力，把事件存入 `events` 表并建立 `(aggregate_id, occurred_at)` 索引。运行时启动时从表重放事件投影，因此任务状态可以跨进程恢复；追加事件使用 SQLite 单条写入，事件正文保持 JSON 以支持版本化。

CLI 默认将数据库保存为：

```text
~/.agentcorps/agentcorps.db
```

## JSONL

`JsonlEventStore` 仍然保留，适合：

- 人类审阅和调试
- 导出/迁移
- 不希望依赖 SQLite 的小型 fixture
- 事件日志损坏时的应急检查

它不是 CLI 的默认长期存储。正式导出工具需要同时输出数据库版本、schema、事件版本和校验信息。

## 当前限制

- Node.js 22 的内置 SQLite 在当前版本仍报告实验性警告，项目已把存储接口隔离，未来可替换为稳定驱动。
- SQLite 当前没有自动备份、迁移命令、锁冲突重试和压缩归档。
- 会话和记忆目前仍有各自的 JSONL 存储，后续需要统一迁移到 SQLite schema。
- 事件的 `aggregateType` 和 payload 版本需要在正式 schema 迁移前继续稳定化。
