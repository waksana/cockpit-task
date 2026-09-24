# Task 产品设计

Task 是 Cockpit 内的独立任务协作模块。模块 ID 与 MCP key 为 `cockpit-task`，
展示名称为 Task；orchestrator / assignee 是每条 Task 的协作关系，不是项目身份或可选 session 角色；服务按关系授权写入。

使用与打包见 [Task](task-board.md)，记录语义见 [Schema](task-schema.md)，
调用接口见 [MCP 契约](task-mcp-contract.md)，行为指导见
[角色 Skills](task-tools-skills.md)。隔离验证方法见
[生命周期回放](task-lifecycle-testing.md)。

## 1. 一个 Task，一个完整结果

用户可以先与 orchestrator 讨论想法、澄清范围，再明确登记或授权执行。讨论、调查、
记录想法和启动交付是不同决定；不为闲聊自动建 Task，也不把登记等同于派单。

orchestrator 管理多个独立 Task，默认 Agent Task 交给一个 assignee 完整负责，包括调查、
实施、修正和交付。独立成果可分别建 Task；紧密关联的步骤、资源和专业分工
由同一 assignee 内部组织，可使用 subagent，不转移整体责任。

对于已授权、可信、可重复的已知脚本，orchestrator 可显式选择 automation Task；
服务持久单队列执行，没有 assignee、ACK 或 session 占用。登记和创建不执行，
可选必要订阅之后才显式 start；不是把任意工作脚本化或增加工作流引擎。
成功 done+outcome，失败/中断 blocked+outcome，不自动重跑；详见
[轻量自动化](task-automation.md)。以下指派、ACK 和 Agent 协作规则不套用于 automation。

- Task 之间只有普通引用，没有父子关系、任务树、依赖引擎或级联调度。
- 一个 session 同时最多执行一项未结束 Task，完成或取消后可承接其他 Task。
- 首次绑定后不能替换 assignee；orchestrator 或符合条件的原 assignee 可在用户明确授权返工时
  用 `task_reopen` 将 done Agent Task 重开，工作仍由原 assignee 继续；cancelled / automation 不适用。
- orchestrator 信任 assignee 完整交付，不增加默认上游审批或逐阶段重新派单。
  `in_review` 仅在工作约定本身需要评审时使用。
- 新建或 fork session 不自动隔离共享资源，也不继承额外授权。

orchestrator 可以只读调查、回答问题和比较方案。实施及改变外部状态的交付默认委派，
不亲自实施或用自己的 subagent 代替独立 assignee。用户要求一个结果不等于要求
orchestrator 本人执行；明确要求本人执行，或实际以具备能力的 assignee 身份承接 Task，
才是个人执行例外。上述 automation 是另一条显式服务执行路径，不允许静默接管任意工作。
无法委派且不符合可信脚本边界时应说明阻塞。
编码工作中 orchestrator 只说明要求并引用现有 Issue；assignee 自行建立独立 worktree 并在合并后
安全清理，orchestrator 不准备或清理环境；独立 [github-coding Skill](../skills/github-coding/github-coding/SKILL.md)
定义这条工作流程，不改变角色分工或为非编码 Task 增加步骤。

## 2. Task 是共同工作记录

Task 保存完整当前约定、资料、修订、执行动态和成果。聊天与通知只提供交流
或引用，不维护第二份要求或进度账。用户可以直接与 assignee 澄清；
影响范围、约束或交付条件的结论应写回 Task，不要求 orchestrator 转述。

| 记录 | 职责 |
| --- | --- |
| `description` | 完整当前工作说明，包括背景、目标、约束和完成条件 |
| `revision` / `changelog` | 仅对 description 版本化；保留每版正文、作者、时间与原因 |
| `acknowledged_revision` | 固定 assignee 已确认的 description 版本；逐版确认另有记录 |
| `activity` | assignee 报告的执行事实，指向实际依据且已确认过的 revision |
| `status` / `outcome` | 明确的工作状态与成果；不从 activity 文本或 session 状态推断 |
| `retro` | Agent 交付后的轻量复盘，独立于成果，随同次完成记录保存 |
| `references` / `metadata` | 补充资料；不形成依赖或新的 Task 子类型，不隐藏工作要求 |

orchestrator 修改 description 不替 assignee ACK，也不生成 assignee activity。当前
assignee 亲自成功修改未结束 Task 的正文时，同时确认新 revision；相同正文、
仅资料编辑或终态编辑均不自动 ACK。ACK 本身不开始执行、不解除阻塞、不生成活动。

状态、归属、动态和 ACK 不推进 description revision。旧成果保留原版本；
定义改变后，旧成果不能冒充新要求已交付的证明。终态定义可以编辑，但不会重开执行。
独立的 `task_reopen` 是窄例外：同一 Task/orchestrator/assignee 原子进入 in_progress，
强制新建定义版本（正文相同也递增）；原 assignee 调用时自 ACK，orchestrator/Web-user 调用时不 auto-ACK 并给 assignee 发送 `[Task updated]`。保留旧成果、复盘、资料及所有历史。
新交付仍需新 outcome 和显式 retro，不把旧 ACK/成果当作新版交付。

资格由 schema v5 后的持久单调指派序号判定：自原指派后未承接其他 Task，
后来已 done/cancelled 也会永久使该旧 Task 不符合条件；同时不得占用其他未结束 Task。
升级前已经指派的全部不符合资格，无时间戳推断或历史回填。
原 assignee 在当前执行轮次可自助重开，只查能力就绪、不套首次派单 idle 门槛；
不派单、不恢复已结束订阅或补发通知。orchestrator 重开仍使用同一原 assignee，不创建替代执行者。
orchestrator 不为可合法继续的原 assignee 建替代 Task；不符合条件则采用适当的新授权 Task。
不新增通用状态日志、强制 activity 或轮次状态机。

assignee 完成交付后、done 前简短回顾：保留有证据、可行动的自动化候选、具体慢点或
重复卡点、Skill/MCP 发现/契约/能力验证缺口；区分观察、假设、外部等待，不编造耗时。
不要求多段模板或填充内容；无有用发现传 null。Agent done 同次必须显式提交新
outcome 和 `retro` 文本或 null，普通报告不传；服务保证提交，不保证思考或文本质量。
轻量视图只显示状态、归因与处理状态；历史未记录不冒充无发现。复盘不代替成果和阻塞、
不授权改进或扩大范围，服务不新增通知、派单或完成门槛；创建该 Task 的 orchestrator 按 Skill
用 `task_retro_handle` 处理有发现的 retro（有Subtask 的 assignee 在自己 done 前，根节点仅在用户问起时）。
脚本 automation 不运行 Agent、也不需要 retro；现有服务成果和生命周期保持不变。

## 3. 登记、准备和指派是独立操作

```text
澄清并登记 Task
  → 明确选择工作资源，新建 assignee 或准备符合条件的既有 session
  → 指派工具检查能力和原生可接单状态，固定执行归属
  → 发送一次 assigned 引用
  → assignee 读取完整当前约定并 ACK
  → 明确开始执行，持续维护 Task，完整交付
```

`task_create` 只登记，backlog 无需派单；`task_session_create` 通过宿主新建并装配
Task assignee，可显式准备所选 Skill/MCP。`task_session_prepare` 为已加载空闲、
无未结束 Task、已应用 assignee 且无待重载角色的既有 session 准备资源。
两者不关联 Task 或发送消息；不强制优先新建或复用，也不自动匹配候选者。
选择限于已存在可发现的原生名称，不从 description 推断，不安装、认证或改全局默认值。
旧创建省略选择时保持兼容；显式准备须有独立宿主能力标记，缺失在副作用前拒绝。
`task_assign` 只指派 orchestrator 选定的已有 session，
不追加角色、安装 Skill、启用 MCP、重载或创建替代者。

宿主提供角色选择、组合、持久化、冷恢复及已有 session 的角色管理。
Task 自身不暴露已有 session 的角色变更；宿主角色变化不等于 Task 指派，
也不改变现有交付责任。orchestrator / assignee 可以同时具备，工具取并集，
但多角色不放宽单项未结束执行的限制。

角色标签表示配置，不证明当前能力就绪。创建后和指派前显式检查能力；
原生运行、队列、待决问题和后台工作另行检查，不持续采集或展示 readiness badge。
工具能力是装配范围，不是逐 Task ACL；`actor` 为自报归因，
不能宣称验证了身份、用户授权或实际阅读。

## 4. 主动同步，默认静默

orchestrator 按需读取 Task 了解情况，不向 assignee 聊天追问进展或索要确认。
assignee 在自己的 session 向用户提出真实决策问题，把进展、阻塞和成果写回 Task，
不直接或通过 subagent 向 orchestrator 发消息。面向用户的简洁总结允许，但不是另一份持续账本。

assignee 在开工、恢复、重要阶段之间、重要外部操作前和交付前读取最新定义，
理解变化并 ACK 精确版本。每次 Task 业务调用的 `definition_check` 都需处理，
包括读取、失败和重放；提醒不等于自动确认或后台通知，不要求忙循环轮询。

消息用途严格区分：

| 用途 | 消息 |
| --- | --- |
| 普通引用 | `[Task](task:<uuid>)` |
| 首次派单，由 `task_assign` 发送一次 | `[Task assigned](task:<uuid>?event=assigned)` |
| assignee 之外的调用者修改已指派未结束 Agent Task 的 description / `blocked_by`、重开或依赖变化 | `[Task updated](task:<uuid>?event=updated)`，附读取/ACK 最新版要求 |
| assignee 之外的调用者取消已指派未结束 Agent Task | `[Task cancelled](task:<uuid>?event=cancelled)`，附读取取消理由并停止受影响工作要求 |
| 显式一次性状态订阅，由系统通知 subscriber | `[Subscribed Task status changed](task:<uuid>?event=status_changed)` |
| 依赖方的全部 blocker 已 done，由系统通知 orchestrator | `[Subtask ready](task:<uuid>?event=ready)` |
| 待派发依赖方的 blocker 被取消，由系统通知 orchestrator | `[Subtask blocker cancelled](task:<uuid>?event=blocker_cancelled)` |
| Subtask 进入 done，由系统通知其 orchestrator（父 Task 的 assignee） | `[Subtask done](task:<uuid>?event=child_done)` |
| Subtask 进入 blocked，由系统通知其 orchestrator（父 Task 的 assignee） | `[Subtask blocked](task:<uuid>?event=child_blocked)` |
| Subtask 进入 cancelled，由系统通知其 orchestrator（父 Task 的 assignee） | `[Subtask cancelled](task:<uuid>?event=child_cancelled)` |

首次派单不复制 description，orchestrator 不重复发单。普通编辑与报告静默。
assignee 之外的调用者对已指派未结束 Agent Task 改 description / `blocked_by`、重开、取消或依赖变化时，服务自动用
`mode:"immediate"` 发送固定 updated/cancelled 引用和读取/ACK 或停止工作要求。
不整理或重放队列、不为通知中断工作；受理不等于消费或 ACK，未知效果不盲重试或手写补发。

状态订阅默认不使用。只有未来状态使 orchestrator 必须采取具体、必要的后续行动时
才登记；单纯看进度或确认完成不是理由。不虚构后续工作或审批关卡，
选择最少必要目标，后续行动不再需要时取消等待。首次匹配后结束，
不自动续订；assignee 不等待订阅或通知被读才执行。登记时已匹配则失败，
不即时补发；通知投递与已保存的 Task 成果分别记录。

## 5. 如实保留冲突与不确定性

Task 保护版本、逐版 ACK、生命周期、首次绑定、单 session 单项执行及请求幂等。
这些是数据一致性，不是按 orchestrator/assignee 归属鉴权。

已实际 ACK 的旧版 activity 可保留原 revision；同次请求的过期状态或成果拒绝，
必须明确部分应用。读过或确认更高版本不证明被跳过的版本已获确认。

session 已创建、资源准备、能力就绪、归属已绑定、消息被接受、ACK 和实际执行是不同事实。
Skill enabled 不等于正文已读，MCP connected 不等于工具 offered；assignee 仍须在
首次需要时自行加载相关 Skill 正文。准备分步效果和最终 readiness 分开保留，
已知失败先检查回执及当前状态，再明确继续；未知准备不允许盲重试或替换。
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
