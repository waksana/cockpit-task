# 安装、运行和恢复

要求 Linux、Node 24+、npm、flock、systemd user manager；Cockpit 公开接口在本机 8771。无需另一个 Copilot runtime。常驻服务数据与源码隔离。

浏览器需有中文字体；本机 headless Chromium 最初缺 CJK 字体，已补装 `fonts-noto-cjk`。工作页不从第三方 CDN 加载字体或脚本。

## 固定版本安装

标准本机路径可直接在已提交、干净仓库运行 `bash scripts/install.sh`：建立固定 commit release、按 lockfile 安装依赖，安全停止**本服务**、备份数据库、原子切换、安装 user unit、启动并核对健康 release。失败不自动回滚或重放副作用；保留 build 目录和备份供核对。MCP/skill 注册仍是后文的显式步骤。自定义数据目录需先按下文配置环境和 unit，不能仅改一次 shell 变量。

从已经验证、已提交的版本制作只读意义上的固定 release（不修改已发布目录）：

```sh
git archive HEAD | tar -x -C "$RELEASE"
cd "$RELEASE"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
# RELEASE 为事先明确创建的 ~/.local/share/work-commander/releases/<commit>
# current 用临时 symlink + rename 原子指向该 release。
```

首次创建 `~/.local/state/work-commander`（0700），将 `deploy/work-commander.service` 安装为 `~/.config/systemd/user/work-commander.service`。如 shell 没有 user bus，设置：

```sh
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
systemctl --user daemon-reload
systemctl --user enable --now work-commander
systemctl --user status work-commander --no-pager
curl --fail http://127.0.0.1:8790/health
```

用户 linger 应开启以便登出后运行；本机已经开启。不会重启 Cockpit。停止/启动/重启仅本服务：

```sh
systemctl --user stop work-commander
systemctl --user start work-commander
journalctl --user -u work-commander -n 40 --no-pager
```

环境文件可用 `~/.config/work-commander/service.env`（0600），可选 `WORK_DATA_DIR`、`WORK_PORT`、`COCKPIT_URL`、`COCKPIT_API_TOKEN`、`COCKPIT_WEB_URL`。数据目录变更同时更新 unit ReadWritePaths。首次使用不需要任何秘密写入环境文件。

## MCP 与 skill

显式授权后，`node scripts/register.js ~/.local/share/work-commander/current --confirm` 增加独立 MCP 定义和两个独立 skill symlink，保持现有定义及原 work-owner 不变。调用 Cockpit `mcp/refresh` 发现新增定义，然后立即 `mcp/global-default {name:"work-commander",on:false}` 设置原生默认关闭，再 `skills/refresh` 刷新 skill 发现；不重载其它 session。安装失败要检查实际步骤，不盲重跑脚本。


注册是用户级目录的发现入口，不等于批量启用。讨论方需显式启用 MCP `work-commander` 与 skill `work-commander`。本服务为**自己新建或明确继续的 owner**在投递前启用 MCP 和 `work-commander-owner`。不自动给其它历史 session 设置任何东西。

登记前已加载的讨论 session 可能完全看不到新定义：全局 refresh 不会重载其现有连接。须用户授权后，在该 session 空闲时执行 Cockpit `mcp/reload-session`，核对列表，再单独 enable `work-commander`；重载会重新应用全局默认。不能把 enable 未知服务器的失败当已接入，也不自动重载运行中的讨论。

管理员签发讨论方或只读凭证：

```sh
node src/admin.js issue caller ACTUAL_CALLER_SESSION_ID
node src/admin.js issue viewer
```

命令输出 credential 文件路径，不输出 token。将 caller 路径交给对应讨论 session，工具 `credential` 传路径；不要将 viewer 当 caller，不让 owner 用 caller 凭证。页面登录选择 viewer JSON 文件即可，也可粘贴其中的 token（仅本机使用，不发到聊天）。文件在浏览器本地解析，不存聊天或 localStorage。退出清 cookie；永久失效：

```sh
node src/admin.js revoke /absolute/path/to/credential.json
```

远程查看：本机 `ssh -L 8790:127.0.0.1:8790 honglai@SERVER`，浏览器打开 `http://127.0.0.1:8790/`，凭证仍必需。不把端口直接代理到匿名公网，不传 token 到第三方。

CLI 隔离客户端也可用 `--additional-mcp-config @FILE` 和显式 skill 目录接入；不要为生产真实会话另连一套 runtime。真实会话创建/fork/恢复/投递仍通过 Cockpit adapter。

## 升级与备份

升级前创建一致 SQLite 备份：

```sh
node src/admin.js backup /absolute/private/backups/work-YYYYMMDD.db
```

使用 SQLite 在线 backup，不直接复制活跃 WAL 文件。另在私有备份目录保留 `credentials/`；数据库含哈希而不是可恢复的 bearer 明文。备份目录 0700、文件 0600，属于敏感任务数据，不上传公共服务。

推荐升级时停止本服务（不停止任何 owner/Cockpit），备份，创建新固定 release，安装相同锁文件的依赖，原子切 current，然后启动，确认 health 与任务操作状态。数据库 schema 有 user_version；未知较新 schema 会拒绝启动。未来破坏性迁移必须另有备份/升级说明，不能强行降级。

恢复数据库：先停止本服务，保留现数据目录的明确备份；将指定备份恢复到**新的私有数据目录**并复制配套 credentials，设置 WORK_DATA_DIR 和 unit ReadWritePaths，再启动。不要直接覆盖仍打开的数据库，不把老 WAL 与新 DB 混用。离线备份里的 in-flight 操作恢复后会标 unknown，仍需核对。

**外部副作用不会随备份回滚**。恢复较旧备份前核对备份之后的创建、派单、通知；旧库没记录它们，不能直接重派。没有可靠差异证据就保留只读并问用户。凭证目录内路径是绝对路径，改数据目录时须保留原路径或明确重新签发/重新派单路径；不能把它当透明跨机恢复。

## 未知操作

`work_read(taskId,view:"operations")` 得到具体步骤和真实 owner。failed 可显式 `work_recover` 继续；unknown 要核对实际效果。确认 applied 则跳过该步骤；确认 not_applied 才允许再次尝试。创建 applied 必须提交准确 sessionId。没有通用轮询或自动重试线程，不会每次启动重发消息。

## 旧账本迁移

本次不迁移旧工作。`node src/admin.js migration-preview manifest.json` 只验证显式清单中的 workstream/ownerSessionId/callerSessionId/goal/authorization 和冲突，导入/投递都为零，不读取旧聊天。

正式切换前用户明确选定目标范围，暂停写入旧账本，核对每条授权/暂停/版本/真实 owner/caller，确认一份真相。可将批准的静态记录作为只读历史导入另行实现；绝不能导入即派单、改 caller 或唤醒旧 owner。没有自动批量迁移命令是刻意的权限边界。
