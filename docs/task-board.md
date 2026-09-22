# Task

Task is a Cockpit module for independent work records shared by Owner and Executor.
Its module ID and HTTP MCP key are `cockpit-task`, source preparation version `0.1.8`.
It runs in Cockpit, not a standalone daemon or dashboard.

## Requirements

Use Node.js 24 or later and a host with Module API v1, Web API v2/UI v1, module
roles, the public `context.host.call` bridge, exact declared MCP server keys, and
service-ready lifecycle v1. `context.serviceReadyVersion === 1` and the post-listen
`onReady` callback are required for pending notification recovery.
The service-ready requirement is checked before storage opens or migrates;
a release label or API-v1 alone is insufficient. Missing public capabilities fail
explicitly, without private-access fallbacks. See the
[host contract](https://github.com/waksana/cockpit-task/blob/main/docs/task-host-contract.md).

Explicit resource preparation additionally requires
`context.host.resourcePreparationVersion === 1` and `session/resources-prepare`
([waksana/cockpit#98](https://github.com/waksana/cockpit/issues/98)); unsupported hosts reject
before resource-aware creation or preparation effects. Omitting resource selections
preserves legacy creation. This is separate from the unchanged UI support baseline
`9fd5204bda99a8bd65b2c5ef152cc47ce87837d5` / `uiSurfaceVersion: 1`.
Source support is not a release or deployment claim.

## Roles and records

Choose Owner, Executor or both through the host's role management. The host
assembles role System Prompts, Skills and HTTP MCP subsets, persists the selection
and reassembles it on cold resume. Host role changes for existing sessions are
separate from Task operations: Task does not expose that mutation or automatically
add capabilities during assignment.

| Role | Responsibility |
| --- | --- |
| Owner | Clarify, register, explicitly assign and follow independent Tasks |
| Executor | Deliver one entire assigned outcome, organizing internal steps/subagents |

Agent Tasks remain the default. Owner may explicitly choose a trusted repeatable
known script instead, using a service-managed automation Task—not arbitrary work,
a fake Executor or a child-Task workflow. See
[lightweight automation](https://github.com/waksana/cockpit-task/blob/main/docs/task-automation.md).

Owner may investigate read-only and answer questions, but delegates implementation
and state-changing delivery by default. An outcome request is not a request for
personal execution. Explicit personal-execution instruction or a real assignment
as a capable Executor is an exception; dual-role selection alone is not.
Unavailable delegation is a blocker, not permission to take over.
For coding, Issue maintenance, preparing the isolated environment and safe
post-merge cleanup are Owner coordination, not permission to implement code.

One session can execute at most one unfinished Task, then be reused after
completion/cancellation. Tasks are flat references: no child Tasks, dependency
engine, reassignment or terminal reopening. Review is optional unless the Task's
requirements demand it; Executor can complete without a default Owner approval gate.
Work methods remain separate from role collaboration.

The active Skills are [cockpit-task-owner](../skills/cockpit-task-owner/cockpit-task-owner/SKILL.md)
and [cockpit-task-executor](../skills/cockpit-task-executor/cockpit-task-executor/SKILL.md).
Load when first needed, reuse guidance in context, and reload only when missing,
changed or unclear. Each bundles its own on-demand references; stable Skill reuse
does not replace fresh Task reads.

Both roles also discover the same self-contained
[github-coding](../skills/github-coding/github-coding/SKILL.md) work Skill through
their declared discovery roots; selecting both deduplicates that resource.
Applicability depends on changes intended for commit to version-controlled repository
files, not GitHub mentions. Deployment of existing verified artifacts and runtime
configuration use Task without this Skill requiring Issue/PR/branch/worktree;
project policies, immutable installation requirements and separate deployment
authorization still apply. Owner's default delegation responsibility is unchanged.
Mixed delivery stays one Task with Issue/PR only for necessary repository changes.
If changes emerge later, update that Task and obtain Owner-coordinated Issue/environment
preparation before editing, not a new deployment Issue or stage Task.
For initially known changes, Owner prepares clean current mainline, a dedicated branch/worktree and environment,
then reuses or creates an Issue before Task. Executor owns implementation, checks,
independent review and authorized PR merge. Owner safely removes only this work's
merged temporary resources once no longer in use and restores clean current mainline.
Task done means the complete agreed delivery, including separately authorized
non-coding work in a mixed Task, not code merge alone or proof of cleanup/session idle.
Routine cleanup can be deferred and batched; it does not by itself justify waking
Owner for each Task. Record PR/branch/path and explicit resource-release evidence.
Subscribe only if the future status unlocks necessary authorized Owner action.
If cleanup is blocked, ask the user directly about the blocker and what is needed
to continue. The consumed done subscription will not wake Owner again when it clears.
After the user's answer, reread current evidence before cleanup; do not create a
new Task, resubscribe or poll.
Reuse existing environments, preserve others' changes, respect PR-only boundaries,
and skip GitHub-specific steps for non-GitHub repositories. No release or deployment
is implied. Issue/PR/environment evidence uses existing Task references and metadata.

Description contains the full current agreement. Revision/changelog version only
that description. Activity records reported execution against an actually ACKed
revision, not live native progress. ACK never starts work or adds activity.
Only the assigned Executor's actual changed-description edit on an unfinished
Task auto-ACKs the new revision. Terminal definitions can be edited without reopening.

## Tools and normal use

| Tool | Use |
| --- | --- |
| `task_read` | Bounded views with optional overview include groups; histories/logs stay paginated |
| `task_create` | Register an Agent todo or immutable automation snapshot; never execute |
| `task_script_read` | Discover/read immutable trusted local script registrations |
| `task_script_register` | Register an existing script, fixed argv and ordered typed parameters |
| `task_automation_start` | Explicitly enqueue automation once with revision/write_context |
| `task_automation_reconcile` | Clear a proven-safe process-group barrier; never rerun or mark done |
| `task_session_create` | Create an Executor, optionally preparing explicitly selected native resources |
| `task_session_prepare` | Prepare a loaded idle Executor with no unfinished Task; no creation or dispatch |
| `task_assign` | Check an existing Executor, bind once and send one assigned reference |
| `task_edit` | Replace the complete description or edit title/materials |
| `task_ack` | Confirm the current definition separately from status |
| `task_report` | Explicit activity, status and/or outcome; Agent done requires a new outcome and explicit retro text or null |
| `task_cancel` | Cancel Agent without stopping its session; request automation termination, never rollback |
| `task_subscribe` | Optional one-shot Owner wait for explicit target statuses |
| `task_unsubscribe` | Cancel a still-waiting subscription |

Owner receives read/create/session_create/session_prepare/assign/edit/cancel/subscribe/unsubscribe
plus script_read/script_register/automation_start/automation_reconcile;
Executor receives read/edit/ack/report/cancel (all `task_` prefixed). Both roles
take the union. Having a tool permits cross-Task operations: responsibility
fields are not per-record authorization. `actor_session_id` is reported provenance,
not verified identity.

The following is the default Agent flow. Automation uses discover/register → create
snapshot → optional necessary subscription → explicit start. No assign/ACK/report,
session slot or auto-subscription; a persistent single service queue executes it.
Read the latest Task/outcome on a notice, not a monitoring loop. Queued/starting/running
definitions freeze; script/inputs never change. Started work never reruns after recovery.

1. Owner chooses authorized work resources/environment and registers the complete
   Task. Backlog registration alone does not dispatch.
2. Create with optional `skills` / `mcp_servers`, or explicitly prepare an eligible
   existing Executor; inspect the operation receipt. Exclude every Executor bound
   to unfinished work, even if idle. No preference for new or reused sessions is imposed.
3. Assignment checks capability and native idle/empty state, binds, rechecks and
   sends exactly one assigned reference. Owner does not duplicate it.
4. Executor reads `execution`, ACKs the exact current revision, then explicitly
   reports `in_progress` when work starts.
5. At meaningful checkpoints and before consequential actions/delivery, read the
   latest requirements, reconcile changes and ACK as necessary.
6. Record meaningful activity and blockers. Complete delivery, then briefly
   reflect before reporting `status=done`, a new outcome and explicit `retro`
   text or null in the same request. Ordinary reports omit retro.

Keep retro useful and evidence-based: observed automation candidates, specific
slow/repeated sticking points, or Skill/MCP discovery, contract or capability
harness gaps. Distinguish observations from hypotheses and external waits;
never fabricate timings. No mandatory sections or filler: no findings means null.
Retro neither replaces outcome/blockers nor authorizes improvements or scope
expansion. It creates no notifications, dispatch or mandatory Owner review.
The service guarantees submission, not thought or text quality. Automation
does not run an Agent or submit retro.

Resource names must already be discoverable; preparation does not infer them from
Task text, install/authenticate, alter unrelated choices or global defaults, reload,
change roles/models or send a prompt. Explicit empty selections still request preparation.
Tool availability is checked against the actual filtered offered table.
Skill enabled is not body loaded; MCP connected is not tool offered; initialized
tools are not final readiness. Executor loads relevant Skill bodies when first needed.

Owner finds Tasks with `task_read(view=list, owner=<own session ID>)`; actor is not
that filter. For one Task, select only needed groups in one overview read:
`include=["context"]` for status/version, `["activity","outcome"]` when both explain
the necessary next action. Outcome can be null; no guess-and-fetch sequence is needed.
Retro, definition, automation and cancellation are also opt-in groups. Omit include
for existing overview defaults. Selection has a 48,000 serialized-character budget
and explicit overflow errors, never truncated records. Read full definition before
editing; Executor still reads execution and ACKs current requirements. History/log
pagination remains separate. An available current outcome does not itself prove delivery.
Default overview/list show retro status and attribution without text. Execution/definition
and outcomes expose it independently: `recorded` text or explicit null,
`not_recorded` for missing history, `not_applicable` for automation. Owner reads
on demand. The detail view separates completion retro from outcome; original
revision/attribution remain visible after edits, with `current:false` for historical
reflection. Legacy history is never backfilled as no findings.

## Writes, failures and recovery

Every write requires a stable request_id. Exact-input replay preserves original
effects; the same ID with changed input conflicts. Existing-Task writes also
send back the read's opaque write_context, except unsubscribe, which checks the
specified subscription's waiting state. Description revision is not a general
lifecycle concurrency token.

Read `result`, `error` and fresh `definition_check` independently, including on
failure or replay. Old activity can save while stale status/outcome fail; do not
repeat saved activity or relabel it to satisfy new scope. Exact ACK history matters:
ACKing v3 does not prove a skipped v2 was acknowledged.

Creation, resource preparation, capability, binding, message acceptance, ACK and actual execution are
different facts. Assignment does not add roles, repair capability, reload or
create a replacement session. Capability readiness is explicit and on demand,
not a list/detail badge; native busy/queue/decisions/background work are checked
separately. The check and enqueue send are not atomic, so a race can produce
queued or unknown results. Neither is safe to resend.

Inspect `task_read(view=operation,request_id)` for durable step results.
Failure-time `availability_reasons` and `observed_at` explain an observation,
not live status; receipt reads/replay do not refresh them.
Preserve created or bound resources after partial failures.
Resource-aware create/prepare receipts retain `preparation`, host `resources` step
effects and separate final `capability`. Read the receipt and current state before
an explicit new preparation request after a known failure; unknown effects never
justify blind retry or replacement. Preparation rejects pending role reload and
any unfinished Task binding; it is not a repair mode for an assigned Executor.
Only an unused final assignment receipt proving `assignment=applied` and
`message=not_sent` supports explicit resume_request_id recovery with a new request
ID, fresh context/revision and the same Task/Executor. Unknown, queued, accepted
or pending sends do not. Cancellation does not stop native work or undo external effects.

## Collaboration and references

Requirements, decisions, progress and outcomes belong in Task, not a second chat
ledger. Executor asks the user directly in its own session; neither role starts
an Owner/Executor conversation for progress, confirmation or clarification.
No direct or subagent-relayed Executor messages to Owner. User-facing summaries
are allowed. Ordinary edits/reports stay silent without an explicit subscription.

| Purpose | Reference |
| --- | --- |
| Ordinary reference | `[Task](task:<uuid>)` |
| Entire automatic first dispatch | `[Task assigned to you](task:<uuid>?event=assigned)` |
| Explicit important-update notice | `[Task updated](task:<uuid>?event=updated)` |
| System notice from a status subscription | `[Task status updated](task:<uuid>?event=status_changed)` |

Pass only the UUID to tools. Event values are exact lowercase URL metadata, not
Task fields, commands or inferred states. Generic references have no event title;
unknown events or malformed queries remain unclaimed. Use `task:`, not relative
`task/<id>` file-like paths.

The frontend renders an inline reference card and current-data detail dialog,
not a separate dashboard. Message reason is fixed; title, state, definition and
history are fetched from Task. Native session observations are labelled separately,
read on demand and never imply business progress or capability readiness.

For an exceptionally important change that cannot wait for checkpoints, Owner
follows the [important-update handoff](../skills/cockpit-task-owner/cockpit-task-owner/references/important-updates.md):
save the updated Task, preserve pending content before removing saved IDs, handle
new arrivals explicitly, and if needed interrupt the main turn once while
preserving the queue. Send one preserved-context summary followed by an updated
reference and an instruction to read/ACK the latest revision. Do not copy description,
blindly Stop/clear unread messages, cancel background work or loop interruptions.
`task_edit` never sends this notice automatically.

### One-shot status subscriptions

Default to no subscription. Register only when a future status enables a concrete,
necessary Owner action—not merely knowing progress or confirming completion.
Do not invent work or approval gates to justify waiting. Choose the fewest useful
targets and withdraw the wait if the follow-up is no longer needed.
Executor never waits for subscription or notice consumption before delivering.

Registration already in a target state fails without subscribing or notifying.
Each Task permits one waiting subscription; the first matching committed
transition consumes it. An unmatched terminal transition expires it.
Same-state reports, edits, ACKs and activity alone do not trigger.
Unsubscribe cannot recall a consumed notification or host queue item.

The system enqueues one status_changed reference to Task.owner without interruption
or queue clearing. Owner reads current evidence, reassesses the necessary action
and does not automatically re-subscribe, poll or hold a model turn open.
This is not an Executor requirement-update/ACK notice or a dependency scheduler.

Inspect subscriptions for immutable trigger facts and delivery evidence.
Task results and notification_error are separate; failed delivery does not undo
saved outcomes. Unknown sends are not automatically retried or manually duplicated.
After HTTP is listening, onReady recovers only known-unattempted pending notices
in a bounded pass. One-shot triggering does not guarantee exactly-once host delivery.

## Module API and packaging

Relative to the host's protected, version-bound module API base:

- `POST /read` and `POST /tools/<tool-name>` share the business service.
- `GET /tasks/<uuid>/native` reads the assigned session without loading it.
- `/mcp` provides official stateful Streamable HTTP: POST requests/notifications,
  GET stream and DELETE protocol-session close. Cancellation reaches the original
  call without undoing completed effects.

Current backend/frontend paths remain `src/task-board/` and `web/task-board/`.
The database is `task-board.sqlite` under the host-provided dataRoot.
Task does not copy session histories, credentials or native runtime state.

From this repository, build the modern module:

```sh
npm ci --ignore-scripts
npm test
npm run package:module
```

`dist/cockpit-task-0.1.8.tgz` contains runtime dependencies, backend/frontend assets,
role prompts, two role Skills and the shared coding Skill. Its `.sha256` sidecar identifies the
archive. [Task CI](https://github.com/waksana/cockpit-task/blob/main/.github/workflows/task-board-ci.yml) retains these as the
`cockpit-task-module` artifact; an artifact is not an installation or deployment.

Installation is an explicit operator action on a compatible host. From the host
checkout, stage the local artifact using the host's module installer:

```sh
pnpm module install /absolute/path/to/cockpit-task-0.1.8.tgz --trust-local-code
```

This command deliberately omits automatic enablement. Follow that host's documented
module-management procedure to inspect and explicitly enable the installed module;
the host does not run npm during installation. Do not bypass compatibility guards.
These are instructions, not a claim that cleanup or packaging installed anything.
Changed package contents require a new version; do not overwrite an installed
same-version archive. Merging this source does not upgrade an existing installation.

## Further contracts and validation

- [Product design](https://github.com/waksana/cockpit-task/blob/main/docs/task-design.md) and [record schema](https://github.com/waksana/cockpit-task/blob/main/docs/task-schema.md)
- [MCP tools](https://github.com/waksana/cockpit-task/blob/main/docs/task-mcp-contract.md) and [role guidance](https://github.com/waksana/cockpit-task/blob/main/docs/task-tools-skills.md)
- [Host integration](https://github.com/waksana/cockpit-task/blob/main/docs/task-host-contract.md) and [implementation](https://github.com/waksana/cockpit-task/blob/main/docs/task-implementation.md)
- [Lifecycle replay methodology](https://github.com/waksana/cockpit-task/blob/main/docs/task-lifecycle-testing.md), including isolated
  model-driven cases and opt-in host integration

Use isolated storage and synthetic sessions for validation. Never substitute real
Owner sessions, existing installations, credentials or live databases for fixtures.
## 焦点与详情阅读

详情使用原生 `dialog.showModal()`，不在打开后再次聚焦关闭按钮，也不重复浏览器的关闭返回。
定义版本使用原生 `details` / `summary`；展开时才挂载并读取完整版本，收起保留 summary 焦点。
仍保留三处局部连续性处理：重试替换当前按钮前移至结果区、原生状态刷新移至稳定标题、
分页使当前分页控件不可用时移至页码。它们不在后台刷新或首次打开时运行。
样式只使用公开 `ck-*` / `--ck-*`，焦点提示位于组件边界内。
