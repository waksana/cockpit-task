# Task MCP 与角色 Skills

本文说明角色如何使用共同记录与工具。参数以
[MCP 契约](task-mcp-contract.md)和[源码 schema](../src/task-board/contracts.js)为准；
记录语义见 [Schema](task-schema.md)，隔离验证见
[生命周期回放](task-lifecycle-testing.md)。

## 1. 角色资源与工具

Task 提供 [Owner Skill](../skills/cockpit-task-owner/cockpit-task-owner/SKILL.md)
和 [Executor Skill](../skills/cockpit-task-executor/cockpit-task-executor/SKILL.md)，
并随包提供独立工作 Skill [github-coding](../skills/github-coding/github-coding/SKILL.md)。
工作方法与协作角色正交，不新增 Task 子类型；非编码或研究工作不加载编码流程。

| 角色 | 常驻指令 | 注入的 Task 工具 |
| --- | --- | --- |
| Owner | [task-owner.md](../roles/task-owner.md) | `task_read`、`task_create`、`task_session_create`、`task_assign`、`task_edit`、`task_cancel`、`task_subscribe`、`task_unsubscribe` |
| Executor | [task-executor.md](../roles/task-executor.md) | `task_read`、`task_edit`、`task_ack`、`task_report`、`task_cancel` |

共十个工具。宿主可组合两种角色，工具取并集、相同资源去重；角色管理由宿主负责。
Task 不提供给已有 session 追加角色的工具，指派也不补能力。角色是协作能力，
不是项目身份、实际承接或逐 Task ACL；自报 actor 只是归因。

常驻 prompt 固定责任及加载入口；Skill 正文指导判断，随包 references 解释
具体问题。外层目录是原生发现根目录，内层技能自包含，不依赖仓库 docs。
两角色的 `skillDirectories` 都包含同一个 `skills/github-coding` 根；
双角色由宿主按同源资源去重。Task 正文按名字指向这个可发现工作 Skill，
不假定 Executor 继承 Owner 已读的上下文，也不在 role prompt 注入整套方法。

首次需要时加载 Skill，指令仍在上下文时复用。压缩/恢复后缺失、内容改变或
具体规则不清楚时再读，不因每条消息或检查点重复加载。稳定指导可以复用，
可变的 Task 定义、状态和 ACK 却必须按需刷新；文字指导不是加载频率的程序保证。

### Git/GitHub 编码协作

Owner 确认授权与仓库状态，将自己的主目录保持为干净最新主线，准备专用
branch/worktree 和环境；先复用或创建 Issue，再创建描述完整且关联资料的 Task。
这些准备、Issue 维护及合并后清理属于协调职责，不允许 Owner 亲自实施代码。
已有合适 Issue/环境继续使用，不能为“干净”丢弃、stash 或删除用户改动。

Executor 使用指定 worktree，完整负责实现、必要验证、独立只读 review、修复、
关联 PR 和授权内正常合并；PR 创建后及时补 Task 链接，确认最新 head 的 CI，
不绕过仓库保护。Task 用现有 references/metadata/outcome.references 表达关联，
不增加 GitHub 字段、MCP 或评论镜像。仅 PR、补丁、调查授权不擅自扩成合并。

Task done 是 Executor 的约定结果，不等于 session 空闲或环境已清理。Owner 确认合并、
无其他工作仍使用且无未保存/需保留产物后，仅清理本次已合并临时分支和 worktree，
让主目录回到干净最新主线。清理受阻时直接向本 session 的用户提问，说明具体阻碍与
继续所需的决定或条件，不只说“等待”，也不承诺自动醒来。用户答复或明确要求继续后，
重读 Task/PR 并重新确认占用和文件状态；答复本身不是可以安全删除的证明。
已经触发的 done 订阅不会在环境解除占用后再次通知，不另建 Task、不重新订阅或轮询。
需要后续通知恢复这一
真实清理动作时，可在派单前登记一次 done 订阅；无必要或另有安排时不登记，
不轮询或自动续订，也不新建清理 Task/审批门。发布、部署、重启不是默认阶段。
讨论、非编码和非 GitHub 工作不被强加不适用的步骤。

## 2. Owner：澄清、委派、跟进

Owner 可只读了解情况、回答问题和澄清目标。实施及改变外部状态的交付默认通过
Task 交给独立 Executor，不亲自实施或用自身 subagent 绕过委派。
要求达成结果不等于要求本人执行；明确的本人执行要求或实际 Executor 指派才是例外。
双角色选择本身不是承接，无法委派应说明阻塞。

将一个完整成果放在一个 Task，独立成果才分别登记。创建或修订 description 时，
完整保留本项工作的目标、范围、关键决定、授权边界、特殊约束和完成条件；
完整约定不等于完整上下文。通用 Skill、仓库指令和环境资料按需引用，不重复展开，
任务专属且影响正确执行的信息仍须明确，已有调查与当前要求分开。
Task 是共同工作记录，不是原始证据仓库：详细证据用可访问、可定位的引用保留，
但不能以“见 Issue”替代关键约定、把要求藏进 metadata 或假定继承上下文；
支持结论或安全接续必需的精确数值仍应保留。不复制整段聊天，不强制工作表单。区分讨论、调查、登记
和执行授权；尊重“只讨论”“暂不执行”，不对已授权工作重复索要开工口令。

正常流程：

1. `task_create` 登记完整要求；不启动 session。
2. 需要新 Executor 时用 `task_session_create`；也可明确选择已有能力的 session。
3. 用 `task_assign` 进行能力/原生状态检查、绑定和一次 assigned 派单。
   不另发首条消息，不把角色标签当成就绪证明。
4. 按需读取 Task，修改要求而非向 Executor 聊天追进度、澄清或索要确认。
5. 读取 outcome 判断实际交付及未执行边界，不把 idle 或成果可用性当成完成证明。

Owner 默认用 `task_read(view=list, owner=<自己的 session ID>)`，单项用 overview。
关注 id/title、Executor、状态、最新 activity 及时间、revision/ACK、
`outcome.available/current`。编辑前读 definition，判断交付时读 outcomes，
针对具体疑问再展开 activity/changelog。actor 不是 owner 筛选器。

## 3. Executor：完整交付、同步要求

Executor 先读 execution 确认真实指派、完整 description、资料、版本与状态，
不从名称、角色或旧聊天推断承接。内部组织步骤或 subagent，负责调查、实施、
修正和完整交付，不建立子 Task 或向下转移责任。同一 session 只执行一项未结束 Task。

开工、恢复、重要阶段间、重要外部操作前和交付前读取最新定义，理解并 ACK
精确 revision。ACK 与状态分开：确认后仍为 todo，开始时明确报告 in_progress。
每次响应都处理 definition_check，检查不可用不能解释为未变化。

真实决策、缺少的重要条件及范围变更直接向自己 session 中的用户提出，
不让 Owner 转述，不向 Owner 直接或经 subagent 发送问题、进展、阻塞或完成消息。
澄清后的有效结论写回完整 description，并说明来源、原因和被替代决定。
编辑定义遵循上述任务专属约定与证据取舍原则，不要将提案或引用误作授权，
也不把要求藏进 metadata。

当前 Executor 成功修改未结束 Task 的实际正文时自动 ACK 新版；
相同正文、仅资料修改、终态编辑不适用。检查是否又有后续变化，不把通知当成新授权。

activity 先写本次有意义的变化、发现、决定、阻碍和必要剩余工作，说明解除阻碍
需要什么，不重述任务、不固定间隔更新、不编造百分比或倾倒工具日志。
outcome 先写交付结论、约定满足情况和剩余限制，再给必要依据；研究成果可详细，
区分结论、论证和未验证点。引用不能删去支持结论或安全接续必需的精确数值。
这些是内容取舍指导，不是必填模板、字数限制或模型行为保证。
activity 不自动改状态，outcome 不自动 done。完成最新已确认约定后，
在同次报告提交 `status=done` 与新 outcome，保留成果引用和未执行边界。
仅工作本身需要时使用 in_review，不等待默认 Owner 审批。

## 4. 消息与一次性等待

| 引用 | 使用规则 |
| --- | --- |
| `[Task](task:<uuid>)` | 普通引用 |
| `[Task assigned to you](task:<uuid>?event=assigned)` | `task_assign` 的完整首次派单；Owner 不重复发送 |
| `[Task updated](task:<uuid>?event=updated)` | Owner 明确的重要要求更新，附读取/ACK 最新版要求 |
| `[Task status updated](task:<uuid>?event=status_changed)` | 系统按显式一次性订阅通知 Task.owner，不是 Executor 的 ACK 通知 |

使用真实 UUID。event 由 URL 明确给出，只有上表小写值有效；不是 Task 类型、
状态、命令或事件总线。卡片读取当前数据，消息原因保持不变。
完整语法见[引用契约](task-implementation.md#read-boundaries-and-reference)。

普通要求更新只改 Task，不排队发送 cue。Owner 仅在重要变更不能等待正常检查点时，
按[重要更新参考](../skills/cockpit-task-owner/cockpit-task-owner/references/important-updates.md)
先保留 pending 全部可得内容，再按已保存 ID 清理；必要时单次保留队列地中断主轮次。
未知内容、附件、并发新消息和未停止后台工作不能盲删或忽略。重新核对 Task 和
原生可接续状态后，一次发送上下文摘要与 updated 引用，不复制 description，
不逐条重发，不反复中断；queued/unknown 不能盲重发。接受不等于当前 revision 的 ACK。

**默认不订阅。** Owner 只有在未来状态会使自己采取具体、必要的后续行动时，
才用 task_subscribe；无需等用户明确要求订阅，但不能为此虚构工作、拆分成果或
增加审批。仅看进度或确认完成不是理由。选择最少必要目标，行动不再需要时
task_unsubscribe 取消仍在等待的订阅。

登记时已匹配则失败，不即时通知。首次实际匹配后由系统 enqueue 给 Task.owner，
不打断或清队列、不保持原模型轮次等待。Owner 收到后读取最新 Task，重新判断
后续行动是否仍必要且已授权，不自动续订或轮询。Executor 不等待订阅或通知被读，
也不发送、重复或 ACK 这条消息。失败投递不抹去已保存成果，不手工补发未知通知。

<a id="通用响应"></a>

## 5. 通用响应

| 字段 | 职责 |
| --- | --- |
| `result` | 读取数据或原操作的明确效果，可能包含已应用部分 |
| `error` | 原操作未完成部分的错误；无错误为 `null` |
| `definition_check` | 响应检查点的定义同步情况，独立于操作成功与否 |
| `notifications` / `notification_error` | 触发订阅时的投递证据与独立错误，不回滚 Task 效果 |

definition_check 检查本次定向 Task 及 actor 承接的未结束 Task，不扫描聊天或全部任务。
`checked` 的条目含 task_id、revision、acknowledged_revision、needs_ack，
需要时附提醒；`unavailable` 带检查错误；确实无相关 Task 才为 `not_applicable`。
读取仍不 ACK，提醒的确认责任仍属于固定 Executor，不要求 Owner 代确认。

操作结果与检查时点分别解释：报告已提交后才出现的新要求，不会使先前成功写入
消失；重放原效果也不能缓存旧的“无需 ACK”结论。

### 写入、冲突与恢复

- 使用真实 ID、自报 actor、稳定 request_id；同一操作重试保持完整输入不变。
  新的明确操作才使用新 ID，不通过换 ID 绕过不确定效果。
- 既有 Task 写入原样回传 write_context；task_unsubscribe 直接检查指定等待。
  description revision 不负责全部生命周期或资料冲突。
- 逐版 ACK 是精确记录。ACK v3 不证明跳过的 v2 已确认；不能把旧工作重标新版本。
- 已确认旧版 activity 可保存，同时旧版 status/outcome 被拒绝。保留各字段实际效果，
  读取/理解/ACK 当前定义后，以新的明确报告提交真正满足新要求的状态或成果，
  不重复已保存 activity。
- session 创建、能力、绑定、消息接受、ACK 和执行是不同事实。部分失败保留已创建/
  绑定资源；未知效果不允许自动换 Task/session、撤销归属或重发。
- `resume_request_id` 仅适用于未被消费的 final 指派回执证明
  `assignment=applied`、`message=not_sent`；新操作用同 Task/Executor 和最新上下文。
  unknown/queued/accepted/pending 不符合条件，不允许重开终态或换人。
- 取消 Task 不停止原生工作或撤销外部效果。终态不能恢复，授权的新工作需独立 Task。

## 6. 按问题加载参考

| 问题 | Owner | Executor |
| --- | --- | --- |
| 视图、字段、截断和分页 | [Task 读取](../skills/cockpit-task-owner/cockpit-task-owner/references/reading-tasks.md) | [Task 读取](../skills/cockpit-task-executor/cockpit-task-executor/references/reading-tasks.md) |
| 写入、冲突、部分结果与恢复 | [写入与恢复](../skills/cockpit-task-owner/cockpit-task-owner/references/task-writes-and-recovery.md) | [写入与恢复](../skills/cockpit-task-executor/cockpit-task-executor/references/task-writes-and-recovery.md) |
| Task 引用和通知原因 | [Task 链接](../skills/cockpit-task-owner/cockpit-task-owner/references/task-links.md) | [Task 链接](../skills/cockpit-task-executor/cockpit-task-executor/references/task-links.md) |
| 重要变更不能等正常检查点 | [重要更新](../skills/cockpit-task-owner/cockpit-task-owner/references/important-updates.md) | 不把队列接管交给 Executor |

只读当前需要的参考，不每轮加载全套。Skill 指导真实行为，工具保护数据一致性；
两者都不保证自然语言遵从性、验证用户授权或扩大任务范围。
