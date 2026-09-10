# 同一工作：想到 → 明确授权 → 执行 → 交付

`work_record create` 只需一句 title、稳定 idempotencyKey 和已有 caller 凭证路径。服务生成 taskId/workstream，保存为 backlog，goalVersion=0；不建会话、不切模型、不通知、不生成假授权。可加 notes/sources，不引入期限、优先级、估时或提醒。

`work_record update` 用 taskId+recordRevision，编辑标题/说明或将未执行记录 deferred/abandoned/archived；非 open 需 reason。这些是记录意向，不是停止模型、关闭执行或回滚副作用。活跃/未知派单受保护，元数据改名不使 owner 已接受的 goalVersion 失效。

需要开工时，在同 taskId 上 `work_dispatch new/fork`，给 recordRevision、完整 goal 和 cwd/真实 fork 来源；不再创建第二条任务。失败/重复沿原 operation 恢复。同目标后续仍 continue 原 owner；明确改变执行目标/授权才 amend。

## 两种版本

- **recordRevision**：元数据、导入观察和有来源的历史补充发生改变时更新，防旧编辑覆盖新记录。
- **goalVersion**：完整执行授权的版本；首次真实派单为 1。标题/备注变化不自动递增它；acceptedVersion 必须对应当前执行版本。

任务 `status` 保留真实执行状态；记录 `disposition` 保留意向。比如代码按授权交付后可记录发布暂缓及理由，并不等于已经上线或自动获得发布授权。

## 旧记录不是假装执行过的原生任务

schema v2 在原 7 表上增加 3 表：

| 表 | 内容 |
| --- | --- |
| legacy_records | 历史 owner/caller 引用、观察时间/状态、授权说明与覆盖关系；不占用 tasks.owner 的正式唯一绑定 |
| legacy_sources | namespace+稳定 sourceKey、原文、哈希、最后导入的记录版本和快照关联 |
| import_snapshots | 不可变任务来源文件快照；旧源被替换也不丢原记录 |

原 tasks/credentials/operations 的身份和检查点不重置。历史同一 owner 的多项任务全部保留为引用；正常新任务仍受 owner UNIQUE 约束。

旧任务未来真正继续：caller 先核对原授权/暂停和来源，以完整当前授权显式 `work_dispatch adopt`，只采用原 ownerRef。生成当前执行版本/owner 凭证后才进入服务派单流程。不在导入时给旧 owner 批量发消息或配置工具。若原 owner 已正式绑定另一个目标、归属不清或与 caller 相同，返回明确冲突，不能放宽规则或悄悄换人。

## 在途旧回执

旧通道 owner 不需要冒充服务 owner 或获取 caller 秘密；按原派单向实际 caller 回复。讨论方用 `work_observe`（taskId、recordRevision、observedAt、observedState、summary、source、artifacts）登记来源，事件类型为 legacy_observation，**不是 accepted/delivered**。

默认只保留历史；确认消息对应当前授权范围而非旧研究阶段，才显式 updateCurrent=true 并说明 reason。已正式 adopt 的执行只允许附历史，不能借旧回执改当前状态。时间和事实依赖明确来源/调用方判断，服务不通过遍历聊天伪造实时证明。

## 查询与展示

默认 work_read 返回未结束任务；workstream 精确定位、query 搜标题/说明/摘要，includeClosed=true 查历史。board 为待办、执行、受阻、待决定/确认、暂缓、完成历史六栏，分别分页。detail 的 goal 可以为 null；sources 分页展示原文，历史 owner 链接明确标为“引用，未绑定”。

viewer 仍只读。所有登记、编辑、观察、查询和导入均零 Cockpit 调用，只有显式派工/通知才跨基础服务。没有自动续派、日程、广播或 Markdown 状态双写。
