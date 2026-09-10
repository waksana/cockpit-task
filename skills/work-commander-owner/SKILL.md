---
name: work-commander-owner
description: Work Commander执行方协作入口。一项独立完整目标一个owner，同目标调查、实现、修正和交付负责到底；按授权版本报告重要进展，真实决策在本session问用户，服务唯一通知caller。
---

# Owner：接完整结果，对结果负责

以当前派单的 taskId、goalVersion、owner、caller、目标和授权为准。先理解最小背景，不加载讨论便签或全历史；引用旧事实需甄别时效，不继承 fork 中旧授权、不重演旧副作用/回执。

**一项独立完整目标由本 session 承担到底。** 同目标的调查、实现、修正、返工和交付不按阶段等续派；紧耦合且只有一个验收结果的工作不机械拆分。不同独立目标即使相关或本 session 已 idle，也不能复用本 owner，应由 caller 明确另行派单；专业工具可辅助但不转移责任。

owner 负责完整结果并遵守目标项目的工程/运行规范（Git 服务开发按需用 `/service-development`）；任务绑定或新建/fork session 不等于完成工程隔离，也不授予额外权限。

## 承接与报告

使用派单里的受保护 credential **文件路径**，不读取/展示 token、不猜别人的文件。服务按凭证校验任务/session 归属，不接受自称 owner；这是单用户信任边界，不是恶意 agent 沙箱。

1. 必要时 `work_read` taskId/view=detail，确认目标版本和授权。用 `work_report` kind=accepted 承接当前版本；已接受则不重复 accepted。
2. 实际推进目标。仅重要进展 kind=progress，受阻 kind=blocked，真实决策 kind=needs_decision；需要用户时在**自己 session** 用 ask_user，得到回答继续，不让 caller 中转。报告只写服务/页面，不聊天通知 caller、不通过代理转送。
3. kind=result 可记录部分成果，状态 result_reported，**不是最终交付**。不把方案、某个阶段、turn idle 或 API 受理当完整完成。仍受依赖阻塞时如实 blocked，不以部分成果结束完整目标。
4. 完整目标结束才 `work_deliver`：outcome=delivered/failed/cancelled，真实 summary；成功交付必须有 artifacts 结果入口。服务先落结果，再唯一尝试通知绑定 caller；本 session 正常交付，**不另发最终消息或 ACK**。失败/未知通知不抹掉结果，不自行补发。

每次报告带 taskId、goalVersion、稳定 idempotencyKey。超时先按需读取，重试仅同 key/同输入；未知副作用先核对，不盲重放。遇 STALE_GOAL 读新目标与授权，承接后继续，不把旧完成改写为新版本完成。服务短暂不可用不重跑实际工作，恢复后补真实重要事实。

待办/导入不是授权：goalVersion=0、legacy ownerRef 不表示服务派工；须显式派单和绑定 owner 凭证。recordRevision 元数据变化不使已承接的 goalVersion 失效。

需要前置背景时按需读本 task 的 conditions 或 `work_read taskId/view=dependencies`，不遍历其它任务。ready 只指直接记录条件满足，不是授权或原生运行就绪；failed/cancelled 不是满足，未绑定正式目标或前置 amend 需 caller 核对。关系编辑不改变当前执行、暂停或决策，不能凭 ready 自动开工/续派；新关系也不会撤销已有承接。owner 不能增删关系、冒充 caller 或获取其凭证，仍只按真实目标报告进展与结果。

旧通道在途目标继续原派单的最终回复义务，无需加载旧 work-owner；不因入口退役或记录迁入而补历史回执、取用 caller 凭证、新建 owner 或重开任务。caller 用 `work_observe` 登记有来源的旧回执；不能把旧观察冒充本服务 accepted/delivered。

## 授权与结果

调查不自动升级修复等操作；重要取舍、权限缺口和风险升级直接问本 session 用户，不重复索要已有授权，不自行扩大范围。结果说明保留未执行边界，不把局部交付泛化为完整完成。

已完成或暂停目标不自动重开，记录“暂缓”不等于停止模型或撤销已发生操作；不擅自打断用户聊天。服务不替 owner 判断验收真假。

正常会话和实际产物即可，不要求额外台账、检查点、固定报告、百分比或工具流水；不设固定报告频率或催工链。
