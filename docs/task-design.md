# Task 产品设计

Task 是 Cockpit 内的独立任务协作模块。模块 ID 与 MCP key 为 `cockpit-task`，
展示名称为 Task；Owner / Executor 是协作职责，不是项目身份或权限等级。

使用与打包见 [Task](task-board.md)，记录语义见 [Schema](task-schema.md)，
调用接口见 [MCP 契约](task-mcp-contract.md)，行为指导见
[角色 Skills](task-tools-skills.md)。隔离验证方法见
[生命周期回放](task-lifecycle-testing.md)。

## 1. 一个 Task，一个完整结果

用户可以先与 Owner 讨论想法、澄清范围，再明确登记或授权执行。讨论、调查、
记录想法和启动交付是不同决定；不为闲聊自动建 Task，也不把登记等同于派单。

Owner 管理多个独立 Task，每个 Task 交给一个 Executor 完整负责，包括调查、
实施、修正和交付。独立成果可分别建 Task；紧密关联的步骤、资源和专业分工
由同一 Executor 内部组织，可使用 subagent，不转移整体责任。

- Task 之间只有普通引用，没有父子关系、任务树、依赖引擎或级联调度。
- 一个 session 同时最多执行一项未结束 Task，完成或取消后可承接其他 Task。
- 首次绑定后不能替换 Executor；`done` / `cancelled` 不能重新开始执行。
- Owner 信任 Executor 完整交付，不增加默认上游审批或逐阶段重新派单。
  `in_review` 仅在工作约定本身需要评审时使用。
- 新建或 fork session 不自动隔离共享资源，也不继承额外授权。

Owner 可以只读调查、回答问题和比较方案。实施及改变外部状态的交付默认委派，
不亲自实施或用自己的 subagent 代替独立 Executor。用户要求一个结果不等于要求
Owner 本人执行；明确要求本人执行，或实际以具备能力的 Executor 身份承接 Task，
才是例外。无法委派应说明阻塞，不静默接管。
编码工作的 Issue 维护、独立工作环境准备和安全的合并后清理属于 Owner 协调，
不属于代码实施；独立 [github-coding Skill](../skills/github-coding/github-coding/SKILL.md)
定义这条工作流程，不改变角色分工或为非编码 Task 增加步骤。

## 2. Task 是共同工作记录

Task 保存完整当前约定、资料、修订、执行动态和成果。聊天与通知只提供交流
或引用，不维护第二份要求或进度账。用户可以直接与 Executor 澄清；
影响范围、约束或交付条件的结论应写回 Task，不要求 Owner 转述。

| 记录 | 职责 |
| --- | --- |
| `description` | 完整当前工作说明，包括背景、目标、约束和完成条件 |
| `revision` / `changelog` | 仅对 description 版本化；保留每版正文、作者、时间与原因 |
| `acknowledged_revision` | 固定 Executor 已确认的 description 版本；逐版确认另有记录 |
| `activity` | Executor 报告的执行事实，指向实际依据且已确认过的 revision |
| `status` / `outcome` | 明确的工作状态与成果；不从 activity 文本或 session 状态推断 |
| `references` / `metadata` | 补充资料；不形成依赖或新的 Task 子类型，不隐藏工作要求 |

Owner 修改 description 不替 Executor ACK，也不生成 Executor activity。当前
Executor 亲自成功修改未结束 Task 的正文时，同时确认新 revision；相同正文、
仅资料编辑或终态编辑均不自动 ACK。ACK 本身不开始执行、不解除阻塞、不生成活动。

状态、归属、动态和 ACK 不推进 description revision。旧成果保留原版本；
定义改变后，旧成果不能冒充新要求已交付的证明。终态定义可以编辑，但不会重开执行。

## 3. 登记、创建和指派是独立操作

```text
澄清并登记 Task
  → 明确新建 Executor，或选择已有能力的 session
  → 指派工具检查能力和原生可接单状态，固定执行归属
  → 发送一次 assigned 引用
  → Executor 读取完整当前约定并 ACK
  → 明确开始执行，持续维护 Task，完整交付
```

`task_create` 只登记；`task_session_create` 通过宿主新建并装配 Task Executor，
不关联 Task 或发送消息；`task_assign` 只指派 Owner 选定的已有 session，
不追加角色、安装 Skill、启用 MCP、重载或创建替代者。

宿主提供角色选择、组合、持久化、冷恢复及已有 session 的角色管理。
Task 自身不暴露已有 session 的角色变更；宿主角色变化不等于 Task 指派，
也不改变现有交付责任。Owner / Executor 可以同时具备，工具取并集，
但多角色不放宽单项未结束执行的限制。

角色标签表示配置，不证明当前能力就绪。创建后和指派前显式检查能力；
原生运行、队列、待决问题和后台工作另行检查，不持续采集或展示 readiness badge。
工具能力是装配范围，不是逐 Task ACL；`actor_session_id` 为自报归因，
不能宣称验证了身份、用户授权或实际阅读。

## 4. 主动同步，默认静默

Owner 按需读取 Task 了解情况，不向 Executor 聊天追问进展或索要确认。
Executor 在自己的 session 向用户提出真实决策问题，把进展、阻塞和成果写回 Task，
不直接或通过 subagent 向 Owner 发消息。面向用户的简洁总结允许，但不是另一份持续账本。

Executor 在开工、恢复、重要阶段之间、重要外部操作前和交付前读取最新定义，
理解变化并 ACK 精确版本。每次 Task 业务调用的 `definition_check` 都需处理，
包括读取、失败和重放；提醒不等于自动确认或后台通知，不要求忙循环轮询。

消息用途严格区分：

| 用途 | 消息 |
| --- | --- |
| 普通引用 | `[Task](task:<uuid>)` |
| 首次派单，由 `task_assign` 发送一次 | `[Task assigned to you](task:<uuid>?event=assigned)` |
| Owner 明确的重要要求更新 | `[Task updated](task:<uuid>?event=updated)`，附读取/ACK 最新版要求 |
| 显式一次性状态订阅，由系统通知 Owner | `[Task status updated](task:<uuid>?event=status_changed)` |

首次派单不复制 description，Owner 不重复发单。普通编辑与报告静默。
只有 Owner 判断重要更新不能等待正常同步点时，才按
[重要更新参考](../skills/cockpit-task-owner/cockpit-task-owner/references/important-updates.md)
保存 pending 内容、按已保存 ID 清理，必要时单次保留队列地中断主轮次，
再一次发送上下文摘要和 updated 引用。未知内容、并发新消息和后台工作必须明确处理，
不能盲删、反复中断或自动推进队列。

状态订阅默认不使用。只有未来状态使 Owner 必须采取具体、必要的后续行动时
才登记；单纯看进度或确认完成不是理由。不虚构后续工作或审批关卡，
选择最少必要目标，后续行动不再需要时取消等待。首次匹配后结束，
不自动续订；Executor 不等待订阅或通知被读才执行。登记时已匹配则失败，
不即时补发；通知投递与已保存的 Task 成果分别记录。

## 5. 如实保留冲突与不确定性

Task 保护版本、逐版 ACK、生命周期、首次绑定、单 session 单项执行及请求幂等。
这些是数据一致性，不是按 owner/executor 归属鉴权。

已实际 ACK 的旧版 activity 可保留原 revision；同次请求的过期状态或成果拒绝，
必须明确部分应用。读过或确认更高版本不证明被跳过的版本已获确认。

session 已创建、能力就绪、归属已绑定、消息被接受、ACK 和实际执行是不同事实。
稳定 `request_id` 的相同输入重放不重复副作用；部分失败保留已创建/绑定资源。
未知、queued 或 accepted 发送不能自动重发。只有已完成且未被消费的回执证明
固定指派 `assignment=applied`、`message=not_sent` 时，才允许通过
`resume_request_id` 显式恢复该次发送；这不是换人或重开 Task。

## 6. 模块边界

Task 后端维护记录，普通 HTTP 与 HTTP MCP 共用业务服务和 `task-board.sqlite`。
宿主负责模块挂载、角色能力和原生 session；模块只通过公开
`context.host.call` 接入，不访问私有 runtime、聊天、凭据或其他数据库。

前端是聊天中的内联引用卡片与按需打开的当前数据详情，不是独立 dashboard、
编辑器或调度界面。消息 event 固定，卡片数据重新读取；Task 报告和按需原生
session 观察分开显示，不伪造实时业务进度。

宿主兼容性、启动后通知恢复和关闭保护见
[宿主契约](task-host-contract.md)与[实现契约](task-implementation.md)。
打包、测试或文档更新不执行安装、真实 session 操作或生产部署。
