# 持久化与事件存储

> 版本：0.1.0

## SQLite

`SqliteEventStore`、`SqliteSessionStore` 和 `SqliteMemoryStore` 使用 Node.js 22 内置的 SQLite 能力。CLI 默认把任务事件、会话、消息和记忆保存在同一个数据库：

```text
~/.agentcorps/agentcorps.db
```

任务事件仍使用 `events` 表和 `(aggregate_id, occurred_at)` 索引；会话使用 `sessions` 与 `session_messages`；记忆使用 `memories`。每个存储实现都保留原有端口，因此测试和不需要 SQLite 的嵌入场景仍可使用内存存储。

`MemoryService` 和 `SessionService` 提供 `migrateMemoryStore`、`migrateSessionStore`，可以把旧 JSONL 中的现有记录（包括记忆 tombstone 和已归档会话）复制到 SQLite。迁移是幂等的：相同 ID 会覆盖为源记录，不会重复产生消息。

## JSONL

`JsonlEventStore`、`JsonlSessionStore` 和 `JsonlMemoryStore` 仍然保留，适合：

- 人类审阅和调试
- 导出/迁移
- 不希望依赖 SQLite 的小型 fixture
- 事件日志损坏时的应急检查

它们不是 CLI 的默认长期存储。正式备份应复制完整的 `agentcorps.db`，并在恢复后运行全量读取检查；正式导出工具还需要输出数据库版本、schema、事件版本和校验信息。

## 当前限制

- Node.js 22 的内置 SQLite 在当前版本仍报告实验性警告，项目已把存储接口隔离，未来可替换为稳定驱动。
- 当前迁移 API 负责复制记录，不负责删除旧 JSONL，也不提供在线数据库热备份、锁冲突重试和压缩归档。
- 事件的 `aggregateType` 和 payload 版本需要在正式 schema 迁移前继续稳定化。
