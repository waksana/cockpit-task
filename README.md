# Task

Task 是 Cockpit 模块：用共同的持久化 Task 记录协作，通过 Owner / Executor
角色组合 System Prompt、Skill 和 HTTP MCP。Task 引用直接在聊天中显示卡片，详情按需读取；
不保存聊天、不自动监工或调度。默认不发送进度或完成通知；
默认不登记订阅；仅当未来状态会使 Owner 需要作决定、安排后续独立工作等必要行动时，
由 Owner 自行判断并显式登记一次性订阅，不为追踪进度或确认完成而订阅。

Owner / Executor 是 Task 提供的协作能力，不是 session 的业务身份。例如 Cockpit Owner
仍负责 Cockpit 本体，选择 Owner 只增加任务协调能力，不表示负责开发 Task 模块或绑定某条 Task。

通用引用为 `[Task](task:<uuid>)`；首次指派由 `task_assign` 仅发送一次
`[Task assigned to you](task:<uuid>?event=assigned)`。Owner 明确决定的重要更新
使用 `[Task updated](task:<uuid>?event=updated)`，并要求读取、ACK 最新版本。
event 只说明这条消息的原因，不是 Task 状态；卡片仍读取当前数据，普通编辑不发通知。

状态订阅使用独立的 `[Task status updated](task:<uuid>?event=status_changed)`，
发送给 Task 的 Owner，不是要求 Executor 读取并 ACK 的更新指令。
登记时若已处于目标状态则明确失败，不创建订阅或补发消息；只有登记后第一次
进入目标状态才触发，不重复订阅、不轮询、不打断 Owner 当前工作。

一个 Executor 完整负责一个独立 Task，可在内部使用 subagents。要求直接修改 Task，
Executor 在同步点读取并 ACK；执行动态和结果带有实际确认的版本。没有子任务树、
改派或续办；Coding / Research 的具体工作方法不属于 Task 模块。

**使用与打包：[Task](docs/task-board.md)**。模块需要支持模块角色和宿主
能力接口的 Cockpit；旧版宿主不能仅靠安装这个包获得这些能力。构建、合并不等于安装
或升级，部署须由操作者另行决定。

契约：[产品设计](docs/task-design.md) · [Schema](docs/task-schema.md) ·
[MCP 工具](docs/task-mcp-contract.md) · [角色 Skills](docs/task-tools-skills.md) ·
[宿主接入](docs/task-host-contract.md) · [实现边界](docs/task-implementation.md)。

回归演练：[Owner / Executor 生命周期用例与复跑流程](docs/task-lifecycle-testing.md)，
包含隔离边界、输入、角色分工、故障注入、证据标准，以及生命周期与订阅必要性演练的结果和限制。

## 开发与打包

需要 Node.js 24 或更新版本：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run package:module
```

模块代码位于 `src/task-board/`，卡片位于 `web/task-board/`；
`cockpit.module.json` 是模块入口。归档输出到 `dist/cockpit-task-<version>.tgz`，
供支持所需接口的 Cockpit 装载；Task 不提供独立服务启动命令。

模块 ID、MCP key 和包名均为 `cockpit-task`；正式 Skill 为
[Owner](skills/cockpit-task-owner/cockpit-task-owner/SKILL.md) 和
[Executor](skills/cockpit-task-executor/cockpit-task-executor/SKILL.md)。
持久化仅使用宿主提供的模块目录，不自动导入其他数据库或修改既有安装。
