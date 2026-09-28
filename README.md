# Task

Task 是 Cockpit 的持续责任模块（module/MCP key：`cockpit-task`）。
一个 Agent Task 只绑定自己的 assignee：亲自交付 `execute`，或组织更具体子责任并整合
结果 `orchestrate`。两种模式均可使用 helper；helper 不接管正式责任。
Internal helpers are read-only: they may call `task_read` and `task_script_read`,
but return work results to the main agent for all Task maintenance, including activity.
Independent child-Task main agents retain their own authority.
上级负责人从当前 parent 的绑定派生，`created_by` 只是历史。root 只是无 parent 的普通
Task，没有树外 owner、特殊角色或隐藏控制权。唯一模块角色为 `node`。

Task 记录本项工作特有的目标、决定、边界、进展和证据，正式节点之间只通过 Task 与
服务通知协作，不私聊或通过 helper 传话。任意节点都直接问用户所需决定，避免重复问题，
答案改变约定就写回 Task。讨论、登记、ready 或通知都不扩大用户授权。

## 履责流程

1. 登记新 Agent 意图：`task_create` 为 todo/undecided，不绑定、不发消息、不执行。
   无 active Task 的 caller 建普通 unbound root，可用 `task_claim` 承接；
   Web user 可外部指派 root。当前 active orchestrate 父则创建更具体 child。
2. child 的 parent assignee 选择/准备另一 capable session，`task_assign` 绑定并发送一次
   assigned 指针；准备、消息受理、ACK 与实际开工分别记录。claim 不自派单、不改标题。
   claim 可承接 blocked root 以澄清，不要求 Task ready，也不开始工作。
3. assignee 读完整 execution、ACK 精确 revision，再 `task_start` 原子选择 execute/
   orchestrate 并进入 in_progress。todo 只澄清和轻度发现，report 不能直接开工或完成 todo。
4. execute 专注交付；需独立分解时 `task_convert` 记录原因、已有成果/剩余责任，转为
   orchestrate 后再创建 child。不原样转包、不降级、不与 native interaction mode 同步。
   orchestrator 的有限调研服务于协调判断，持续实施/深度专项调查交给 child。
5. 完成前子项必须全部 done/cancelled，但子 cancelled 不算成功、子 done 不自动完成父。
   父仍判断自己的目标、满足前置并提交新 outcome 与显式 retro（文本或无发现的 null）。

`blocked_by` 与包含关系分开。Task-ID 前置等那次 done，不保证成功；cancelled 不解除，
reopen 不复活旧依赖。own assignee 可用 `task_resolve_condition` 对具体文字条件提交
用户答案/客观满足证据，按 dependency_id 解除，不借此改条件含义、删 Task-ID 前置或越权。

## 取消、恢复与责任树

Agent `task_cancel` 先记录 cancellation_request，即使 leaf 也不立即 cancelled。
停止推进目标、安排 child 收口及残留处置后，bound assignee 用 `task_cancel_finalize`；
未绑定 Agent 由 Web user finalize。done/cancelled 同查所有直接 child 终态，
最终取消不要求满足已放弃的执行前置或 ACK，不盲级联，不证明外部退出或回滚。
祖先仍有绑定且 active orchestrate 时，其意图/blockers 不阻止既有 child done 收口；
child 仍须自己的当前 ACK、ready、无自身意图、完整成果及子终态门槛。

`task_attach` 可将已有 root 接到另一 session 的 active orchestrate parent，
保留 Task、binding、范围、子树和历史。无固定三层上限；仍检查防环、祖先有效性、
并发 context 和 10,000 节点资源边界。无 detach 或任意 reparent 逃逸。
reopen 保留原 assignee/mode，遵守可靠指派序号、无后续指派/其他 unfinished 责任及能力资格，
并先合法恢复所需祖先；cancelled/不合格祖先或未知 legacy mode 不暗中替换/猜测。

恢复、重要动作和交付前完整读/ACK。未知操作先读 caller-scoped operation，
保留原 ID/输入重放，不盲重派、换 Task 或重复外部效果。通知是 task: 指针，
不是授权、活跃性或成功证据。parent 关系变了不改投旧通知；Web subscription 显式选 subscriber。
默认不订阅、不轮询，只有未来状态解锁必要后续行动才一次性等待。
长期 root 可闲置，不因为 child 暂时都结束就自动完成或找新活。

可信现有脚本可选择 service-managed automation：不可变登记、create、显式 start，
无 Agent mode/assignee/ACK/report。失败/中断 done 是尝试结束，不是目标成功；
取消/reconcile 保留 Linux 进程组、残留和队列屏障协议，不临时造脚本绕过 Agent 责任。
见 [Automation](docs/task-automation.md)。

## 使用与兼容

**[使用与打包](docs/task-board.md)** · [产品设计](docs/task-design.md) ·
[Schema](docs/task-schema.md) · [MCP 工具](docs/task-mcp-contract.md) ·
[Skills](docs/task-tools-skills.md) · [宿主](docs/task-host-contract.md) ·
[实现](docs/task-implementation.md) · [隔离验证与历史回放](docs/task-lifecycle-testing.md)

当前数据边界为 **schema12**，普通加载拒绝自动升级已有 schema≤11。
历史未完成模式、责任关系和恢复意图须明确审阅；终态未知模式保留 legacy，不伪造历史。
旧 JSON、回执和不确定效果不重放。唯一操作程序：
[schema 12 migration](docs/task-responsibility-migration.md)。
源码/合并/自动 Rolling 不授权现有数据迁移、安装、部署或重启。

Task 只在支持 Module API v1、UI surface v1、service-ready v1、角色与公开 host.call、
MCP invocation metadata 的 Cockpit 中运行；显式资源准备另需 resourcePreparationVersion=1。
角色标签/Skill enabled 不证明正文已读，MCP connected 不等于工具 offered。
UI 是聊天内联引用与按需详情，不是独立 dashboard、聊天镜像或依赖调度器。

## 开发与打包

需要 Node.js 24 或更新版本：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run package:module
```

Each worktree needs its own `node_modules`; untracked or ignored setup is not inherited.
Use the initialization command when dependencies are missing, reusing npm's own cache.
Do not copy production dependencies or credentials, or symlink another worktree's entire
`node_modules`. Documentation-only edits do not require dependency installation, and a ready
environment should not be reinstalled unconditionally.

Run `npm run quotas` for fixed prompt-text limits and remaining capacity; no dependencies
are required. Counts use JavaScript String.length (UTF-16), LF-normalized Markdown without
frontmatter/outer whitespace; internal whitespace counts. Limits remain in
`scripts/prompt-quotas.js`, independent of payload limits.

源码：`src/task-board/`；前端：`web/task-board/`；入口：`cockpit.module.json`。
包输出 `dist/cockpit-task-<version>.tgz`。Node 按需加载
[cockpit-task-tree](skills/cockpit-task-tree/cockpit-task-tree/SKILL.md)，
仓库变更另用 [github-coding](skills/github-coding/github-coding/SKILL.md)，
两者不扩大授权。实现节点在 execute 中自行建立隔离 worktree、验证、审阅和安全清理；
parent 保留组织和整合责任，helper 在两种模式均可使用。

Main 保持 `0.0.0-dev`；每次实际 main PR 合并自动尝试该 SHA 的不可变 Rolling Release，
不是手动版本 PR，也不自动部署。PR-only/no-merge 等较窄边界阻止发布副作用。
版本注入、产物核验及显式 Milestone promotion 以 [Releases](docs/releases.md) 为准。
