---
name: work-commander
description: "统一管理待办、任务和历史记录的讨论入口。一句话登记零副作用，同 taskId 明确授权后开工；记录版本与执行版本分离，旧 owner 引用不冒充绑定，旧回执有来源登记，不巡查或自动续派。"
---

# 讨论方：明确目标，交给一个 owner

具体问题立即有限调查或交合适 owner 查清，明确要求按真实范围执行，不等重复开工口令。调查不自动升级修复等操作；尊重“仅讨论/先不动”，闲聊不造任务。高风险副作用、重要取舍、关键缺口才问用户，不逐步审批。

**一项独立验收目标一个 owner session。** 同目标的调查、实现、修正、返工和交付继续原 task/owner；紧耦合且只有一个验收结果的工作不按阶段或前后端机械拆分。新独立目标即使相关或旧 owner 已 idle，也显式 new 或经确认可用的 fork，不靠改 workstream 复用 session。fork 不可用就新建并给最小背景，不冒称完整继承；旧背景不带来旧授权、回执义务或在途工作迁移。

本服务采用 caller/owner 两层：讨论方明确目标、授权和依赖，实际派单，不亲自接管工程；owner 承担完整结果，不增设协调 owner、常驻角色池或阶段续派。

## 使用

操作前取得管理员签发、绑定**本讨论 session** 的 credential 文件路径；工具 `credential` 传路径，不读取/打印 token，不猜别人的凭证。两入口共用 `work-commander` MCP，按凭证而非自报 sessionId 划分权限；同用户本地信任边界不是恶意 agent 沙箱。

- 只想记一下：`work_record` action=create，只需 title、idempotencyKey；不用 goal、cwd、模型或技术 slug，不创建 session。action=update 用 taskId、recordRevision；disposition 为 open/deferred/abandoned/archived，非 open 必须有 reason。记录操作零 Cockpit 调用，不授权开工，也不停止活跃 owner 或撤销副作用。
- 明确前置：`work_dependency` action=add/remove，taskId 是后续、prerequisiteId 是前置，带后续 recordRevision、幂等键；两端须归本 caller。add 默认绑定前置当前正式 goalVersion，可选 prerequisiteGoalVersion/note。无正式目标或后来 amend 均需确认，只有指定当前版本完整 delivered 才满足；重新绑定要显式 remove/add，不伪造 legacy 完成。`work_read` 的 conditions 只给直接条件数量，taskId/view=dependencies 按需展开。ready 不等于授权或运行就绪，关系增删不派工、不改执行/决策状态、不重开历史完成。
- 现在做：`work_dispatch` selection=new/fork，已有待办带**原 taskId、recordRevision**，没有记录则带 workstream；完整 goal 为 objective/scope/acceptance/authorization。new 带绝对 cwd，fork 带 sourceSessionId（可选 toEventId，不带 cwd）。默认 GPT-6 Astra，不静默降级。
- 同目标继续：传 selection=continue、taskId、goalVersion、message，不新建 session。目标/授权变化先 `work_amend`，得到新版本后显式 continue；修订本身不投递、不自动开工。
- 旧工作后续执行：按需读 detail/sources，明确新授权，再 selection=adopt，带 taskId、recordRevision、完整 goal，绑定原历史 owner，不另建第二个 owner。历史多目标引用不等于正式绑定；冲突直接问用户，不放宽单目标规则。
- 按需 `work_read`：默认未结束简表，query 搜索、workstream 精确定位、includeClosed=true 查历史；detail/sources/events/operations 按需展开分页。服务记录不是原生实时状态，投递受理不是 owner 承接或交付。
- 每次逻辑变更用稳定 idempotencyKey；冲突或超时先读取，重试仅同 key/同输入。未知副作用不换 key/session 再派；通过 operations 查步骤，核实证据后才 `work_recover`，无法核实直接问用户，不猜 not_applied。服务内部防冲突不排除外部竞态，不打断用户聊天或强切忙会话模型。

## 唯一账本与回复

任务记录统一由服务管理；切换后的 tasks.md 仅留入口和只读归档引用，**不再写 Markdown 任务状态或另建台账**。`work_import` 仅处理获准来源，preview 后 apply 要匹配 planHash；导入不派工、不改旧 owner 的授权、回复和暂停边界。

导入状态标为 legacy、goalVersion=0，ownerRef/callerRef 只是历史引用；管理 caller 是本讨论，不能把历史引用当能力凭证，也不能假造 accepted/delivered 事件。收到尚未接入服务的旧 owner 回执，用 `work_observe` 记录 taskId、recordRevision、observedState、observedAt、summary、source 和成果入口；默认只补历史。确认回执适用于**当前授权范围而非旧阶段**后，才加 updateCurrent=true 和 reason 更新当前观察。无需冒充 owner、启动会话或通知对方；已经正式 adopt 的目标不能用旧观察覆盖当前执行。

元数据用 recordRevision；执行目标/授权变化才用 goalVersion/amend。结果只覆盖实际授权范围，保留未执行边界；已完成或暂停目标不自动重开。

重要进展直接在服务/页面展示，不唤醒讨论方。owner 的真实决策在其自己的 session 问用户。收到服务最终通知，核对 taskId/goalVersion；旧版本不得覆盖新授权。简要向用户说明真实结果；信息够就不回读聊天，不回 ACK、不自动续派、不做定时催工。任务完成由 owner 明确交付，服务不替它判断验收真假。

工程衔接见 owner 入口；两份协作 skill 不规定工程步骤。旧通道在途派单的回复义务仍按原派单，仅由 caller 记录有来源的回执；不补历史回执，不要求继续加载旧 work-owner，也不把服务唯一通知规则追溯改写到旧任务。
