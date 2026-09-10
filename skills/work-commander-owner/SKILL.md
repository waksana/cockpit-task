---
name: work-commander-owner
description: work-owner 两层规范的服务化 owner 入口。单独完整目标单 owner，自主隔离实施；用版本绑定凭证向服务报告重要进展、结果和交付，真正受阻在本 session 问用户，服务唯一通知 caller。
---

# Owner：接完整结果，对结果负责

以当前派单的 taskId、goalVersion、owner、caller、目标和授权为准。先理解最小背景，不加载讨论便签或全历史；引用旧事实需甄别时效，不继承 fork 中旧授权、不重演旧副作用/回执。

一项独立完整目标由本 session 承担到底。普通排错、实现、集成、交付自主完成，不把设计、某个阶段、turn idle、API 受理当完整完成；不等讨论方逐阶段续派。不同独立目标不能复用本 owner；专业工具可辅助但不转移责任。

## 承接与报告

使用派单里的受保护 credential **文件路径**，不要读取、展示 token 或猜别人的文件。服务按真实签发的能力凭证校验任务/session 归属，不接受 payload 自称 owner。相同 OS 用户仍能读取同用户文件：这是单用户信任边界，不是恶意 agent 沙箱。

1. 必要时 `work_read` taskId/view=detail，确认目标版本和授权。用 `work_report` kind=accepted 承接当前版本；已接受则不重复 accepted。
2. 实际推进目标。仅重要进展 kind=progress，受阻 kind=blocked，需要真实决策 kind=needs_decision；真正需要用户时在**自己 session** 用 ask_user，得到回答继续。报告写入服务和页面，不聊天通知 caller、不通过代理转送。
3. 可用 kind=result 记录阶段成果，状态是 result_reported，**不是最终交付**。结果入口用原产物、文件路径、会话入口；不要求额外报告文件、百分比或工具流水。
4. 完整目标结束才 `work_deliver`：outcome=delivered/failed/cancelled，真实 summary 和结果入口 artifacts。服务先落最终结果，再尝试向绑定 caller 唯一投递；本 session 正常交付即可，**不再直接 send_prompt 发最终回复，也不发 ACK**。失败/未知通知不抹掉交付事实，不自行补发。

每次逻辑报告用稳定 idempotencyKey。超时先按需读取或同 key/同输入重试，不重复实际工程副作用。收到 STALE_GOAL 不把旧完成改写成新版本完成；读新目标，确认并承接后继续。服务短暂不可用不重跑工程，恢复后补本次真实重要事实。不要承诺服务能强制 agent 正确工作或证实验收。

## 工程与权限

必要隔离由 owner 判断并完成；同仓并行或共享目录冲突必须独立 worktree 或可靠等价隔离，正确基线、验证、集成和收尾都属于同一完整目标。新建/fork session 不隔离文件、数据库或部署；只读/非 Git 不机械造 worktree。不能覆盖他人修改、强推或清理未知资源。

调查不自动升级修复/部署/交易；重要取舍、权限缺口、风险升级直接问本 session 用户，不让 caller 中转。已完成或暂停的目标不自动重开。服务只防内部派单冲突，用户可直接聊天；不擅自打断用户消息或强制切忙会话模型。

运行环境交付须确认实际健康版本与目标行为，提交/构建/发布受理不够。未知副作用先核对，不盲重放。无需额外台账/检查点平台，成果放真实产物和正常会话。
