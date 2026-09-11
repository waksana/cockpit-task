# Work Commander

独立的工作服务 + SQLite + MCP + 两层协作 skill + 私人工作页。Cockpit 仍是唯一真实会话基础服务；这里不保存聊天、模型目录或会话状态副本，不运行指挥 agent、巡查器或自动调度。

**Cockpit Task 是面向 agent 的结构化工作记录与操作服务，主动方是 agent。** 从实际协作中形成的通用约定由 schema 承载，统一身份、状态、关系和结果表达，降低沟通成本并直接支撑 Dashboard；skill 指导何时、为何调用，agent 判断具体内容与下一步。Commander 显式派单，owner 主动写回；Task 执行指定操作，不主动监工、验收或推进任务。看板反映最近报告，不是实时监测。详见[定位与契约](docs/contract.md#定位供-commander-使用的工作工具)。现有 MCP、skill 和安装技术名称仍保留 `work-commander`。

**一个 MCP，两份协作 skill**：`work-commander` 给讨论方，`work-commander-owner` 给执行方，规定目标、授权、结果责任和服务报告；工程方法遵守目标项目规范，Git 服务开发按需使用独立模块的 `service-development`，不在协作正文重复。权限由 caller/owner 凭证决定，不靠自报 sessionId；本服务最终通知统一由服务发送。旧 `work-owner` 已退役，旧在途任务兼容及工程承接见[入口切换](docs/operations.md#协作入口与旧定义退役)。

## 使用入口

- 外部只读工作页：[task.rbym47.com](https://task.rbym47.com/)，由现有 Passkey Gate 保护；新主机需设备验证，不在浏览器放 Task 凭证。接入与边界见[HTTPS 工作页](docs/passkey-access.md)。
- 工作页不包含登录、凭证输入或认证管理；本机 API/MCP 的 bearer 鉴权仍保留，浏览器通过上方受保护入口访问。
- [工作台阅读与交互](docs/dashboard.md)：真实已加载数量概览、按阶段分组的单列表、独立分页与任务详情；包含隔离合成预览方式。
- 服务：`systemctl --user status work-commander`；数据 `~/.local/state/work-commander/`。
- MCP：`node <安装目录>/src/mcp.js`（stdio），默认连接本机 8790。
- 文档：[待办与统一记录](docs/backlog.md) · [接入和运行](docs/operations.md) · [工具与可靠性边界](docs/contract.md) · [统一迁入范围与交付](docs/unified-records-delivery.md) · [首版实证](docs/acceptance.md)。
- 显式前置：`work_dependency add/remove`，查询复用 `work_read`；[语义与调用](docs/task-dependencies.md)。只维护同 caller 的直接关系和条件，不自动派工或修改执行状态。
- 验证：`npm test`；开发启动：`npm start`，同数据目录持有内核独占锁。

## 运行版本与安全退出

`GET /version` 返回启动时捕获的 `SERVICE_DELIVERY_SHA/ARTIFACT/REQUEST/INSTANCE` 身份及实际包版本；
`GET /health` 使用同一 `instanceId`，均禁止缓存。源码启动未设置这四项身份时明确返回
`sha:null` / `artifactSha256:null` / `identitySource:"unknown"` 并生成独立 UUID，不读取 Git HEAD 冒充已部署版本。
交付身份四项必须全部提供且合法（40 位 SHA、64 位 artifact SHA256、非空 request、UUID instance），
部分或畸形配置会拒绝启动；`/version` 的规范字段为 `sha`、`artifactSha256`、`requestId`、`instanceId`。
`GET /status` 只读返回 admission、在途 mutation/dispatch/notification/recovery 数量、总数 `inFlight` 和退出原因；
`POST /admin/restart {"pending":true}` 同步关闭新 mutation admission，重复调用幂等，
等已经接受的真实执行及通知结束才退出，不等仍在 Cockpit 中执行的业务 owner。
排空期间认证读取继续可用，新 mutation 返回 `503 SERVICE_DRAINING`；静态读取/SSE 不阻止退出。
没有强制超时、取消操作或自动恢复重放。

管理入口只接受通过现有 Host 防护的非浏览器 loopback 客户端（拒绝 Origin / Sec-Fetch-Site 等浏览器元数据；
允许 Node fetch 单独发送的 Sec-Fetch-Mode）。
本机同用户可信边界不是恶意本机进程隔离；不应将端口或管理路径代理到公网。
可选 `WORK_ADMIN_TOKEN` 要求单独的 bearer 管理凭证，不使用 caller/owner/viewer 凭证；
未配置时供可信本机 runner 无凭证调用。`service-delivery.json` 声明交付契约，不代表 runner 已安装。
首次迁移的旧进程**没有**此 drain 协议，须另行批准维护切换并确认真实在途操作已完成，
不能把旧 `/health` 当安全退出证明。新 unit 使用无限 stop 等待，安装前旧 unit 的 75 秒强停限制仍存在。

一句话用 `work_record` 登记待办，零会话副作用；补齐授权后通过 `work_dispatch` 在**同 taskId**开工。同目标继续原 owner。元数据用 recordRevision，执行目标/授权用 goalVersion；只有后者变化才 `work_amend`。owner 报告/交付仍用 `work_report`、`work_deliver`。默认 `work_read` 返回 10 个未结束简表，完成历史按需查，不查询 Cockpit。

**统一记录**：用户批准的旧任务保留原始来源后迁入，历史 owner/caller 引用与真实执行绑定分离。迁入不派工、不唤醒 owner、不发旧回执；切换后的 Markdown 仅留入口，不再双写状态。旧回执由讨论方 `work_observe` 带来源登记，不能冒充 owner。单用户本地部署不隔离恶意同用户 agent；现有 Cockpit 宽读取和未知副作用仍如实暴露。
