# 本机交付实证（2026-09-10）

服务由 systemd user unit `work-commander.service` 托管，固定 release 经 `current` 原子切换，监听 `127.0.0.1:8790`；开机/登出驻留使用本机已有 linger。当前精确版本以 `/health` 的 release 为准。数据库、凭证及私有备份位于 `~/.local/state/work-commander`。

## 真实协作，不是模拟 agent 回执

隔离 Astra 讨论方 `be544a1c-4548-490e-b340-9646e9175754` 加载 `work-commander` skill，经真实 MCP `work_dispatch` 新建 owner `26b2f4fb-ee90-4a9b-9e48-e0dc1d77a995`。owner 加载 `work-commander-owner`，真实执行 accepted → progress → 明示模拟 blocked → progress → 文件写入和读取 → result → delivered。服务唯一通知 caller；caller 自己按需读取并给出最终答复，没有 ACK 链。

任务 `1e8290b3-ff84-408d-8700-5790a5af239b`，workstream `fixture-collaboration-20260910`。同任务显式修订 v2 后，原 owner 被冷恢复，重新承接，演练 needs_decision/解除，再次完整交付。两版本各有一次最终通知；重放原 v2 交付请求没有增加通知。旧 v1 新回执被 STALE_GOAL 拒绝，caller 越权代报被 FORBIDDEN 拒绝。

v2 真实产物 `/home/honglai/work-commander/.local/fixtures/owner/result.txt`：

```text
work-commander fixture complete
version 2
```

末尾有换行。工作页与 MCP 展示同一任务 v2/delivered。真实 Chromium 中完成只读鉴权、SSE 连接、四栏和详情展示；1600px 与 390px 视口均无横向溢出。匿名数据请求 401。凭证未写入浏览器 localStorage 或聊天。

## 实际成本和真实限制

| 动作 | 服务内基础 HTTP 调用 | 基础响应字节 |
| --- | ---: | ---: |
| 首次新建，含 Astra 切换与确认 | 7 | 3938 |
| v1 最终通知 | 1 | 11 |
| v2 冷恢复，含一次明确核对后的恢复 | 8 | 4418 |
| v2 最终通知 | 1 | 11 |
| owner 报告 / 默认工作查询 | 0 | 0 |

首次派单 MCP 内容 691 字节；v2 默认简表 668 字节。操作指标是基础 HTTP 调用/响应体，不是原生 RPC 数或模型 token 数。宽 `session/get` 的原生内部成本没有消失。

v2 第一次在 MCP enable 遇到真实 `MCP connections are still settling`（HTTP 500），服务保留原 owner、resume 完成步骤及 unknown，未发 prompt、未新建替代 owner。限定核对原生状态和精确错误的未提交位置后，caller 显式 work_recover 恢复成功。外部核对读调用和源码/日志定位不计入上表，不能将“8 次”冒称本次排错全部成本。此基础能力限制详见 [契约](contract.md)，没有静默 sleep/自动重放来掩盖它。

## 恢复与交付边界

18 项自动覆盖包含真实 stdio MCP、HTTP 权限、并发、目标版本、重复报告、创建/投递/通知未知结果、SIGKILL 后恢复及内核锁、SSE 与 SQLite backup/restore。真实部署升级重启后，任务、版本、操作和结果仍一致。操作 unknown 不会因重启自动发送。

独立 MCP 已注册并设置**原生默认关闭**；两份独立 skill 已被原生发现。没有改原全局 work-owner、替换旧 tasks.md、迁移旧任务、重启 Cockpit、修改并行 owner 的代码或微信发送。正式旧账本切换与公网接入仍须单独确认。

用户随后明确批准实际讨论方接入：仅对空闲的 `8d3fc61c-10a6-4cf1-9a00-07346b6514e7` 执行原生 MCP reload，确认 work-commander connected/enabled，讨论 skill 已 enabled，并签发绑定该 session 的 caller 凭证。**只用于新任务，旧任务不迁移**。未加载/修改其它历史 owner；fixture 会话是本项目明确创建的测试资源。

可复现实证入口：`npm test`；`scripts/mcp-call.js`；`scripts/fixture-check.js`（仅允许 fixture-*）；`scripts/browser-probe.js`（使用本机已有 Chromium，不安装额外浏览器）。真实 fixture 会话保留历史、可卸载休眠，不作为常驻指挥角色。
