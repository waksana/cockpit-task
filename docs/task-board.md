# Task

Task (`cockpit-task`) runs inside Cockpit, not as a standalone daemon or dashboard.
Its current source version is `0.0.0-dev`; merged main PRs attempt immutable Rolling
publication. Current data is schema12; existing databases require the
[explicit reviewed migration](https://github.com/waksana/cockpit-task/blob/main/docs/task-responsibility-migration.md), never inferred modes
or replayed effects. Source changes do not deploy, restart or migrate an installation.

## Requirements

Node.js 24+, Module API v1, Web API v2/UI v1 and shared-surfaces v1,
module roles, public host.call, exact MCP server key and service-ready v1 are required.
Activation checks host capabilities before opening storage. The documented UI source
baseline is `1d37f04335ce9328ce1e37b59e5a4a8564709a0b`, including
sessionListItemVersion=1, menuVersion=1 and globalComponentVersion=1, not a deployment claim.
MCP calls need host-injected `_meta["cockpit/invocation"].sessionId`.
Explicit resource selections additionally need resourcePreparationVersion=1 and
session/resources-prepare; omitted selections preserve ordinary session creation.
See the [host contract](https://github.com/waksana/cockpit-task/blob/main/docs/task-host-contract.md); no private runtime/credential fallback.

## Session Task entry

The session list adds one non-interactive, neutral badge before the existing details
on the directory/roles/activity line: a static 16px lifecycle icon and
`Root` / `Branch` / `Leaf`. It adds neither another line nor a repeated Task title.
Only the icon uses status color; Task progress is independent of native session
activity. The full Task title, lifecycle and position remain in the badge's
accessible name and existing details; the menu entry includes the Task title.
Clicking the row still selects the session and other modules' contributions remain intact.

Lifecycle icons use Lucide `Square` (to do), `SquarePlay` (in progress),
`SquareCheck` (done) and `SquareX` (cancelled), consistently across the session
badge, Task card and details. Cancellation is neutral, not an error.
Blocked prerequisites and cancellation intentions supplement the actual lifecycle
rather than replacing it with a pause or terminal cancellation icon.

Only actual assignee bindings count. An unfinished Task takes precedence; otherwise
the latest recorded assignment stays visible after completion/cancellation. Creation
order, creator and update timestamps never choose the Task. Untracked historical
assignment order is explicitly unknown, not an invented latest Task. A parentless
Task is `Root`, including a single-node tree; a child with children is `Branch`,
otherwise `Leaf`. Terminal children still count.

The session menu's **Current Task** or **Recent Task** opens the existing Task details.
The open dialog keeps its captured session/Task identity through navigation and newer
bindings. Closing the menu does not close it; losing the module or target session does.
Loading, disconnected and failed reads remain separate from the four Task lifecycle
states. Retained snapshots keep their lifecycle and position, with an explicit
`Updating`, `Not synced` or `Read failed` notice and an unconfirmed accessible name.
Without a snapshot, the badge shows text only (`Task loading`, `Task offline`,
`Task read failed` or `Task unconfirmed`), never a question mark or invented position.
Unknown Task cards use a neutral document icon, not the native session's ask icon.
The menu offers an explicit read retry after failure. Confirmed sessions without a
Task have no badge or entry.

This feature requires `sessionListItemVersion: 1`, `menuVersion: 1` and
`globalComponentVersion: 1` in addition to the existing UI contract. The module
refuses unsupported hosts rather than using private Sidebar styles or DOM injection.
Rows and the active header share event-driven batches of at most 100 session IDs;
there is no per-row polling, native session inspection or eager Task detail read.

## Roles and records

The `node` role provides the short responsibility model and Task tools, plus
independent `cockpit-task-tree` and `github-coding` Skill discovery roots. Load bodies
when needed; enabled is not read, and children do not inherit the parent's loaded context.
Legacy owner/executor roles have no aliases. Role migration is an operator concern,
not a tool permission to edit native settings or an automatic Task assignment.

The optional `advisor` role contributes only `task_read` and the independent
[cockpit-task-advisor guide](../skills/cockpit-task-advisor/cockpit-task-advisor/SKILL.md).
People and agents can use it to locate a responsible session, choose Node capability
for continuing work and understand Task modes without becoming an assignee.
Task metadata assists discovery; actual native session/Chat remains the business
conversation source. There is no new module or built-in dependency in a conversation
entry point.

Select `{moduleId: "cockpit-task", roleId: "advisor"}` through ordinary host role
composition, alongside existing roles. Its read-only contribution is not a sandbox:
other selected roles retain their tools, and combining `node` and `advisor` unions
their same-endpoint tool sets. No roles are automatically added to existing sessions.
Saved role additions need an explicitly authorized reload/cold load; they are not
applied or ready merely because saving succeeded. Check actual tools and Skills
before use, never force a busy session to reload. The advisor contributes no session
creation or messaging tools; those come from separately available capabilities.

Task is a continuing work-specific agreement. The Agent's own assignee is its only
binding; parent_assignee derives from the current parent. Creation provenance gives
no management rights. A root is simply parentless, not a special session or hidden owner.
One session has at most one unfinished Agent Task. Modes and native activity are separate:

| Task mode | Responsibility |
| --- | --- |
| undecided (new todo) | Read, clarify and limited discovery, no implementation/children |
| execute (in_progress) | Direct research, implementation or review |
| orchestrate (in_progress) | Narrower children, dependencies, blockers, decisions and result integration |

Both modes may use internal helpers, whose results remain the caller's responsibility.
Helpers may only call `task_read` and `task_script_read`. All maintenance, including
activity, belongs to the main agent; helper writes fail with `SUBAGENT_WRITE_FORBIDDEN`
before effects. This does not restrict independent child-Task main agents.
Formal children are for independent continuing responsibility, not a tool-count rule.
Orchestrators keep sustained implementation/deep investigations in children. Convert
explicitly before splitting execution; preserve prior results and remaining responsibility,
never pass the agreement unchanged downward or downgrade once orchestrating.

## Tools and normal use

1. Register an authorized agreement with task_create. A caller without active work
   creates an ordinary unbound root; task_claim binds its ready Node without self-message,
   title change or caller idle requirement. Web user can externally assign a root.
   Claim may bind a blocked root for clarification; it is not ACK or start.
2. A bound active orchestrating parent creates narrower children only when acknowledged,
   ready and free of cancellation intent. Prepare an eligible existing/new Node and
   task_assign it; no takeover, extra role installation or proactive interruption.
3. Read execution, ACK exact revision, then task_start atomically selects execute/
   orchestrate and in_progress. Registration, preparation, binding and ACK are not start.
4. Read/ACK again on resume, before consequential actions and delivery. Record important
   activity, actual evidence and changed agreements; handle definition_check even on failures/replays.
5. task_report(done) requires in_progress, current ACK, ready, no own intent and all direct
   children terminal, plus a new outcome and explicit retro text/null. No todo→done.

Descriptions contain work-specific goals, decisions, boundaries and completion requirements;
reference external procedures rather than copying history. Only the own assignee's actual
unfinished-description change auto-ACKs. An outcome's current flag compares revision,
not goal achievement; useful child retros inform the parent's own outcome/retro.

## Cancellation, trees and prerequisites

task_cancel records Agent intent, even on a leaf. Stop goal progress, arrange child
closure and residual handling, then bound assignee task_cancel_finalize records disposition;
Web user finalizes unbound work. Both done and final cancelled wait for every direct
child done/cancelled. No blind cascade or coordinator-first exit. Cancellation need
not satisfy abandoned prerequisites or ACK and never proves external exit/rollback.
Existing child done may close under active bound orchestrating ancestors' intent/blockers;
its own intent still forbids done. Ancestor intent still forbids new start/create/assign/
convert/attach, not orderly closure of existing work.

task_attach places an existing unfinished root under another session's active orchestrate
parent, preserving binding/scope/subtree/history. Current authority and notices follow the
parent relation, never creator history. No fixed three-level cap; cycles and bounded
resource operations still reject, and there is no detach/arbitrary reparent escape.
Long-lived roots can wait without creating new work or auto-closing when children finish.

Authorized task_reopen preserves mode and original eligible assignee. Reliable assignment
tracking, no later assignment/other unfinished responsibility, readiness and valid active
ancestors are required. Restore ancestors legally first; cancelled or ineligible ancestors
block in-place reopen. Unknown legacy mode needs explicit review, not inference.
No new dispatch, subscription renewal, revived old dependencies or old outcome substitution.

blocked_by contains explicit Task-ID/condition prerequisites, not all children.
Task-ID waits for that execution's done, not success; cancelled does not satisfy it,
and reopen does not reactivate a resolved relation. Own assignee can resolve a satisfied
condition with task_resolve_condition, exact dependency_id and recorded evidence.
Parent/user can do so too; changing meaning or scope is not satisfaction. Edit cannot let
the assignee bypass this evidence path or remove Task-ID dependencies through it.

## Writes, failures and recovery

Mutations use caller-scoped request_id; helpers may read that session's receipts,
but cannot replay writes. MCP writes require explicit `subagent: false` and
`runtimeSessionId === sessionId`; missing or inconsistent provenance fails with
`INVOCATION_REQUIRED`. Web-user and service-managed automation paths are unchanged.
Replay original inputs; new writes return current opaque write_context. Structure/mode/intent
changes participate in concurrency guards. Read result/error/definition_check separately.
Saved old ACK activity may coexist with rejected stale outcome/status; do not repeat it.
Creation, resources, capability, binding, message acceptance, ACK and start are separate.
Native idle/unloaded or a notification is not delivery or authorization.

On uncertainty read the original operation before action. Preserve known created/bound
resources; no blind retry or replacement. Only a final receipt proving assignment=applied
and message=not_sent supports one explicit resume_request_id with fresh context and same
Task/assignee. Unknown/queued/accepted/pending does not. Unattributable legacy request IDs
remain reserved and reject, not become runnable after migration.

## Collaboration and references

Formal nodes coordinate only through Task facts and service notices, not direct/helper
messages. Every node asks users directly for real decisions, without duplicate questions.
Changed answers enter the agreement; parent processes cross-Task facts, not an approval relay.
Use `[Task](task:<uuid>)`; service event cards are fixed task: pointers, not free-form notes.
Cancellation intent is `[Task cancellation requested]`, distinct from historical cancelled.
Current relation validation prevents stale child/dependency cards being sent to a new parent.

Default to no subscription. A future status must unlock specific necessary action;
Web user chooses subscriber explicitly, never by creator fallback. Do not poll, chase ACK
or await notice consumption; cancel obsolete waits, no automatic renewal.
Notifications preserve delivery failures separately from saved outcomes. Startup expires
old pending assignee notices; onReady recovers only eligible known-unattempted other notices.
No exactly-once host delivery claim or automatic retries.

## Automation

Existing reviewed trusted repeatable scripts may use automation: immutable registration,
create snapshot, optional necessary subscription, explicit start. No Agent binding/mode/ACK/
report or session slot. Child creation/start still respects current parent responsibility;
root automation management belongs to Web user. Finished failed/interrupted runs may be
done; inspect outcome/run facts/barriers rather than infer success. Existing Linux process
group cancellation/reconcile safeguards remain; no temporary script to bypass Agent delivery.
See [automation](https://github.com/waksana/cockpit-task/blob/main/docs/task-automation.md).

## Module API and packaging

POST /read and POST /tools/:name share service/storage. GET /tasks/:id/native passively
reads the bound session; /mcp uses official stateful Streamable HTTP POST/GET/DELETE.
Protocol reconnect/cancellation does not undo or authorize repeating business effects.
SQLite lives only in the host module dataRoot; no chat/credential/native-state copying.

Development initialization and commands are in [README](https://github.com/waksana/cockpit-task/blob/main/README.md#开发与打包).
Packaging produces dist/cockpit-task-&lt;version&gt;.tgz plus checksum; the archive includes
runtime assets, Skills, Node prompt and explicit migration CLIs. Tests use synthetic data.
An archive is not installation; immutable Rolling identity, compatibility, release recovery
and separately authorized installation/migration use [Releases](https://github.com/waksana/cockpit-task/blob/main/docs/releases.md).

## 焦点与详情阅读

卡片显示当前责任、模式、状态、要求/ACK、活动数及刷新；事件只是固定历史消息原因。
详情按需读完整资料、父/直接子项/祖先、责任事件及历史，不载入无界整树。
Task 与 passive native 观察分开。缓存按 identity/version，后台更新保留内容，
错误标记未确认；普通聊天 invalidate 不重读旧卡。
原生 dialog 管理焦点与关闭；版本用 details/summary，展开才读，收起保留焦点。
局部重试/分页保持连续性，后台刷新不抢焦点；只用公共 UI surfaces/tokens。

更多：[设计](https://github.com/waksana/cockpit-task/blob/main/docs/task-design.md) ·
[Schema](https://github.com/waksana/cockpit-task/blob/main/docs/task-schema.md) ·
[MCP](https://github.com/waksana/cockpit-task/blob/main/docs/task-mcp-contract.md) ·
[Skills](https://github.com/waksana/cockpit-task/blob/main/docs/task-tools-skills.md) ·
[实现](https://github.com/waksana/cockpit-task/blob/main/docs/task-implementation.md) ·
[历史回放与当前验收](https://github.com/waksana/cockpit-task/blob/main/docs/task-lifecycle-testing.md)。
