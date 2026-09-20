# Task 最小宿主接入设计

状态：设计和实现已收口，隔离集成与独立审阅完成；配套宿主变更见
[waksana/cockpit#68](https://github.com/waksana/cockpit/pull/68)，不表示已部署

本页保留针对基线的调研证据；“当前能力与缺口”记录实现前的宿主状态。
实际模块入口见 [使用说明](task-board.md) 与 `cockpit.module.json`。
新增角色及宿主桥接以配套宿主源码契约为准，不由旧版 0.2.6 标签推断已经具备。

依据：[产品决定](task-design.md)、[MCP 契约](task-mcp-contract.md)

## 1. 核对基线

2026-09-20 通过 GitHub API 核对宿主 main 为
`3494c0b1e58ed1d1f717bf7d434534172d3e6fa8`，随后只读该提交的源文件，
不依赖 `/home/honglai/cockpit` 工作区当前文件。源码 core 版本为 0.2.6，
SDK 固定为 1.0.13；GitHub latest Release 返回 v0.2.4。
源码、Release 和用户此前提供的生产版本是不同事实，本轮没有探测或修改生产。

同时核对本机已安装的 SDK 1.0.13 公开类型，未创建真实 session、
调用发送/中断、读取凭据或访问真实 Task 数据。

当前协议为 `cockpit.module.json`、后端 API v1、Web API v2 / UI v1。
旧 `module.json`、独立 stdio 服务和旧 session/modules 协议不能直接使用。

## 2. 当前能力与缺口

| Task 所需 | 当前公开能力 | 结论 |
| --- | --- | --- |
| 业务持久化、HTTP、变更通知 | module dataRoot、命名空间 routes、invalidate / publish | 可复用；Task 自己维护业务数据，不碰真实旧数据库 |
| Task 引用渲染 | Markdown link / image renderer、模块 request、state、事件及 portal | 有现成入口，不需要新增任意页面/router |
| 角色内容声明与选择 | 当前 manifest 无角色字段；session/new 仅 cwd；普通创建明确不注入产品角色 | 前端与 MCP 创建共用角色选择与装配，session 列表同时返回所选角色 |
| agent 工具入口 | 后端可注册 HTTP routes；尚无模块 MCP 配置与角色装配契约 | 模块实现 HTTP MCP，本体挂载并使用模块配置；不新增业务工具注册表或 caller 鉴权 |
| 创建执行 session 并准备能力 | 宿主可创建真实 session；SDK 支持创建配置中的 systemMessage、skillDirectories、mcpServers / tools | 原生基础存在，但未向模块暴露角色化创建与就绪结果 |
| 当前原生活动 | session/resources 可只读 control，不加载未加载 session；panel 可读任务/工具标签及状态 | 可显示真实运行状态和有限原生条目，不等于详细的实时工作摘要 |
| 明确中断 | cancel 清队列后 abort；session/interrupt 保留并继续 native queue | 本体队列推进 MCP 组合保留队列的中断，不使用 clear |
| 消息发送与推进 | prompt 支持 enqueue / immediate；无公开 idle-only 前提字段 | 最新方案先明确入队引用、再动态推进到最新队尾并保留最后轮次；不要求 idle 或宣称原子保证 |

宿主本身保持薄底座，不理解 Task.status、Owner / Executor 分工、
description revision、ACK 或成果。模块公开接口不足，不意味着可以绕过它访问宿主内部 store。

## 3. 用户收窄后的接入方向

### 通用角色选择与创建时装配

模块声明自己的角色标识、角色指令、skill 资源与 MCP 配置及工具选择。
宿主提供发现、显式选择、创建时装配及真实就绪结果，不硬编码 Task 角色名。
用户明确：前端新建与 MCP 新建都能选角色，共用同一套创建契约，
不是仅为 Task 的 task_session_create 增加私有入口。未选择角色不隐式追加角色。
Task 仅声明 `task-owner`、`task-executor`；Coding / Research 的定义、安装、
维护不包含在 Task 模块内。

首次创建链：

```text
Owner 调用 task_session_create
  → Task 请求宿主的通用角色化 session 创建
  → 宿主创建真实 session、绑定身份、装配角色指导和工具
  → 返回真实 ID 与各项就绪结果
  → 不发送初始化消息、不绑定 Task
```

能力就绪至少区分：创建是否成功、角色指导是否按选定资源装配、
skill 是否可用、工具是否真实可调用。不把“目录可发现”当成 skill 正文已进入上下文，
也不能用额外启动 prompt 弥补角色装配，否则破坏首次消息只含 Task ID 的要求。
角色短指令与 skill 的加载配合要在隔离场景证明，不把自然语言遵从性说成程序保证。

用户已确认：**同一模块也可以同时选择多个角色**，不同模块同样可组合。
Task Owner / Executor 可以在创建时一起选择；`task_session_create`
仍只请求 Executor，不隐式追加 Owner。

组合遵循以下最小规则，不预建通用指令冲突推理或规则引擎：

- 角色使用 `{moduleId, roleId}` 标识，重复选择同一角色不重复装配；
  所选工具取并集，相同模块中的同一个工具仅注册一次。
- 同一来源的同一 skill 资源去重；同名但不同来源/内容的 skill 明确冲突。
  不按角色选择顺序静默覆盖工具实现、技能或已有 MCP 配置。
- 保留宿主原有指令，角色短指令以标明来源的片段追加；创建时采用明确、
  可复现的顺序并保存，冷恢复使用同一顺序。不得声称自动识别所有自然语言矛盾。
- 两份 Task skill 按当前行为分工：委派时使用 Owner 流程，执行所承接 Task 时
  使用 Executor 流程。已有 Owner 工具不使当前 Task 变为任务树，
  也不放宽“一个 session 同时最多执行一个未结束 Task”。

用户已确认角色指令由本体汇总：多个模块的多个角色都保留来源，
本体进行结构化组合，不通过模型摘要改写，再作为
`systemMessage: {mode: "append", content}` 传入。
这部分成为主 agent 的 system prompt 的追加内容，不替换原生基础指令；
Skill 正文和 MCP 工具并不因此全部变成 system prompt 文本。

创建时的角色选择和资源来源属于通用装配元数据，不是 Task 保存聊天或 native
状态副本。不以仅第一次创建成功冒充完整生命周期可用，不引入运行中动态追加。

用户已确认：**只复用已有能力的 session**。角色在本体创建 session 时选择，
指派不临时追加角色、安装技能、启用 MCP 或重载 session 来补齐。
`task_assign` 检查目标当前能力；缺少所需指导、技能或可调用工具时，
在绑定和发送前返回 `CAPABILITY_UNAVAILABLE`，不要求 Owner 手工排查底层配置。
返回缺少哪项能力和已有证据，由 Owner 决定是否通过 `task_session_create`
创建新的 Executor，工具不自动另建或换人。

已有 Executor 完成 Task 后仍可承接下一项，但角色标签本身不是就绪证明。
仍需确认能力有效、没有另一项未结束 Task，且目标当前可以接收首次派单。
不恢复已有 Executor 追加 Owner，也不在某工具回调里等待它所属的 turn 空闲。

历史 `NativeRoleEnvironment` 可借鉴：技能路径/名称冲突、原生发现结果、
MCP 连接状态检查及创建/恢复参数组合。不能直接恢复旧业务服务、旧凭据与通知流程。

### 调研结论：角色是 Skill 与 MCP 的装配单元

2026-09-20 根据用户要求，重新对照宿主 main、已安装 SDK 1.0.13 的公开类型、
create/resume 参数转发代码及 GitHub 官方文档核对。结论是：
**这条实现路径有原生支持，但当前 Cockpit 尚未提供角色声明和装配层。**
角色是 Cockpit 模块提供的配置组合，不需要把每个角色变成 SDK custom agent。

```text
模块包
  → 声明多个角色
  → 每个角色引用自己的 Skill 资源和 MCP 配置/工具选择
  → 用户或 agent 在本体创建 session 时选择角色
  → 本体合并所选角色，生成原生 session 配置
  → SDK 创建 session，装载 Skill 目录并连接 HTTP MCP
  → 返回真实 session ID 和各项就绪结果
```

安装模块只使它的角色可选，不把该模块的所有 Skill / MCP 全局启用。
本体不要求用户再分别选一次 Skill、配一次 MCP；角色声明提供二者的对应关系。
模块可在包内复用共同 MCP 连接定义，但面向 session 的装配入口仍是角色，
不是模块安装后自动注入全部资源。

| 所需能力 | SDK 1.0.13 的真实入口 | 宿主应做的事 |
| --- | --- | --- |
| 发现角色 Skill | `SessionConfigBase.skillDirectories` | 将所选角色的包内目录解析为绝对路径，保留来源并排除同名冲突 |
| 保证 Skill 可用 | `enableSkills`、`disabledSkills`；`session.rpc.skills.list()` 返回 enabled / path | 保证所选技能未被实际配置禁用；只作用于本 session，不修改全局设置或无关技能 |
| 连接模块 HTTP MCP | `mcpServers[name] = {type: "http", url, headers?, tools?}` | 使用模块提供的配置，解析挂载地址及必要请求头，注入该 session |
| 按角色提供工具 | 每个 MCP 配置的 `tools` 列表 | Owner / Executor 选择不同列表，多角色取并集；`undefined` 或 `["*"]` 是全部，`[]` 是无工具，不能混淆 |
| 短角色指令 | `systemMessage: {mode: "append", content}` | 追加角色身份、适用 Skill 名称和同步原则，不覆盖基础指令、不发送初始化 prompt |
| 冷恢复 | `ResumeSessionConfig` 同样继承上述配置；client 恢复路径转发对应字段 | 本体保存角色选择并在冷恢复时重新解析和传入，不能依赖连接或目录自然留存 |

例如，Task 的一个 HTTP MCP 可以实现全部八个工具，角色配置决定 agent 获得的
工具子集，无需仅为 Owner / Executor 分别启动服务：

| 选择 | Skill | Task MCP 工具 |
| --- | --- | --- |
| Owner | `task-owner` | read、create、session_create、assign、edit、cancel |
| Executor | `task-executor` | read、edit、ack、report、cancel |
| Owner + Executor | 两份 Skill | 八个工具的并集，同一个连接配置 |

上表省略工具的 `task_` 前缀；正式 schema / Skill 使用完整名称。
工具选择是 SDK 的 agent 工具配置，不是 Task 数据访问 ACL，
不承诺阻止可信本机程序直接访问模块端点。

**Skill 可用与正文加载要分开。** 官方 CLI 文档说明 Skill 按相关性调用，
调用时才将正文注入上下文。`skills.list()` 的 enabled / path 可以确认发现和启用，
不能证明正文已经加载。SDK 的 `CustomAgentConfig.skills` 提供提前加载正文，
但当前 `DefaultAgentConfig` 只有 excludedTools，没有相同的 skills 字段；
不能把 custom agent 的能力错写成主 session 的配置。
本期沿用“短角色指令 + 可用 Skill”的装配，不为此把多角色 session 改造成
单个自定义 agent，也不谎称选择角色就确定执行了 Skill 中每一步。

Skill 目录应按所选角色提供可发现的父目录，不把整个模块的技能根目录
无条件加入每个 session。否则只选 Executor 也可能发现 Owner Skill。
可在包内为各角色分别放置技能根目录；实际目录形状按原生发现结果确认，
不向全局或项目技能目录复制文件。工作技能继续使用已有独立来源。

创建后的就绪读取分别检查 Skill 的名称/路径/enabled、MCP 的连接状态及工具存在。
`session.rpc.mcp.listTools()` 是服务器真实 tools/list，不等于 agent 过滤后的工具集；
不能据此单独证明角色筛选生效。SDK `tools` 配置语义有公开依据，
仍须在隔离集成中覆盖单角色和多角色的实际可用集合，不调用真实 Task 写操作做探测。

当前宿主 `session/new` 仍只有 cwd，`Engine.config()` 只处理原生发现和
全局 disabledSkills 等基础选项，模块 manifest/backend 没有角色声明字段。
因此还要实现 H1–H3：模块角色/配置发现、创建时装配、持久选择及列表/恢复，
不能把 SDK 已有支持说成当前本体已经支持。
本次调研未创建 session、连接新 MCP、装载 Skill 或修改生产配置。

### 创建角色与 session 列表共用记录

用户新增要求：`cockpit_list_sessions` 必须带上本体创建时选择的角色，
让 Owner 直接从列表找到 Executor 候选，不通过读聊天、标题或反查 Task 猜测。
这是宿主的 session 配置元数据，不由 Task 模块维护第二份 session 名册。

建议公开形状为 `roles: [{moduleId, roleId}]`，使用模块限定的稳定标识；
人类输出显示可读角色名，机器输出保留明确标识。
数组沿用通用角色组合方向，不意味着本期允许运行中动态追加角色。
准确类型名称在宿主接入实现中对齐。

| 入口 | 角色行为 |
| --- | --- |
| Web 新建 session | 从已注册模块角色中明确选择，经公共创建契约装配 |
| `cockpit_new_session` | 使用同一角色选择参数与装配流程，不单独维护另一份角色映射 |
| `task_session_create` | 经上述公共创建入口固定选择 Task Executor；不是给任意已有 session 补能力 |
| `session/list` / `cockpit_list_sessions` | 轻量返回所选角色；Markdown 和 JSON 均包含，不必逐个读取详情 |
| `session/get`、identity 投影及 Web session 元数据 | 使用相同角色记录，避免列表和详情不一致 |
| 冷恢复 | 读取宿主保存的选择并重新装配；不能静默丢失、换角色或仅保留标签 |

角色选择需随 session ID 持久保存，卸载不会丢失；角色装配所依据的模块资源标识
由宿主管理，不保存到 Task。记录读取不需要加载 session，也不为列出角色触发
MCP 连接、skill 装载或创建新的 native session。

必须分清**所选角色**和**当前能力**：列表中的 Executor 表示创建配置，
不表示其 MCP 此刻已连接，或 skill 正文已加载。未加载的 session 仍可显示角色，
但实时就绪情况未知；模块缺失、资源变化或装配失败也不得抹去已记录的选择。
`task_assign` 使用当前能力结果，不把列表角色直接当成通过判据。

明确未选角色时返回空列表；历史 session 没有可靠选择记录时标注 unknown，
不能按当前全局配置、Task 归属或可用工具列表补造角色。
旧无角色 session 的普通使用不受影响，但不能因此成为可直接指派的 Executor。
无需为本次设计迁移真实旧数据。

### MCP 随角色注入，不按 Task 归属鉴权

用户明确：获得对应 MCP 就可以调用其工具，也可以操作其他 Task，
不限制为自己负责/承接的记录。角色决定注入哪些工具，Owner / Executor
字段只是责任分工，不构成逐 Task 的访问控制。

撤回上一稿的通用可信 caller、会话绑定授权通道和按归属鉴权要求。
不新增身份服务或 Task ACL。当前仍缺少模块 MCP 配置装配及 HTTP MCP 适配确认，
这属于让角色注入实际可用工具的接入工作，不包装成额外安全项目，
也不恢复旧独立 daemon。模块实现 MCP，本体沿公共模块 HTTP 机制挂载。

操作作者与角色分工仍可用于记录、读取筛选和本人修订自动 ACK，
但这些业务上下文不是权限凭据；其来源和表示在后端设计中明确，
不能对未知作者编造“已验证身份”。ACK 仍表达执行者确认要求，
拥有工具不等于其他 session 已阅读或理解；Skill 必须避免虚报确认。
保留版本、状态、首次指派、单 Executor 单未结束 Task 和幂等检查，
它们保护记录一致性，不拒绝某调用者读取或操作其他 Task。

模块还需要公开、受生命周期约束的宿主操作访问：创建、读取必要的原生状态、
明确中断和发送。可以沿用 typed intent 契约，不直接暴露 Engine、
SDK handle 或内部 stores。不借模块需要控制 session 扩大为全局接口统一。

人类前端读取走现有受保护模块 HTTP；不能把浏览器正在查看的 session ID
当成经过验证的操作作者。本项目是单操作者可信模块模型，不借此声称恶意同用户进程隔离。

### H1 已确认方向：模块实现 HTTP MCP，本体挂载并使用配置

用户进一步收窄：**模块自己实现 MCP，通过本体的模块 HTTP 入口暴露，
再提供 MCP 配置供本体使用**。不要求本体新增业务工具注册表或替模块实现
tools/list、tools/call。本节替代上一稿“模块仅声明 handler、本体实现 MCP 协议”的提案。

Task 模块提供两组入口，使用同一业务操作层与持久化：

| 入口 | 使用方 | 职责 |
| --- | --- | --- |
| Task HTTP API | Task 卡片、dashboard 或其他操作 Task 的界面 | 普通业务读取/变更与结构化错误；已有前端范围仍为 Task 卡片，不因此新增独立 dashboard |
| Task HTTP MCP | agent，经角色装配后连接 | 模块自己的 MCP server、工具 schema、调用适配和 MCP 结果语义 |

HTTP MCP 是挂载在宿主 HTTP 服务内的模块入口，不额外启动独立进程、
监听端口或旧 stdio daemon。两组入口不是两个数据库，也不是两份业务规则。
共享业务操作保护 revision、ACK、幂等、生命周期与部分失败；各传输只负责适配。

最小宿主增量为：

| 公共表面 | 模块提供 | 宿主责任 |
| --- | --- | --- |
| HTTP 挂载 | 普通 Task routes 和模块实现的 HTTP MCP handler | 沿模块命名空间路由，保留协议所需 headers、响应流及取消信号，管理生命周期和现有访问防护 |
| MCP 配置声明 | 模块 MCP 入口相对位置、原生连接所需配置及角色使用的工具选择 | 解析当前安装的实际地址/版本，在创建和冷恢复时注入原生 session；不硬编码 Task 工具 |
| 角色声明 | role ID、名称/说明、短指令、skill 资源及 MCP 配置引用 | Web / MCP 发现与选择共用；资源来自模块包，不接受创建调用任意覆盖 prompt / 文件路径 |
| 模块宿主访问 | 与既有公开协议对应的创建、能力读取、必要原生状态读取和发送 | 校验契约并执行，不暴露 Engine、SDK handle、store 或凭据文件 |

本体使用模块声明的 MCP 配置，而不是把所有模块业务工具并入本体 MCP。
同一模块多角色时合并工具选择，复用相同来源的连接配置，不产生重复工具；
相同配置名却不同来源或内容的冲突明确报错。实际 agent 工具集合是否符合
所选角色须通过原生连接结果确认，不能仅靠 Skill 自觉不用额外工具。
具体配置字段和工具选择方式须对照原生 SDK 收口，不先造第二套配置语言。

当前 main 再次核对仍为上述固定提交。模块 routes 已传入 params / query /
headers / body / signal，并支持响应状态、headers 和 Readable 流。
但现有接口不是 Node 原始 request / response：
请求 `body: stream` 只接受 application/octet-stream；写请求还要求模块 digest header。
不能声称现有 Node MCP HTTP transport 可以不经适配直接挂载。
实现前须用正式 MCP transport 验证初始化、发现、调用、通知、
流式响应及所采用会话模式的关闭行为；只补确实缺少的通用 HTTP 适配，
不为 MCP 承载重建模块工具注册体系或开放整个 Fastify / Engine。

MCP 协议实现及其依赖由模块负责；宿主是否需要通用 HTTP 桥接依赖，
取决于选定 transport 的实际适配，不因本设计直接给本体引入 MCP server SDK。
模块端点沿用宿主访问防护，不能变成无保护的公开路由；
模块不读取宿主凭据文件，不提供关闭防护的 fallback。

角色引用不存在的 MCP 配置或资源应在 native session 创建前拒绝。
创建后确认连接及实际可用工具；仅有 URL 或连接成功不代表角色完全就绪。
模块不可用、宿主退出或 digest 不匹配必须反映真实失效，
不将旧配置静默路由到另一版本，不因连接重试重放业务写操作。
该方向现由模块 `src/task-board/mcp.js` 和宿主现有模块 routes 实现。
宿主未新增模块业务工具代理，也没有为 MCP 扩展原始 HTTP request/response 接口。

### HTTP MCP 适配调研：优先不扩展宿主 HTTP 接口

进一步检查本机已有 MCP SDK 1.30.0，存在正式的
`WebStandardStreamableHTTPServerTransport`，接收 Web `Request`，
支持通过 `parsedBody` 使用已经解析的 JSON，返回 Web `Response`。
因此不必为了使用 Node 版 transport 向模块暴露原始 request / response。

模块内的适配可以沿已有公开字段完成：

| 现有模块契约 | MCP transport 适配 |
| --- | --- |
| 按 HTTP method 注册 route | 每个 route handler 已知自己的 method，不依赖缺失的 request.method 字段 |
| headers / body / signal | 生成协议请求，JSON body 通过 parsedBody 传入；不用仅支持 octet-stream 的上传模式 |
| 模块 apiBase 与确定的 MCP 子路径 | 固定 MCP 入口可构造请求 URL；不根据客户端传入的任意 Host 生成连接配置 |
| response status / headers | 原样保留 MCP 响应码、内容类型、协议 headers，包括无正文的通知响应 |
| response Readable | 将 Web 响应流转换为 Node Readable，沿现有宿主流响应处理 |
| 模块关闭 signal / dispose | 关闭模块拥有的 transport；请求取消须显式接到模块操作，不假定构造 Request 就自动传播到工具 handler |

已用本机现有包完成纯内存的协议适配实验：官方 MCP client 经自定义 fetch，
使用公开模块响应形状转换，请求初始化、initialized 通知、tools/list 和一个只读
合成工具调用；JSON 与 SSE 两种响应均可往返。实验没有网络监听、真实 session、
生产数据、依赖安装或源码改动。
这只能证明 transport 与请求/响应形状的可组合性，不冒充实际 ModuleHost
路由、防护、关闭行为或 Copilot 原生连接的完整集成结果。

最初的无状态提案在实现审阅中发现取消缺口：原生 MCP client 会以另一个 HTTP
POST 发送 notifications/cancelled，若每次创建新 server，就找不到原调用的
取消控制器。当前实现因此使用**按 MCP session 隔离的 HTTP transport**，
支持初始化、跨请求取消和 DELETE 关闭；不是整个模块共享一个所有客户端的连接。
每个活跃请求再绑定宿主请求取消信号，取消后不继续派发新的外部副作用。
已经开始的创建或发送仍保留实际操作结果，不冒充撤销。

协议连接只保存连接/在途取消状态，Task 数据和 request_id 幂等仍在 SQLite，
不放进 MCP 会话。使用 SSE 响应以便关闭和释放逐请求的协议资源；
取消时返回终止错误来释放 SDK 保留的响应映射，取消不会影响同连接其他调用。
模块关闭释放连接；无请求、无执行中操作、无打开流的连接空闲 5 分钟后释放。
最多保留 256 个协议连接；容量不足时可提前回收空闲连接，但不挤掉执行中请求
或打开的流。全为活跃连接时明确拒绝新初始化。失效 ID 返回 404，不能因此重试
Task 写操作或创建替代的 Executor session。
本体队列推进是另一个宿主工具，仍以自己的 operation ID 管理，
不因调用它的 MCP 连接断开而取消。

正式实现需覆盖请求结束后的实例释放、客户端断开、模块关闭、并发请求 ID
不串线、空响应、错误响应和写入结果未知等场景。
不用关闭访问防护或绕过 digest header 来跑通；所需 header 从模块 MCP 配置传入。
Task 当前依赖声明为 SDK ^1.27.1，本次实验使用宿主已安装的 1.30.0；
实际实现必须确认 Task 的锁定版本提供相同 transport，不能把版本范围当成已安装事实。

据此，H1 **暂不预设新增通用 HTTP 挂载接口**：先在模块内适配现有 routes，
实际集成显示确有缺口才增加最小公共字段。
宿主明确仍需新增的是角色/资源声明、MCP 配置解析与 session 装配入口，
不是 MCP 协议实现。具体挂载地址解析须由宿主提供可靠来源，
不硬编码生产域名或把相对 apiBase 直接当成 SDK 所需的绝对 URL。

### 现有原生基线

宿主现有工具可执行单次 `session/interrupt`、状态读取和消息发送。
用户先前选择由 Owner 组合使用，随后提出将队列推进循环封装为本体 MCP。
最新行为见下一节，替代早期“循环直到 idle 再发送”的流程。

SDK 1.0.13 的 `SendMode` 说明：`immediate` 会在已有 turn 中 interject；
公开队列结果也包含 `steeringMessages`。正在执行时的 immediate cue
不是一次停止后重新启动，也不能替代保留队列的中断。

当前宿主 `prompt` 先读取 control，再调用 SDK send；没有“只有仍为空闲才发送”
的原生前提。SDK 公开 `SendRequest` / `SendMessagesRequest` 也未见对应条件字段。
先查状态再发送之间存在竞态。这是用户选择的工具组合边界，
不宣称是原子“仅空闲才发送”或后台工作全部停止的程序保证，
也不为消除一切竞态扩展本期宿主范围。

当前两个停止路径也有不同副作用：

- `cancel`：queue.clear 后 abort，不能未经授权丢弃其他来源的排队内容。
- `session/interrupt`：interruptMainTurn({flushQueued:true})，继续已有 queue；
  后台工作仍可存活，返回 interrupted 不代表整个 session 已空闲。

将这些真实语义写入 Owner skill；不改变已有 prompt / cancel 的语义。
已有队列、未停止后台工作或待决问题不能被默默清除、绕过或当成空闲。
“不用 Owner queue”保留为明确的协作与调用规范，不升级为本期原生调度器改造。

### 最新决定：推进到动态最新消息并保留其执行

用户进一步明确“不用 queue”是 Owner 遵循 Task 协作规范时不主动积累提示，
不是要求 Executor 永远没有任何 queue。其他 session、subagent 等来源的消息
应保留，不删除、不清空，也不自行取出后重新发送。

**触发条件：** Owner 判断本次 Task 更新非常重要，不能等待 Executor 的正常同步点，
才主动发起下面的强制重新对齐流程。它不是每次修订后的常规动作，
不是收到未 ACK 提醒就自动执行，也不是 MCP 自行判断重要程度。
即使封装成 helper，也只能响应 Owner 的明确调用；task_edit 不调用它，
不订阅 revision 变化来自动中断，不作为后台巡查。

用户决定本体增加通用 MCP 来执行队列推进，不理解 Task。
工具运行期间始终追到最新队尾，不固定调用开始时的最后一条。
成功边界不是整个 session idle，而是后续队列已耗尽，最后接续的轮次不再被工具打断。

建议 Owner 的使用顺序：

```text
Owner 因非常重要的更新，明确请求立即重新对齐
  → 更新 Task
  → 只将 Task ID 引用发送到队尾一次
  → 明确调用本体的队列推进 MCP
  → 尚有后续消息时，中断当前主轮次并由原生接续
  → 期间新到消息也纳入后续队列，继续推进
  → 某个检查点后续队列耗尽，保留最后接续的轮次继续执行
  → 返回，不继续监视之后才到达的消息
```

这里的“队列清空”指原生取出消息继续处理后的耗尽，不是 queue.clear。
保留消息不保证各条要求都执行完成；新启动的轮次仍会被主动中断。
后续消息是否合并到同一轮由原生决定，不能假定一条消息恰好对应一次中断。
每轮中断后的接续由原生处理，不由 Owner 重发已有消息或反复发送 Task ID。
即使 Task ID 已经进入某轮执行，只要本次调用期间又出现更新的队尾消息，
按用户选择仍继续推进；不承诺最终驱动消息一定就是 Task ID。
这不允许把 Task 定义复制进队列，Task ID 入队是明确强制对齐的例外步骤，
不是每次修订的默认动作。

实现必须区分“后续消息已取出、其接续轮次可保留”和“旧轮次还在停止、
尚不能确定接续结果”，不能看到一个瞬时空数组就盲目中断或宣告推进成功。
成功不表示最后消息的工作已完成，也不要求后台任务全部停止。

固定 SDK 1.0.13 已有的相关 API：

| 原生 API | 实际含义 | 能否直接完成整个流程 |
| --- | --- | --- |
| `session.rpc.interruptMainTurn({flushQueued:true})` | 中断主轮次，保留并继续 queued prompts；后台工作存活 | 单次中断，需观察后续轮次再决定下一次 |
| `session.rpc.queue.pendingItems()` | 读取 pending items 与 immediate steering 条目 | 需结合接续状态；空队列不代表最后消息工作已完成 |
| `session.rpc.metadata.isProcessing()` / `metadata.activity()` | 读取主循环及活动状态 | 是判断依据，不执行中断 |
| `session.rpc.tasks.waitForPending()` | 等待后台 agents / shells 及完成触发的后续轮次收敛，有内部超时 | 不会反复打断；返回对象不含“保证已 idle”的标志，应重新读状态 |
| `session.sendAndWait(...)` | 先发送，再等待 session.idle，超时不停止工作 | 顺序与此需求不同，不能替代 |
| `session.rpc.cancelAllBackgroundAgents()` | 取消后台 agents，保留 promoted shells | 不属于用户要求，不能顺便调用 |

本次未发现“逐轮打断、保留消息、推进到动态最新队尾并保留其执行”的单个公开原生 API。
宿主已将单次 interrupt 暴露为 `session/interrupt`；
`tasks.waitForPending` 等并未因此自动成为当前宿主 MCP 能力。

本体 MCP 内部组合现有原生能力，不修改原生队列机制，不新增 Task 专用工具。
用户已确定功能方向和动态追尾规则，具体英文名称、输入/结果及实现仍待收口。
工具本身不新增提示消息，正常用法由调用方先入队再调用，不能将其实现成复制重发。
若先调用工具、之后才发 Task ID，则后发的 ID 不属于已结束操作，
不能宣称之前的调用已经替它完成推进。操作不是原子排他保证。

helper 不能写成忙循环：需观察原生状态/轮次变化，区分尚未停止的同一轮
与真正开始的下一轮。单次中断结果未知时停止并报告，不把对新轮次的明确中断
与盲目重试上一次混淆。不能声称 Task ID 未发送（它可能已在调用前入队或已进入执行），
也不能丢消息、偷偷取消后台工作或因调用失败自动重发。

### 等待与取消

用户已选择**不设业务超时**：只要原生状态仍可确定，操作持续推进，
直到动态队尾耗尽或调用方取消。不设置隐藏的最大轮数或总运行时限。
持续来消息可能一直不完成；后台工作阻碍接续或原生队列暂停时等待可用状态变化，
不能用反复中断同一轮、删除消息或取消后台工作来强制结束。
原生调用失败或结果未知仍应停止推进并如实报告，不因“无超时”无限重试副作用。

取消的是推进操作，不是目标 session：停止发起后续中断，不清理队列、
不另行 abort，不撤销已经发出的中断，也不撤回先前发送的 Task ID。
已有中断请求尚未返回时，应区分取消已受理与在途中请求仍待确认，
不能把取消结果当成目标 session 已停止。剩余工作交回原生正常处理。

**传输限制与已选方案：** 当前宿主 MCP 的 `apps/mcp/src/cockpit.ts`
要求 HTTP 请求超时为正数，并以 AbortController 截止单次请求。
业务上“不设超时”不等于把该值调大就能保证 MCP 连接无限存活。
现有公开 operation 结构用于 MCP server 开关，并非可以直接调用的通用长操作接口。

用户已选择本体以一个可查询、可取消的推进操作承载：启动请求及时返回操作 ID，
操作本身不设超时；通过同一 MCP 的查询/取消动作管理，不增加通用调度系统。
单次 MCP 连接结束不取消已启动操作；停止推进须明确取消。
以下是对应接口草案，不是已存在工具。

### 单一 MCP 接口

实际名称：`cockpit_advance_queue`。
功能采用用户确认的一个 MCP、三个动作，不拆成三套业务工具。
它不接收 Task ID 或提示正文，不内置发送，不理解修订与 ACK。

| action | 输入 | 效果 |
| --- | --- | --- |
| `start` | `session_id` | 为已加载目标启动推进并及时返回 `operation.operationId`，不等待整个循环完成 |
| `get` | `session_id`、可选 `operation_id` | 读取指定操作；省略 ID 时读取该目标当前或最近一次操作，便于恢复丢失的启动回执 |
| `cancel` | `session_id`、`operation_id` | 停止该操作发起新的中断，不清队列、不取消目标 session |

返回 `{operation}`，沿用宿主原生公共协议的 camelCase 字段：
`operationId`、`sessionId`、`state`、`startedAt`、`interrupts`；
终态另有 `completedAt`，失败有 `error`。MCP 输入使用上表 snake_case 名称。
未找到最近操作时 `operation:null`，不能据此声称已完成或安全重试。
`interrupts` 是已确认的中断次数，不是消息完成数、Task 进度或实时活动摘要。

| state | 含义 |
| --- | --- |
| `running` | 正在观察或推进，也可能等待原生接续；不是始终在发中断 |
| `cancelling` | 已禁止新的中断，之前发出的原生请求仍在收尾 |
| `completed` | 在完成检查点后续队列已耗尽，不再打断最后轮次；不代表 session idle 或最后工作完成 |
| `cancelled` | 推进已停止，取消不回滚之前的动作 |
| `failed` | 无法继续确认或执行；停止新增中断，保留真实错误和已发生的部分效果 |

具体一致性与生命周期约束：

- 同一目标同时最多一个推进操作。重复 `start` 返回已有活动操作及其 ID，
  不并行开循环、不重置开始时间。已结束后新的明确 `start` 才代表新的操作。
  启动回执未知时先 `get`，不自动重试 `start`，不再发送 Task ID。
- `cancel` 必须携带操作 ID，避免把针对旧操作的迟到取消作用于后来新操作。
  取消与下一次中断派发在宿主内串行协调；已派发请求不可冒充已撤回。
  对已终结操作返回其真实终态，不把已经 completed 的操作改写成 cancelled。
- 调用开始时若队列已空、也没有待确认的原生接续，则直接 completed，
  不为完成一次调用而打断当前轮次；若有过渡状态则继续观察。
- 原生消息可以合批进入同一轮。观察普通队列及公开 steering / in-flight 状态，
  不把已取出但仍在交接的消息当作已安全完成推进，不以消息数推导中断次数。
  若公开状态不足以判定接续边界，明确失败/能力不足，不用私有 store 猜测成功。
- 运行与最近终态由本体管理并可查询，不保存聊天副本，不向任何 session
  发送操作进度消息。不因 MCP 客户端断线停止，也不靠调用方轮询驱动推进。
- 宿主退出或原生 session 丢失后不能继续控制；不在恢复时自动重新启动循环。
  查询无法找回的操作须明确返回 unknown / unavailable，不能伪造 completed。
  活动操作需要纳入本体现有生命周期管理；卸载目标前必须先解决该操作，
  不能留下指向旧 native handle 的循环。具体退出与保留策略在宿主实现中对齐。

原生单次请求仍可以有传输截止；它到期且效果不确定时进入 failed，
而不是对整个业务循环增加隐藏超时，或重试同一次中断。
工具不承诺在原生持续暂停、持续新消息或无法接续时一定完成。

## 4. 前端与活动：不扩大宿主范围

### Task 卡片

现有 Markdown renderer 接收已解析的单个 link / image，保留原始 target 和消息来源。
可采用只含 Task ID 的约定链接，Task 模块据此请求自己的后端并渲染。
当前语法为 `[Task](task:<uuid>)`，两份正式 Skill 已使用此格式。

现有 renderer 要求合法的 inline phrasing 内容；可做紧凑引用卡片，
详细内容可通过 portal 打开。不能在段落里硬塞非法 block DOM，
或扫描/重写整段聊天绕过公共契约。若用户要求超出现有边界的整块卡片，
届时再说明最小展示缺口，不因此预建页面系统。

Task 记录变化可用现有模块事件提示可见卡片重新读取。事件不是持久回放；
重连需要重新读当前 Task。卡片展示读取时的当前记录，不冒充历史消息快照。

### 原生活动与任务报告

保持两种来源分开：

| 来源 | 可表达 | 不可推断 |
| --- | --- | --- |
| Task activity | 执行者最新报告的内容、依据 revision、报告时间 | session 此刻正在做同一件事 |
| native control / tasks panel | 当前读取到的运行、待决、子代理计数或公开任务条目 | 未公开的具体工具参数、下一步意图或实时业务进度 |

`session/resources` 可只请求需要的资源；未加载就返回未加载，不为展示偷偷唤醒。
现有控制资源可用，无需扫描聊天来获得“正在运行”。
更细的实时工具活动未在本节点得到足够公共契约支撑，不作为当前已承诺功能；
如果需要超出“报告动态 + 原生状态”的展示，先与用户单独确定范围。

## 5. 当前边界与后续决策

Task 模块和宿主通用能力已分别在隔离 worktree 实现。开发集成仅使用临时模块
目录和合成 session/模型服务，不读真实旧数据库，不部署、重启或覆盖现有安装，
不向上游 Owner 或任何真实 session 发消息。

用户已确认继续设计通用角色选择与装配，前端和 MCP 共同使用；
工具随角色注入，有工具即可操作其他 Task。不增加通用 caller 鉴权。
只复用已具备 Executor 能力的 session，指派不补齐能力；
本体记录创建时所选角色，MCP session 列表和详情带出该记录，不冒充实时就绪。
用户新增本体的通用队列推进 MCP 方向：动态追最新队尾，保留最后接续轮次执行；
它不是原子 idle-only 控制接口，也不属于 Task 的八个业务工具。
模块声明和公开桥接已落盘：`session/new`、`session/get`、`roles/readiness`、
`prompt`，通过 `context.host.call(name, body)` 调用，输入/结果沿用公共 intent，
不暴露 SDK handle、Engine 或内部 store。角色资源在创建与冷恢复时一致装配。
用户已要求把宿主更改纳入本 session 的交付计划，见
[分阶段执行计划](task-design.md#16-分阶段执行计划)：
节点 5H 明列 H1 模块角色/MCP 承载、H2 创建/恢复、H3 列表角色、
H4 队列推进；节点 6 完成真实集成，节点 7 覆盖两个仓库的独立审阅与保护合并。
宿主实现使用另建的独立工作区，不修改现有宿主 checkout；本次不授权部署。
不启动宿主 #63 的全面接口统一，不恢复旧模块运行时，
不增加 Task 续办、改派、工作技能包或独立管理页面。

## 6. 源码依据

宿主链接均固定到本次核对提交：

- [后端模块契约](https://github.com/waksana/cockpit/blob/3494c0b1e58ed1d1f717bf7d434534172d3e6fa8/packages/module-api/src/index.ts)：manifest、ModuleRequest、ModuleBackendContext、backend 注册。
- [前端模块契约](https://github.com/waksana/cockpit/blob/3494c0b1e58ed1d1f717bf7d434534172d3e6fa8/packages/module-api/src/frontend.ts#L509-L594)：Markdown renderer、request、事件与 portal。
- [Engine](https://github.com/waksana/cockpit/blob/3494c0b1e58ed1d1f717bf7d434534172d3e6fa8/packages/core/src/engine.ts)：newSession（约 567 行）、control（840 行）、prompt / cancel（910 行）、interrupt（979 行）。
- [公共 intents](https://github.com/waksana/cockpit/blob/3494c0b1e58ed1d1f717bf7d434534172d3e6fa8/packages/protocol/src/index.ts#L535-L552)：prompt / interrupt 的实际输入与结果。
- [MCP 请求传输](https://github.com/waksana/cockpit/blob/3494c0b1e58ed1d1f717bf7d434534172d3e6fa8/apps/mcp/src/cockpit.ts#L230-L305)：单次请求的正数超时、AbortController 与不确定结果。
- [角色未注入的现有创建契约](https://github.com/waksana/cockpit/blob/3494c0b1e58ed1d1f717bf7d434534172d3e6fa8/packages/core/src/engine.test.ts#L749-L760)。
- [当前 session 元数据与轻量列表](https://github.com/waksana/cockpit/blob/3494c0b1e58ed1d1f717bf7d434534172d3e6fa8/packages/protocol/src/index.ts#L340-L427)：SessionMeta、identity 投影与 SessionBrief，目前均无角色选择记录。
- [历史角色配置实现](https://github.com/waksana/cockpit/blob/33696b81c5d2ebe073e4700410c1cc4adabc4c1b/packages/core/src/modules/role-environment.ts)：仅供复用原则参考。
- SDK 1.0.13 本机包 `dist/types.d.ts` 的 ToolInvocation（483 行）、
  `dist/generated/rpc.d.ts` 的 SendMode（2746 行）、InterruptMainTurnRequest（9247 行）、
  steeringMessages（15755 行）和 SendRequest（16811 行）。
- SDK v1.0.13 标签已核对为提交 `f13e4a2cc7e4e220974d2333142234e162a3252e`；
  [对应 RPC 源码](https://github.com/github/copilot-sdk/blob/f13e4a2cc7e4e220974d2333142234e162a3252e/nodejs/src/generated/rpc.ts)。
  本机公开类型的 interrupt / 后台取消见 23596–23612 行，
  tasks.waitForPending 见 24137–24142 行，返回契约见 21007–21015 行。
- [SDK v1.0.13 session / MCP 类型](https://github.com/github/copilot-sdk/blob/f13e4a2cc7e4e220974d2333142234e162a3252e/nodejs/src/types.ts)：MCPHTTPServerConfig、SessionConfigBase、ResumeSessionConfig、CustomAgentConfig 与 DefaultAgentConfig。
- [SDK v1.0.13 创建与恢复参数转发](https://github.com/github/copilot-sdk/blob/f13e4a2cc7e4e220974d2333142234e162a3252e/nodejs/src/client.ts)：两条路径传入 mcpServers、skillDirectories、disabledSkills、enableSkills 等配置。
- [官方 SDK Skills 文档](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/skills)：技能父目录、启停、custom agent 预加载及 MCP 配合。
- [官方 SDK MCP 文档](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/mcp)：HTTP 配置、headers、tools 子集与冷恢复配置。
- [官方 CLI Skill 使用语义](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills#using-agent-skills)：相关性选择、正文注入及显式调用。
