# Task MCP 工具契约

本文与 [contracts.js](../src/task-board/contracts.js) 定义当前工具输入、结果和错误。
记录语义见 [Task Schema](task-schema.md)，行为指导见
[角色 Skills](task-tools-skills.md)，隔离验证见
[生命周期回放](task-lifecycle-testing.md)。

## 1. 工具集合与角色

Task 提供十个工具，模块 ID 与 MCP key 为 `cockpit-task`。
登记、创建执行 session 和首次指派是独立操作；状态订阅是可选的一次性等待，
不是默认最终通知、监工或依赖调度。模块只维护 Owner / Executor 两份角色技能，
不包含 Coding / Research 工作技能。

| 工具 | Owner | Executor | 职责 |
| --- | --- | --- | --- |
| `task_read` | 是 | 是 | 按角色关注点读取，说明、历史、成果与操作结果按需展开 |
| `task_create` | 是 | 否 | 只登记，不指派或创建 session |
| `task_session_create` | 是 | 否 | 创建 Executor session 并配置执行能力，不关联 Task 或发送派单消息 |
| `task_assign` | 是 | 否 | 对未分配 Task 首次指派，检查已有能力、更新 Task、发送一次 assigned 引用，不补齐角色配置 |
| `task_edit` | 是 | 是 | 修改完整 description 或补充资料，不改变执行状态 |
| `task_ack` | 否 | 是 | 只确认 description 版本 |
| `task_report` | 否 | 是 | 记录 activity、明确更新状态或提交 outcome，不隐式 ACK |
| `task_cancel` | 是 | 是 | 明确取消，不停止 session；仅匹配已登记订阅时产生系统状态通知 |
| `task_subscribe` | 是 | 否 | 显式登记未来状态的一次性 Owner 通知，当前已匹配则失败 |
| `task_unsubscribe` | 是 | 否 | 取消仍在等待的订阅，不撤回已触发或发送的通知 |

表中角色表示宿主注入的工具集合，不是逐 Task 权限表。具有工具即可操作其他 Task，
owner / executor 用于责任、筛选和追溯，不作为 ACL。版本、状态、逐版 ACK、
幂等、固定绑定与单 session 单项未结束执行等数据检查仍适用于所有调用者。

Executor 子集没有创建 Task 或订阅工具。宿主负责已有 session 的角色管理；
Task 自身不暴露角色变更，指派不追加角色、Skill 或 MCP。
已绑定 Executor 不可替换，done / cancelled 不可恢复执行。

同一模块可以选择多个角色。仅选 Executor 时使用上表 Executor 列；
同时选 Owner / Executor 时工具取并集，共享工具只注册一次，两份 Skill 按委派和执行场景配合。
`task_session_create` 只为新 session 选择 Executor，不隐式选中两种角色。
角色变化或多选不等于实际承接，也不放宽执行占用限制。

### 普通更新不发消息，重要更新由 Owner 处理队列

普通要求更新只写 Task，不发送追加指令、提醒或待执行 cue。
Owner 判断重要更新不能等待正常同步时，可明确进行一次重要更新交接。

- Owner 按 Skill 先读取并保留 pending 内容，再按已保存的消息 ID 清理，包括其他 session / subagent 的消息；不能盲删未知内容或并发新消息。
- 随后总结保留的上下文，最后附上 `[Task updated](task:<uuid>?event=updated)` 和读取/ACK 最新 revision 的要求，合为一条消息发送；不复制完整 description。
- 必要时单次中断主轮次，不循环推进或静默取消后台工作；发送前查看真实原生状态，接受回执不等于已读取或 ACK。
- 首次指派先检查 idle / 空 queue，已知忙碌则不发送、不主动中断；检查与 enqueue 发送之间存在竞态，queued / unconfirmed 必须保留真实分步结果，不承诺绝不入队或盲重发。
- 不通过后台巡查、定时发送或 Task 自建消息队列触发该行为，不宣称是原子排他保证。

这是 Owner Skill 指导的例外流程，不是 Task 工具、自动推进或后台循环。
完整边界与模板见 [Owner 随包参考](../skills/cockpit-task-owner/cockpit-task-owner/references/important-updates.md)，
公开接入见[宿主契约](task-host-contract.md)。
task_edit、definition_check 和 ACK 差异都不自动触发队列清理、中断或消息发送。

## 2. 共用输入约定

表中 `?` 表示可选；对象中的固定字段严格校验，不把未知顶层字段默默丢弃。字符串与聚合读取上限见本节；所有写入需要 `actor_session_id`，读取可省略。

| 名称 | 含义 |
| --- | --- |
| `task_id` | 已存在 Task 的 UUID；不是完整 `task:` URI，不含 query |
| `actor_session_id` | 操作者自报的 session 标识；所有写入必填，读取可选，不是鉴权凭据 |
| `revision` | agent 实际读取或执行所依据的 description 版本，正整数 |
| `request_id` | 每次明确变更的稳定请求标识；同请求重试保持不变 |
| `write_context` | 从读取或写入结果取得的不透明并发上下文；原样回传，不自行构造 |
| `reason` | 变更原因；涉及用户澄清或取消时记录相应来源说明 |

`write_context` 是不透明技术上下文，不是业务版本或身份凭据。它分别编码生命周期与可编辑资料代次；description 使用独立 revision。首次绑定/实际状态变化推进生命周期，title/references/metadata 实际变化推进资料代次：

- 取消或完成后迟到的执行状态、成果请求不能复用旧上下文覆盖结束事实；不同 session 不能争抢同一 Task 的首次指派。
- 只有 description 更新时，不能一刀切拒绝本应允许保存的旧版 activity；按报告各部分分别处理。
- ACK 不因同时追加了一条无关 activity 就变成定义过期；冲突按实际依赖字段判断，不以全 Task 每次写入都失效替代设计。
- activity 引用的版本必须有该执行归属下的确认记录，包含本人修订时的自动确认。仅凭当前 acknowledged_revision 大于该版本，不能推断跳过的中间版本也确认过；SQLite 独立确认表逐版保留，不混入 description changelog。
- session ID 可表示委派方、执行者或操作者等业务上下文，不作为访问权限凭据。作者来源需如实记录，不宣称未经验证的参数具有可信身份保证。

所有变更工具都带 `request_id`；对已有 Task 的变更还带 `task_id` 和对应的 `write_context`，但 `task_unsubscribe` 直接以 `subscription_id` 检查等待状态，不接受 Task 上下文。`task_create` 和独立的 `task_session_create` 不要求已有 Task 上下文。重复请求不重复产生副作用；同 ID 换输入明确冲突。重放原结果时仍重新进行 definition_check，不因结果缓存而漏掉新修订。

通用引用形状为 `{label, target}`，两项均为字符串；`references` 为该形状的数组。`metadata` 为开放 JSON 对象，不存放凭据，不覆盖固定字段。编辑时提供的 references / metadata 整体替换该字段，省略则保持不变，空数组 / 空对象用于显式清空。description、title、reason 及文本成果不能为空。

Task ID 为 UUID。session/request ID 最长 200 字符，write_context 最长 1,000，cwd 最长 4,000，title 最长 240，reason 最长 2,000。description 最长 24,000 字符。references 最多 20 项，label/target 最长 200/2,000；整个 references JSON 最多 8,000 字符。metadata 为有界纯 JSON 对象，序列化最多 8,000 字符、深度最多 12。description、references、metadata 的组合序列化最多 64,000 字符，编辑也校验与现有未改字段的组合。

activity.text 最长 4,000，outcome.summary 最长 8,000；每个 activity/outcome 输入对象序列化最多 16,000 字符。列表默认 20、最多 50 条；历史默认 5、最多 10 条。每个列表/历史页另受 **24,000 序列化字符**聚合预算限制，可能少于所请求条数；所有剩余条目均通过 `next_cursor` 继续读取。预算包括 JSON 转义，不包括通用响应封装/定义检查；不截断历史正文。完整当前定义和单个完整修订不套用页预算，其输入组合与作者等字段限制使结果保持约 80,000 字符以内。overview 活动摘录最多 320 字符并带 `truncated`。

## 3. 工具输入与效果

### task_read

`view` 必须明确指定。Owner 默认用 `list` 并显式指定 `owner=自己的 session ID`，
单项用 `overview`；Executor 默认用 `execution`。这些是 Skill 的信息默认值，
不一次返回全部内容，也不限制任何持有工具者的读取范围。
列表筛选使用显式 owner / executor；actor 只提供归因和定义提醒，不自动筛选列表。

| `view` | 其他输入 | 返回内容 |
| --- | --- | --- |
| `list` | `owner?`、`executor?`、`status?`、`query?`、`limit?`、`cursor?` | 按显式筛选的轻量任务摘要页；不含完整说明、资料和历史 |
| `overview` | `task_id` | Owner 默认视图：标题、归属、状态、revision / ack、最新报告活动的有界摘录、成果是否存在及其版本、write_context |
| `execution` | `task_id` | Executor 默认视图：标题、归属、状态、完整当前 description、revision / ack、当前 references / metadata、write_context；不夹带活动、修订或成果历史 |
| `definition` | `task_id` | 双方按需读取完整当前 description、revision、资料和 write_context；Owner 修订前使用 |
| `changelog` | `task_id`、`limit?`、`cursor?`，或 `task_id,revision` | 默认修订摘要页；指定 revision 返回该版完整 description，不得同时传 limit/cursor |
| `activity` | `task_id`、`limit?`、`cursor?` | Executor 活动页，每条保留其 revision 和作者 |
| `outcomes` | `task_id`、`limit?`、`cursor?` | 保留的成果页，区分对应定义版本和执行归属 |
| `subscriptions` | `task_id`、`limit?`、`cursor?` | 有界订阅历史、匹配状态及投递事实，不扫描 Owner 聊天 |
| `operation` | `request_id` | 某次明确操作的结果，特别是指派步骤 |

列表默认只看未结束记录；可显式查询 done / cancelled。Owner 列表侧重各任务的执行者、状态、最新活动摘录、确认差异和成果可用性；Executor 列表侧重本人承接关系、状态与待确认版本。摘要使用现有字段和活动摘录，不生成另一份“进度总结”；摘录标明截断，正文通过专门视图读取，完整 description 不静默截断。

列表 `status` 可为业务状态、`unfinished`（默认）或 `all`；`query` 只匹配标题。overview/execution/definition 返回扁平字段，不包在 `task` 中；列表为 `{items,next_cursor}`，历史为 `{task_id,items,next_cursor}`。overview 的 `activity` 为可空摘录，`outcome` 为 `{available:false}` 或带 `id,revision,at,current` 的可用性记录，不附成果全文。execution/definition 返回当前 `description,references,metadata`，不附 activity/outcome。changelog 摘要带 `description_available,description_length`；选择单版返回 `task_id,revision,description,reason,author,at,source`。

operation 视图返回 `{request_id,tool,status,task_id?,result,error,created_at,updated_at}`；这里 status 是回执的 `pending|final`，与其内部 `result.operation.status` 及 Task 业务 status 不同。已有 Task 的操作从持久输入提供 `task_id`，失败且 `result:null` 时也保留关联，不返回整份输入。外部步骤保存在内部 operation，本地操作保存其原 effects/错误；definition_check 每次响应重新读取，不保存在回执里，也不能因原操作失败而漏掉相关 Task。

subscriptions 视图返回 `{task_id,items,next_cursor}`，默认 5 项、最多 10 项，并遵循共用页预算。终态 Task 仍可读取。每项为：

```text
subscription_id, task_id, owner, actor_session_id, statuses,
state, created_at, ended_at, ended_by,
event: null | {event_id, request_id, from_status, status, at, actor_session_id},
notification: {status, attempted_at, completed_at, error: null | {code, message}}
```

`state` 为 `waiting|triggered|cancelled|expired`；`ended_by` 仅显式取消时记录操作者。进入非目标终态时等待自动变为 expired，不发送通知。event 是实际触发时的持久事实，不随卡片读取的最新状态改变。notification 的状态与订阅状态、Task 状态各自独立，含义见下文。

UI 可以不提供 actor，不伪造 human session ID；定向读取仍检查该 Task。Skill 在读取也提交自己的 `actor_session_id`，使列表或跨 Task 调用同时检查当前承接的未结束 Task。公开 MCP schema 使用对象根展示 `view` 和 selector，服务仍严格按视图验证，不能混用无关字段。

视图只决定返回内容，不限制读取权限。Owner 并非不能读定义，Executor 也并非不能读历史，只是不默认塞入。活动、修订、成果分别分页，操作结果只返回指定操作，不查询聊天或冒充 native 动态。读取不 ACK。

`definition_check` 仍适用于 Executor 的每次调用，只附必要版本提醒，不借提醒返回整份 Task。写入响应也只返回明确效果、相关版本/状态及新 write_context，不因一次 ACK 或报告而重新附上完整 description 和历史。读取缺失或不可访问的记录明确报错。
其中 ACK 提醒描述的是指定 Executor 尚未确认当前要求，不指示 Owner 或其他读取者代为 ACK；
一般的修订冲突要求读取当前定义，不把修订要求与 Executor 的确认责任混为一谈。

### task_create

输入：`actor_session_id, request_id, title, description, owner, references?, metadata?`。owner 是明确的委派 session 业务标识，不作为授权凭据，不要求新增可信身份服务。

输出：Task ID、初始状态/版本与 `write_context`，不重复回传输入的完整正文。状态为 todo，executor 和 acknowledged_revision 为 null。description 初始为 v1，保留初始定义记录。

不接受 executor、初始执行状态或 outcome 参数。不创建 session，不注入角色，不发消息。

### task_session_create

Owner 决定新建及所需工作环境；该独立入口通过宿主公开能力创建真实 Executor
session、装配 Task 指导与工具并显式检查能力。不要求 Owner 手工拼装，
也不接受自报“能力已就绪”代替检查。

完整输入：`actor_session_id, request_id, cwd`。不接受 `work_skills`、任意角色或宿主配置透传。Task 只负责自身 Executor 协作能力；Coding / Research 的内容、安装和维护不属于本模块。模块调用 `context.host.call("session/new",{cwd,roles:[{moduleId:"cockpit-task",roleId:"executor"}]})`，再用 `roles/readiness` 与 `session/get` 检查能力及原生状态。

`roles/readiness` 仅在明确请求时读取当下的 Skill、MCP 和工具能力；常规 session 列表、快照、详情不附带该结果，也不持续维护就绪状态或展示 badge。`session/get` 的运行、pending、subagent 等信息是另一类检查，不能把能力可用当作当前可立即接单。

正常在 `result.operation` 返回真实 `session_id` 与明确的创建、能力准备结果。创建成功但能力未就绪时保留真实 session ID 和失败步骤，不宣称可派单；创建结果未知时也不自动再建一个。原操作结果可通过 `task_read(view=operation)` 查询，pending 重放返回 `OPERATION_UNCONFIRMED`，不再次调用宿主。

这个工具不创建 Task、不绑定 executor、不发送启动消息。创建成功或能力就绪不证明
之后仍可立即接单，task_assign 会重新检查。宿主管理真实 session 和角色，
不兼容必须明确拒绝，不降级成未装配 session。

### task_assign

输入：共用变更字段，加 `revision, executor, resume_request_id?`。`executor` 为 Owner 已创建或选好的真实 session ID。不提供 mode / reassign 参数；resume_request_id 仅恢复已证实未发送的操作，不续办 Task。

- 仅用于尚未分配的 todo；已有 Executor 不可替换。
- 同一目标的重复指派不作为重新唤醒命令；原 request_id 重放原结果，不重复发送。重要更新的队列处理是独立显式动作，不借指派工具追加 cue。
- done / cancelled 均不可通过指派恢复。
- 目标不可承担第二项未结束 Task。程序不因冲突而取消其现有任务或另建 session。

正常步骤严格为：

```text
确认所选 session 及执行能力可用
  → 首次绑定 Task 的 Executor，ACK 仍为空，等待明确确认和开始执行
  → 确认 idle / 空 queue 后仅发送一次 [Task assigned to you](task:<uuid>?event=assigned)
```

该引用就是完整首次派单消息，标签无需 UI 渲染也能说明原因，不复制 description。
Owner 不手工重复发送。`event` 是消息/引用元数据，不增加工具参数、Task 字段、
Task 类型或状态，也不是命令或调度机制。工具的能力检查、原生忙碌判断与幂等规则不变。

发送时 Task 的定义与归属必须仍符合该次操作前提，不能拿先前检查冒充现在可发送。已知目标不能安全接收时，在绑定前拒绝；若绑定后重新检查发现忙碌或冲突，返回归属已应用、消息未发送的真实部分结果，不自动重试或换人。适配器在确认 idle 且队列为空后调用 `prompt({sessionId,text,mode:"enqueue"})`，空闲时直接开始；不使用会中断新启动工作的 immediate。检查与发送之间不是原子窗口，竞态下实际 queued 必须作为异常保留，不能宣称严格 idle-only 保证。

新建 session 通常来自 `task_session_create`；复用由 Owner 从宿主列表选择候选者。
列表角色标签不代表当前能力就绪。无论来源，指派工具都负责重新检查，
不把此前创建成功或宿主角色记录当作永久就绪证明。

已有 session 缺少 Executor 角色指导、Skill 或工具时，绑定和发送前返回
`CAPABILITY_UNAVAILABLE` 及缺失项，不追加角色、启用 MCP、重载或自动新建替代者。
完成或取消后 session 可复用，但不得同时承担两项未结束 Task。

指派不改变 description、revision 或 changelog，不生成 Executor activity。

输出独立步骤结果，例如：

```json
{
  "operation": {
    "request_id": "assign-example",
    "status": "unconfirmed",
    "executor": "session-example",
    "capability": "ready",
    "assignment": "applied",
    "message": "unknown"
  }
}
```

已受理消息不等于已读、已 ACK 或已开始执行。上述 unknown 不是安全重发的依据；不能自动撤销归属后另派，以掩盖可能已经启动的工作。

当能力或可接单检查拒绝目标时，`result.operation.details` 保留该次检查的诊断，
绑定前拒绝和绑定后 `partially_applied` 均适用：

```text
reasons                宿主公开 roles/readiness 返回的能力缺失原因
loaded, status         当次公开 session/get 返回的加载状态和原生状态
availability_reasons   从同一次原生观察生成的固定原因码，不附队列/问题正文
observed_at            该次观察完成的 ISO 时间；回执重放不刷新它
```

| availability_reasons | 含义 |
| --- | --- |
| `session_not_found`, `session_not_loaded`, `session_not_idle` | 会话不存在、未加载或原生状态不是 idle；具体状态见 status |
| `native_processing`, `active_operations` | 主轮次或宿主操作仍在进行 |
| `queued_messages` | 存在待处理消息，只报告存在性，不保存消息内容 |
| `loading`, `closing`, `cancelling` | 会话处于加载、关闭或取消过程 |
| `pending_user_question`, `pending_plan`, `pending_elicitation` | 存在待用户处理的决定，不附问题、计划或 elicitation 内容 |
| `active_subagents`, `active_mcp_operations` | 存在活动的后台 subagent 或 MCP 操作 |
| `native_processing_unconfirmed`, `active_operations_unconfirmed`, `queue_unconfirmed` | 无法确认原有空闲前提，不把缺失信息当空闲 |

这些诊断只解释当次失败，不是实时状态或持续监控；读取 operation 不调用宿主刷新它们。
能力原因与可接单原因分开，前者不通过角色标签猜测，后者不改变既有空闲判断或发送规则。
若宿主调用失败、没有有效观察，仍返回明确错误，不伪造诊断。成功指派不附加这些失败诊断。

若检查后的竞态使宿主返回 queued，保留真实排队事实并明确报错，不映射为派单成功或“未发送”，也不盲目重发。这是非原子检查/发送的异常结果，不是首次派单主动选择的排队策略。

恢复使用新的 request_id、最新 write_context/revision、相同 Task/executor，并以 `resume_request_id` 指向原指派回执。原回执必须已 final、assignment=applied、message=not_sent 且未被其他恢复消费；仅接受同一固定 Executor。unknown/queued/accepted 或 pending 都不能授权重发。恢复不撤销归属、不替换 Executor，不恢复 done/cancelled。

### task_edit

输入：共用变更字段，加 `revision, reason, description?, title?, references?, metadata?`；至少提供一个实际要修改的字段。

description 如提供，必须是完整的新定义，不是让执行者自行拼接的增量文字。实际正文改变时，原子写入 description、新 revision 和一条 changelog。相同正文不制造虚假修订，也不借无变化的编辑隐式 ACK。

标题和补充资料的编辑不冒充 description 修订；实际要求、约束和验收变化必须更新 description，不能藏进 metadata 绕过定义同步。未提供字段不修改，资料按共用输入约定整体替换。

Owner 修订后保留 Executor 的旧 ACK。仅当自报 actor 是当前绑定 Executor、
Task 未结束且正文实际改变时，同时确认新 revision；不改变 status 或生成 activity。
相同正文、仅资料修改及终态编辑不自动 ACK。编辑不能恢复 done / cancelled，
旧成果仍标注原版本。

输出变更效果、当前 revision / ack 和 write_context，不重复返回全文。并发冲突不覆盖当前定义，也不自动合并自然语言要求。

### task_ack

输入：共用变更字段，加 `revision`。

具有 ACK 工具即可对指定 Task 提交确认，不按操作者与 Task 的关系拒绝。
确认语义是固定 Executor 已读当前定义；记录其 confirmed_for 和自报 author，
并不验证实际阅读或理解。Skill 必须如实确认，不能代 Executor 虚报。
后端校验当前 revision、已有执行归属和未结束生命周期。

只更新 acknowledged_revision。首次 ACK、后续 ACK 都不改变 status、不生成 activity、不发消息。已经确认同一版时返回 unchanged；最新定义已变时拒绝旧 ACK，并附上更新提醒。

输出已确认的 revision、保持不变的执行状态及 write_context，不附带整份 Task。

### task_report

输入：共用变更字段，加 `revision, activity?, status?, outcome?`，至少有一项。

| 可选部分 | 输入形状 | 意义 |
| --- | --- | --- |
| `activity` | `{text}` | Executor 对所依据版本的执行活动，作者与保存时间由服务记录 |
| `status` | `in_progress`、`blocked`、`in_review`、`done` | 明确状态变化；不靠 activity 文本推断 |
| `outcome` | `{summary, references?}` | 提交的成果；保留其 description revision 和执行归属 |

各部分都是显式输入：只写 activity 不改状态；只改状态不凭空生成一条 activity；提交 outcome 本身不隐式进入 done。完成时可一次明确提交 `status=done` 与 outcome，两者一起保存。进入 done 必须有本次完成对应的成果，不借旧版或前次执行的 outcome 代替。

在当前 revision 且已 ACK 的前提下，合法状态和成果作为一个执行更新一起提交。无合法 lifecycle 转换、无成果却请求 done、格式错误等输入应在写入前明确拒绝，不随意部分执行。

activity 只能引用固定 Executor 精确 ACK 过的版本，合规自动 ACK 同样有效。
未确认版本不能作为依据；版本存在、读过或已确认更高版本都不能证明它曾获 ACK。

唯一的报告部分应用场景是 description 已更新，而基于已确认旧版的 activity
在其他生命周期和并发条件下仍可合法追加：

- activity 保存原 revision。
- 同次请求的 status / outcome 不保存，返回 DESCRIPTION_UPDATED。
- 没有提交 activity 时，没有这部分应用；只有 activity 时可成功并附提醒。
- 不因为允许旧版 activity 而放松归属、取消和未知版本等保护。
- 所引用版本尚未 ACK 时，activity、状态和成果均不保存，返回 ACK_REQUIRED。不存在的版本同样拒绝，不能伪造旧版补记。

报告结果逐项区分 `saved | rejected | not_requested`；部分应用的 MCP 响应保留完整结构并标记失败，不能引导 agent 整单重放。

### task_cancel

输入：共用变更字段，加 `reason`。

具有取消工具即可指定 Task；角色 skill 指导 Owner 按明确决定取消、Executor 按用户要求取消。reason 记录上下文，不是用户授权的技术证明，不按调用者与该 Task 的关系拒绝。

取消不是执行成果报告，不应因未 ACK 新 definition 而强迫执行者先继续工作；仍核对生命周期和并发前提。明确置 cancelled，不改变 description、revision、changelog，不冒充执行者 activity，也不自动停止 session。仅当前有匹配的一次性订阅时由系统发送状态卡片，默认不发消息。按共同规则返回定义提醒。

只取消未结束任务；已 cancelled 的合法请求返回 unchanged，done 不能通过 cancel
重写已完成事实。不提供终态恢复；取消不等于实际执行已停止。

### task_subscribe

可选能力，默认不调用。Owner 仅在未来状态会使自己需要采取具体、必要的后续行动时
自行登记，不为追踪进度或确认完成而注册。选择最少必要目标；后续行动不再需要时，
取消仍在等待的订阅。不新增必要性字段或服务端规则，Executor 执行不依赖是否订阅。

完整输入：`actor_session_id, request_id, task_id, write_context, statuses`。
`statuses` 是 1–6 个互不重复的 Task 状态：`todo`、`in_progress`、`blocked`、
`in_review`、`done`、`cancelled`。不接受 recipient、owner、规则表达式或 revision。

当前状态检查、生命周期上下文检查和登记在同一个 SQLite 事务内。当前状态已在目标集合中时返回 `ALREADY_IN_TARGET_STATUS`，不创建订阅、不立即通知。终态 Task 无未来转换，其他目标也拒绝。每个 Task 最多一项 waiting 订阅；已有等待时明确失败，不静默替换或合并目标。

输出 `result` 为本地变更效果和 `subscription` 完整记录。recipient 固定取 Task.owner，不取 actor。登记本身不发送消息、不 ACK、不改变 Task 状态、定义或 write_context。首次成功进入任意目标状态时，状态提交、订阅消费、事件事实和 pending 投递记录同事务保存。相同状态报告、activity、edit、ACK 和被拒绝的状态请求不触发；没有订阅时保持静默。一次消费后不自动续订。

触发后系统只发送 `[Task status updated](task:<uuid>?event=status_changed)`，通过宿主 enqueue 新 prompt；busy Owner 的 queued 是正常结果，不中断、不清队列。卡片读取最新数据，不承诺展示触发时状态，也不要求 Owner ACK。原始触发事实通过 subscriptions 读取。

### task_unsubscribe

完整输入：`actor_session_id, request_id, task_id, subscription_id`。不接受 `write_context` 或 revision，因为取消的是指定订阅的等待，而不是 Task 的执行状态。

只把 waiting 改为 cancelled；已 cancelled 返回 unchanged。triggered / expired 返回 `SUBSCRIPTION_NOT_WAITING`，不撤回已消费通知、已发送消息或宿主 queue 项。Task 与 subscription 必须匹配；返回 `result: {status,task_id,subscription}`。与状态变化的竞态按事务先后决定：取消先提交则不会触发，触发先提交则取消失败。同 request_id 重放原结果。

### 通知投递证据

触发状态变更的响应保留原 `result`（包括 `subscription_ids`），另外附 `notifications` 完整订阅记录和独立 `notification_error`。投递失败不回滚已经保存的 Task 状态或成果。重放仍保留原 Task 效果，通知证据按当前持久记录返回；用 `task_read(view=subscriptions)` 单独查询不会重新发送。

| notification.status | 含义 |
| --- | --- |
| `not_requested` | 尚未匹配，或等待已取消/失效；没有投递请求 |
| `pending` | 触发已提交，明确尚未尝试发送；可在服务就绪时恢复 |
| `unknown` | 发送前已持久标记，可能正在发送、已发送或响应丢失；不自动重发 |
| `accepted` | 宿主确认接受，不证明 Owner 已读或已处理 |
| `queued` | 宿主确认入队，是 busy Owner 的正常结果，同样不证明已读 |
| `not_sent` | Owner 不存在或被动存在性查询失败，明确未调用发送；失败已记录，不自动再试 |

只有 pending 可以自动恢复。发送前原子 claim 成 unknown，防并发和重启重复发送；宿主 prompt 没有幂等键，因此不宣称 exactly-once。Owner 不存在时不创建替代 session。通知失败通过 `notification_error` 和 MCP `isError` / HTTP 502 显式返回，Task 的 `error` 仍独立反映原变更。存储确认失败时不能把“没有通知记录”误当未发送，应保留 `NOTIFICATION_STORAGE_UNCONFIRMED` 并检查。

## 4. 通用结果与错误

沿用 [通用响应](task-tools-skills.md#通用响应)：`result`、`error`、`definition_check`。

| 操作结果 | 含义 |
| --- | --- |
| `applied` | 请求的本地变更已提交；不扩大为外部执行完成 |
| `unchanged` | 符合数据规则的幂等无变化操作，没有新副作用 |
| `partially_applied` | 已明确保存一部分，其余失败；按字段或步骤返回 |
| `rejected` | 本次请求未应用；给出原因 |
| `unconfirmed` | 外部副作用可能发生但未确认；禁止猜测重放 |

读取直接返回所请求的数据，操作状态不与 Task.status 混用。

主要错误类别（业务错误与字段效果分开）：

| 错误 | agent 应如何处理 |
| --- | --- |
| `DESCRIPTION_UPDATED` | 读取最新 description 并 ACK；不得把旧成果直接重标为新版 |
| `ACK_REQUIRED` | 先读取并确认当前定义；未确认过的版本不能记录 activity，ACK 不开始执行 |
| `ASSIGNMENT_CONFLICT` | 已有绑定与本次首次指派冲突，不能换人覆盖；不是按调用者归属拒绝 |
| `TASK_STATE_CONFLICT` | 读取当前生命周期状态，不用普通报告恢复已结束任务 |
| `EXECUTOR_OCCUPIED` | 由 Owner 选择其他安排，不抢占或自动新建 |
| `CAPABILITY_UNAVAILABLE` | 能力未就绪，不宣称指派完成 |
| `EXECUTOR_NOT_READY` | 当次检查不满足可接单条件，未发送；检查是否已绑定，不自动重试或擅自中断 |
| `REQUEST_ID_CONFLICT` | 不用同一请求标识提交不同内容 |
| `TASK_NOT_FOUND` / `OPERATION_NOT_FOUND` / `REVISION_NOT_FOUND` | 指定 Task、操作或修订不存在（404），不编造空记录 |
| `OPERATION_UNCONFIRMED` | 读取原操作及可靠证据，不自动重发或换人 |
| `INVALID_INPUT` / `INVALID_CURSOR` / `INVALID_WRITE_CONTEXT` | 修正格式或读取有效上下文（400），未知字段也不被忽略 |
| `EDIT_CONFLICT` | title/references/metadata 已变，重新读取，不覆盖 |
| `ASSIGNMENT_REQUIRED` | 未绑定 Executor，不能 ACK 或报告 |
| `UNSAFE_DISPATCH_RECOVERY` | 原回执不足以证明可恢复，禁止重发 |
| `UNEXPECTED_QUEUE` | 已发生异常排队，保留真实结果，不再发送 |
| `REQUEST_CANCELLED` | 请求在后续操作前已取消；已有外部/本地效果以回执为准 |
| `RESULT_TOO_LARGE` | 单个结果不满足有界页预算（413），不是静默删减 |
| `ALREADY_IN_TARGET_STATUS` | 当前已满足订阅目标，本次未登记也不通知；不自动改成持续等待 |
| `SUBSCRIPTION_EXISTS` | 已有等待订阅，读取并明确决定是否取消，不静默替换 |
| `SUBSCRIPTION_NOT_FOUND` / `SUBSCRIPTION_NOT_WAITING` | 记录不存在、不属该 Task，或已结束；不能撤回已消费通知 |
| `NOTIFICATION_PENDING` | Task 已保存，明确未发送的通知待恢复；不要重做 Task 变更 |
| `NOTIFICATION_UNCONFIRMED` / `NOTIFICATION_STORAGE_UNCONFIRMED` | 通知效果或其持久确认不明，检查现有证据，不盲重发 |
| `OWNER_NOT_FOUND` / `OWNER_UNAVAILABLE` | Owner 不存在或存在性读取失败，未发送，不自动新建替代者 |

操作步骤维护还可能返回 `OPERATION_NOT_PENDING` / `OPERATION_FINALIZED`；存储新版本不兼容为 `SCHEMA_TOO_NEW`。已进入业务处理的本地错误通常附 HTTP 意义的 `status`（冲突默认 409）；MCP 的失败以 `isError` 和结构化 `error` 表达，不依赖调用者从文本推测。未列出的宿主错误保留其真实步骤语义。

错误和 definition_check 独立。每次进入业务处理的调用都检查定向 Task 及 actor 当前承接的未结束 Task，包括读取、重试和业务失败，不将它当作权限范围。结果缓存不得缓存成永久的“无更新”判断；MCP schema 验证等业务层前失败不能宣称已完成检查。

## 5. 正常调用示例

以下为调用顺序，省略的共用字段仍为实际输入必填。通用引用仍为 `[Task](task:<uuid>)`，例如 `[Task](task:de33dc0a-2f93-4c5a-b14e-87111940d520)`。整条首次派单消息则为 `[Task assigned to you](task:<uuid>?event=assigned)`，不附 description。

只有小写 `assigned` / `updated` / `status_changed` 是有效 event。消息原因固定不变，卡片仍读取最新
Task；renderer 只看 URL 中的显式 event，不从 label 或 Task status 推断。
通用引用及历史消息不显示事件标题，保持兼容；未知 event、畸形 query 不认领，
不能丢弃 query 后冒充通用引用。不使用可能被识别为文件的相对 `task/<id>` 路径。
无需宿主协议变更；File 兼容性与完整引用边界见[实现契约](task-implementation.md#read-boundaries-and-reference)。

```text
Owner:
  task_create(title, description)                 → todo、无 Executor
  task_session_create(cwd, ...)                   → 新建并配置 Executor 协作能力
  或 Owner 明确选择已有 session                   → 不隐式新建
  task_read(view=overview, task_id)               → 状态与归属概览、write_context
  task_assign(task_id, executor, ...)             → 确保能力、关联、一次发送 assigned 引用
  task_subscribe(task_id, statuses=[done], ...)   → 仅当 done 后有必要的 Owner 行动时登记；否则省略

Executor:
  task_read(view=execution, task_id)              → 完整 description v1 与当前工作资料
  task_ack(task_id, revision=1, ...)              → ack=1，仍是 todo
  task_report(task_id, revision=1,
              status=in_progress, ...)           → 明确开始
  task_report(task_id, revision=1,
              activity={text: ...}, ...)         → 仅记录活动
  task_read(view=execution, task_id)              → 交付前核对
  task_report(task_id, revision=1,
              status=done, outcome={...}, ...)    → 完整交付；匹配显式订阅时系统通知 Owner
```

每次写入都带 actor_session_id 和新的明确 request_id；已有 Task 写入还带读取返回的 write_context，create/session_create/unsubscribe 不带。相同操作重试保留相同输入和 request_id。Skill 读取也提交自己的 actor_session_id；每次响应都处理 definition_check。

重要更新由 Owner 按 Skill 保存并清理 pending 内容，再通过宿主公开发送入口一次发送
摘要、`[Task updated](task:<uuid>?event=updated)` 和读取/ACK 最新版要求。
必要时单次保留队列地中断；不用 Stop 作为清理捷径，不重复未知发送，
不把接续回执当作当前 revision 的 ACK。普通 task_edit 不发送通知。

## 6. 传输与启动边界

模块 HTTP MCP 与普通 HTTP API 挂载于宿主，共用业务服务和独立
`task-board.sqlite`，不启动额外 daemon。宿主按角色装配配置，
不为十个业务工具另建注册表。

官方 stateful Streamable HTTP transport 让后续 POST 的取消通知关联原调用；
取消阻止后续副作用，不回滚已完成动作。协议 session 失效不构成重放业务写入的理由。
细节见[宿主契约](task-host-contract.md)。

通知恢复要求 `context.serviceReadyVersion === 1`，在 DB 打开或升级前检查。
只从宿主 runtime 启动且 HTTP 监听后的 `onReady` 恢复明确 pending 的发送，
不在激活、提前的 agent 事件或首次读取时恢复，不重试 unknown 或已尝试失败项。
并发、持久回执和安全恢复细节见[实现契约](task-implementation.md)。
