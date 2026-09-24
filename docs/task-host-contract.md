# Task 宿主接入契约

当前 UI 的精确宿主支持基线为
`9fd5204bda99a8bd65b2c5ef152cc47ce87837d5`（Cockpit 源码，未宣称已发行）。
卡片复用 `ck-button`，详情使用 `ck-surface`、`ck-modal`、`ck-heading`、
`ck-actions` 与公共字体 tokens。激活在注册贡献前检查
`context.uiVersion === 1` 与独立的 `context.uiSurfaceVersion === 1`，
缺少或不支持时明确拒绝；历史 UI v1 主机不会自动获得新增样式。
原生 dialog 的 portal、打开、关闭、焦点和业务几何不变；不引入 React SDK 或私有宿主依赖。

资源准备是独立的后端支持契约，由 [waksana/cockpit#100](https://github.com/waksana/cockpit/pull/100)
实现；完整后端源码支持基线为 `d9952cb6060ef6d573431dd4778d6cd221311ece`，
并须有 `context.host.resourcePreparationVersion === 1`。UI 基线和 `uiSurfaceVersion: 1`
不证明该能力存在，也不因本次后端变更而改变。源码合并不等于部署；
调查时运行的宿主 0.2.7 / 源码 `1dd38c6` 尚无此能力及相关 #97 工具初始化支持，
不据此虚构最低宿主发行版本。

Task 是运行于 Cockpit 的模块，不启动独立 daemon 或监听端口。
宿主提供通用模块、角色和原生 session 能力；Task 维护自己的记录、工具和卡片。
两者通过公开契约连接，不访问 Engine、SDK handle、私有 store、凭据或聊天。

模块入口见 [cockpit.module.json](../cockpit.module.json)，使用见
[Task](task-board.md)，业务接口见 [MCP 契约](task-mcp-contract.md)。

## 1. 兼容性与激活保护

| 能力 | 要求 |
| --- | --- |
| 后端模块 | API v1，module ID 为 `cockpit-task` |
| 服务就绪生命周期 | `context.serviceReadyVersion === 1`，支持返回 `onReady` 回调 |
| 宿主操作 | `context.host.call(name, body)`，支持下文公开 intents |
| 显式资源准备 | 仅资源感知 create / prepare 要求 `context.host.resourcePreparationVersion === 1`；缺失在副作用前拒绝，旧创建不受影响 |
| HTTP | 命名空间 routes，保留 headers、JSON body、取消 signal、响应状态与流 |
| 角色 | 模块角色声明、所选角色资源装配、持久记录、冷恢复及按需 readiness |
| MCP | 模块 HTTP 配置、准确的声明 key `cockpit-task`、角色工具子集与版本绑定，并由宿主为每次 tool call 注入 `_meta["cockpit/invocation"]` |
| 前端 | Web API v2、UI v1、shared-surfaces v1 (`uiSurfaceVersion: 1`)、Markdown link renderer、模块 request、事件和 portal |
| 运行时 | Node.js 24 或以上 |

API-v1 或某个宿主发行版本标签本身不证明上述能力齐备。Task 在打开或迁移
SQLite **之前**检查模块身份、service-ready v1 及公共宿主桥接；v9 另要求 MCP 调用时存在 invocation metadata；缺失明确拒绝，
不能降级成未装配 session、跳过通知恢复或私有访问。

通用 service-ready 接口的兼容性说明见
[Cockpit #74](https://github.com/waksana/cockpit/pull/74)。
是否兼容取决于实际宿主能力，不以链接中的合并事实推定当前安装或部署。

## 2. 角色是能力装配单元

模块声明唯一的 `node` 角色及其名称、说明、System Prompt、Skill 发现目录、
HTTP MCP 配置和工具选择。Web 与 MCP 创建共用宿主角色选择流程：

```text
选择 {moduleId, roleId}
  → 宿主解析模块资源，检查冲突并组合配置
  → 创建真实 native session，装配指令、Skill 与 HTTP MCP
  → 持久保存角色选择，冷恢复时重新装配
```

安装模块只使角色可选，不全局启用全部 Skill/MCP。未选角色不隐式追加。
已有 session 的角色变化由宿主角色管理负责；Task 自身不提供这项 mutation，
`task_assign` 也不调用角色变更。宿主角色变化不等于工作指派或授权。

同一模块或不同模块都可多选：

- 角色以 `{moduleId,roleId}` 标识，重复选择去重。
- 工具取并集，同来源资源复用；同名但不同来源/内容的 Skill 或 MCP 配置冲突明确失败，
  不按选择顺序覆盖。
- 角色指令按确定顺序保留来源，以 `systemMessage: {mode:"append",content}` 追加，
  不覆盖基础指令或用模型摘要改写；不承诺自动识别全部自然语言矛盾。
- 只向 session 提供所选角色的 Skill 发现根目录，不把整个模块所有技能无条件加入。
- 资源不存在或配置冲突应在创建前拒绝；创建后发现能力失败须保留真实 session ID。

| 选择 | Skill | Task MCP 工具（省略 `task_` 前缀） |
| --- | --- | --- |
| node（Node） | `cockpit-task-tree`、`github-coding` | 全部十七个：read、create、session_create、session_prepare、assign、edit、cancel、subscribe、unsubscribe、script_read、script_register、automation_start、automation_reconcile、ack、report、reopen、retro_handle |

原 `orchestrator`、`assignee` 角色已删除且无别名；宿主冷启动到 0.1.13 前，操作者须备份并迁移
`$COCKPIT_HOME/session-roles/<sessionId>.json`，把 `cockpit-task/owner` 和
`cockpit-task/executor` 替换为去重后的 `cockpit-task/node`，保留其他角色；仅追加 `node`
仍会因保存了未声明角色而加载失败，回滚到 0.1.12 时应同时恢复该备份。
`node` 声明 `skills/cockpit-task-tree` 与 `skills/github-coding` 发现根；
不复制到其他目录，不新增装载接口。工作 Skill 仅在编码工作需要时读取，非编码不触发；
Skill 可发现不等于正文已读，Subtask 的 assignee 不继承 orchestrator 的加载上下文。

工具子集是 agent 能力装配，不是 Task 逐记录 ACL。业务 actor 由宿主 MCP invocation 派生（HTTP 路由固定为 `user`），不是工具参数；
具有工具不证明用户授权或另一个 assignee 已阅读要求。
节点可同时是自己 Task 的 assignee 与Subtask 的 orchestrator，但不放宽“一项未结束执行 Task”的限制。

默认 Agent Task 使用上述 session 指派边界；可信脚本 automation 由模块持久单队列
执行，不创建或占用 assignee session，不伪造 ACK。启动仍显式授权，宿主不提供
额外调度引擎；Linux 进程组观察、恢复屏障与取消的非回滚边界见
[轻量自动化](task-automation.md)。它是同用户可信执行，不是沙箱或认证服务。

### 配置、可用能力和正文加载分别判断

session 列表、详情和冷恢复使用宿主保存的角色记录；读取标签不触发连接、
Skill 加载或新 session 创建。标签可帮助选择候选者，但不证明当前工具可用。
没有可靠记录时不能从标题、Task 归属或当前全局配置编造角色。

显式 `roles/readiness` 检查角色装配、Skill 名称/路径/enabled、MCP 连接与工具可见性，
不加载未加载 session。普通 session 列表、快照、详情和 Task 读取不采集或缓存 readiness，
不展示就绪 badge。能力就绪与原生忙碌、queue、待决问题和后台工作是不同事实。

Skill 可发现/启用不证明正文已经进入模型上下文。角色 prompt 指向按需 Skill；
沿用原生加载机制，不发初始化 prompt 来替代装配，也不把多角色 session
变成另一套 custom-agent 系统。原生工具发现也须与 agent 实际子集配置分别验证。

## 3. Task 使用的公开宿主调用

Host API 使用 camelCase，Task MCP 使用 snake_case。Task adapter 仅依赖：

| 调用 | 输入/结果 |
| --- | --- |
| `session/new` | `{cwd,roles:[{moduleId:"cockpit-task",roleId:"node"}]}` → `{sessionId}` |
| `session/get` | `{sessionId}` → `{meta}`；未知 session 为 `meta:null` |
| `session/resources-prepare` | `{sessionId,skills?,mcpServers?:[{name,tools?}]}` → `{sessionId,ok,skills,mcpServers,tools,error?}`；严格验证、分步回执 |
| `roles/readiness` | `{sessionId,roles:[{moduleId:"cockpit-task",roleId:"node"}]}` → 含 `sessionId,loaded,ready,roles,reasons` 的显式检查结果 |
| `prompt` | `{sessionId,text,mode:"enqueue"|"immediate"}` → `{ok,queued?}`；首次指派/订阅等普通通知用 enqueue，重要更新通知由模块用 immediate |
| `session/rename` | `{sessionId,name}` → `{ok,title?}`；仅用于指派后的会话标题步骤 |

指派的标题步骤依赖宿主在完整 `session/get` 中提供 `nativeName` 与 `nativeNameUserSet`
（原生 workspace `user_named`）。缺少这些字段时视为来源未知，跳过且不调用 `session/rename`；
规则见 [MCP 契约](task-mcp-contract.md#assign-session-title)。

`task_session_create` 省略资源字段时保持旧创建及能力检查路径；提供任一资源字段
（包括空数组）时，在创建前检查准备 v1 标记，创建后与 `task_session_prepare`
共用资源准备路径。两者不绑定 Task 或发消息，最终分别确认 readiness 和原生空闲。
只创建/准备成功不保证之后可立即接单；指派仍重新检查。
未知创建不重试，已知 ID 即使能力失败也保留，不自动新建替代者。

### 窄的原生资源准备接口

`session/resources-prepare` 在整个原生验证、enable、工具元数据初始化和读回期间
持有 idle 生命周期保护。只处理已加载空闲目标上的现有可发现资源，保留无关选择；
不安装、认证、改全局默认值、绕过策略、加载/重载、改模型/角色或发送 prompt。
原始 MCP 工具名对照实际过滤后的 offered table，拒绝 `*`；
省略 tools 或传空数组也须至少一个实际 raw `mcpToolName` offered。
资源/工具数量限制及完整 receipt 形状见
[MCP 契约](task-mcp-contract.md#两个入口共用的资源选择与回执)。

工具元数据为 `null`，或本次已确认启用所选资源时，初始化一次。后者即使元数据
非 `null` 也适用，修复 MCP enable 可能保留的旧空表；这是配置变化后的初始化，
不是工具过滤绕过。资源已启用、无实际变更且元数据非 `null` 时，真正缺少工具仍失败，
不猜测性重建，不借自动重连/重载或无关 Skill toggle 修复。已确认步骤不因后续失败抹去。
省略/空工具选择仅回传一个实际 offered 原始名称作为证据，而非目录；
显式选择仅回传所请求且实际 offered 的名称。错误字符串最多 2,000 字符，截断有标记。

宿主接口不理解 Task 业务占用。Task 自身拒绝任何绑定未结束 Task 的目标，
要求已应用 assignee、无待重载角色，并在已加载 Task 服务的调用存续期间保护
同目标 prepare/assign 互斥；这不是新增持久锁或锁恢复协议。
`roles/readiness` 的已应用角色和待重载信息用于这项检查；保存的角色标签不能替代。
准备回执与最后的 assignee readiness 分开；任何失败保留分步效果和有界观察，
不使用成功形状的 fallback。

Task 在下一次宿主调用开始前检查取消。单次受保护的 `session/resources-prepare`
提交后，所选内部原生步骤可能继续完成；不逐 RPC 中断、回滚或重试。
实际结果可得时写入回执，不能把调用者取消当作准备没有生效的证明。

既有 `session/new`、`session/get`、`roles/readiness`、`prompt` 契约不变；`session/rename` 只由指派标题步骤调用。
Task adapter 不单独调用 [Cockpit #97](https://github.com/waksana/cockpit/pull/97)
的 `session/tools-initialize`：它是相关宿主内部支持，不是 Task 的第二套修复路径。
不暴露任意 `host.call` 透传或访问私有 SDK handle。

`task_assign` 在绑定前检查能力和原生可接单状态，绑定后再次检查并核对 Task，
然后发送一次 assigned 引用。缺能力不安装、启用、补角色、重载或自动换人。
原生未知信息不能当作空闲：

| 原生前提 | adapter 的判断 |
| --- | --- |
| 存在、已加载、idle | `meta` 非 null，`loaded=true`，`status="idle"` |
| 主循环与操作 | `nativeProcessing=false`，`activeOperations=0` |
| 队列 | 明确的空 `queue` 数组 |
| 生命周期/决定 | 无 loading、closing、cancelling、ask、planRequest、elicitation |
| 后台工作 | 无活动 subagent 或 MCP operation |

已知忙碌时不发送或主动中断。检查与 enqueue 发送不是原子操作；
竞态可能导致 queued，必须记录 `UNEXPECTED_QUEUE` 和实际消息状态，不能当作
成功派单或“未发送”。不用 immediate 向检查后才开始的工作插入指派。
接受也不等于已读、ACK 或实际执行。

拒绝时的 `operation.details` 保留 capability `reasons`、native `loaded/status`、
固定 `availability_reasons` 与 `observed_at`；不复制 pending/问题内容。
这些是失败时观察，读取/重放回执不会刷新宿主或变成持续监控。
完整原因码及安全恢复条件见 [MCP 契约](task-mcp-contract.md#task_assign)。

`task_reopen` 使用相同公开适配器检查原 assignee 存在且能力就绪，但不是接单：
orchestrator 或原 assignee 可调用；工作仍继续归原 assignee，不要求 idle/空队列或无当前 MCP 操作。
不创建/加载/重载 session、不修复资源、不调用 prepare，也不发新派单。
服务在宿主观察后仍于本地写事务核对调用者关系、revision/context、持久指派序号资格
及无其他未结束 Task。原 assignee 调用会 self-ACK 且不发 prompt；orchestrator/Web-user 调用不 auto-ACK，并通过 assignee notice 发送固定 `[Task updated]`。能力、业务资格与用户授权分别判断；调用 session 等于原 assignee 不是用户授权认证，
不读取聊天验证用户决定。首次 assign/prepare 的原生空闲门槛保持不变。

### Assignee notices are service-sent immediate prompts

Agents never send Task notices to other agents. When someone other than the assignee changes an assigned unfinished Agent Task description or `blocked_by`, reopens it, cancels it, or a blocker of an assigned dependent resolves/cancels, the module writes an `assignee_notices` row and uses host `prompt` with `mode:"immediate"` to send fixed updated/cancelled text to the assignee. Callers do not use `cockpit_send_prompt` or free text for these cards.
运行中的 immediate 是向当前轮次插入消息，不是新开一轮；不整理、删除或重放队列，
也不为通知中断主轮次或后台工作。它不能回答待决 ask/plan/elicitation，受理不等于已读或 ACK，
失败或未知效果只作有界核对，不盲重试或自动升级为中断。

## 4. 模块 HTTP 与官方 MCP transport

Task 普通 HTTP API 和 HTTP MCP 共用业务服务及 SQLite。宿主只负责模块挂载、
访问边界和生命周期，不注册 Task 业务工具或代模块实现 MCP 协议。

| 相对模块 API 路径 | 用途 |
| --- | --- |
| `POST /read` | 固定有界读取视图 |
| `POST /tools/:name` | 同一业务工具调用 |
| `GET /tasks/:id/native` | 按需读取已绑定 session 的公共 native 观察 |
| `POST /mcp` | 初始化、工具调用和通知 |
| `GET /mcp` | MCP 协议流 |
| `DELETE /mcp` | 关闭 MCP 协议 session |


MCP `POST /mcp` 的每个 tool call 必须携带 host-injected `_meta["cockpit/invocation"]`，至少包含 `sessionId`，并可包含 `runtimeSessionId`、`subagent`、`agentName`。Task 不信任工具输入中的身份字段；缺少 invocation 时 `INVOCATION_REQUIRED`（400）且不写入，包括 reads。subagent 调用归因到 containing session，完整 invocation 存入 operation receipt，供 `task_read(view=operation)` 返回 `actor` 和 `invocation`。request fingerprint 覆盖工具、已验证输入和派生 actor，不覆盖完整 invocation。该契约来自 waksana/cockpit#205，因此本模块必须与包含该宿主能力的 Cockpit 联合部署。

模块 HTTP 路由（`POST /read`、`POST /tools/:name`、`GET /tasks/:id/native`）没有 native session 身份，固定以 actor `user` 执行。通过 HTTP 创建的 Task 因而 `orchestrator="user"`；后续依赖或 Subtask 通知会尝试查找名为 `user` 的 orchestrator session，通常记录 `ORCHESTRATOR_NOT_FOUND` / not_sent。`user` 自己登记的 subscription 也路由到 `user`，通常记录 `SUBSCRIBER_NOT_FOUND`；真实 session 登记的 subscription 正常发给该 session。Web board 只应读取。

模块使用官方 `WebStandardStreamableHTTPServerTransport`，将公开 headers/body/signal
转换为 Web Request，以 parsedBody 传递 JSON，保留响应状态/headers，
将 Web 流转换为 Node Readable。无须获取原始 Node request/response 或暴露 Fastify。
宿主从当前安装解析真实 endpoint、模块版本头和角色工具选择；不硬编码生产地址，
不关闭访问保护或读取宿主凭据来凑连接。

transport 按 MCP session 隔离，后续 POST 的 cancellation 能关联原在途调用。
HTTP request ID、协议 session ID 与持久 request_id 的业务幂等是不同层次。
取消在下一次 Task 到宿主调用前检查，不回滚已经创建、准备、绑定或发送的效果，
也不保证中断已提交准备调用内的原生步骤。

协议连接最多 256 个；无请求、执行或打开流的连接空闲五分钟后释放。
容量不足可回收空闲连接，不挤掉活跃连接；全忙时拒绝新初始化。
失效协议 ID 返回 404，需要显式重新连接，不能据此重做业务写入。
模块关闭释放连接，并保持存储直至在途操作记录完真实结果。

## 5. 服务就绪与通知恢复

激活返回 `onReady`。宿主只在 runtime 已启动、HTTP 已监听后，为每次成功激活
调用一次；关闭已开始则跳过，不自动重试。回调不阻塞宿主启动/关闭，
通过 `context.signal` 取消，错误经模块报告通道公开。

必须等 listen 之后，恢复的 orchestrator 才能连接模块 MCP；激活、提前的
`agent/status:up` 或 inbound read 都不能启动恢复。
Task 的 service-ready v1 检查在数据库打开/升级前执行。

Assignee notice expiry happens earlier: `TaskService` construction synchronously expires pending assignee notices left by a previous process before accepting any request, so replay cannot send them late.
Task 回调按固定 high-water mark 分批恢复其余持久 `pending` 通知，不等新业务流量。
先被动检查原接收者存在，再持久 claim 为 unknown 后发送；不创建替代接收者。
unknown、accepted、queued 和已记录 not_sent 失败不自动再试，
宿主 prompt 没有幂等键，因此不承诺外部 exactly-once。
这是通用生命周期回调，不是宿主 Task 事件总线或消息调度器。

## 6. 前端与验证边界

宿主 Markdown renderer 提供原始 link target/label，Task 只认合法 `task:<uuid>`
及受支持 event query。卡片使用合法 inline DOM，详情通过 portal 打开；
不扫描、重写整段聊天或增加独立 dashboard。

URL event 固定消息原因，卡片重新读取当前 Task；模块 invalidation/事件只提示
刷新，不是持久回放，重连必须重读。Task 报告与 native 观察分别显示。
native 读取只用 session/get，不采集能力、不加载 session、不持久复制原生状态
或推断实时业务进展。不要使用会被 File 当作文件候选的相对 `task/<id>` 路径。

用隔离数据、合成 sessions 和 loopback 模型验证真实包、安装器、角色装配与
官方 transport，不以模型遵从性或单次连接证明全部接入。
跨仓库集成及模型驱动场景的设置、证据和局限见
[生命周期回放](task-lifecycle-testing.md)。测试、打包或文档清理不执行生产安装、
真实 session 消息、凭据读取或真实数据迁移。
