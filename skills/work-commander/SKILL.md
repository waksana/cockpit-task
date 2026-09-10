---
name: work-commander
description: 两层协作的讨论入口。用独立工作服务显式派单和按需查询，同目标原 owner、新目标新建或真实 fork；服务保存版本化任务，最终通知由服务唯一发送，不巡查、不阶段续派。
---

# 讨论方：明确目标，交给一个 owner

具体问题立即有限调查，明确要求按真实范围完整执行；调查不自动升级修复。闲聊不造任务，高风险副作用、重要取舍、关键缺口才问用户。普通工程步骤不逐步审批。

一项独立验收目标一个 owner session。同目标调查、实现、修正、返工继续原 task/owner；新独立目标显式 new 或已确认真实可用的 fork，不按 cwd、标题或 idle 复用。fork 继承背景，不继承旧授权、回执义务或工程隔离。讨论方不执行工程，不增加 commander agent、协调 owner 或常驻角色池。

## 使用

操作前取得管理员签发、绑定**本讨论 session** 的 credential 文件路径；它是授权凭证，不是任意自报 sessionId。不要读取/打印 token，不猜别的凭证路径。工具 `credential` 参数传文件路径。MCP 是同一个 `work-commander`，服务按凭证划分 caller/owner 权限；拆成两个 MCP 不会提供额外身份保证。

- 新目标：`work_dispatch`，明确 selection=new/fork、workstream、goal 的 objective/scope/acceptance/authorization、cwd 或 sourceSessionId。默认 GPT-6 Astra；不静默降级。caller 由凭证确定，无需手写 caller。新建不是 worktree；隔离责任交 owner。
- 同目标继续：传 selection=continue、taskId、goalVersion、message，不新建 session。目标/授权变化先 `work_amend`，得到新版本后显式 continue；修订本身不投递、不自动开工。
- 按需 `work_read` 默认只读简表；详情选 taskId/view=detail，事件或操作分页取。任务状态不是会话 busy/idle。操作 succeeded/投递受理不等于 owner 承接，更不等于交付。
- 每次逻辑变更选稳定 idempotencyKey；重试必须同 key/同输入。冲突先读取。超时、未知副作用不得换 key 或换 session 再派；保留真实已创建 owner，通过 work_read operations 查失败步骤。只有核实后的证据才用 `work_recover`；无法核实直接问用户，不猜 not_applied。
- 本服务内部串行化冲突，不锁住用户聊天。忙且模型不匹配时停止切模和投递；相同模型可排队。外部并发不是跨服务原子事务。

## 唯一账本与回复

只读写**本服务显式管理的新目标**；旧 tasks.md 继续是旧任务唯一账本，不双写、不批量迁移或复活。切换旧账本需用户明确确认。

重要进展直接在服务/页面展示，不唤醒讨论方。owner 的真实决策在其自己的 session 问用户。收到服务最终通知，核对 taskId/goalVersion；旧版本不得覆盖新授权。简要向用户说明真实结果；信息够就不回读聊天，不回 ACK、不自动续派、不做定时催工。任务完成由 owner 明确交付，服务不替它判断验收真假。

这是 work-owner 两层规则的服务化入口；不修改或重新解释旧任务派单。在本服务任务中，最终通知由 work_deliver 唯一发送，owner 不再另发相同消息。
