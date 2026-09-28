# Task MCP 工具契约

[contracts.js](../src/task-board/contracts.js) 是严格输入 schema；业务约束在 service/store
事务中核对。本文描述 schema12 的操作路径，不把历史回执改写成新调用。
Task 保存本项工作特有的约定。行为见 [Skills](task-tools-skills.md)，
字段见 [Schema](task-schema.md)，外部效果见 [实现](task-implementation.md)。

## 1. 身份、关系与共用输入

唯一 `node` 角色暴露全部 Task 工具，但工具可见不等于操作权限。
MCP 必须有宿主 `_meta["cockpit/invocation"].sessionId`，否则连读取也
`INVOCATION_REQUIRED`；不接受参数 actor/invocation。helper 归因到 containing
session。HTTP 固定内部 actor=user，不是可冒充的 session。

Agent 只绑定 own assignee；parent_assignee 动态从 parent 得到。created_by 只为历史，
没有旧 orchestrator 输入/当前字段/授权 fallback。root 无 parent，无额外 owner。
actor_role 为 assignee、parent_assignee、user 或 none；所需 parent 未绑定明确失败。
用户授权仍是外部边界，不由 Task 工具替用户作决定。

所有 mutation 用稳定 `request_id`。下文 **existing** 指
`request_id,task_id,write_context`；**current** 指 existing 加当前 `revision`。
write_context 从结果原样传回；结构、模式、意图/状态及资料代次保护并发，不自行构造。
同一 caller 与其 helpers 共用 `(actor,request_id)` 空间，不同 session 可复用 ID。
原 ID 重放保持输入完全一致，换输入冲突；operation/resume 不能读另一个 caller 的回执。
历史无可靠 caller 的 ID 保留 `LEGACY_OPERATION_UNSCOPED`，不得换 ID 重复不确定效果。

| 上限 | 字符/数量 |
| --- | --- |
| session/request ID；write_context；cwd | 200；1,000；4,000 |
| title；description；reason | 240；24,000；2,000 |
| references | 20 项，label 200、target 2,000，合计序列化 8,000 |
| metadata | 纯 JSON，8,000 字符、深度 12，有界节点检查 |
| description + references + metadata | 序列化 64,000（编辑包含原未改字段） |
| activity；outcome；retro | 4,000；8,000；2,000 |
| activity/outcome；outcome+retro | 每对象/组合序列化最多 16,000 |
| blocked_by；condition | 20 项；每文字条件 2,000 |
| list/ancestors；普通历史 | 最多 50；最多 10 |
| 页；overview include | 序列化 24,000；48,000 |
| 结构遍历 | 10,000 节点，超出 TREE_RESOURCE_LIMIT，不是固定业务深度 |

未知顶层字段拒绝。references/metadata 提供时整体替换，省略保留；不存秘密、
不隐藏决定。UUID 是纯 ID，不是带 query 的 task: 链接。普通文本不能空白。

## 2. 读取

`task_read(view=...)` 不 ACK。actor 不自动筛选 list；派发前跨任务冲突检查
使用未加关系过滤的 status=unfinished 列表，按需分页。

| view | 输入与内容 |
| --- | --- |
| list | parent_assignee? / assignee? / parent_task_id? / root? / work_mode? / status? / query? / retro? / limit? / cursor? |
| overview | task_id，include?：当前紧凑上下文与所选完整内容 |
| execution | task_id，完整当前约定、ACK、模式、parent、前置、意图及最新活动/成果，assignee 恢复入口 |
| definition | task_id，完整当前 description/revision/references/metadata/context |
| ancestors | task_id、limit?、cursor?，最近 parent 在前的有界当前祖先身份链 |
| changelog | task_id、分页，或 revision 选完整一版（不能同时分页） |
| activity / outcomes / dependencies / responsibility_events | task_id、分页；实际版本/作者/时间和原始事实 |
| retro_handlings / subscriptions | task_id、分页 |
| dependency_notices / child_notices / assignee_notices | task_id、分页；历史触发与投递事实 |
| automation_log | task_id、offset?、limit?（最大8,192），合并 stdout/stderr |
| operation | 当前 caller 的 request_id，完整持久步骤/不确定回执 |

status 默认 unfinished，允许四业务状态、unfinished、all；query 只匹配 title。
retro=unhandled/watching 时 status 默认 all。root 是 list 派生过滤器，不是持久 root 类型。
parent_task_id 只列直接 child，不嵌入全树。active condition 含 dependency_id，供精确证据解除。
上下文 children 为 `{total,nonterminal}`；legacy 是布尔历史标记，未知模式不伪造为 execute。
cancellation_request 为 null 或 `{reason,author,at,request_id}`。
responsibility_events 项为 `{id,task_id,kind,author,at,details}`；kind 包括
created、claimed、assigned、started、converted、attached、blockers_replanned、
condition_resolved、reopened、completed、cancellation_requested、cancellation_finalized、migrated。
list/history 返回 items,next_cursor；cursor 绑定过滤/视图，不能自行拼接或跨查询复用。

### 单项按需组合

include 只用于 overview，为非空、不重复白名单：
context、activity、outcome、retro、definition、automation、cancellation。
不可同时分页或选择 revision。context 始终返回，含当前 ID、binding/parent、
work_mode/legacy、status、revision/ACK、context、前置、child summary 和取消意图。
activity/outcome 是最新完整记录或 null；未选字段不加载/返回。retro 区分
not_recorded、recorded(text=null 表示无发现)、automation 的 not_applicable。
cancellation 组返回最终取消详情，不把 intent 当已终态。

同一 SQLite 只读事务取得所选内容；definition_check 在响应检查点另行刷新，
可能更新，仍须处理。超 48,000 返回 RESULT_TOO_LARGE 和大小诊断，不截断成完整假象；
缩小 include，大定义用 execution/definition，历史按页读。
current 仅比较 description revision，不证明目标达成；activity_count 不统计聊天或脚本日志。
data_version 是缓存相等令牌，不是业务 revision。

## 3. 登记、承接和履责

### task_create

输入 request_id,title,description，加 references?、metadata?、blocked_by?、
automation?。Web user 可显式 parent_task_id；session 不可自行选 parent。
有 active Agent Task 的 caller 自动在自己的有效 in_progress/orchestrate/current ACK/
ready/无取消意图责任下建更具体 child；无 active Task 只建普通未绑定 root。
所有祖先必须有效。新 Agent 为 todo/undecided，不绑定、ACK、派发或执行。
创建者不保留管理权，backlog 可不承接。

### task_claim

current，无 assignee 参数。就绪 Node 只承接既有 unbound root，
不适用 Web user 或 child，不授予创建者特权。服务只读 host capability/node 检查，
事务重查根、版本、占用与合法性；当前 caller 不套外部接单 idle 门槛。
成功绑定为自己，不自发 assigned、改标题、ACK 或开工。
可承接 blocked root 以澄清前置；Node 能力就绪不等于 Task ready。

### task_start

current + work_mode=execute|orchestrate。仅 own assignee，todo、精确 current ACK、
ready、合法 active orchestrating 祖先、无取消意图。原子写 in_progress+mode。
不设置 native interaction mode，不自动创建 child。report 不替代此入口。

### task_convert

current + reason≤2,000 + completed≤8,000 + remaining≤8,000。
仅 own assignee，当前 ACK、active execute、合法祖先且无取消意图。
保存转换原因、既有成果与剩余责任，推进 context；保持 Task/assignee，不降级，
不改变 native 模式。后续 child 必须更具体，父仍承担整体结果。

### task_attach

current + parent_task_id + parent_write_context + reason≤2,000。
仅目标 parent 的 assignee 或 Web user。把既有 todo/in_progress root 接到另一
session 承担的有效 active orchestrate parent，核对两边 context、祖先、取消意图、
防环及新祖先下 blocker。保留原绑定/子树/历史，原子更新 descendant depths 和失效版本。
没有 detach/任意 reparent，资源超限失败而非局部挂接。

### task_session_create / task_session_prepare

create: request_id,cwd，加 skills?、mcp_servers?；通过 host 创建真实 node。
prepare: request_id,session_id，加同资源选择；目标必须已加载空闲、Node 已应用、
无待重载角色、无未结束 Task。两者不绑定 Task、不发初始化消息。

#### 两个入口共用的资源选择与回执

skills 最多64个现有原生名称；mcp_servers 最多64项 `{name,tools?}`，
每个最多256个 exact raw tool names，拒绝通配符/重复；tools 省略/空仍须至少一项实际 offered。
显式资源字段（含空数组）要求 resourcePreparationVersion=1；
省略选择保留旧创建兼容。只启用所选已存在资源，不安装/认证/改全局默认、
模型/角色、重载或绕过过滤。Skill enabled 不等于正文已读，MCP connected 不等于 offered。
preparation、host resources 分步效果与最终 capability/native availability 分开。
部分失败保留 ID/已生效资源；不确定不重建替代者，先读 operation。

### task_assign

current + assignee + resume_request_id?。仅 current parent_assignee 或 Web user 外部派发
unbound todo Agent，Web user 也可派 root。父不能自派 child 或派祖先；无固定层数上限。
检查业务容量、ready/祖先/取消意图及已有 Node 能力、原生空闲，再绑定、复查、发送一次 assigned。
不补角色/资源或主动中断，check/send 不是原子：queued/unconfirmed 分别保留真实步骤。

<a id="assign-session-title"></a>
默认/自动生成 native 名称可 best-effort 设为 Task title；用户命名保留，
来源未知则跳过。标题错误独立，不撤销绑定，也不适用于 claim。
只在同 caller 的 final 回执明确 assignment=applied/message=not_sent 时，
允许新 request_id + fresh current + 同 Task/assignee + resume_request_id
完成一次原发送。pending/unknown/queued/accepted 不得恢复，不能借此换人或重开。
failure-time availability_reasons/observed_at 不是实时观察，operation 读取不会重测 host。

## 4. 约定、前置与结果

### task_edit / task_ack

edit: current + reason + 至少一个 title/description/references/metadata/blocked_by。
own assignee、current parent_assignee 或 Web user；不能编辑 binding/mode/parent/status。
own assignee 真正改变 unfinished description 自动 ACK 新 revision；
相同文字、资料-only、terminal 编辑不 ACK。ACK: current，仅 own assignee，
确认 exact revision，不开始工作、解除条件或生成 activity。

blocked_by 整组原子替换，避免 false-ready 间隙。own assignee 可新增文字条件，
但不能通过 edit 移除/替换已有 condition 来绕过证据；parent/user 重新规划须 reason。
Task-ID 等 done（不是 success），cancelled 不解除、reopen 不复活已解除关系。
children 不自动成为 parent 的 blockers。

### task_resolve_condition

current + dependency_id + evidence≤4,000 + references?。
own assignee、current parent_assignee 或 Web user 对 active 精确文字条件登记满足事实。
证据持久进 dependency history，root 自己也可办理。不能移除 Task-ID 前置、
重写条件含义或改变授权；写回用户答案的 description 本身不是解除。

### task_report

current + activity? / status? / outcome?，至少一项；retro? 仅 done 接受。
仅 Agent assignee，针对实际 ACK 版本。status=in_progress 只确认已开工，
不从 todo 开始；done 必须 in_progress、current ACK、ready、无自身取消意图、
全部直接 children terminal，并同次新 outcome + 显式 retro 文本或 null。
祖先仍须有绑定且 active orchestrate，但祖先的取消意图或 blockers 不阻止既有 child done 收口。
outcome 不隐式 done。旧 ACK activity 可真实保存，同次过期状态/成果拒绝并说明部分应用；
不重写旧成果版本，不重复已保存活动。

### task_cancel / task_cancel_finalize

cancel: existing + reason。own assignee、parent_assignee 或 Web user。
Agent 持久写 cancellation_request，状态保持（叶子也如此），必要时通知 assignee，
不自动级联/停止 native 工作。意图下禁止普通 start/create-child/assign/convert/attach/done，
仍可读/ACK/edit/activity 与善后。祖先意图阻止后代新进展；既有 child done 按上述收口例外，
不因祖先的取消意图或 blockers 被卡住，自己的意图仍禁止自己的 done。

finalize: current + summary≤8,000，需取消意图。绑定 Agent 仅 own assignee；
未绑定 Agent 仅 Web user。要求直接 child 全部 done/cancelled，但不要求 abandoned prerequisites ready 或 ACK。
记录最终处置并 cancelled。Automation cancel 仍走服务终态/进程组取消，不走此入口。

### task_reopen

current + 完整 description + reason。own original assignee、current parent_assignee 或 Web user。
只允许 done Agent；保留 assignee/mode，原指派有可靠序号、之后无任何新指派、
无其他 unfinished Task，host 能力就绪（不套当前 caller idle）。
所有祖先需 active orchestrate、无 intent；先合法恢复祖先，不自动恢复。
legacy unknown mode、cancelled 或 automation 拒绝，不猜测/替换。
没有 post-schema12 mode-repair API；有证据的历史 mode 只能在显式审阅的 11→12 迁移中选择，
不补造 started 事件。
原子新 revision+in_progress；own 调用 auto-ACK，其他合法调用通知更新。
不创建环境、不派单、不续订，不恢复旧依赖或拿旧 outcome 完成新约定。

### task_retro_handle

request_id,task_id,outcome_id,status,note,references?。任意 caller 为已记录有发现
retro 追加 fixed/followup/watching/dismissed；followup 必须引用且为终态处理，
不会因后续工作结束重新处理。没有 status 变更、通知、默认改善授权或自动派发。

## 5. Automation 与订阅

### task_script_read / task_script_register

read: script_id 或 limit/cursor。register: request_id,script_id,title,description,
绝对 executable/script_path、argv（默认[]）、有序 parameters=[{name,type,description}]。
script_id 为小写 kebab，最多64；参数名 snake_case 最多64；类型 string/integer/boolean。
argv/参数各最多32；参数字符串≤4,000，typed input JSON≤8,000。
既有可信脚本指纹及配置不可变，变更需新 ID，注册不执行。
只在 Linux/WSL2 支持；不是为了绕过 Agent 临时造脚本。

### task_automation_start / task_automation_reconcile

automation create 保存 `{script_id,parameters}` 快照，无 assignee/mode/ACK。
start: current，由 parent_assignee 或 Web user 显式入持久单队列一次；
parent 必须有效 orchestrating，ready/取消意图仍约束开始。root automation 由 Web user 管理。
reconcile: existing+reason，同权限，只在证明无启动握手或 Linux 组不存在时解除屏障。
不杀 recovered processes、不重跑、不改结果、不宣称成功。
done 可为 succeeded/failed/interrupted；取消不证明退出或回滚。
详见 [automation](task-automation.md)，保留原进程组和日志边界。

### task_subscribe / task_unsubscribe

subscribe: existing + statuses + subscriber?。MCP caller 订阅自己，不能选他人；
Web user 必须明确 subscriber session，不回退 creator。默认不订阅；
只为未来状态解锁必要后续动作，不为追踪或确认完成。
已匹配、终态或相同 subscriber 重复 waiting 拒绝。首次匹配消费，未匹配终态 expired。
unsubscribe: request_id,task_id,subscription_id；任意 caller 可取消 waiting，
无需 write_context，不能撤回已消费或已发送通知。

### 通知投递证据

| event | 固定标签 |
| --- | --- |
| assigned | Task assigned |
| updated | Task updated |
| cancellation_requested | Task cancellation requested |
| cancelled | Task cancelled（历史） |
| blocked | Task blocked |
| ready / blocker_cancelled | Subtask ready / Subtask blocker cancelled |
| child_done / child_cancelled | Subtask done / Subtask cancelled |
| child_blocked | Subtask blocked（历史） |
| status_changed | Subscribed Task status changed |

格式 `[label](task:<uuid>?event=<event>)`，普通引用 `[Task](task:<uuid>)`。
label/event 不是状态、命令或授权，不复制 description。
ready 时要求变化、ready 边界、reopen/blocker 取消按规则通知 assignee；
blocked 期间普通变更、部分解除静默，不自我提醒。
child/dependency notices 记录 recipient 快照；发送前核对当前 parent/binding，
关系变了记 not_sent，不重定向或重试。未绑定 root 不猜收件人。
显式订阅单独按 subscriber 路由；匹配同一次同收件人时去重。
assignee intent/update 使用 immediate，其余 enqueue；不清队列，不回答 pending 决策，
不宣称已读。旧 pending assignee notices 启动时过期；其余 known-unattempted 通知
仅 onReady 有界恢复，unknown/accepted/queued/not_sent 不重试。

## 6. 响应、错误与恢复

响应分 result/error、definition_check、notifications/notification_error。
保存成功与后续通知失败独立；definition_check 在失败/重放后也按当前事实检查，
unavailable 不等于无变化。读不 ACK，旧通知不恢复暂停授权。
冲突/未知先读 original operation 和当前 Task，不盲改 ID 再执行或私写数据库。

错误包括输入/身份/关系不符、未绑定 parent、未就绪、未 ACK/版本/context 冲突、
非法模式/生命周期、子项未终态、取消意图、防环/资源限制及外部 host 不确定。
使用实际返回的 code/result，不把无错误文案当作成功或猜恢复路径。
普通加载 schema≤11 不自动迁入责任模型；按
[schema12 显式程序](task-responsibility-migration.md)审阅，不以工具调用代替迁移。

模块 HTTP 与 MCP 共用 service/storage；官方 Streamable HTTP 和 host public API
边界见 [host](task-host-contract.md)。协议重连不是重跑 mutation 的理由。
