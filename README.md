# Work Commander

独立的工作服务 + SQLite + MCP + 两层协作 skill + 私人工作页。Cockpit 仍是唯一真实会话基础服务；这里不保存聊天、模型目录或会话状态副本，不运行指挥 agent、巡查器或自动调度。

**一个 MCP，两份短 skill**：`work-commander` 给讨论方，`work-commander-owner` 承载 work-owner 的 owner 规则。权限由服务签发的 caller/owner 凭证决定，不靠 agent 自报 sessionId。原全局 `work-owner` 不改；本服务任务的最终通知统一由服务发送。

## 使用入口

- 工作页：`http://127.0.0.1:8790/`，需要只读凭证。
- 服务：`systemctl --user status work-commander`；数据 `~/.local/state/work-commander/`。
- MCP：`node <安装目录>/src/mcp.js`（stdio），默认连接本机 8790。
- 文档：[接入和运行](docs/operations.md) · [工具与可靠性边界](docs/contract.md) · [本机实证与限制](docs/acceptance.md)。
- 验证：`npm test`；开发启动：`npm start`，同数据目录持有内核独占锁。

新目标用 `work_dispatch`；同目标继续原 task/owner。目标或授权变化先 `work_amend`，再显式继续新版本。owner 通过 `work_report` 报重要事实，完整目标结束才 `work_deliver`。默认 `work_read` 只返回 10 个简表，不查询 Cockpit。

**当前范围**：只管理显式创建的新工作。旧 `tasks.md` 不导入、不双写、不自动唤醒旧 owner。单用户本地部署不是同用户恶意 agent 的隔离沙箱。服务内部防冲突，但用户直接聊天仍可与操作并发；现有 Cockpit 宽读取和未知副作用如实暴露，不伪装成分布式原子事务。
