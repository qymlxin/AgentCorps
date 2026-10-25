# 桌面端文件浏览

桌面端控制台的 `Files` 页面通过本地 Gateway 的只读文件接口浏览工作区。Gateway 启动时使用 `--workspace-root PATH` 或 `config.json` 的 `paths.workspaceRoot` 作为根目录；未配置时使用 CLI 启动目录。

```bash
agentcorps serve --workspace-root ~/workspace/project
```

接口：

- `GET /files`：列出根目录或 `?path=src` 指定的子目录。
- `GET /files/content?path=src/main.ts`：读取小型文本文件预览。

安全边界：

- 只接受相对于配置根目录的路径；绝对路径、空字节和 `..` 越界路径都会被拒绝。
- 文件和目录会经过真实路径校验，符号链接不能跳出工作区。
- 浏览接口只要求 Gateway 的 `read` 角色，不提供写入和删除操作。
- 目录默认最多返回 500 项；文件预览默认限制 512 KiB，避免把大型二进制或日志直接加载进控制台。
- 浏览器不能直接访问宿主机文件系统，所有访问都由本地 Gateway 在认证和根目录边界内完成。

```mermaid
flowchart LR
  Desktop[桌面控制台 Files 页面] -->|GET /files| Gateway[本地 Gateway]
  Desktop -->|GET /files/content| Gateway
  Gateway --> Auth[read 角色认证]
  Auth --> Boundary[真实路径与 workspaceRoot 校验]
  Boundary --> FS[本地只读文件系统]
```
