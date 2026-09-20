# Task Schema 与协作流程

状态：产品语义、实现及独立审阅已完成；交付状态见 [PR #3](https://github.com/waksana/cockpit-task/pull/3)，不代表生产部署。

依据：[产品设计与最新决定](task-design.md)

日期：2026-09-20

本文说明 Task 的记录语义和协作行为，保留早期节点决策来源。当前工具参数见 [MCP 契约](task-mcp-contract.md)，存储、并发和边界见 [实现契约](task-implementation.md)；不再把已收口技术项标成等待下一节点。

**版本语义修正（2026-09-20）：** 用户明确 `description` 始终保存最新完整任务说明，`revision` 仅是 description 的版本，`changelog` 与 description 修订一一对应。`activity` 是独立的执行记录，每条指向它所依据的 description 版本；`acknowledged_revision` 表示当前 Executor 确认了哪个 description 版本。此前将归属变更也推进 revision、将所有操作混入 history 的草案作废。

**定义与执行分开：** 用户再次确认，description 和 changelog 针对 Task 的定义；activity 是 Executor 在执行时添加的活动。Owner 修订定义写入 changelog，不冒充 Executor 活动，也不自动复制一条相同内容到 activity。

**最新范围收缩：** 用户移除续办与改派，覆盖此前对此的确认；Task 首次绑定 Executor 后不换人，done / cancelled 不恢复执行。读取按角色关注点提供有界视图。Task 仅提供 Owner / Executor 角色技能，Coding / Research 属于模块外。

**访问模型更新（节点 3）：** 系统按所选角色注入 MCP，有对应工具即可操作其他 Task，不按 owner / executor 归属限制读写。以下角色行为表示协作分工，不是访问控制；作者来源、当前工作上下文和 ACK 的业务记录不依赖新的通用可信身份服务。版本、状态、幂等与绑定不可替换等数据规则继续保留。

**消息事件不改变 Schema：** 通用引用仍为 `[Task](task:<uuid>)`，首次派单和 Owner
显式重要更新分别使用 `?event=assigned` / `?event=updated`。event 仅是该条消息
固定的引用元数据，不是 Task 实体字段、类型、状态、命令或调度事件。Task ID 始终
是纯 UUID，不含 URI/query。卡片保留消息原因并读取当前 Task 数据；事件不改变
revision、ACK、activity 或生命周期。完整语法见[实现契约](task-implementation.md#read-boundaries-and-reference)。

## 1. 已确认的边界

| 方面 | 当前决定 |
| --- | --- |
| 工作单元 | 一个独立 Task，由一个 Executor session 完整负责；Owner 可管理多个 Task |
| 拆分 | 内部步骤和 subagent 由 Executor 自行组织；没有父子 Task 或任务树 |
| 角色 | Owner 创建和派单，Executor 更新自己承接的 Task；不实现已有 Executor 追加 Owner |
| 信任 | Owner 充分信任 Executor，不设置默认的上游验收关卡 |
| 共同记录 | 任务背景、完整要求、澄清、动态和成果写入 Task；外部资料可通过引用关联 |
| 派单 | `task_assign` 仅发送一次 `[Task assigned to you](task:<uuid>?event=assigned)`，不复制说明、不另发手工派单 |
| 登记 | 允许先登记 Task，不创建 Executor；之后由 Owner 明确派单，同一 Task ID 保持不变 |
| 执行 session 创建 | Owner 通过独立 Task MCP 入口创建并配置能力；不与 Task 登记或指派合并，不要求 Owner 自行拼装底层能力 |
| 进度读取 | Owner 主动读取 Task；执行者不发送进度、阻塞、完成等反向消息 |
| 要求修订 | Owner 和当前 Executor 都可修订；Executor 可直接与用户澄清后写回 |
| 修订确认 | Executor 自己成功修订时直接确认新版本；Owner 修订由 Executor 之后读取并确认 |
| ACK 与状态 | ACK 只更新 acknowledged_revision，不改变 status 或生成 activity；首次确认也不等于开始执行 |
| 调用时提醒 | 每次 Executor 调用 Task MCP 都检查最新 description 与 ack；发现待确认更新时提示读取并 ack，不自动确认 |
| 旧版执行活动 | 当前 Executor 可以补写本人已 ACK 过版本的 activity，仍指向原 description revision；未确认版本拒绝，旧版状态与成果不能保存 |
| 重要修订 | Owner 修改后查看 Executor 运行情况与最近活动，自行判断是否打断并要求重新对齐；不自动中断 |
| 普通更新与强制对齐 | 普通更新只改 Task；非常重要的更新由 Owner 按 Skill 处理 pending，再一次发送摘要和 `[Task updated](task:<uuid>?event=updated)` 及读取/ACK 最新版要求，不自动触发 |
| 其他来源的队列 | Owner 先读取并保留内容再按消息 ID 清理，包含其他 session / subagent 消息；未知内容及并发新消息不盲删，不循环中断或静默取消后台工作 |
| 同步 | 开始、重要阶段间、重要操作前、交付前及恢复时检查最新要求；不忙循环轮询 |
| 一致性 | 旧确认、旧结果不能覆盖新版本或结束事实；跨 Task 操作也不能虚报执行者确认或更换已有绑定 |
| 生命周期范围 | 不续办、不改派；done / cancelled 不恢复执行，绑定后的 Executor 不替换 |
| 取消 | Owner 可以取消；当前 Executor 收到用户取消要求时也可以取消本任务。取消后不能继续报告进行中或完成，不冒充 session 已停止 |
| Session 复用 | 只复用已有 Executor 能力的 session，指派不补能力；一次最多承接一个未结束 Task，完成或取消后可承接其他 Task，不终身绑定 |
| 前端 | 引用由前端识别并从后端读取数据渲染卡片；不另存一套前端工作状态 |

## 2. 核心信息的语义

角色与字段名称统一为 Owner / Executor、`owner` / `executor`，不再保留 Coordinator / Assignee 两套名称。下表给出已实现的概念语义；它不是一次全量读取对象。字段、分页与并发的具体传输形状由 MCP/实现契约规定。

| 信息 | 表达什么 | 边界 |
| --- | --- | --- |
| `id` | Task 的稳定身份，也是派单和卡片引用依据 | 不以 session ID 或聊天消息 ID 代替 |
| `title` | 简短、可识别的工作名称 | 不代替完整要求 |
| `description` | 始终为最新完整任务说明，包括背景、目标、约束和完成条件 | 修改时更新正文、推进 revision 并追加对应 changelog；不是简述或差量补丁 |
| `owner` | 这项工作的委派方 session ID | 创建时明确记录，供分工和筛选；不是权限标识，不以此限制其他 session 的操作 |
| `executor` | 对这项工作完整负责的 session ID 或 `null` | 不共享执行归属；未派单时为 `null` |
| `status` | Task 的工作状态 | 与 session 的 running、idle、unloaded 分开 |
| `outcome` | 工作交付成果，保留所属 revision | 成果历史含 summary 与可选 references；overview 仅返回 available 与版本/current，不附全文；尚无成果时 available=false |
| `activity` | Executor 在执行时添加的进展、阻塞或交付活动 | 每条携带所依据的 description revision；不改变 description，不写入定义 changelog，最新一条直接作为最新执行情况 |
| `revision` | 当前 description 的版本 | 仅 description 修订时推进；不是整个 Task 的写入计数或归属标识 |
| `changelog` | description 的修订记录 | 与 description 版本一一对应，保留修改人、时间、原因和可追溯的内容变化；不混入进度、状态或归属流水 |
| `acknowledged_revision` | 对固定 Executor 已记录确认的 description 版本或 `null` | 记录 confirmed_for 与自报 author，不验证实际阅读；跨 Task ACK 可调用但不得虚报，也不能涵盖未确认的修订 |
| `references`（可选） | 资料、成果或其他独立 Task 的引用 | 使用 `{label,target}`，不强制 GitHub 字段，不解释引用为依赖 |
| `metadata`（可选） | 工作方法需要的补充结构化内容 | 开放内容，不引入 Coding/Research Task 子类型；不能覆盖固定字段、作为身份凭证或自动触发工作 |

不添加父子字段、递归完成规则或 Owner 升级配置。取消通用 `history` 字段的含混定义：定义修订属于 `changelog`，执行动态属于 `activity`。已有的保留历史要求不意味着需要再建一个包揽所有事情的 history。

### 当前记录与有界历史

完整当前定义必须可直接读取，不能要求 Executor 扫描聊天或拼接历史才能开工；但不是每次读取都返回完整 Task。

Owner 默认关注执行者、状态、最新报告活动、确认差异与成果可用性；Executor 默认读取完整当前 description、工作资料、当前责任与版本/ACK、状态。完整定义、活动、修订和成果可按需分别读取，历史有界分页；角色默认视图不限制双方已有的读取权限。列表和卡片读取摘要，不额外维护进度总结。当前 `activity` 指执行者报告的工作情况，不与原生 session 活动混合。

持久化使用独立 `task-board.sqlite`，不读取或迁移旧服务数据库。description 快照、逐版 ACK、activity、outcomes 和操作回执独立保存；部分唯一索引保证 Executor 同时最多一项未结束 Task。列表默认 20/最多 50，历史默认 5/最多 10，均再受 24,000 序列化字符页预算约束，剩余由不透明 keyset cursor 读取。description 最长 24,000 字符，与 references/metadata 组合序列化最多 64,000；详情不静默截断。changelog 默认仅摘要，显式 revision 才取该版全文。

### 四个概念的对应关系

```text
description + revision         最新完整任务说明及其版本
changelog                      description 各版本的修订记录
activity[].revision            每条执行动态所依据的 description 版本
acknowledged_revision          当前 Executor 确认的 description 版本
```

修改 description 时，新的完整正文、递增后的 revision 和对应 changelog 必须一起保存。记录执行动态只增加 activity，确认已读只更新 acknowledged_revision；两者都不产生 description 新版本或 changelog。

例如，Owner 将 description 从 v2 修订为 v3，Executor 的 ack 仍是 2，表示还没有确认 v3。已有的 v2 动态保留原版本，不重标成 v3。Executor 读取并确认 v3 后，新的执行动态引用 v3。若 v3 是 Executor 本人成功修订的，则按已确认规则同时将 ack 更新为 3。

状态、归属的变化本身不是 description 修订。当前工具将 definition edit 与状态 report 分开；不能因状态改变而制造没有正文变化的 description 版本。

### 字段形状示例

以下保留早期设计的合成概念示例，用于说明四种记录的关联，不代表真实 session，也不是当前单个 read 的返回形状。实际 overview 不含完整 description，execution 不含 activity/outcome；Task ID 为 UUID（下例旧占位符不是有效调用参数）。

```json
{
  "id": "task-example",
  "title": "设计 Task 模块",
  "description": "交付独立 Task 的 Schema、后端、MCP、skills 和展示卡片。按已确认节点推进，不做任务树或已有 Executor 追加 Owner，不部署生产。",
  "owner": "session-owner-example",
  "executor": "session-executor-example",
  "status": "in_progress",
  "revision": 2,
  "acknowledged_revision": 2,
  "outcome": null,
  "activity": {
    "source": "reported",
    "author": "session-executor-example",
    "revision": 2,
    "at": "2026-09-19T15:00:00Z",
    "text": "正在整理已确认的 Schema 与协作规则。"
  },
  "references": [],
  "metadata": {}
}
```

`changelog` 单独读取，示例的 `activity` 展示最新一条。保存时间由服务记录，作者来源须明确，不将业务参数称为经过验证的身份；activity 所关联的 description 版本必须明确并校验，不能自动标成服务器最新版本。这里保留少量固定概念，不强迫 agent 填写与工作无关的空字段；示例中的可选内容不代表实际输入必填。

## 3. 状态与完成

当前使用以下状态词汇：

| 状态 | 语义 |
| --- | --- |
| `todo` | 尚未开始执行，包括先登记但未分配，以及已派单但未承接 |
| `in_progress` | 正在处理当前工作约定 |
| `blocked` | 存在阻碍，需要在 Task 中说明原因和所需条件 |
| `in_review` | 工作本身包含且当前正在等待的评审步骤，不是固定上游审批 |
| `done` | Executor 已完成当前约定并写入成果 |
| `cancelled` | 这项工作被取消；不代表系统已经停止执行中的 session |

### 已确认：不强制经过 in_review

用户明确选择：

> Executor 可以直接完成，in_review 仅按任务需要使用。

因此，Executor 在完成约定后可直接写入 outcome 并标记 `done`，不等待 Owner 再批准。是否需要评审由任务本身的约定决定，不由 Task 系统统一添加。

例如，任务明确要求代码审阅时，Executor 应完成该工作步骤；不能把“可直接标记 done”理解为跳过 description 里的要求。任务是否需要部署同样由 description 决定，不能把代码合并自动视为已部署。

进入 `blocked`、`in_review` 或 `done` 都不产生反向消息。Owner 通过主动读取了解变化。

### 已确认：当前不做续办或改派

用户在节点 2 因复杂度与使用频率决定去掉两项能力。已结束记录与历史保留，但不通过编辑、报告或指派恢复执行；已有 Executor 不可替换。独立新工作由 Owner 明确另建 Task，不自动创建替代工作。

### 状态转换边界

下表把已确认规则整理成操作边界，不定义具体工具数量或名称：

| 行为 | 操作主体 | 工作记录效果 |
| --- | --- | --- |
| 登记 | Owner | 新建 `todo`，`executor=null`，尚未确认 |
| 明确指派 | Owner | 接收 Owner 已创建/选定的 session；确保能力后更新 Task 的 Executor，再发送一次 assigned 引用；仍为 `todo`，指派不等于承接 |
| 确认定义 | 当前 Executor | 读取并 ACK 当前 revision，仅更新 acknowledged_revision，不改变 status 或 activity |
| 开始执行 | 当前 Executor | 明确更新为 `in_progress`，与 ACK 分开 |
| 报告阻塞 / 恢复处理 | 当前 Executor | `in_progress`、`blocked` 之间按实际情况更新；保存动态，不改变要求版本 |
| 执行约定中的评审步骤 | 当前 Executor | 按需进入或离开 `in_review`；不存在统一 Owner 批准门槛 |
| 完成交付 | 当前 Executor | 确认当前要求后写入 outcome，进入 `done`；不发反向通知 |
| 取消 | Owner，或收到用户取消要求的当前 Executor | 进入 `cancelled`，记录原因；拒绝继续以普通报告进入执行或完成状态 |

done / cancelled 不接受普通报告恢复执行；指派只用于未分配的 todo。Executor 自己修订后的自动 ACK 也不能改变执行状态。

取消或完成允许业务上复用 session，但不证明该 session 已满足原生安全空闲条件。指派其他 Task 时仍须在接入层尊重真实运行状态，不自动抢占或创建替代 session。

## 4. 已确认的正常协作路径

用户确认允许先登记、之后再派单。只登记时 Task 处于 `todo`、Executor 为空，不创建 session 或发送消息。稍后派单使用同一 Task，不为启动执行再复制一条工作记录。节点 2 进一步确认不提供合并登记与派单的工具；Owner 自己判断新建还是复用 session，接口保持可组合。

1. Owner 与用户澄清，将足够执行的完整工作约定写入 Task。
2. Owner 通过独立 Task MCP 入口创建并配置 Executor session，或明确选择已有 session，然后调用指派 MCP 工具。指派工具确认目标当前能力、更新 Task 的执行归属、发送一次 assigned 引用；Owner 不自行检查底层能力或重复发送，指派工具也不创建替代 session。
3. Executor 根据角色指导读取当前 Task，ACK 对应 description 版本；真正开始工作时另行明确更新执行状态，不把两者合并。
4. Executor 内部组织步骤或 subagent，处理完整工作；有意义的动态写回 Task。
5. 用户可以直接与 Executor 澄清；影响工作的结论由 Executor 写回共同记录，不经 Owner 转述。
6. Owner 按需读取进度，不要求执行者另外汇报。
7. Executor 在交付前检查最新约定，完成所要求的步骤，写入成果并标记 `done`。

派单准备的失败和未知结果属于操作过程，不能用工作状态冒充“已创建 session”“角色已可用”或“消息已受理”。实现通过独立持久化操作回执逐步记录这些事实，`task_read(view=operation,request_id)` 按需读取。

### 要求修订与重新对齐

`revision` 只表示 description 版本。description 修订推进版本并追加一条 changelog；执行归属、进度、阻塞和状态变化本身不推进该版本，也不进入 description changelog。

执行者本人基于最新版本成功修订要求时，同时确认新版本。其他 session 的跨 Task 编辑不等于该执行者已经确认；操作者的业务来源和本人修订判定在后端节点明确。任何更新基于过期版本，都不能靠“自己写的”绕过冲突保护。

Owner 修订时不替 Executor 确认。Executor 在之后的检查点主动读取、对齐并确认；如果修订重要，Owner 还要查看执行者运行状态和最近活动，再决定是否打断并要求重新对齐。

重要性判断和是否打断由 Owner 负责，不预设自动检测规则、自动取消或自动发消息。Task 的 revision 保护能够拒绝过期更新，但不能撤销执行者已经做出的外部操作，因此不能用版本保护代替必要的主动中断判断。

用于判断的原生动态和 Task 自报动态必须区分，未知仍是未知。普通修订只更新 Task；非常重要的更新由 Owner 按 [Owner 随包参考](../skills/cockpit-task-owner/cockpit-task-owner/references/important-updates.md)保存 pending 内容、清理已保存项，整理摘要并在末尾附 Task updated 引用，一次发送。需要中断时仅中断主轮次一次，真实后台工作、并发新消息和未知结果由 Owner 明确处理；不以 idle 标签或消息接受回执冒充可接续或已确认。修订本身仍不发消息，也不触发循环。

## 5. 归属、修订与旧结果保护

角色决定注入哪些工具，具有工具即可对其他 Task 调用，不再分别检查调用者与单条 Task 的权限关系。owner / executor 是责任分工；工具不靠这两个字段拒绝跨 Task 操作。Skill 指导如实执行和确认，后端维持版本、状态和幂等等数据一致性。

版本编号：description 初始版本从 1 开始，changelog 保留对应的初始定义记录；之后每次实际正文修订递增并追加对应记录。相同正文不造新版本或隐式 ACK。首次派单不改变 description 版本。编号由服务维护，不要求用户手工推算。

状态和成果更新必须针对已确认的当前 description revision，但不推进要求版本。activity 则关联实际执行所依据的 revision：用户确认允许仍具备当前归属的 Executor 补写旧版 activity，只追加执行事实，不更新当前状态或成果。状态/成果被拒绝的原因明确为 description 已更新，要求先读取最新定义并 ack。

activity 所引用的版本必须在当前执行归属下记录过该 Executor 的 ACK，包含本人修订时的自动确认。未 ACK 的版本不能记录活动；读取过、版本存在或 ACK 了更高版本，都不能证明一个被跳过的版本曾获确认。确认表逐版保存 fixed executor（confirmed_for）与自报操作者（author），不属于 description changelog，也不把作者字段宣称为认证身份。

一次报告如部分应用，响应须明确哪些已保存、哪些因定义过期被拒绝；不能使重试重复保存 activity。取消后也不能被同一 revision 的延迟“进行中”报告覆盖。技术层须分别核对定义版本、执行归属、当前状态及操作顺序；具体幂等与并发契约在节点 2、4 定义。

每次 Executor 与 Task MCP 的交互，都需检查相关 Task 最新 description revision 与 acknowledged_revision，未确认新版本则提醒读取并 ack。提醒不是后台消息，也不改变 ack；工具读取最新定义后若尚未确认，仍应保留提醒。原操作失败时也不能仅因此省略可可靠完成的检查，读取失败必须如实处理。

通用响应、旧版 activity 部分应用示例和相关契约场景见 [MCP 与 Skills](task-tools-skills.md#通用响应)。操作重试不重复执行，但每次响应仍要检查当前定义，不能把旧提醒缓存成最新事实。

首次指派后保留固定执行归属；其他 session 可通过所具备的工具操作记录，但不借此替换 Executor、虚报确认或绕过生命周期。即使不支持改派与续办，首次指派竞争、取消和完成后的迟到更新仍必须受保护，不能借 description revision 代替生命周期约束。

当 description 变化时，旧 outcome 保留其原 revision，不能继续作为新 description 已经交付的证明；成果记录不混入 description changelog。overview 的 outcome.current 标明是否对应当前定义，成果全文在 outcomes 页读取。终态仍允许编辑定义，但不会自动 ACK 或重新开始执行。

用户指令来源和修订原因可以记录以供追溯，但 agent 填写“用户同意”不是技术上已验证的授权凭证。Task 不通过扫描聊天制造这种证明。

## 6. 完整协作实例

### 先登记、后执行

Owner 登记“设计 Task 模块”，暂未安排执行者：Task 为 `todo`，Executor 为空，没有消息。后来明确派单，准备好 Executor 的角色和读取能力，由 `task_assign` 发送一次 assigned 引用。Executor 读取并 ACK，状态仍为 todo；实际开始工作时再明确更新为 in_progress。派单及阶段动态都不改变 description 版本，动态指向执行所依据的版本。完成 description 所要求的交付后，Executor 写入 outcome 并直接标记 `done`。Owner 下次主动读取时看到成果。

### Executor 直接澄清与修订

用户在 Executor 会话澄清“只做卡片，不做独立管理页面”。Executor 将完整当前要求修订成功，同时确认新版本，再继续工作。不让 Owner 转述，不向 Owner 发消息，也不要求 Executor 再读取一遍自己刚写成的同一版本。若提交期间有另一项修订先发生，则先处理冲突，不能覆盖新内容。

### Owner 的重要修订

Owner 将“允许部署”改为“本轮不部署”，修订 description、推进版本并追加 changelog，不替 Executor 确认。随后查看其实际运行情况与最近活动，判断是否即将执行部署，是否需要明确打断。不能因为要求已经落盘就假定正在执行的外部操作停止。重新对齐时按 Skill 保留并处理 pending 内容，在单条摘要后附 updated 引用及读取/ACK 最新 revision 的要求，不在消息里复制另一份 description。

### 结束后的复用与迟到请求

Executor 完成任务 A 后可明确承接任务 B。A 的迟到执行报告不能重新启动 A 或覆盖已结束事实；同一 session 被复用不使两项 Task 的写入上下文通用，也不自动恢复 A。

## 7. 节点确认与后续边界

当前有效确认包括：直接完成与可选评审、先登记后派单、要求版本、本人修订确认、重要修订后主动判断中断、双方按约定取消、单 session 单项未结束工作，以及 Owner / Executor 命名。此前续办和改派方案已被节点 2 的范围收缩覆盖，不实施。

用户在 2026-09-20 澄清 definition / execution 的版本模型后同意继续进入节点 2，后续授权连续实施。本文保留该决策历程；当前 JSON 形状与技术实现已经收口，不改变已确认语义。未授权能力不隐式加入：例如取消后恢复、Owner 转移、批量操作和 Executor 自助追加 Owner。

角色工具装配、业务上下文、部分失败、幂等、分代并发、独立存储和 `[Task](task:<UUID>)` 卡片引用已实现，不新增通用可信 caller 或逐 Task ACL。唯一的 `resume_request_id` 用途是新操作显式恢复已证实未发送的固定指派；不是生命周期续办或改派。MCP、skills 和前端沿用同一状态语义；实际发布与部署不由本文推定。
