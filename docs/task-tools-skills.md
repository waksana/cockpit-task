# Task MCP 与 Skills

状态：角色协作规则、工具及独立审阅已完成；交付记录见 [PR #3](https://github.com/waksana/cockpit-task/pull/3)，不代表发布/部署。保留节点讨论作为产品决策来源。

依据：[产品设定](task-design.md)、[Task Schema](task-schema.md)

日期：2026-09-20

本文定义 agent 如何使用 Task，并对应已实现的宿主角色装配；不直接修改旧版 skills。旧版 `cockpit-task-owner` 实际指导执行方，不能按名字映射到新版 Owner；旧版最终通知、凭据路径和固定 goal 表单不沿用。

具体工具名称、角色范围、输入与效果见 [MCP 工具契约](task-mcp-contract.md)。本模块仅提供 Task Owner / Task Executor 两份角色技能；[Owner 设计说明](skill-drafts/task-owner.md)、[Executor 设计说明](skill-drafts/task-executor.md) 保留在原设计目录，实际打包资源为 `skills/task-owner/task-owner/SKILL.md` 与 `skills/task-executor/task-executor/SKILL.md`。外层目录分别作为角色的原生技能发现根目录，内层是技能本身。未修改真实 session 或替换旧技能。Coding / Research 是外部工作技能，不在本模块内。

**最新范围收缩：** 不做续办或改派；删除对应工具和参数。读取按 Owner / Executor 的不同关注点组织默认视图，其他正文和历史按需读取，不能把所有内容一次返回。

**普通更新不积累 queue：** 普通要求只更新 Task，不排队发送 cue、提醒或追加要求。非常重要的更新由 Owner 按 Skill 主动处理 pending 队列，再发送一条包含上下文摘要和 Task updated 引用的消息。首次派单仍不擅自中断忙碌目标，不把这项例外变成普通指派默认行为。

**节点 3 的角色决定：** 前端与 MCP 新建 session 共用角色选择和装配；系统按角色注入工具。有相应 MCP 就可调用，包括操作其他 Task，不按 owner / executor 归属鉴权。后续队列决策改为 Owner Skill 指导，不再推荐自动推进 MCP，也不宣称原子控制或排除其他来源的新消息。

**创建时角色组合：** 同一模块也可多选，Owner / Executor 可同时具备；
工具取并集、相同资源去重，两份角色 Skill 按委派和执行行为配合。
这不是运行中追加角色，也不放宽单 session 同时最多承接一项未结束 Task。

**其他来源队列的处理（最新决定）：** 不要求 Executor 永远没有 queue。重要更新需要接管时，建议 Owner 先读取并保留所有可获取的 pending 内容，再按已保存的消息 ID 清理队列；包含其他 session / subagent 的消息。随后总结这些内容，保留来源、未解决请求和资料，最后附上 `Task updated: [Task](task:<UUID>)`，合成一条消息发送。未能读取或保留的内容不能盲删；展示文本不是附件的无损备份。清理中新增或已开始执行的消息由 Owner 另行判断，不能假装快照锁定了队列。

必要时使用保留队列的单次主轮次中断，不用 Stop 作为清理捷径，不自动反复中断或取消 subagent。发送前核对实际原生状态、Task 仍未结束且 Executor 未变；已停止的回执或 idle 标签不等于可以立即接续。发送和清理不是原子操作，排队或未知回执不能盲重发，实际对齐以当前 revision 的 ACK 为准。完整流程和消息模板见[正式 Owner Skill](../skills/task-owner/task-owner/SKILL.md#exceptional-update-handoff)。

上述强制对齐仅在 Owner 判断更新非常重要、不能等待正常同步时明确触发。普通修订仍只更新 Task；不能因未 ACK 提醒、revision 变化或每次 task_edit 而自动运行中断循环。工具只执行明确操作，不替 Owner 判定重要性。

## 1. 不得改变的模型

| 概念 | 唯一职责 |
| --- | --- |
| description / revision / changelog | 当前完整定义、定义版本与对应的定义修订记录 |
| activity | Executor 执行时添加的活动，明确关联所依据的 description 版本 |
| acknowledged_revision | 当前 Executor 确认的 description 版本 |
| 角色与执行归属 | 决定谁可操作哪项工作；首次绑定后不替换 Executor，不借用 description revision 处理身份或生命周期 |

Owner 修改定义不自动添加 Executor activity；Executor 报告进度不修订定义。工具也不能通过任意对象更新，让调用者直接写入 owner、revision、ack 或伪造历史。

下文操作职责对应已实现工具，准确 schema 见 MCP 契约。用户已确认的行为不因工具分组改变，技术并发标识也不得冒充新的任务定义版本。

## 2. 操作职责

先按职责区分操作，再确定哪些合并为同一个工具，避免既恢复旧版十工具体系，又把所有事情塞进一个没有清晰边界的 update。

| 操作 | 可用角色 | 主要输入 | 效果 |
| --- | --- | --- | --- |
| 读取 | Owner / Executor | Task ID 或有界筛选；按角色默认视图或显式读取类型 | Owner 看概览，Executor 看完整执行定义；历史、成果与操作结果按需读取，不隐式 ack，不加载聊天或唤醒 session |
| 登记 | Owner | title、description、可选资料 | 创建未分配的 todo；不创建 session 或发送消息 |
| 创建执行 session | Owner | 工作目录、所选工作技能等创建选项 | Task MCP 通过宿主创建并配置执行能力；不登记、关联 Task 或发消息 |
| 明确指派 | Owner | Task ID、Owner 已创建或选定的 Executor session ID | 确保目标具备执行能力，更新 Task 的执行归属，再发送只含 Task ID 的引用；不新建或自动选择 session，不代表已承接 |
| 修订定义 | Owner / 当前 Executor | Task ID、所读 revision、完整新 description、原因 | 原子更新 description、revision 和 changelog；Executor 本人成功修订同时 ack |
| 确认定义 | 当前 Executor | Task ID、已读 revision | 只更新 acknowledged_revision；首次和后续 ACK 都不改变 status，不生成 activity |
| 报告执行 | 当前 Executor | Task ID、所依据 revision、活动内容、必要的状态或成果 | 追加执行 activity；完成时保存 outcome 并进入 done；不改定义或发消息 |
| 取消 | Owner / 收到用户要求的当前 Executor | Task ID、原因 | 标记 cancelled；不冒充 session 已停止，不由 Owner 生成执行者 activity |

系统按角色提供工具；后端不按调用者与 Task 的关系限制读写。角色分工由 skill 指导，工具仍校验版本、状态、ACK 与幂等。操作者标识用于业务追溯，不作为访问凭据；不另建通用可信 caller 协议。

用户在节点 2 明确选择：登记与派单分为两步，不提供“创建 Task 并自动创建/派发 session”的组合入口。Owner 自己判断新建 session 还是复用已有 session，使用开放、灵活的操作组合，不由程序猜测。首次指派后不改派，不通过其他编辑入口替换 Executor。

用户进一步确认保留一个明确的指派 MCP 工具，负责下面的顺序：

1. 确保 Owner 提供的目标 session 具备执行能力。
2. 更新 Task，将该 session 设为 Executor。
3. 以非排队方式发送只含 Task ID 的约定引用；忙碌或不能安全启动则明确失败，不放入 queue。

**ACK 与执行状态分开：** 用户明确两者是不同操作，不合并。Executor ACK 只记录对某版 description 的确认；即使首次 ACK，也不能自动把 todo 改为 in_progress。`task_report` 显式接受 activity、status、outcome 的任意非空组合；done 必须同次提交新 outcome，不隐式 ACK。

用户进一步确认：新建 Executor 时，Owner 调用独立的 Task MCP 创建工具，由工具创建并配置 Task 执行能力，不由 Owner 自己检查或拼装。Owner 仍决定新建还是复用以及工作目录；外部工作技能选择遵循宿主通用能力，不由 Task 定义或维护。普通创建、编辑 Task 不能通过填写 executor 字段绕过指派流程，也不隐式发消息；description 修订和进度更新同样不发消息。不因字段重复提交而重复发送。

“确保具备能力”是必要条件，不等于只检查 session 存在。用户已确认只复用有能力的 session：本体创建时选择角色，MCP session 列表带出该角色供筛选；指派仍检查当前能力，缺失则拒绝，不补齐角色、Skill 或 MCP，也不恢复已暂缓的 Executor 升格 Owner 功能。

本节点规定正常路径的顺序；能力未就绪时不冒充已指派或已发送。归属已更新但发送失败或未知时，必须保留并返回真实步骤结果，不能把失败当作从未执行并盲目重发。具体恢复契约在后端设计中收口。

`task_edit` 已支持 title/references/metadata 的整体字段替换，省略保持、空集合清空，不推进 description revision；独立资料代次防止并发覆盖。不得把定义要求藏进 metadata 绕过修订同步。必需执行环境应能从 Task 的工作资料读取，不仅存在于一次派单消息中。

## 3. 输入与结果的一致性

Owner skill 默认指定 overview，关注状态、执行者、最新 activity 摘录、revision / ack 差异和成果可用性。Executor skill 默认指定 execution，读取完整当前 description、资料、revision / ack、归属与状态。不把历史活动、所有修订和成果全文附在两种视图后面。Owner 编辑前显式读取 definition；activity、changelog、outcomes 分别分页读取。工具不以 Task 归属限制这些视图，列表范围由显式业务筛选决定。

每项写入都需要明确的操作身份，避免网络重试重复产生 changelog、activity、Task 或 session。相同操作重试返回原操作事实，不把它描述为当前版本的重新授权；当前状态仍应读取。

description revision 解决定义修订冲突，不负责全部并发问题。首次指派冲突、取消或完成后的迟到更新仍需独立的一致性保护；不再为改派或续办预建机制。具体字段和令牌设计在后端节点收口，不要求 agent 手工递增 description 版本来规避冲突。

Executor 的 activity 必须引用实际执行所依据的 revision，不能由服务自动改标为最新版本。可以补写该 Task 已确认旧版的执行事实，但不能借它更新当前状态或成果。失败原因明确为 description 已更新，要求先读取最新定义并 ack；跨 Task 调用也遵守这些数据规则，不另作归属权限拒绝。

用户进一步明确：该版本必须是 Executor 已经 ACK 过的版本；未确认过的版本应拒绝 activity，不以“允许补记”为由放行。仅仅读取、版本存在或当前 ACK 编号更大，都不证明某个被跳过的旧版本曾获确认。本人修订时的自动 ACK 算作确认，技术确认记录与 description changelog 分开。

如果一次报告同时携带 activity、状态和成果，而 description 已更新，应如实区分“旧版 activity 已保存”和“状态/成果因定义过期未保存”，不能返回全部成功，也不能返回仿佛没有任何写入发生的笼统失败。重试不得重复追加这条 activity，具体结果 schema 见后续工具契约。

### 每次 Executor 调用都检查定义更新

用户要求：只要 Executor 调用了 Task MCP，就检查相关 Task 是否有新的 description，并在需要时提示它读取并 ack。这是所有工具共用的响应规则，不是只放在读取或报告工具中的可选提示。

- 检查最新 description revision 与当前 Executor 的 acknowledged_revision。已经读取但尚未 ack 的版本仍然需要提醒，不能按“读过就算确认”处理。
- 读取、确认、修订、报告、取消等操作，以及能够识别调用者与任务的业务失败响应，都执行检查；不能仅在成功写入后提示。
- 提醒与具体 Task ID、当前 revision 和 ack 对应，不按调用者归属过滤。任务未变且已确认时，不制造“有更新”的提示；未承接时如实提示尚未确认。
- 返回记录与提醒应尽量来自同一个一致的响应检查点。Executor 自己修订并成功自动 ack 后，不再把该版本提示为待确认；但不能用本次 ack 掩盖已经发生的后续修订。
- 提醒说明“description 已更新，请先读取最新任务说明并 ack”。不自动 ack、不把旧活动改标为新版本，不因提示而发送额外消息、打断 session 或后台轮询。
- 原操作是否应用，与更新提醒分开表达。提醒不能吞掉输入错误、归属冲突、状态/成果被拒绝等实际结果；也不能把已经写入的 activity 当成未写入。
- 无法可靠检查时明确报告检查失败，不返回“没有更新”这样的成功默认值。Task 不存在或读取失败时如实处理；MCP 传输层未进入处理的请求也不能声称已完成检查。

检查范围是本次操作相关 Task 和 `actor_session_id` 当前承接的未结束 Task，不扫描所有任务或聊天。所有写入要求自报 actor；Skill 在读取也提供它。UI 读取可以省略，不伪造 human session ID；有 task_id 时仍检查相关定义。它用于提醒，不用于鉴权，不能因其他读取视图漏掉当前工作提醒。

派单结果必须区分 Task 已登记、session 已创建、角色已可用、消息已受理和 Executor 已承接。发生不确定结果时保留已有事实，不盲重试、新建替代 session 或重新发消息。

Task 修订工具不自带隐式中断。重要更新由 Owner 按 Skill 读取并保留 pending 内容、清理已保存的队列项，再将摘要和 Task updated 引用一次发送。不复制 description，不逐条重发旧消息，不以接受回执冒充已读取或工作完成；不再调用自动推进 helper。

<a id="通用响应草案"></a>

### 通用响应

实现将操作结果与定义更新检查分开，不能靠一段混合提示让 agent 猜测哪些操作生效。以下示例描述结构；错误 message 的具体语言不是协议常量。

| 字段 | 职责 |
| --- | --- |
| `result` | 原操作的结果；包含读取内容或明确的写入效果 |
| `error` | 被拒绝或未完成部分的错误码与原因；没有错误时为 `null` |
| `definition_check` | 对当前 Executor 相关任务的定义更新检查，独立于操作是否成功 |

`definition_check` 的表示（Task ID 在实际输入/结果中为 UUID，下例为语义占位）：

```json
{
  "status": "checked",
  "tasks": [
    {
      "task_id": "task-example",
      "revision": 3,
      "acknowledged_revision": 2,
      "needs_ack": true,
      "message": "description 已更新，请先读取最新任务说明并 ack。"
    }
  ]
}
```

这里的 `revision` 始终是 description 版本。当前未确认过定义时，`acknowledged_revision` 为 `null`，提示“尚未确认当前任务说明”，不捏造已发生修订。

没有待确认更新时，`needs_ack=false`，不附加重复的催促文字。Executor 自己修订后的检查使用已经提交的 ack，而不是提交前的旧值。

不能可靠读取定义时，`definition_check.status` 为 `unavailable` 并返回检查错误，不能用空数组表示已经确认没有更新。只在确实不适用时使用 `not_applicable`；不得因为原工具失败就省略检查。不存在的 Task 不编造版本，角色关系不构成拒绝读取的理由。

检查结果表示该响应检查点的事实，不保证响应发出后没有新的修订。也不能在新修订恰好晚于报告提交时，反过来宣称已经成功的报告没有保存：报告是否保存由实际提交结果决定，提醒由响应时能可靠读取的事实决定。

### 旧版 activity 与部分应用示例

假设当前 description 是 v3，Executor 仍 ack v2，提交基于 v2 的活动，并同时请求保存状态与成果。若它仍是当前 Executor，且这次活动写入符合其他生命周期约束，可以返回：

```json
{
  "result": {
    "status": "partially_applied",
    "activity": {
      "status": "saved",
      "id": "activity-example",
      "revision": 2
    },
    "task_status": { "status": "rejected" },
    "outcome": { "status": "rejected" }
  },
  "error": {
    "code": "DESCRIPTION_UPDATED",
    "message": "description 已更新，状态和成果未保存。请先读取最新任务说明并 ack。"
  },
  "definition_check": {
    "status": "checked",
    "tasks": [
      {
        "task_id": "task-example",
        "revision": 3,
        "acknowledged_revision": 2,
        "needs_ack": true,
        "message": "description 已更新，请先读取最新任务说明并 ack。"
      }
    ]
  }
}
```

这个结果在 MCP 层仍应标明含有失败，不能因 activity 保存成功就把整个请求标成成功。结构化结果同时保留已应用的部分，方便 agent 正确处理。

未请求的部分标记 `status=not_requested`，不与请求后被拒绝混用。这里的部分状态和操作结果状态都不是 Task 的业务 status。

如果只补写旧版 activity，没有申请改变状态或成果，则活动写入本身可成功，附带同样的更新提醒；不能虚构不存在的状态写入失败。

### 操作重试与响应检查的区别

相同操作标识和相同输入重试时，不重复追加 activity，也不重复发送 Task ID；返回原操作是否应用的事实。同时，响应的定义检查仍重新读取当前可见情况，不能拿旧操作缓存中的提醒冒充现在的检查结果。

Executor 接到提醒后的行为：

1. 保留“哪些内容已保存、哪些未保存”的判断，不全量重放刚才的请求。
2. 读取当前完整 description，理解变化，再明确 ack 所读版本。
3. 判断已做工作是否满足新要求，必要时继续执行；不能把旧成果直接改标为新版本。
4. 如需报告新状态或新成果，使用新的明确操作，原 activity 不重复提交。

任务取消、已完成状态和重复操作等约束独立于旧版 activity 的保留规则。允许跨 Task 操作或记录旧版事实，不等于允许被取消的任务通过活动重新进入执行状态。

### 需要覆盖的契约场景

| 场景 | 预期 |
| --- | --- |
| Owner 修订 v2 → v3，Executor 随后调用读取 | 返回 v3，保留 ack v2，并提醒确认 |
| Executor 再次读取但未 ack | 继续提醒；读取不替代确认 |
| Executor 成功 ack v3 | ack 为 3，不再提示该版本待确认，status 与 activity 不变 |
| Executor 首次 ack todo 任务 | 仍为 todo；开始执行须明确更新状态 |
| Executor 自己成功修订为 v4 | description、revision、changelog 与 ack 按规则一起更新，响应不误报 v4 待确认 |
| 只报告基于旧版的 activity | 保留该活动的原版本，附带更新提醒，不改状态或成果 |
| activity 引用本人尚未 ACK 的版本 | 拒绝保存；当前版或旧版均不能绕过确认 |
| ACK 从 v1 跳到 v3，随后报告 v2 activity | 拒绝；确认 v3 不证明曾确认 v2 |
| 旧版 activity 同时携带状态与成果 | 明确部分应用，状态和成果因 description 更新被拒绝 |
| 修订冲突或其他业务操作失败 | 保留原错误，并在可可靠检查时返回定义提醒 |
| 重试已经部分应用的报告 | 不重复保存活动，返回原结果与新检查到的定义情况 |
| Executor 查询其他视图 | 仍检查当前承接任务，不仅在 activity 工具中检查 |
| 定义读取失败 | 明确 unavailable，不声称没有更新 |
| 具有相应工具的 session 操作其他 Task | 不因归属不同而拒绝，仍校验该 Task 的版本、状态与幂等 |
| 已结束 Task 请求恢复执行或替换 Executor | 拒绝，不通过普通编辑、报告或指派恢复 |
| Owner 例行读取概览 | 不返回完整 description、资料或全部历史；可按需展开 |
| Executor 读取执行上下文 | 完整返回当前定义与工作资料，不附带历史全集；读取仍不 ACK |
| Owner 更新要求但未决定中断 | 只修订 Task，无消息、queue 或后台唤醒 |
| Owner 因重要更新明确接管 | 先保存 pending 内容再清理，发送一条摘要加 Task updated 引用；没有自动推进循环 |
| 清理期间又有新消息 | 重新读取并由 Owner 判断，不盲删未读消息、不假装原子排空 |
| 首次派单发送时目标忙碌 | 不入队、不擅自中断；返回真实未发送及已产生的其他效果 |

这些场景指导了当前核心与接入测试；是否通过以对应工作树的实际测试结果为准，不把设计清单或文档状态当作已发布/已部署证明。

## 4. Role skills

以下为两份已实现角色技能的协作摘要。Owner 注入 read/create/session_create/assign/edit/cancel；Executor 注入 read/edit/ack/report/cancel（工具均带 `task_` 前缀），多角色取并集。Task 引用为 `[Task](task:<UUID>)`，不能把 `<UUID>` 占位符作为实际 ID。角色资源具备可打包实现，不表示已安装进任何生产 session。

### Task Owner

1. 与用户澄清工作，将完整当前要求写入 Task 的 description；资料和成果通过 Task 中的引用关联。
2. 可先登记，再明确派单。每项独立工作由一个 Executor 完整负责，不创建父子 Task。
3. 新建执行 session 时调用 Task MCP 的创建入口，由它创建并配置执行能力；也可明确选择已有 session。登记 Task 与创建 session 相互独立，两者就绪后调用指派工具，由工具确认当前能力、更新归属并发送 Task ID，不再手工重复发送。消息不附带任务说明或凭据。
4. 主动按需读取自己的 Task，以状态、执行者、最新活动、确认差异和成果可用性为概览；需要修订时再读取完整定义，需要细节时再读取对应历史或成果。不要求 Executor 反向汇报，不自动轮询。
5. 普通修订只提交完整新 description 和原因。Owner 判断更新非常重要、不能等待时，才按 Skill 保存并清理 pending 内容，归并摘要，最后附 Task updated 引用一次发送。需要中断时只做单次主轮次中断，原生阻塞及新消息由 Owner 明确处理，不自动推进。
6. 信任 Executor 完整交付；不添加统一的 Owner 验收门槛。取消必须明确，不能把记录变更当作 session 已停止；不续办或改派。
7. 面向用户展示工作时使用规定的 Task 引用格式，卡片从后端读取真实数据，不在消息里维护另一份状态。

### Task Executor

1. 收到 Task 引用后读取完整当前 description，核对本人归属并 ACK 对应 revision。ACK 不代表开始工作；真正开始执行时，另行明确将状态更新为 in_progress。
2. 对整项工作负责，按工作技能与项目约定执行。可用内部 subagent，但不创建子 Task 或为自己追加 Owner 能力。
3. 在开始、重要阶段间、重要操作前、交付前及恢复时读取最新要求。每次 Task MCP 响应都检查定义更新提醒；发现新版本先读取、对齐再 ack，不能把收到提醒或读过内容当成已经确认。不忙循环轮询。
4. 用户可直接与你澄清。影响定义的结论写成完整新 description，成功修订时确认新版本；并发冲突时重新读取，不覆盖新内容。
5. 有意义的进展、阻塞和交付写成 activity，携带实际依据的 description 版本；不把一次 activity 当作定义修订。旧版 activity 可以保留，但过期状态和成果会被拒绝；先读取新定义并 ack，再判断后续工作，不把旧成果直接重新贴上新版本。
6. 完成当前约定后写入成果并直接 done。任务要求评审时执行评审，不把 in_review 当成固定 Owner 审批。
7. 不向 Owner 发送进度、阻塞或完成消息。真正需要用户决定时在自己的会话提问；取消按用户要求明确操作，不恢复已结束任务。
8. 不覆盖旧归属或新版本。失败和未知结果如实保留，不自动换任务、换 session、重发派单。
9. 对用户展示 Task 时使用约定引用格式；不手写会与后端失同步的卡片内容。

## 5. 外部工作技能边界

Coding Work、Research Work 不包含在 Task 模块内，本仓库不维护其正文、安装或发布。Task 仅提供两份角色技能，指导如何通过 Task MCP 协作和记录执行事实。

外部工作技能定义“如何完成具体工作”，可经宿主通用机制组合；Task 不硬编码技能名单或业务流程，不把它们做成 Task 子类型或模块必装依赖。工作产出的相关进展与成果由角色技能指导写入 Task，不要求外部工作技能绑定 Task API。

## 6. 实现交付与历史边界

实现工具为 `task_read`、`task_create`、`task_session_create`、`task_assign`、`task_edit`、`task_ack`、`task_report`、`task_cancel`。创建并配置执行 session 是独立入口，首次指派仍独立；删除续办与改派。read 按角色关注点组织默认视图，历史与操作结果显式有界读取。

两份角色技能分别负责 Owner 与 Executor 协作，不包含外部工作方法，不混入 Task 子类型或宿主权限机制。技能必须处理版本提醒、已保存的部分结果和不确定派单，不发送反向通知。

已确认 activity 只能引用本人确认过的版本；旧版补记不是任意填写 revision 的通道。ACK 与执行状态仍严格分开。

通用角色注册、前端 / MCP 创建选择、能力装配已实现，不新增逐 Task 鉴权。旧版队列推进 MCP 已在宿主实现，但本次 Skill 改用 Owner 主动处理，不再推荐调用；这次文档及 Skill 修改不代表宿主工具已经移除。分代 write_context、逐版确认、持久化回执、`resume_request_id` 的未发送操作恢复和引用卡片已在后续技术收口中实现，详见 [实现契约](task-implementation.md)。恢复操作不是恢复终态 Task，未知发送不能据此重试。

保留节点 2→3→4 的讨论文档作为决策与原生 API 调查来源，但不再要求已授权的实现停在逐节点等待。开发实现不等于发布、合并或生产部署，不因已有原生 API 就直接改变真实 session 的 skills 或 MCP。
