# 契约与边界

## 定位：供 Commander 使用的工作工具

Cockpit Task 是面向 agent 的结构化工作记录与操作服务：以统一契约降低协作成本，让工作可查询、可衔接、可展示；判断和行动由 agent 发起。它不是自主指挥、监督或调度系统，也不是任意文本存储桶或 MCP 配置数据库，不因保存了待办就主动执行。记录主要供讨论 Commander 阅读和理解，也供 owner 与用户按权限查看；目标含义、优先顺序、并发安排、业务冲突和结果是否满足需求，最终由 Commander／owner 根据实际情况判断，重要取舍与授权由用户决定。

主动方是 agent：Commander 明确决定并调用派单工具，Task 才按指定参数准备 session 和投递；owner 实际工作后决定报告时机与内容，调用工具写回进展或交付。Task 不读取聊天来推测进度，不因长时间没有报告就认定卡住、失败或完成。看板中的工作进展表示最近报告的事实，不是服务持续监测所得的实时状态。

owner 调用交付工具时，定向通知是该显式操作的既定效果，不是 Task 自行决定发起汇报。派单或通知操作的结果由程序如实记录，与 owner 声明的业务进展分开：投递受理不等于 owner 承接，消息被接收不等于 caller 已阅读，结果落盘不等于服务验证了验收结论。

沟通约定从实际协作中产生，成熟、通用的部分由 Task 的 schema 承载，而不是仅靠 skill 提醒每个 agent。任务身份、版本、状态、依赖和结果入口使用统一字段与合法值，避免各 agent 临时发明同义字段，减少接收方反复解析不同格式的负担。Dashboard 可直接按同一结构展示已报告事实，不必先用模型总结聊天。

schema 与 skill 分工互补：schema 提供可校验的表达结构、引用和必要转换；skill 指导何时调用、怎样理解授权、什么值得报告、如何判断完整交付；agent 选择具体内容、解释变化并决定下一步。通用结构之外的业务细节保留简短说明，不把每一种例外变成必填字段。当前 accepted/result/deliver 等操作及结果入口要求是实际接口契约，不是服务已经理解或验证业务结论；调整它们需要明确接口变更，本节不取消现有约束。

派单调用等待准备与投递步骤的结果，但不等待 owner 完成工作；顺序派单仍可产生并行执行。服务不会因此自主挑选下一项工作、设定业务并发额度、推导代码冲突或在前置完成后自动开工。依赖就绪仅表达已登记条件，不等于执行授权或运行环境就绪。

“不替 Commander 限制工作安排”不等于取消契约保护。服务仍校验凭证与归属、输入、版本、幂等、依赖关系和操作一致性；这些防止越权、重复副作用及数据冲突，不构成自主业务决断。服务无法约束 agent 绕过它的所有行为，也不能证明自然语言成果真实合格。实际 Git 集成与部署的互斥由工程流程保证。

本定位不新增业务调度器、并发配额或资源锁；先由 Commander 合理安排，只有反复出现且可明确表达的通用需要，才考虑新增机制。

维持被动定位不意味着程序没有内部活动：页面连接心跳、凭证撤销检查、启动时将中断操作标为 failed/unknown，都是连接安全和已有操作的账务处理；不启动或重放任务。依赖条件计算和页面变更事件同样只整理已有事实，不自行派工。常驻服务的存活不等于有一个常驻 agent 在工作。

## 字段与机制的演进原则

2026-09-11 用户确认：字段从实际使用中生长，不为一次性、临时或极端案例预设大而全的表单。每个新增字段都应有反复出现的通用需求，并能支持明确的校验、查询或关系维护，或显著减少后续阅读负担。

- 服务已知或能可靠推导的身份、版本、时间和操作结果由服务维护；协议必要参数仍须按契约提供，但不要求 agent 在摘要中重复填写。
- 普通事实优先使用简短摘要、可选说明和成果引用；只将确需程序判断的信息结构化，不要求固定交付长表、空字段占位或冗余报告。
- 少量稳定字段保持统一语义；不以任意自由 JSON 或同义字段堆积替代契约。新增字段需考虑填写、传输、存储和未来 agent 阅读的总成本。
- 服务维护显式关系、确定性约束和事实展示；AI 负责理解目标、选择背景、判断成果和形成交接。不能仅凭摘要抽取就改授权、关闭任务或启动后续工作。
- 依赖关系是优先考虑的通用能力；批次、交付范围、剩余工作和决策先利用现有说明与引用，反复使用后再决定是否提升为正式字段。不把这些设计方向描述成当前已实现的能力。

本节是后续设计准则，不修改下列现行 API、必填参数、权限或执行行为。

## 十个工具

全部通过同一 MCP。`credential` 是管理员签发的受保护 JSON 文件路径，不是 token 或自报 sessionId。每项变更带稳定 `idempotencyKey`；同 key 同输入返回原操作/结果，换内容返回冲突。字段严格校验；任意命令、目标 caller 重绑定、批量迁移不在 API 中。

| 工具 | 权限 | 关键输入 / 效果 |
| --- | --- | --- |
| work_record | caller | create 只需 title；update 用 taskId/recordRevision 修改标题、说明、来源、意向。零 Cockpit；不能停止或关闭活跃执行。 |
| work_dependency | 两端同属的 caller | add/remove 用后续 taskId、前置 prerequisiteId、后续任务 recordRevision；add 可选前置目标版本和短说明，默认绑定当前正式版本。零派工/通知；read 的 dependencies 视图分页查询。 |
| work_observe | 管理 legacy 的 caller | 带来源登记旧回执，默认只补历史。确认适用当前授权范围才 updateCurrent=true+reason；不能覆盖已 adopt 的执行。零 Cockpit/通知。 |
| work_import | caller | preview/apply 本地私有 staging 中的 manifestId；apply 要匹配 planHash。原始来源、记录变化和原 owner 引用保留，零派单副作用。 |
| work_dispatch | caller | new: workstream/goal/cwd；fork: workstream/goal/sourceSessionId/可选 toEventId；continue: taskId/goalVersion/message。模型默认 gpt-6-astra，可显式 reasoningEffort/contextTier。绑定 caller 来自凭证。 |
| work_read | 作用域内 caller/owner；viewer 全部只读 | 默认 10 简表；board 返回四栏各 10 项，group+before 分栏续页；taskId+detail 获取目标和成果；events/operations 用 before 游标，最多 50。零 Cockpit 读取。 |
| work_report | 绑定 owner | taskId/goalVersion/kind/summary/artifacts；accepted、progress、blocked、needs_decision、result。无 caller 聊天通知。 |
| work_deliver | 绑定 owner | 同版本完整结果，delivered/failed/cancelled；成功交付必须有结果入口。先持久结果，再唯一尝试通知绑定 caller。 |
| work_amend | 绑定 caller | 当前 goalVersion、完整 goal、reason；递增目标/授权版本，清承接和当前成果，旧事件保留；不自动发消息。 |
| work_recover | 绑定 caller | operationId；unknown 必须提供 resolution: applied/not_applied + evidence；确认创建成功还需真实 sessionId。只继续原操作和原 owner。 |

goal 的 objective/scope/acceptance/authorization 都必填。服务不将调查扩成实施，不自动判断“两项目标是否同一”，也不能验证成果真实达到验收；这些仍是用户/agent 的责任。

上述完整 goal 仅在**执行派单**时必填。new/fork 带 taskId+recordRevision 可在同一待办上首次开工；adopt 带这两个字段和完整新授权，只绑定导入记录的原 owner 引用。纯登记不强填 goal，参见 [记录语义](backlog.md)。

## 状态与版本

`recorded → dispatched → active / blocked / needs_decision / result_reported → delivered / failed / cancelled`。

未开工是独立的 `backlog`，历史导入是 `legacy`，两者 goalVersion=0、无 acceptedVersion、无执行绑定。记录 disposition 的 open/deferred/abandoned/archived 不冒充执行状态；active 任务不能由记录编辑关闭。recordRevision 与 goalVersion 分离，显式依赖增删只递增后续任务的 recordRevision。

## 显式前置条件

`work_dependency` 的 `taskId` 是**后续任务**，`prerequisiteId` 是**前置任务**；两端必须都属于当前 caller。除已有凭证、幂等键、后续记录并发版本外，不要求额外业务字段；`prerequisiteGoalVersion` 可选，不填时在事务内绑定前置当前正式版本，`note` 是可选短文本。显式版本必须匹配前置当前目标，不能把过期版本悄悄登记为满足。自依赖、重复、循环和不存在的引用均拒绝，失败不产生部分事件或版本更新。

简表和 detail 的 `conditions` 仅含 ready、total、satisfied、waiting、needsConfirmation。`work_read taskId/view=dependencies` 按 limit/before 展开本任务的直接前置；不复制完整 goal 或逐层展开。关系事实可由后续 owner 读取，但前置标题只在有权读取前置任务时返回；不授予访问其目标、成果、来源或会话的权限。跨 caller 关系禁止，viewer 仍只有读取能力。

- **满足**：绑定的正式 goalVersion 仍为当前版本，并已有该版本的完整 delivered 事件及 delivered 状态；通知是否成功与条件无关。
- **等待**：当前绑定版本尚未成功交付，包括 failed、cancelled、仅 result_reported。没有自动重试或续派。
- **需要确认**：登记时无正式 goal（含 legacy v0），或前置后来 amend。无绑定关系不会自动跟随首次授权，旧版本交付不满足新目标。caller 核对实际含义后显式 remove/add 绑定当前版本；不提供人工伪造 delivered 或阶段表达式。

ready 只表示**记录的直接条件**满足，无前置时为 true；不是执行授权、原生运行就绪或“现在应该开工”。不查询 Cockpit 忙闲，不持久化另一套状态；查询时由当前记录推导。前置变化只使页面通过既有失效事件重读，不递归改下游状态或生成逐层通知。已有决策、暂停、活跃执行和历史完成不被关系编辑覆盖，显式 dispatch/continue 保持既有授权边界，不因依赖硬拦。幂等重放返回原变更回执；需要当前条件时另读 work_read。

使用与两条待有权限 caller 登记的案例见 [任务依赖](task-dependencies.md)。

投递操作另有 running/succeeded/failed/unknown；succeeded 仅表示请求得到基础服务受理。owner 要显式 accepted 当前版本才能报告进度或交付。idle 不是任务状态。目标变更将状态置 recorded，必须新版本承接。旧版本新回执返回 STALE_GOAL；旧幂等重放返回原版本结果，不改新版本。失败/取消同样是完整目标结束，不自动重开。

最终目标状态与通知状态分开。通知超时不会抹掉已交付结果。页面显示待处理操作；owner 不另发最终消息。普通 progress、blocker、decision 不通知 caller；真实问题直接在 owner session ask_user。

## 原子性、冲突、未知结果

SQLite WAL + synchronous=FULL，目标、版本、事件、幂等键和操作建档在同一事务。外部请求前写 inflight，响应后写完成步骤。操作持有任务和相关 session 的持久保留；内核 flock 防两个服务实例对同数据目录运行。服务退出后不会靠超时释放未知保留；启动把遗留 running 转成 failed 或 unknown，不自动重放。

事务不能跨 Cockpit/原生 runtime。窗口“请求已执行、响应未落盘”故意保留 unknown，包括 HTTP 错误可能发生在副作用之后的情况。单次 MCP call **不是**原子事务、exactly-once 外部执行或最终交付。已确认的步骤会复用；已创建 owner ID 保留。创建结果未知时不会猜一个新 owner。

恢复前用公开基础接口做**限定范围**的实际核对，如某个 task marker 的队列/单页事件、明确创建返回。无法核对就问用户。只有确证 applied 或 not_applied 才提交 resolution；证据是操作者声明，服务不把它冒称程序证明。不是“失败就换 session”：那可能让两个 owner 同时执行同目标。

同服务内部串行化；忙且模型不匹配直接失败，不切模/打断。相同模型可 enqueue。模型不匹配且空闲时请求切换，权威回读确认才投递。用户聊天、其它 MCP 和另一基础客户端不持有本服务锁；检查与操作之间仍可能有竞态。这是用户明确接受的内部尽量防冲突边界，不以长锁阻止用户聊天。

实际冷恢复可遇到 Cockpit `MCP connections are still settling`：reload 已成功，但原生连接尚未稳定，toggle 返回 HTTP 500。当前公开接口未完整暴露 host pendingConnections，因此不靠固定 sleep 或宽泛轮询冒称已就绪；如实保留步骤为 unknown，未投递 prompt。通过限定的 MCP 状态和错误原因确认未生效后，再显式恢复原操作。这是已实测的基础接口限制，不能当作新的 owner 或自动重放的理由。

fork 仅使用 Cockpit 正式原生 fork：源须已加载且空闲，拒绝不允许的历史边界由基础服务处理，子 session 不继承执行授权，不能当作配置克隆或 worktree。不复制原生数据库或事件文件。

## 读取成本与保留数据

默认新建且模型匹配：new → get → MCP enable → skill enable → prompt，共 5 次基础 HTTP 调用。模型需要改变再加 setModel + get，共 7。同目标 loaded/matching 4；unloaded 再加 reload + get（6）。已冷恢复的 MCP/skill 必须重新启用。最终通知 1；报告、修订、工作查询 0。

每个操作只保留实际 calls、responseBytes、byIntent，便于测量。**session/get 目前仍是宽接口**，包含原生模型目录、队列等；本项目仅不保存、不回传它们，不能声称底层已经字段投影。没有扫描全历史、轮询同步或缓存原生状态。未来基础服务若提供小型 prepare/get 控制接口，可在独立适配器替换，不加任务语义到 Cockpit MCP。

工作页六栏独立分页；待办按登记顺序，其余按最近事件，避免执行进展挤走旧待办。默认查询未结束，完成历史可搜索。SSE 只发送失效提示，页面按需读本服务数据；断线重连重新读取当前任务，不以漏掉事件为由缓存聊天或轮询原生会话。

只保存 tasks、版本化 goal/授权、有限分页可读的 owner 事件、成果入口、凭证哈希和必要操作信息（含原派单参数及恢复声明）。不保存聊天/模型目录/session snapshots；这些不能作为第二份真相。

## 身份与隐私

服务只监听 loopback；API bearer 鉴权，页面使用仅 viewer 的 HttpOnly/SameSite=Strict cookie。Host/Origin 校验，无 CORS，严格 CSP，不渲染任务 HTML，不加载外部资源。只读入口不会匿名公开任务。远程用 SSH 本地端口转发，不新增公网域名。

管理员本机命令签发 caller 绑定已知 session；服务新建 owner 后签发 task+session 绑定能力，存 0600 文件，派单只含路径；MCP 只接受固定 credentials 根内的规范路径。哈希凭证、角色、归属三者由服务验证。viewer 无写权限，owner 无派单/改目标权限，caller 无 owner 代报权限。

同一 OS 用户/allow-all agent 能读同用户文件，因此不是相互不信任 agent 的强隔离；分两个 MCP 不会解决这个边界。凭证路径不应传播，秘密内容不进源码、MCP config 或日志。完全不可信 agent 应在不同 OS 用户/容器运行并配独立秘密交付，不在此版本暗中承诺。

无自动重试、催工、自动拆任务、模型总结聊天或通知 ACK 链。skill 指导规范，服务仅校验它实际知道的权限与转换，不能强制 agent 遵循所有自然语言边界。
