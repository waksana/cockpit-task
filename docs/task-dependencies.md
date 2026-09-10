# 轻量显式任务依赖

关系由 AI 明确选择，服务不从自然语言抽取或自动执行。`taskId` 依赖 `prerequisiteId`；仅同一管理 caller 可增删。`work_dependency` 是一个操作，action 为 add/remove；后续任务 recordRevision 和稳定 idempotencyKey 沿用现有并发/幂等契约。可选 prerequisiteGoalVersion 默认取前置当前正式版本，可选 note 最多 1000 字符，不要求重复摘要、目标或授权。

查询用 `work_read`，简表/详情有精简 conditions，明细用 taskId + view=dependencies，limit 默认 10、最大 50，nextBefore 续页。没有反向批量编辑、自动调度、自动续派、阶段条件、人工完成开关或新的任务账本。

| 条件 | 含义 |
| --- | --- |
| satisfied / delivered | 绑定的当前正式版本已完整 delivered，通知结果不影响满足 |
| waiting / not_delivered | 当前绑定版本未完整交付；failed/cancelled 也不算满足 |
| needs_confirmation / no_bound_goal | 登记时没有正式授权版本，包括 legacy，即使历史观察为 done |
| needs_confirmation / goal_changed | 前置目标发生 amend，旧交付不再适用 |

未绑定或过时的关系由 caller 核对后 remove，再以返回的新 recordRevision add；这两个显式操作有各自幂等键，不隐式改绑定，不伪造 accepted/delivered。重复 add 拒绝，不作为更新入口。

ready 只表示直接记录条件满足，不表示被授权、原生空闲或可开工。无前置为 true。比如 B 已 delivered，即使后来给 B 添加未满足条件，依赖 B 的 A 仍按 B 的正式交付判断；不做递归状态推导。B 的执行状态同样不会被新关系重开。

## 两条实际案例：仅由 actual caller 应用

功能 owner **没有执行下列正式写入**，也不读取或签发 caller 凭证。管理 caller 先分别调用：

```js
work_read({ credential: CALLER_CREDENTIAL, taskId: "634f0870-ded6-43e8-9c3c-154329d81b8f" })
work_read({ credential: CALLER_CREDENTIAL, taskId: "54c7c36f-de37-41dc-b254-c4541b5ec68a" })
```

将各自返回的 recordRevision 代入下面两次调用；CALLER_CREDENTIAL 为**调用方已有、绑定本 session** 的路径，不是功能 owner 的凭证。返回 STALE_RECORD 时先重读，不猜修订号；不重复已有成功关系。

```js
work_dependency({
  credential: CALLER_CREDENTIAL,
  action: "add",
  taskId: "634f0870-ded6-43e8-9c3c-154329d81b8f",
  prerequisiteId: "cbc1aa63-71dd-4e6f-b981-31b3ad5e4efc",
  prerequisiteGoalVersion: 1,
  recordRevision: CI_RECORD_REVISION,
  note: "CI/CD 依赖工程开发接口交付；依赖满足不解除实际路线决策。",
  idempotencyKey: "ci-engineering-dependency-v1"
})
work_dependency({
  credential: CALLER_CREDENTIAL,
  action: "add",
  taskId: "54c7c36f-de37-41dc-b254-c4541b5ec68a",
  prerequisiteId: "cbc1aa63-71dd-4e6f-b981-31b3ad5e4efc",
  prerequisiteGoalVersion: 1,
  recordRevision: RETIREMENT_RECORD_REVISION,
  note: "协作 skill 退役依赖工程承接；补记历史依赖，不重开已交付任务。",
  idempotencyKey: "skill-retirement-engineering-dependency-v1"
})
```

前置 v1 若仍为当前 delivered，两条条件均显示满足；CI 的 needs_decision 和 skill 退役的 delivered 必须原样保留。前置已变更则返回 STALE_GOAL，由 caller 核对，不把历史完成偷换成当前授权。这些调用不派工、不通知、不解除暂停、不新增会话。

新工具发现需使用本次 release 的 MCP 进程。旧已连接进程可能仍列出九个工具，全局配置刷新并不会替它热加载源码；不能因 schema 文件已安装就宣称所有会话已更新。无需强制 reload 正在讨论的 session，实际 caller 可从新连接发现十个工具，或在空闲且获准时仅重连 work-commander。
