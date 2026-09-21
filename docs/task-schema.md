# Task Schema 与协作语义

本文定义共同记录及其不变量。具体参数、分页和错误见
[MCP 契约](task-mcp-contract.md)，事务、存储和宿主边界见
[实现契约](task-implementation.md)。产品范围见[设计](task-design.md)。

## 1. 独立工作与责任

一个 Task 对应一个完整结果，由一个固定 Executor session 负责。Owner 可以
管理多个独立 Task；Executor 内部可拆分步骤或使用 subagent，但不形成父子
Task、依赖引擎或级联状态。引用其他 Task 只是资料关联。

同一 session 同时最多承担一项未结束 Task，完成或取消后可以复用。
首次绑定后不能替换 Executor；终态不能恢复执行。Owner / Executor 字段记录
责任而非访问权限；具备工具即可操作其他 Task，但所有数据不变量仍受保护。

角色由宿主装配和管理，包括已有 session 的角色变化。Task 的创建工具只为
新 session 选择 Executor；指派不补装任何能力，也不暴露角色变更操作。
拥有两种角色不等于实际承接，也不放宽单项执行限制。

资源感知创建和独立 `task_session_prepare` 只准备显式选择的原生资源，不形成
新的 Task 字段、类型或资源要求表单。prepare 要求已加载空闲、Executor 角色已应用、
无待重载角色且未绑定任何未结束 Task；native idle 不能解除业务占用。
准备不创建、绑定或发送消息，Task 登记不依赖准备成功，backlog 可以不派单。

## 2. 核心字段

下表为语义模型，不是一次读取返回全部内容的对象。服务维护 UUID、时间、
版本和历史，调用者不能用任意字段更新直接改写归属或伪造历史。

| 字段/记录 | 含义与约束 |
| --- | --- |
| `id` | 稳定 Task UUID；不同于 session ID、消息 ID 或完整 `task:` URI |
| `title` | 可识别的短名称，不代替完整说明 |
| `description` | 完整当前背景、目标、约束和完成条件；修改传完整正文，不是差量补丁 |
| `owner` | 登记时明确的委派 session；也是状态订阅的固定接收者 |
| `executor` | 固定执行 session，未指派为 `null`；无共享执行归属 |
| `status` | 工作状态，与 native running/idle/unloaded 无关 |
| `revision` | description 版本，从 1 开始，仅实际正文变化时递增 |
| `changelog` | 每版 description 的正文、作者、服务时间与原因，包括初始定义 |
| `acknowledged_revision` | 固定 Executor 已记录确认的版本，初始为 `null` |
| ACK 历史 | 逐版保留 `confirmed_for`（固定 Executor）与 `author`（自报操作者） |
| `activity` | 执行者报告的事实；每条有 revision、executor、author、时间及正文 |
| `outcome` | 成果 summary 与可选 references，保留所属 revision 与执行归属 |
| `references` | `{label,target}` 数组；资料、成果或独立 Task 引用，不形成依赖 |
| `metadata` | 有界纯 JSON 对象，供补充工作资料；不作为凭据、不覆盖固定字段或触发工作 |
| 取消记录 | 取消原因、作者、时间；独立于 description changelog 和 Executor activity |

`actor_session_id` 是调用者自报归因，输出标为 `reported`，不是认证身份。
ACK 表示对固定 Executor 的确认声明，不验证实际阅读。跨 Task ACK 可调用，
但 Skill 不允许代 Executor 虚报已读。用户决定来源可以记入原因，
却不能把“用户同意”文本当成技术授权证明，也不扫描聊天制造证明。

## 3. 定义、确认、执行分别记录

```text
description + revision       最新完整要求
changelog                    逐版定义快照与变更原因
acknowledged_revision        固定 Executor 已确认版本
activity[].revision          执行事实实际依据的版本
outcome.revision             成果对应的定义版本
```

实际 description 修订原子保存正文、新 revision 和一条 changelog。
Owner 修改不生成 Executor activity，也不替 Executor ACK。
仅当自报操作者是已绑定 Executor、Task 尚未结束且正文确实改变时，
修订同时记录新 revision 的 ACK。相同正文、title/references/metadata 编辑
及终态编辑都不自动 ACK。

ACK 只更新确认记录，首次 ACK 也不把 `todo` 改为 `in_progress`，
不解除 `blocked`、生成 activity 或发送消息。开始执行必须明确报告状态。
状态、指派、ACK、activity 与 outcome 本身不推进 description revision。

activity 只能引用固定 Executor 实际确认过的精确 revision，包括本人修订的
自动 ACK。仅有该版、读取过该版、或当前 ACK 号码更大，都不证明它被确认过。
例如 ACK 从 v1 跳到 v3，不能据此报告 v2 activity。

在其他生命周期和并发条件满足时，已确认旧版的 activity 可以补写并保留原版本：

- 只有旧版 activity：可以保存，同时提醒读取/ACK 最新要求。
- 同次还有旧版状态或 outcome：activity 保存，其余拒绝，返回
  `DESCRIPTION_UPDATED` 和明确的部分应用结果。
- 未确认版本、终态、无执行归属、上下文冲突或其他验证失败：不借旧版补记规则部分写入。

每次进入业务层的调用都重新检查定向 Task 及 actor 当前承接的未结束 Task。
`definition_check` 与原操作效果独立；失败或重放也不省略可完成的检查。
检查不可用必须说明，不能当作“没有更新”。提醒不是自动 ACK、后台通知或监控。

旧 outcome 始终保留其 revision。定义更新后，overview 的 `outcome.current`
标明其是否仍对应当前版本；存在当前成果也不代替对内容和交付边界的判断。
终态仍可编辑定义、读取历史，但不会 ACK 或重新启动执行。

## 4. 状态与生命周期

| 状态 | 含义 |
| --- | --- |
| `todo` | 未开始，可尚未指派，也可已派单但尚未明确开始 |
| `in_progress` | 正在处理当前约定 |
| `blocked` | 存在阻碍；执行者应记录所需条件 |
| `in_review` | 工作约定所需的评审步骤，不是默认 Owner 审批 |
| `done` | 已交付当前约定；同次完成报告必须提交新 outcome |
| `cancelled` | Task 已取消，不表示 native session 或外部操作已停止 |

| 操作 | 数据效果 |
| --- | --- |
| 登记 | `todo`、无 Executor、revision=1、ACK=null；不创建 session 或发消息 |
| 首次指派 | 只接受未分配的 todo；绑定既有能力的 Executor，仍为 todo、ACK=null |
| ACK | 只确认当前 description，不开始执行 |
| 报告 | 对已确认版本显式写 activity、status、outcome；未提供的部分不推断 |
| 完成 | 对当前已确认 revision 同次提交 `status=done` 与新 outcome |
| 取消 | 对未结束 Task 保存 cancelled 与原因；不要求先 ACK 新要求，也不停止 session |
| 终态后的操作 | 可读历史和编辑定义；拒绝执行报告、ACK、改派或恢复 |

状态报告可在未结束工作中按事实进入 `in_progress`、`blocked`、`in_review`，
不强制先后审批。outcome 本身不隐式进入 done，activity 本身不隐式改变状态。
已 cancelled 的合法取消返回 unchanged，done 不能再改成 cancelled。

完成或取消解除“单项未结束执行”的业务占用，但不证明 session 已原生空闲；
再次指派仍检查能力、运行、队列、待决请求和后台工作。

## 5. 状态订阅与消息

订阅是独立持久记录，不是 Task 类型、依赖或状态。Owner 默认不订阅；
只有未来状态会使自己采取具体必要行动时才登记，不为看进度或确认完成注册，
不自动续订。后续行动不再需要时撤销等待；Executor 不等待订阅或通知被读。

每个 Task 最多一个 waiting 订阅，目标为显式状态集合，接收者固定取 Task.owner。
事务中检查当前状态：已匹配则失败，不登记或即时发送；其他终态同样不能新建等待。

首次真实匹配的状态转换与 Task 写入同事务消费订阅、保存事件和 pending 通知。
同状态报告、定义编辑、ACK、activity 及被拒绝的状态变更不触发。
进入未匹配终态则 expired；取消等待与触发按事务先后决定。

| 订阅状态 | 含义 |
| --- | --- |
| `waiting` | 等待未来首次匹配 |
| `triggered` | 已消费并记录匹配事件；投递结果另看 notification |
| `cancelled` | 等待被显式取消 |
| `expired` | Task 进入非目标终态，无通知 |

触发事件保留 from/status、时间、request_id 和操作者；卡片却读取当前 Task，
不能把卡片状态当成触发时快照。投递失败不回滚 Task 或 outcome，
`notification_error` 与变更错误分别处理；未知发送不自动重试。

普通更新静默；Executor 不给 Owner 发进度、问题或完成消息。
首次 assigned、显式重要 updated 与订阅 status_changed 的引用 event
仅为消息固定元数据，不改变 revision、ACK 或生命周期。格式见
[引用契约](task-implementation.md#read-boundaries-and-reference)。

## 6. 有界读取与一致性

Owner 默认以显式 owner 筛选 list，单项读 overview；Executor 默认读 execution。
definition 提供完整当前要求，changelog/activity/outcomes/subscriptions 分别分页。
角色默认视图不限制读取权限；actor 不等于列表过滤器。最新 activity 直接表示
最新报告，不额外维护进度摘要，也不与 native 观察混合。

列表默认 20、最多 50，历史默认 5、最多 10，每页另受 24,000 序列化字符预算。
完整当前 description 与显式单版 changelog 不静默截断；摘要和全文按需分开读。
具体输入限制和响应形状见 [MCP 契约](task-mcp-contract.md)。

写入使用稳定 `request_id` 和相同输入重放，已有 Task 通常还需原样回传
`write_context`；取消订阅改为核对具体 subscription 的等待状态。
description revision、生命周期代次和可编辑资料代次分别保护各自冲突，
不能用单一 revision 掩盖首次指派竞争或终态后的迟到状态写入。

外部 session 创建、资源准备、能力检查、绑定和消息发送有独立操作回执。
资源感知 create / prepare 的 `preparation` 和宿主 `resources` 分步效果与最终
`capability` 分开；已有创建回执形状在省略资源选择时保持兼容。
启用、工具初始化、最终就绪、授权、接受、ACK 和执行不能互相替代。
prepare/assign 的同目标并发保护仅覆盖已加载 Task 服务内的调用存续期间，
不新增持久锁，也不改变单项未结束执行的唯一约束。
已创建/绑定资源不能因后续失败而假装不存在；恢复只接受已证实未发送的
固定指派，不重放 unknown、queued 或 accepted 发送。完整规则见
[实现契约](task-implementation.md#external-operation-receipts)与
[生命周期回放](task-lifecycle-testing.md)。
