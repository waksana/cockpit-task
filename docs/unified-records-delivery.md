# 统一任务记录交付（2026-09-10）

运行代码：`49bc7150ed7f`，服务 v1.1.0 / SQLite schema 2。入口 http://127.0.0.1:8790/ ，仅 loopback，viewer 登录后只读。常驻运行和接入见 [operations.md](operations.md)，记录/授权语义见 [backlog.md](backlog.md)。

## 真实迁入范围

原阿来 `memory/tasks.md` 的 62 条任务账本行及 `memory/cockpit-history.json` 的全部 70 个历史目标，展开聚合目标并保留同目标多来源后，合计 **187 条来源记录、127 个独立目标**。6 条项目/讨论概览未强造任务，原文、排除理由及盘点元数据保留在私有快照。未读取原生完整聊天或私人会话数据库。

导入观察分布：94 已结束、3 取消、10 待办、8 暂缓、2 在途、1 待决定、9 未知。它们均为历史观察，不是刚查询的实时会话状态。没有导入后自动派工、消息、模型或 MCP 操作；未增加执行凭证、重置原生 owner 或改历史 caller 引用。

迁移清单：`65994018671fdf60789d6cb50467c098ebb8470fe2419fcae27b4af87a523040`。数据内保留三份完整快照：两份实际来源及含来源定位/覆盖关系/歧义说明的盘点文件。私有准备产物位于 `.local/migration/`，不提交 Git；真实导入前备份为其中 `pre-import-live.db` 和 `pre-import-credentials.tar`。

阿来 `memory/tasks.md` 已切为服务入口；原文件只读归档在同目录 `archive/tasks-49b37db55b00cca2-6cc862e0-0f7d-423e-826b-3c3b9d9b8760.md`。AGENTS、README、记忆/维护指南和必要记忆引用已改为只写服务，不再维护 Markdown 任务状态。切换保留源哈希检查及并发写入拒绝。

## 关键记录与边界

| 工作 | 服务 taskId | 保留的观察 |
| --- | --- | --- |
| work-commander-toolkit | eeb65bbd-d08e-4339-a0c3-724a708b1cf7 | 本目标的旧通道记录；最终回执由实际 caller 用 work_observe 登记，不制造第二个 owner |
| cockpit-minimal-native-usage-review | b95bf16f-0488-4331-b1a9-a66d7c9c12a6 | 捕获迁移准备期间更新的 22:33 回执：6026294 代码已交付但未部署，线上未交付；不自动续派 |
| session-reasoning-capability-fallback | 4a1a2e7e-a7d2-41ec-a3b1-b3d469dd2fd0 | 7ab1983 代码完成，用户明确暂不上线 |

CI/CD 和三项旧清理没有足够来源证明最终闭环，保留未知及后继换代证据，不把旧 PID 阻塞冒充当前运行事实，也不擅自标完成。微信未知发送仍暂停。没有触碰其它 owner 的源码、会话或部署。

## 实际闭环

隔离 Astra caller 先以一句话登记、暂缓、恢复，再在同一 taskId `46b5679c-0347-48f0-b481-8c548bf0bfad` 明确授权开工。登记阶段没有 operation；首次执行版本为 1，只建一个 owner，最终产物中的 taskId 与原登记相同；进展不通知，最终仅一个成功通知。测试 caller/owner 已卸载，历史保留。

影子库及真实导入均逐条核对原文/哈希，原任务字段、credentials、operations、versions 未变；重复导入 187 条均 unchanged、无新增事件。已有测试覆盖记录 CAS、目标版本、未知恢复、历史观察不覆盖新实现、原 owner adopt、所有权不清时拒绝新建替代者、schema 升级和并发源变更。

浏览器实际呈现六栏、历史 owner 引用与暂停说明；原始来源可展开，按成果提交号搜索只得到对应任务，桌面和移动视口无横向溢出。页面仍无写权限。

## 使用

讨论方启用独立 `work-commander` MCP/skill，工具为 9 个；原 `work-owner` 全局定义未改。实际 caller `8d3fc61c-10a6-4cf1-9a00-07346b6514e7` 已在空闲窗口完成原生 MCP 重载，再单独启用 work-commander，连接成功；没有中断其工作。`work_read(workstream: ..., view: "detail")` 定向读取，默认未结束，`includeClosed=true` 查历史，`sources` 按需展开。原来加载旧 MCP 的讨论方必须在空闲时重载连接，再启用该 MCP；不打断忙会话。

导入不是 execution binding：旧通道最终回复仍到原 caller，讨论方带来源和 recordRevision 用 `work_observe` 保存。仅确认与当前授权相符才 `updateCurrent=true`，不能以旧研究回复覆盖新实现。未来业务开工须明确授权；旧 owner 不因迁移而被换人或唤醒。
