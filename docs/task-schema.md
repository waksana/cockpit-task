# Task Schema 与协作语义

当前数据契约为 **schema 12**。Task 是用户授权范围内持续存在的责任，
不是 session 运行状态或外部成功证明。具体输入见 [MCP](task-mcp-contract.md)，
事务/回执见 [实现](task-implementation.md)，显式迁移见
[schema 12 procedure](task-responsibility-migration.md)。

## 1. 核心记录

| 字段/记录 | 含义 |
| --- | --- |
| id / task_id | 稳定 UUID，不是 session ID 或完整 task: URI |
| kind | agent 或 automation；创建后不转换 |
| created_by | 原创建来源，历史字段，不提供当前管理权 |
| assignee | Agent 唯一固定 session 绑定；未承接和 automation 为 null |
| parent_task_id / depth | 当前责任组合；root 为 null/1，无固定业务深度上限 |
| parent_assignee | 从当前 parent 的绑定派生；无 parent 就没有上级 |
| actor_role | 当前调用关系：assignee / parent_assignee / user / none |
| work_mode | 新 Agent：undecided / execute / orchestrate；automation 为 null |
| legacy | 布尔历史标记；未知终态方式可 null，不能推断为 execute 或已遵守新规则 |
| title / description | 本项工作特有的目标、决定、边界和完成要求；description 总是完整替换 |
| revision / changelog | 完整 description 版本；真正改文或 reopen 创建新版，后者相同正文也递增 |
| acknowledged_revision / ACK history | assignee 对精确 revision 的确认；不开始工作、不保证理解 |
| status | todo / in_progress / done / cancelled，与 native activity 独立 |
| cancellation_request | null 或 `{reason,author,at,request_id}`；Agent 持久意图，与最终 cancellation 分开 |
| cancellation | 最终取消与处置事实，不冒充 outcome 成功或外部退出 |
| activity | assignee 重要变化，保留实际 ACK 版本、作者与时间 |
| outcome | 实际交付、遗留、证据及所属 revision；新 done 需要新 outcome |
| retro / retro_handlings | 同次 Agent done 的显式文本/null，以及按 outcome_id 追加的处理记录 |
| references / metadata | 有界外部资料及定位信息，不存秘密、不隐藏要求、不构造关系 |
| blocked_by / ready | active Task/文字前置；无 active 前置才 ready，不表示授权、运行或成功 |
| dependencies | 每轮前置的 ID、来源及持久解决事实；不因 blocker reopen 复活 |
| responsibility_events | claim/start/convert/attach/意图/收口等责任变化的有界审计读取 |
| children | `{total,nonterminal}` 紧凑直接子项计数，不嵌入递归整树 |
| write_context | 不透明并发令牌，不能构造、排序或当授权 |
| data_version | 被动读取缓存相等比较令牌，不是 revision 或 write_context |

当前记录不暴露独立 orchestrator 字段。需要 parent 绑定却缺失时明确
`PARENT_UNBOUND`，不使用 creator、旧通知或历史 JSON 回退。一个 session 最多
绑定一项 unfinished Agent；Automation 没有 Agent binding、ACK、mode 或容量占用。
工具可见性与业务关系授权分开；内部 helper 归因到 containing session，不取得独立责任。

## 2. 生命周期与履责方式

```text
create: todo + undecided + unbound
  claim / external assign → bound todo + undecided
  execution + ACK         → remains todo
  task_start              → in_progress + execute OR orchestrate
  task_convert            → execute becomes orchestrate (one way)
  task_report(done)       → done, retaining mode

task_cancel               → durable cancellation_request, status unchanged
task_cancel_finalize      → cancelled, retaining mode (undecided if never started)
eligible authorized reopen→ in_progress, new revision, same mode/assignee
```

todo 只允许必要澄清与轻发现，不直接实施、建 child 或 report done。
start 由 assignee 对 exact ACK、当前 context、ready todo 原子完成；
report(in_progress) 只确认已开工状态。work_mode 不随 child 数量或 native mode 自动推断。
convert 保存原因、已完成和剩余责任，不改变 assignee，不降级。

新增 child 进展要求祖先有绑定、in_progress/orchestrate、ready、无取消意图；
创建 child 还要求 caller 自己的 Task 当前 ACK、ready。
create 无 active Task 时只建普通未绑定 root；claim 是当前就绪 Node 承接 root，
不发消息、不改 title、不要求调用中 session idle。外部 assign 则使用原生空闲/队列检查。
claim 可承接 blocked root 以澄清，不要求 Task ready，不是 ACK 或 start。
root 无额外 owner 或权限。Web user 可选择合法 parent 创建，或指派 unbound root。

done 和最终 cancelled 都要求所有直接 child terminal（done/cancelled）。
done 还需当前 ACK、ready、无自身取消意图、自己的新 outcome/retro。
祖先仍须有绑定且 active orchestrate，但祖先的 intent/blockers 不阻止既有 child done 收口。
child cancelled 不等于父成功；父必须按实际缺失结果继续安排或取得范围调整授权。
长期 orchestrating root 可以无 child，不自动完成。

Agent cancel 不自动级联，叶子也先意图。意图存在时禁止推进已放弃目标：
start、child create/assign、convert、attach、自己的 done；祖先意图约束新进展，
不禁止符合上述收口条件的既有 child done。
read/ACK/edit/activity 和善后仍可进行。bound assignee 最终处置；
Web user 只 finalize unbound Agent。最终取消不要求满足放弃目标的 ready 或 ACK。
automation cancel 仍是服务终态/进程组协议，不套 Agent intent/ACK/finalize。

## 3. 当前树与原位恢复

`task_attach` 只把既有 unfinished root 挂到另一 session 的 active orchestrate parent。
核对 Task 与 parent 两份当前 context、revision、祖先、防环、取消意图及新祖先下的 blocker。
原 Task/assignee/scope/subtree/history 不变，子树 depth 原子更新并失效受影响读取版本。
无 detach/reparent 逃逸。结构操作有 10,000 节点资源保护；`TREE_RESOURCE_LIMIT`
拒绝整次变更，不静默截树。祖先和直接 children 分页读取。

reopen 只用于用户授权的 done Agent，保留模式和原 assignee，不另分配指派序号。
原指派需有持久 `task_assignments` 序号，之后从未承接其他 Task，即使后者已终态；
还需无其他 unfinished Task、能力就绪、所有祖先合法 active orchestrate 且无取消意图。
必要祖先先独立合法恢复，不能自动重开；cancelled/资格不符祖先阻止原位恢复。
legacy 终态未知 mode 明确拒绝，不能从无 child 或 session activity 猜测。
没有 schema12 后的 mode-repair API。有证据的历史终态 mode 只能在审阅的 11→12
迁移计划中显式选择，仍只生成 migration 事件，不补造 started 事件。

reopen 强制新 description revision。own assignee 操作 auto-ACK，其他合法关系操作
不代 ACK，并通知 assignee 更新。旧 ACK、outcome、retro、订阅与回执仍为历史；
不恢复已解除依赖、已结束订阅，不重新派发或换人。

## 4. 版本、条件和证据

description 真正变化时保存完整 changelog。own assignee 在 unfinished Task 修改正文
会 auto-ACK；相同正文、metadata-only、终态编辑不会。ACK 不生成活动或隐式开工。
旧版 activity 只接受那一版真实 ACK，ACK v3 不意味着跳过的 v2 已确认。
旧版 activity 可独立保存，同次过期 status/outcome/retro 拒绝且明示部分应用；
不能把旧工作重标新版。当前 outcome 仅指 revision 对应，不是完整交付证明。

Task-ID 前置只等待一个 execution 的 done，不判断 success；cancelled 不满足。
引用自身、祖先、未完后代、成环、缺失或新加 cancelled blocker 都拒绝。
防环同时计算显式前置、父等待子终态，以及 todo 后代开始前所需的祖先 readiness，
并覆盖受修改影响的既有 dependent；不只从新增 blocker 单向查找。编辑、挂接和迁移
共用有界校验。已开始 child 的收口不重新要求祖先 ready。
文字条件写具体缺少什么及满足标准。active condition 读回含 dependency_id；
own assignee、parent assignee 或 Web user 可 `task_resolve_condition` 对精确条件
提交 evidence 和 references，持久保存在 dependency history。
此路径不移除 Task-ID 依赖或改变条件含义。own edit 不能绕过证据删除/替换 condition；
parent/user 按授权重规划的整组替换有 reason 审计，不产生中间 false-ready。
所有 child 不自动变为 blocked_by。

Agent done 同次必需 outcome + 显式 retro 文本或 null，不接受省略当无发现。
retro 不扩大授权、不代替成果；automation 无 Agent retro。
retro_handlings 追加 fixed/followup/watching/dismissed，followup 需要引用，
不发消息、不自动派发，后续 outcome 是独立复盘。

## 5. 通知与有界读取

通知是服务生成的固定 task: 指针，保留触发事件而显示当前 Task。
assignee updated 用于 ready 时要求变更、ready 边界、reopen 或 blocker 取消；
仍 blocked 的普通编辑、部分解除静默。新增 own condition 向当前 parent 上行事实。
Agent intent 使用 cancellation_requested，final child cancellation 才是 child_cancelled。
旧 cancelled/child_blocked 标签保留历史识别，不重写历史 JSON。

child/dependency notices 保存 recipient 快照，投递前核对当前 parent/binding；
关系变更则 not_sent，不 reroute、不 retry。root 不找隐藏收件人。
显式订阅独立，默认不用；MCP subscriber 是 caller，Web user 必须显式选 subscriber。
waiting→triggered 只消费首次匹配，不匹配终态则 expired；取消等待不能撤回已消费通知。
接收失败不回滚 Task，unknown/accepted/queued 不盲重发。

list 可按 assignee、parent_assignee、parent_task_id、root、work_mode 筛选；
不要把 caller 当过滤器。overview 的 include 只选当前必要完整组，execution 给 assignee
完整当前约定。ancestors 最近 parent 在前、最多 50，直接 children 用 list(parent_task_id)；
responsibility_events 项为 `{id,task_id,kind,author,at,details}`，与其他历史最多 10。
事件种类见 [MCP](task-mcp-contract.md#2-读取)。列表/历史有序列化预算，不返回无界整树。
definition_check 在响应时独立刷新；读取不是 ACK。

## 6. schema 12 与历史

普通加载已有 schema≤11 拒绝语义迁移。新库可建立 schema12；旧数据只能通过
[显式审阅迁移](task-responsibility-migration.md)，不能猜未完成 mode/责任关系，
不能从 native 忙闲判断恢复意图。历史终态未知方式可 null + legacy，
不是给历史补一次 start 或声称旧成果已满足新父门槛。

保留历史 definitions/ACK/outcomes、绑定序号、notice JSON、caller-scoped receipts、
不确定外部效果与 automation run facts。created_by 历史取代旧创建者当前权力。
旧 caller 无可靠归因的 request ID 仍保留并拒绝 `LEGACY_OPERATION_UNSCOPED`，
不因迁移或新关系重新执行。旧 schema v5–v11 的来源与迁移记录见
[implementation history](task-implementation.md)；兼容声明见 [Releases](releases.md)，
操作程序以 [独立迁移指南](task-responsibility-migration.md) 为准。

新表为 responsibility_events、migration_v12_items、migration_v12_audit。
task_dependencies 保存 evidence/refs 与 evidence resolution；通知列由 orchestrator
改为 recipient，依赖通知的 parent 快照在 event.parent_task_id 中，不重写旧 JSON。
