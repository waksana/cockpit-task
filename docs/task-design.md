# Task 产品设计：递归责任

Task 是用户授权范围内的一份持续责任，跨回复、压缩、卸载仍存在。
一个 Agent Task 只绑定自己的 `assignee`；负责人亲自交付（`execute`），
或通过更具体的子责任组织交付并整合结果（`orchestrate`）。拆分不免除整体责任。
创建来源 `created_by` 只是历史；上级负责人从当前 parent 的 assignee 派生，
没有独立当前 `orchestrator` 绑定，更没有树外长期 owner。

使用见 [Task](task-board.md)，字段见 [Schema](task-schema.md)，
工具见 [MCP 契约](task-mcp-contract.md)，行为见 [Skills](task-tools-skills.md)。

## 1. 责任、授权、工具分开

Task 保存本项工作特有的目标、决定、边界和完成要求。讨论、调研、登记、准备资源
不是开工授权。用户可以直接与任何节点沟通；面对决定的节点直接问用户，不逐级上报
问题或重复提问。影响约定的回答写回 Task；跨责任影响由当前父负责人据已授权事实安排。
正式节点间只通过 Task 记录与服务通知协作，不私聊，不通过 helper 传话。

工具选择与履责方式正交：**execute 与 orchestrate 都可用 helper**，结果仍由调用者整合。
独立审查可以是 helper；不是每次调用工具都要建 Task。只有需要独立持续交付责任时才建子 Task。
不以工具名、调用数、子节点数量判断模式，也不追求更多 session 或更少 Task。

execute 包括深入研究、实施和审阅，不只写代码。orchestrate 的交付包括拆分、
接口/依赖安排、阻塞处理、必要决策、成果判断和整体收口；为这些判断可做有限调研，
持续实施与深入专项调查放在子责任中。执行者需要独立委派时，先显式转换，
记录原因、已有成果与剩余责任，再分解；不是原样逐级转包。
转换保留 Task 和 assignee，不扩大授权，且不降回 execute/undecided。

工作方法另由项目指令及 [github-coding](../skills/github-coding/github-coding/SKILL.md)
等 Skill 指导；两种模式不是通用工具沙箱，也不改变 native interactive/plan/autopilot。

## 2. 初始化、绑定和原子开工

| 事实 | 含义 |
| --- | --- |
| `task_create` | 登记 `todo/undecided` Agent 意图，不绑定、不发消息、不执行 |
| `task_claim` | 就绪 Node 承接普通未绑定 root，不自派单、不改标题、不 ACK |
| `task_assign` | 当前父负责人或 Web user 外部派发；准备、绑定、消息受理分别记录 |
| execution + ACK | 对完整当前约定的精确版本确认，不开工、不解除条件 |
| `task_start` | assignee 对当前已 ACK 且 ready 的 todo，原子选择 execute/orchestrate 并进入 in_progress |
| `task_convert` | 已开工 execute 显式转为 orchestrate，保留成果与剩余责任审计 |

todo 期间只做必要澄清和轻度发现，不实施、不建子任务。不能 `todo→done`，
也不能用普通 report 绕过 start；未开始的意图仍可取消。
状态不是 native 忙闲、加载、工具运行或交付成功的推断。

一个 session 最多承担一项未结束 Agent Task；首次绑定不替换。
派发要求目标能力与原生空闲，claim 是当前 caller 承接，不要求其调用时 idle。
claim 可承接 blocked root 用于澄清，不代表 Task ready、ACK 或开始。
准备资源不授予责任，角色标签不证明工具实际可用，ACK 不证明真实理解。

## 3. 同一单元递归成树

没有 parent 就是普通 root，没有专用角色、标志或权限。长期 root 可以暂时无子任务，
继续承担已约定的管理责任；不因为树暂时空了自动结束，也不为了保活自动找工作。
未绑定 root 不猜隐藏负责人：就绪 Node 用 claim 承接，Web user 可外部指派。
创建者与其他 Node 一样，只能在明确授权且满足 claim 契约时承接，不保留额外管理权。

有 active Task 的 caller 只能在其已绑定、in_progress、orchestrate、当前 ACK、
前置满足且无取消意图时创建 child。祖先链也必须是有效的 active orchestrate 责任。
父负责人不能同时承担 child，不能向祖先派发或形成环。

用户授权增加更大范围的 parent 时，`task_attach` 把已有未结束 root 接到另一 session
承担的 active orchestrate parent 下，保留原 Task、绑定、范围、子树和历史。
当前权限、通知与读取随 parent 派生；创建来源不参与回退。
不支持 detach、任意 reparent 或以删除关系逃避收口。
没有固定三层业务上限；结构操作最多检查 10,000 个节点，超限明确
`TREE_RESOURCE_LIMIT`，读回分页且不嵌入无界树。资源保护不是新业务层级。

## 4. 子终态、整体结果、依赖不是一回事

父进入 `done` 或最终 `cancelled` 前，所有直接 child 必须 `done` 或 `cancelled`。
这是共同结构门槛，不自动转状态，不判断父目标已达成。
子 cancelled 满足终态门槛但不是成功成果；缺失交付应继续安排，或经用户授权调整父约定。
父 done 仍需满足自己的前置、完整成果、新 outcome 及显式 retro（有证据文本或 null），
并整合有用子复盘。需要集成代码时安排执行责任，不让父重回持续实施。

`blocked_by` 表示真实前置，不表示包含关系。不能把所有 child 自动变成父 blocker，
否则会阻止仍必要的编排。`{task_id}` 等待那次执行的 done，不保证成功；
automation 失败的 done 同样可解除它。若需要成功结果，明确写成功条件。
cancelled 不解除 Task-ID blocker，已解除关系不因日后 reopen 复活。

负责人可用 `task_resolve_condition` 对自己的具体文字条件记录用户答案或客观满足证据，
按精确 dependency_id 解除；parent assignee / Web user 也可办理。
这不是改写条件含义、删除 Task-ID 依赖或扩大授权的入口。普通 description 更新
不等于解除；父无需重复问同一个用户决定。涉及重新规划仍审计其原因及授权。

## 5. 取消与返工保持责任连续

Agent `task_cancel` 先持久记录 `cancellation_request`，即使叶子也不直接终态。
收到意图后停止推进放弃的目标，但仍可读/ACK、编辑、记录善后活动并安排子任务收口。
不能继续 start、创建/派发 child、convert、attach 或 done；祖先取消也约束后代普通进展。
但祖先仍有绑定且 active orchestrate 时，其取消意图或 blockers 不阻止既有 child
按自己的当前 ACK、ready、无自身意图及成果/子终态门槛 done 收口。
服务不盲目级联。所有直接 child 终态后，绑定 assignee 用 `task_cancel_finalize`
记录处置并最终 cancelled；未绑定 Agent 由 Web user finalize。
最终取消不要求实现已放弃的执行前置或 ACK，也不证明外部进程退出或回滚。

用户明确返工时，`task_reopen` 保留原 assignee、模式及历史并创建新 revision。
只允许有可靠指派序号、之后未承接其他 Task、无其他未结束责任且能力就绪的原 session。
祖先必须先合法恢复为 active orchestrate 且无取消意图；不能自动重开祖先。
cancelled、automation、未知 legacy mode 或资格不符时拒绝原位恢复，
不暗换人、另建替代责任、猜模式或恢复旧订阅。另行工作须独立明确授权。

## 6. 恢复和证据

开始、恢复、重要外部动作、交付前读完整 execution、ACK 精确 revision，
处理每次响应的 definition_check。已确认旧版 activity 可保留真实版本，
不能拿旧成果证明新要求已交付。新绑定、结构、模式、意图变更进入并发保护。

不确定操作先读原 caller-scoped receipt 和当前事实；相同 request_id 重放保持输入不变，
不盲重试、重派或换 Task。只有 final 回执明确 assignment=applied/message=not_sent
才允许契约限定的 resume_request_id；unknown/accepted/queued 都不行。
通知失败不抹去保存效果，投递不证明消费、ACK 或运行。

默认不订阅；必要后续动作才显式一次性等待，不轮询进度、不等通知被读。
Child 与依赖通知保存收件人快照，发送前核对当前关系；过时不改投他人或重试。
Web subscription 明确给 subscriber，不从 creator/root 猜接收者。

## 7. 服务与历史边界

automation 只运行已授权的现有可信脚本，由服务管理，无 Agent assignee/mode/ACK，
不临时造脚本绕过责任。取消仍走既有进程组与屏障协议；done 是尝试结束，
真实成败、退出及残留看 run facts，见 [automation](task-automation.md)。

schema 12 把当前责任与旧创建来源分开。普通加载拒绝自动猜迁移；
未完成历史责任必须显式审阅，终态未知模式保留 legacy，不伪造既往合规。
旧 JSON、回执、成果及不确定效果保留。升级方法只有
[schema 12 procedure](task-responsibility-migration.md)；
源码、合并与自动 Rolling 都不授权部署、重启或现有数据迁移。
