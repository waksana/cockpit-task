# Task MCP 与角色 Skills

唯一角色 `node` 注入 [Node](../roles/task-node.md)、Task 工具及两个原生 Skill
发现目录：[cockpit-task-tree](../skills/cockpit-task-tree/cockpit-task-tree/SKILL.md)
和 [github-coding](../skills/github-coding/github-coding/SKILL.md)。
Node 是短责任模型和加载入口；Task Skill 指导判断；工具 schema 定义字段、权限、
限额和恢复。工作方法不另造角色、Task 类型或授权。

## 1. 关系定位与初始化

`assignee` 是 Task 唯一直接绑定。`parent_assignee` 从 parent 绑定派生；
`created_by` 是历史而非控制者。没有 parent 的 root 仍是普通 Task，
没有树外 owner 或 root 专用模式。读取返回 `actor_role`；工具全集可见不代表每个操作都允许。
宿主 invocation 决定 caller；MCP 调用者不能自填 actor 冒充别人。

已授权新责任可登记 ordinary root，用 `task_claim` 承接；Web user 也可外部指派。
自己承接不自发消息、不改标题、不要求调用中 session idle。当前 parent 的 assignee
为 child 准备另一 capable session 后 `task_assign`。登记/准备/绑定/消息/ACK 都不开始工作。
claim 可承接 blocked root 以澄清；Node 能力就绪不是 Task ready。
读取完整 execution、ACK 当前 revision 后，以 `task_start` 原子选择方式并进入 in_progress。
todo 只澄清与轻发现；不能直接 done 或以 report 开工。

## 2. 两种履责方式，都可用 helper

| 方式 | 实际工作 |
| --- | --- |
| execute | 直接研究、实现、审阅并交付 |
| orchestrate | 拆分更具体责任、接口/依赖安排、处理阻塞、必要判断与结果整合 |

两种方式均可用内部 helper；调用者整合结果，helper 不取得独立责任。
是否创建 child 取决于独立持续交付责任，不是工具名或调用次数；
独立 review 不强制新 Task/session，不以 Task 数量或新 session 为目标。
orchestrator 可为协调判断轻调研，但持续实施/深度专项调查交给 child。
执行中需要独立分解，先 `task_convert` 记录原因、已完成/剩余责任，再创建更具体 child，
保留原 Task 和 assignee，不原样转包，不降级或同步 native interaction mode。

## 3. 共同记录与直接用户决策

description 写本项工作特有的目标、决定、约束与结束要求；外部材料引用，
不复制通用流程或历史。activity 写重要变化，outcome 写实际交付、遗留和证据。
正式节点之间只通过 Task 与服务通知协作，不能直接或借 helper 传话。
用户可直接与任意节点沟通，面对决定者直接问，避免重复问题；答案改变约定要写回 Task。
父处理跨责任事实，而非代问或第二次审批用户已决定的问题。

自己缺少范围外前置时，原子增加具体 `{condition}`，非阻塞需要留在 outcome。
自己获得满足证据后用 `task_resolve_condition` 及精确 dependency_id 解除；
不能用普通编辑删条件、借此删除 Task-ID blocker 或改变条件含义。
任务依赖等 done，不等成功；cancelled 不解除，reopen 不复活旧解除关系。
子包含关系不自动成为 blocker。

## 4. 收口、取消、返工

父 done 和最终 cancelled 都等所有直接 child 终态。子 cancelled 不是成功，
父需据实际成果完成自己的约定、满足前置并写新 outcome/显式 retro；
有用子 retro 纳入整体回顾，无发现用 null，不编造证据或耗时。

Agent `task_cancel` 是意图。暂停目标进展，读/ACK、编辑、记录活动并组织善后，
child 全终态后 `task_cancel_finalize`。绑定者 finalize，未绑定者由 Web user 办理。
无级联，不先终结协调者；最终取消不要求放弃目标的前置或 ACK，不等于外部退出或回滚。
祖先仍有绑定且 active orchestrate 时，祖先意图/blockers 不阻止既有 child done 收口；
自己的意图仍禁止自己的 done，自己的当前 ACK、ready、成果与子终态要求不变。
长期 root 可空闲，不自动结束或找新活。

用户授权返工时 `task_reopen` 保留原 session 与方式，遵守原指派序号、未有后续指派、
无其他未结束责任及就绪条件。祖先先合法恢复；cancelled/不合格祖先不能自动替换。
旧结果变历史，不恢复订阅、旧 blocker 或旧 ACK 的效力；未知 legacy mode 拒绝 reopen，
没有 schema12 后的 mode-repair API。历史 mode 选择仅限审阅的 11→12 迁移，不补造 start。
增加 parent 用 `task_attach`，保留原 root 的绑定/范围/子树/历史；
另一 session 承担 active orchestrate parent，无固定三层上限，仍检查防环和资源界限。

## 5. 读取、通知和恢复

开始、恢复、重要操作和交付前完整读 execution、精确 ACK，处理 definition_check。
其他判断用 overview include 选所需完整组：context、activity、outcome、retro、
definition、automation、cancellation；历史、祖先、直接子项按需分页，不递归拉整树。
child/依赖更新按当前 parent/binding 路由，通知只是 `task:` 指针。
取消请求卡为 `[Task cancellation requested]`，旧 `[Task cancelled]` 仍可识别；
先读当前 cancellation_request/cancellation，不仅靠旧标签判断。
完整事件见 [MCP](task-mcp-contract.md#通知投递证据)。

默认不订阅、不轮询。只有未来状态解锁自己必要行动才注册一次性等待；
过时则取消，不自动续订或等待读回确认。Web user 要显式 subscriber session，
不从创建者猜测。投递前关系已变时记录未发送，不偷偷改投或重试。

<a id="通用响应"></a>

result / error 描述原操作效果；definition_check 在响应检查点独立刷新；
notifications / notification_error 与已保存效果分开。检查 unavailable 不等于未变化。
未知/失败先读 operation 或 Task，稳定 request_id 重放原输入，新写入使用当前 write_context。
Main/helper 共用调用 session 的回执空间；其他 session 可用相同 ID。
只有 final assignment=applied/message=not_sent 的回执才可按契约恢复固定发送；
pending/unknown/queued/accepted 不可。不能换 Task、换 session 或私写状态绕过。

## 6. 工作方法及特殊流程

GitHub coding 在 execute 下落实仓库变更：自行建立隔离 worktree、验证、独立审阅、
授权内 PR/merge，合并后安全清理；parent 只陈述本项要求与整合，不接管环境。
仅部署既有产物不被编码 Skill 强制 Issue/PR；混合交付保留同一约定，范围变化直接问用户。
main 合并的自动 Rolling 由项目发布契约决定；部署/重启/数据迁移仍需另行授权。

可信现有脚本按需读 [automation reference](../skills/cockpit-task-tree/cockpit-task-tree/references/automation.md)：
不可变登记、create、必要订阅、显式 start；不为了绕过 Agent 责任临时造脚本。
无 Agent 模式/ACK/report，失败 done 不证明目标成功，取消/reconcile 保留进程组屏障。

Skill 启用不等于正文加载，MCP connected 不等于工具 offered。首次需要才加载；
上下文仍在时复用，不假定 child 继承父上下文。工作前核实可变 Task，不能用重读
稳定 Skill 代替。两层 Skill 独立闭包，不依赖仓库 docs 或评估资源。
