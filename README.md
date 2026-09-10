# Work Commander

独立的工作服务 + SQLite + MCP + 两层协作 skill + 私人工作页。Cockpit 仍是唯一真实会话基础服务；这里不保存聊天、模型目录或会话状态副本，不运行指挥 agent、巡查器或自动调度。

**一个 MCP，两份协作 skill**：`work-commander` 给讨论方，`work-commander-owner` 给执行方，规定目标、授权、结果责任和服务报告；工程方法遵守目标项目规范，Git 服务开发按需使用独立模块的 `service-development`，不在协作正文重复。权限由 caller/owner 凭证决定，不靠自报 sessionId；本服务最终通知统一由服务发送。旧 `work-owner` 已退役，旧在途任务兼容及工程承接见[入口切换](docs/operations.md#协作入口与旧定义退役)。

## 使用入口

- 工作页：`http://127.0.0.1:8790/`，需要只读凭证。
- 服务：`systemctl --user status work-commander`；数据 `~/.local/state/work-commander/`。
- MCP：`node <安装目录>/src/mcp.js`（stdio），默认连接本机 8790。
- 文档：[待办与统一记录](docs/backlog.md) · [接入和运行](docs/operations.md) · [工具与可靠性边界](docs/contract.md) · [统一迁入范围与交付](docs/unified-records-delivery.md) · [首版实证](docs/acceptance.md)。
- 验证：`npm test`；开发启动：`npm start`，同数据目录持有内核独占锁。

一句话用 `work_record` 登记待办，零会话副作用；补齐授权后通过 `work_dispatch` 在**同 taskId**开工。同目标继续原 owner。元数据用 recordRevision，执行目标/授权用 goalVersion；只有后者变化才 `work_amend`。owner 报告/交付仍用 `work_report`、`work_deliver`。默认 `work_read` 返回 10 个未结束简表，完成历史按需查，不查询 Cockpit。

**统一记录**：用户批准的旧任务保留原始来源后迁入，历史 owner/caller 引用与真实执行绑定分离。迁入不派工、不唤醒 owner、不发旧回执；切换后的 Markdown 仅留入口，不再双写状态。旧回执由讨论方 `work_observe` 带来源登记，不能冒充 owner。单用户本地部署不隔离恶意同用户 agent；现有 Cockpit 宽读取和未知副作用仍如实暴露。
