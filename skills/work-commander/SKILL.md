---
name: work-commander
description: 统一管理待办、任务和历史记录的讨论入口。一句话登记零副作用，同 taskId 明确授权后开工；记录版本与执行版本分离，旧 owner 引用不冒充绑定，旧回执有来源登记，不巡查或自动续派。
---

# 讨论方：明确目标，交给一个 owner

具体问题立即有限调查，明确要求按真实范围完整执行；调查不自动升级修复。闲聊不造任务，高风险副作用、重要取舍、关键缺口才问用户。普通工程步骤不逐步审批。

一项独立验收目标一个 owner session。同目标调查、实现、修正、返工继续原 task/owner；新独立目标显式 new 或已确认真实可用的 fork，不按 cwd、标题或 idle 复用。fork 继承背景，不继承旧授权、回执义务或工程隔离。讨论方不执行工程，不增加 commander agent、协调 owner 或常驻角色池。

## 使用

操作前取得管理员签发、绑定**本讨论 session** 的 credential 文件路径；它是授权凭证，不是任意自报 sessionId。不要读取/打印 token，不猜别的凭证路径。工具 `credential` 参数传文件路径。MCP 是同一个 `work-commander`，服务按凭证划分 caller/owner 权限；拆成两个 MCP 不会提供额外身份保证。

- 只想记一下：`work_record` action=create，只需 title 和 idempotencyKey。没有技术 slug 也可登记，不要求四段授权、cwd 或模型，不创建 session。闲聊仍不自动造待办。
- 改标题/说明、暂缓或放弃未开工记录：action=update，传 taskId、recordRevision；disposition 为 open/deferred/abandoned/archived，非 open 必须写 reason。记录操作零 Cockpit 调用，不等于停止 agent 或撤销副作用；活跃执行受保护。
- 现在做已有待办：`work_dispatch` selection=new/fork，带**原 taskId、recordRevision**和完整 goal 的 objective/scope/acceptance/authorization、cwd 或 sourceSessionId，保持同一身份。可补定 workstream。没有已登记项时仍可直接完整派单。默认 GPT-6 Astra；不静默降级。新建不是 worktree，隔离由 owner 负责。
- 同目标继续：传 selection=continue、taskId、goalVersion、message，不新建 session。目标/授权变化先 `work_amend`，得到新版本后显式 continue；修订本身不投递、不自动开工。
- 导入旧工作未来确需执行：先按需读 detail/source，明确新授权，再 selection=adopt，以原历史 owner 引用建立正式绑定，绝不为旧目标 new 第二个 owner。历史一个 owner 多目标仅保留引用；若正式绑定冲突，直接和用户解决，不放宽新任务规则。
- 按需 `work_read` 默认只读未结束简表，query 搜索、workstream 精确定位，includeClosed=true 查完成历史；详情/来源/事件/操作按需分页。board 为六栏，待办按登记顺序显示。历史观察不是原生实时状态，投递受理也不是承接或交付。
- 每次逻辑变更选稳定 idempotencyKey；重试必须同 key/同输入。冲突先读取。超时、未知副作用不得换 key 或换 session 再派；保留真实已创建 owner，通过 work_read operations 查失败步骤。只有核实后的证据才用 `work_recover`；无法核实直接问用户，不猜 not_applied。
- 本服务内部串行化冲突，不锁住用户聊天。忙且模型不匹配时停止切模和投递；相同模型可排队。外部并发不是跨服务原子事务。

## 唯一账本与回复

任务记录统一由服务管理，包括待办与已批准迁入的历史；切换后的 tasks.md 仅是入口和只读归档引用，**不再写 Markdown 任务状态**。未批准的其他来源不得自行导入。导入是记录整理，既不授权业务继续，也不改旧 owner 的运行、回复和暂停边界。

导入状态标为 legacy、goalVersion=0，ownerRef/callerRef 只是历史引用；管理 caller 是本讨论，不能把历史引用当能力凭证，也不能假造 accepted/delivered 事件。收到尚未接入服务的旧 owner 回执，用 `work_observe` 记录 taskId、recordRevision、observedState、observedAt、summary、source 和成果入口；默认只补历史。确认回执适用于**当前授权范围而非旧阶段**后，才加 updateCurrent=true 和 reason 更新当前观察。无需冒充 owner、启动会话或通知对方；已经正式 adopt 的目标不能用旧观察覆盖当前执行。

代码按当前授权交付而上线暂缓，要同时保留交付范围和未授权发布的事实，不能泛化成已上线，也不能自动派发布。元数据用 recordRevision；真正执行目标/授权变化才用 goalVersion/amend。

重要进展直接在服务/页面展示，不唤醒讨论方。owner 的真实决策在其自己的 session 问用户。收到服务最终通知，核对 taskId/goalVersion；旧版本不得覆盖新授权。简要向用户说明真实结果；信息够就不回读聊天，不回 ACK、不自动续派、不做定时催工。任务完成由 owner 明确交付，服务不替它判断验收真假。

这是 work-owner 两层规则的服务化入口；不修改或重新解释旧任务派单。在本服务任务中，最终通知由 work_deliver 唯一发送，owner 不再另发相同消息。
