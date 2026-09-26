# Task

Task is a Cockpit module for independent work records shared by orchestrator and assignee.
Its module ID and HTTP MCP key are `cockpit-task`, version `0.3.1` (source preparation; no deployment implied).
It runs in Cockpit, not a standalone daemon or dashboard.

Version 0.1.13 packaged per-Task hierarchical delegation and the tree-node model
merged through #75 (#71, #72, #74). Schema v7 adds nullable
`tasks.parent_task_id`, `tasks.depth` default 1 and `child_notices` through a
forward migration that only adds columns and a table; existing Tasks stay top-level.
It replaced the `owner`/`executor` roles with one `node` role and one merged
`cockpit-task-tree` Skill. Schema v7 is roll-forward only: installed 0.1.12 cannot
open v7 data, and switching back to an older package is not a database rollback.
Validate migration on an isolated consistent copy before authorized deployment;
never overwrite live data with a historical backup.

Version 0.1.12, released as v0.1.12, packaged the native Task dependency work and
github-coding Skill updates merged after 0.1.11 (#59, #61, #63, #65). Task
dependencies added schema v6 (`task_dependencies`, `dependency_notices`) through a
v5→v6 migration that only creates new tables. Schema v6 is roll-forward only:
installed 0.1.11 cannot open v6 data.

Version 0.1.11 added orchestrator sequential subscription follow-up (#53) and assignee
session titles (#55) to 0.1.10 without a schema migration. Version 0.1.10
introduced orchestrator request follow-through (#45), immediate notices for important
updates (#47), and Agent reopen (#49). Schema v5 migrated older supported data
without assignment backfill: pre-upgrade assigned Tasks remain readable but cannot
reopen. Old 0.1.9 cannot open schema v5.

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

Version 0.2.0 packaged schema v8 outcome retro handling and the schema v9
orchestrator/assignee vocabulary switch. MCP tools derive caller identity from
the paired host's `_meta["cockpit/invocation"].sessionId`; callers no longer
supply `actor_session_id`. Schema v9 is roll-forward only and requires Cockpit
0.4.7 or a compatible source containing waksana/cockpit#205.

Version 0.3.0 packaged schema v10: four lifecycle statuses (`todo`,
`in_progress`, `done`, `cancelled`), durable Task/text prerequisites, boundary-only
readiness notices and finished automation as done with truthful run facts. The
incompatible lifecycle/schema contract requires a new pre-1.0 minor version; released
0.2.0 remains immutable and cannot open v10. Every existing v9 database requires an
explicit reviewed plan, including those with no blocked/in_review Tasks. No production
migration, installation or release is implied. The packaged migration CLI defaults
to read-only inventory; see the
[reviewed migration procedure](https://github.com/waksana/cockpit-task/blob/main/docs/task-implementation.md#schema-v10-migration).

Version 0.3.1 prepares caller-scoped request idempotency and schema v11.
The v10-to-v11 migration preserves all receipt fields and reserves unattributable
legacy IDs with an explicit error instead of guessing a caller or repeating effects.
Released 0.3.0 cannot open v11. The v9 lifecycle review remains required; the current
CLI reports its final schema as 11. See
[receipt migration](https://github.com/waksana/cockpit-task/blob/main/docs/task-implementation.md#caller-scoped-receipts-and-schema-v11).
Source preparation is not production migration or deployment authorization.

## Roles and records

Every session is a Task tree node and receives the single `node` role (Node)
through the host's role management. The host assembles its System Prompt, Skills and
all seventeen HTTP MCP tools, persists the selection and reassembles it on cold resume.
The former `owner` and `executor` roles are removed without aliases. Before a host
cold-starts with 0.1.13, operators must back up and migrate each saved host role
selection in `$COCKPIT_HOME/session-roles/<sessionId>.json`, replacing
`cockpit-task/owner` and `cockpit-task/executor` with a deduplicated
`cockpit-task/node` while keeping other roles. Appending `node` is insufficient
because the host refuses saved undeclared roles; restore the backup together with
any rollback to 0.1.12. Task does not expose this host mutation or automatically
add capabilities during assignment.

orchestrator and assignee are per-Task facts, not session roles:

| Relation to a Task | Responsibility |
| --- | --- |
| orchestrator (`orchestrator` field) | Clarify, register, explicitly assign and follow independent Tasks |
| assignee (`assignee` field) | Deliver one entire assigned outcome, organizing internal steps, subagents or Subtasks |

Reads return `actor_role` (`assignee`, `orchestrator` or `none`; legacy rows may show `orchestrator_and_assignee`). Card labels are not prefixed; `Task ...` cards concern the assignee relation and `Subtask ...` cards concern the orchestrator relation. A node with an
assignment owns completing it; a node without one delegates delivery as root.

Agent Tasks remain the default. orchestrator may explicitly choose a trusted repeatable
known script instead, using a service-managed automation Task—not arbitrary work,
a fake assignee or a Subtask workflow. See
[lightweight automation](https://github.com/waksana/cockpit-task/blob/main/docs/task-automation.md).

orchestrator may investigate read-only and answer questions, but delegates implementation
and state-changing delivery by default. An outcome request is not a request for
personal execution. Explicit personal-execution instruction or a real assignment
as a capable assignee is an exception; holding the node role alone is not.
Unavailable delegation is a blocker, not permission to take over.
For coding, orchestrator states requirements and references any existing Issue; it does
not prepare or clean up branches/worktrees and does not implement code.

One session can execute at most one unfinished Task, then be reused after
completion/cancellation. Roles are per Task: a session is assignee for its own
assignment and orchestrator for Subtasks it creates for it. `task_create` by an orchestrator that
is executing an unfinished Agent Task records `parent_task_id` and `depth`
(top-level = 1, capped at 3; deeper creation fails with `DELEGATION_DEPTH_EXCEEDED`).
A Subtask must be more specific than its parent, never passed down unchanged and within
the parent's authorized scope; the parent integrates Subtask results before done.
The service rejects self-assignment (`SELF_ASSIGNMENT`) and assigning an ancestor's orchestrator
or assignee (`DELEGATION_CYCLE`). `DELEGATION_OWNER_MISMATCH` is removed because v9 derives
`orchestrator` from host invocation metadata instead of accepting an input. When a Subtask reaches done or
cancelled, the service sends its orchestrator (the parent's assignee) one
`[Subtask done](task:<uuid>?event=child_done)` card per transition
(`child_cancelled` likewise) without a subscription, skipping self-authored transitions, when a
subscription for that transition already notified the same orchestrator or the parent is finished; the
`child_notices` and `assignee_notices` read views page delivery facts.
`task_session_create` gives new sessions the `node` role. The board shows the delegation
level, a lazy parent link and a lazy Subtask list. There is no workflow engine or
reassignment; `blocked_by` is only a readiness gate and lineage does not gate readiness. The orchestrator or original assignee may reopen an eligible
done Agent Task for explicitly user-authorized rework; the work still continues with that original assignee, while cancelled and automation
Tasks never reopen. Review is optional unless the Task's
requirements demand it; assignee can complete without a default orchestrator approval gate.
Work methods remain separate from role collaboration.

Reopen requires a tracked assignment after schema v5 upgrade, no later Task
assignment to that assignee (even one now done/cancelled), and no other unfinished
Task. Pre-upgrade assignments are all ineligible: no timestamp inference/backfill.
It atomically writes a new full definition revision even for identical text,
advances lifecycle context and enters in_progress with the same
Task/orchestrator/assignee. Original-assignee reopen self-ACKs silently; orchestrator or Web-user reopen does not auto-ACK and sends the assignee a fixed `[Task updated]` notice. Old outcome/retro and all history remain, but current:false
does not deliver the new agreement. Done again requires a new outcome and explicit
retro. Busy original-session execution is allowed; current capability readiness
is still checked. No dispatch/self-prompt, subscription renewal, duplicate notice,
mandatory activity log, round state machine or UI reopen button is added.

The active Skill is [cockpit-task-tree](../skills/cockpit-task-tree/cockpit-task-tree/SKILL.md), a single operating manual for doing your Task, splitting into Subtasks, reading current facts, writing safely, notices and recovery. Its only bundled reference is [Automation](../skills/cockpit-task-tree/cockpit-task-tree/references/automation.md).
Load when first needed, reuse guidance in context, and reload only when missing,
changed or unclear. Load only the reference a question needs; stable Skill reuse
does not replace fresh Task reads.

The node role also discovers the self-contained
[github-coding](../skills/github-coding/github-coding/SKILL.md) work Skill through
its declared discovery roots.
Applicability depends on changes intended for commit to version-controlled repository
files, not GitHub mentions. Deployment of existing verified artifacts and runtime
configuration use Task without this Skill requiring Issue/PR/branch/worktree;
project policies, immutable installation requirements and separate deployment
authorization still apply. orchestrator's default delegation responsibility is unchanged.
Mixed delivery stays one Task with Issue/PR only for necessary repository changes.
orchestrator creates the assignee session with cwd at a target repository's shared main
checkout (any involved one for cross-repository work) so repository instructions load.
That checkout is read-only for the assignee. Its first coding step is to reuse or create
the Issue and create its own branch and isolated worktree from freshly fetched mainline,
recording them in Task; afterwards it works only there, targeting worktree paths
explicitly because tools default to cwd. This applies to every involved repository.
If changes outside the agreed scope emerge, assignee asks the user first; once authorized
it sets up that Issue and worktree within the same Task, not a new deployment Issue or
stage Task. assignee owns implementation, checks, independent review and authorized PR merge.
After merge it verifies delivery and that nobody still uses the worktree, then removes
only its own worktree and local/remote branches (except those kept by repository policy),
recording the result; uncertain use or merge keeps them with the reason recorded.
orchestrator has no routine cleanup duty; it may safely clean up legacy orchestrator-prepared
worktrees once. Task done means the complete agreed delivery, including separately authorized
non-coding work in a mixed Task, not code merge alone or session idle.
Subscribe only if the future status unlocks necessary authorized orchestrator action.
Reuse existing environments, preserve others' changes, respect PR-only boundaries,
and skip GitHub-specific steps for non-GitHub repositories. No release or deployment
is implied. Issue/PR/environment evidence uses existing Task references and metadata.
Authorized rework defaults to reusing the retained worktree/branch when it still exists,
even after its previous PR merged; if already removed, assignee creates a fresh one. Verify actual project, branch, orchestratorship and no conflicting worker;
metadata is only a locator, not orchestratorship proof, and unrelated chats are not scanned.
Fetch and normally merge mainline safely, with no force/reset/amend or lost work;
create a newly reviewed follow-up PR as needed and normally merge within scope.
Repurposed or conflicting worktrees require explicit resolution, not takeover.
orchestrator should not replace a Task whose eligible original assignee can continue.

Description contains the full current agreement. Revision/changelog version only
that description. Activity records reported execution against an actually ACKed
revision, not live native progress. ACK never starts work or adds activity.
Only the assigned assignee's actual changed-description edit on an unfinished
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
| `task_session_create` | Create an assignee, optionally preparing explicitly selected native resources |
| `task_session_prepare` | Prepare a loaded idle assignee with no unfinished Task; no creation or dispatch |
| `task_assign` | Check an existing assignee, bind once, best-effort set its default/auto session title to the Task title, and send one assigned reference |
| `task_edit` | Atomically replace the agreement/materials/active prerequisites; assignee description changes auto-ACK. Ready/blocked boundaries and ready-period agreement updates notify others; blocked-period updates stay silent |
| `task_ack` | Confirm the current definition separately from status |
| `task_report` | Explicit activity, status and/or outcome; Agent done requires a new outcome and explicit retro text or null |
| `task_reopen` | Orchestrator or original assignee reopens eligible done Agent work for the original assignee; assignee self-reopen auto-ACKs, other reopen sends `[Task updated]`; no dispatch |
| `task_cancel` | Cancel Agent without stopping its session; request automation termination, never rollback |
| `task_subscribe` | Optional one-shot subscriber wait for explicit target statuses |
| `task_unsubscribe` | Cancel a still-waiting subscription |
| `task_retro_handle` | Any caller records how a recorded retro with findings (normally the latest) was handled: fixed, followup (terminal), watching or dismissed |

The single `node` role receives all seventeen tools. The service authorizes writes by the caller's relation to each Task: `ack`/`report` require assignee; `edit`/`cancel`/`reopen` require orchestrator or assignee; `assign`/automation start/reconcile require orchestrator; reads, create/session/script helpers, subscribe/unsubscribe and retro handling are open to any caller. Rejections are 403 and save nothing. `actor` is reported provenance, not verified identity.

The following is the default Agent flow. Automation uses discover/register → create
snapshot → optional necessary subscription → explicit start. No assign/ACK/report,
session slot or auto-subscription; a persistent single service queue executes it.
Read the latest Task/outcome on a notice, not a monitoring loop. Queued/starting/running
definitions freeze; script/inputs never change. Started work never reruns after recovery.

1. orchestrator chooses authorized work resources/environment and registers the complete
   Task. Backlog registration alone does not dispatch.
2. Create with optional `skills` / `mcp_servers`, or explicitly prepare an eligible
   existing assignee; inspect the operation receipt. Exclude every assignee bound
   to unfinished work, even if idle. No preference for new or reused sessions is imposed.
3. Assignment checks capability and native idle/empty state, binds, rechecks and
   sends exactly one assigned reference. orchestrator does not duplicate it.
4. assignee reads `execution`, ACKs the exact current revision, then explicitly
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
expansion. It creates no notifications, dispatch or mandatory orchestrator review.
The service guarantees submission, not thought or text quality. Automation
does not run an Agent or submit retro.

Resource names must already be discoverable; preparation does not infer them from
Task text, install/authenticate, alter unrelated choices or global defaults, reload,
change roles/models or send a prompt. Explicit empty selections still request preparation.
Tool availability is checked against the actual filtered offered table.
Skill enabled is not body loaded; MCP connected is not tool offered; initialized
tools are not final readiness. assignee loads relevant Skill bodies when first needed.

orchestrator finds Tasks with `task_read(view=list, orchestrator=<own session ID>)`; actor is not
that filter. For one Task, select only needed groups in one overview read:
`include=["context"]` for status/version, `["activity","outcome"]` when both explain
the necessary next action. Outcome can be null; no guess-and-fetch sequence is needed.
Retro, definition, automation and cancellation are also opt-in groups. Omit include
for existing overview defaults. Selection has a 48,000 serialized-character budget
and explicit overflow errors, never truncated records. Read full definition before
editing; assignee still reads execution and ACKs current requirements. History/log
pagination remains separate. An available current outcome does not itself prove delivery.
Default overview/list show retro status and attribution without text. Execution/definition
and outcomes expose it independently: `recorded` text or explicit null,
`not_recorded` for missing history, `not_applicable` for automation. orchestrator reads
on demand. The detail view separates completion retro from outcome; original
revision/attribution remain visible after edits, with `current:false` for historical
reflection. Legacy history is never backfilled as no findings.

## Writes, failures and recovery

Every write requires a stable request_id within its trusted calling session.
The main session and its subagents share this namespace; different sessions may
reuse IDs independently. Exact-input replay preserves original effects; changed
input in the same session conflicts. Existing-Task writes also
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

Inspect `task_read(view=operation,request_id)` for the calling session's durable step
results, not another session's receipts. Web HTTP uses its fixed `user` namespace.
Unattributable historical IDs return `LEGACY_OPERATION_UNSCOPED` and stay reserved;
inspect retained evidence before any separately authorized remediation, never
change the ID just to repeat an uncertain action.
Failure-time `availability_reasons` and `observed_at` explain an observation,
not live status; receipt reads/replay do not refresh them.
Preserve created or bound resources after partial failures.
Resource-aware create/prepare receipts retain `preparation`, host `resources` step
effects and separate final `capability`. Read the receipt and current state before
an explicit new preparation request after a known failure; unknown effects never
justify blind retry or replacement. Preparation rejects pending role reload and
any unfinished Task binding; it is not a repair mode for an assigned assignee.
Only an unused final assignment receipt proving `assignment=applied` and
`message=not_sent` supports explicit resume_request_id recovery with a new request
ID in the same caller namespace, fresh context/revision and the same Task/assignee. Unknown, queued, accepted
or pending sends do not. Cancellation does not stop native work or undo external effects.

## Collaboration and references

Requirements, decisions, progress and outcomes belong in Task, not a second chat
ledger. assignee asks the user directly in its own session; neither role starts
an orchestrator/assignee conversation for progress, confirmation or clarification.
No direct or subagent-relayed assignee messages to orchestrator. User-facing summaries
are allowed. Ordinary edits/reports stay silent without an explicit subscription.

| Purpose | Reference |
| --- | --- |
| Ordinary reference | `[Task](task:<uuid>)` |
| Entire automatic first dispatch | `[Task assigned](task:<uuid>?event=assigned)` |
| Automatic assignee update notice | `[Task updated](task:<uuid>?event=updated)` |
| Automatic assignee cancellation notice | `[Task cancelled](task:<uuid>?event=cancelled)` |
| System notice from a status subscription | `[Subscribed Task status changed](task:<uuid>?event=status_changed)` |
| Dependent's blockers are all done | `[Subtask ready](task:<uuid>?event=ready)` |
| A blocker of a waiting dependent was cancelled | `[Subtask blocker cancelled](task:<uuid>?event=blocker_cancelled)` |
| A Subtask became done, sent to its orchestrator | `[Subtask done](task:<uuid>?event=child_done)` |
| An assignee records a concrete unmet condition, sent to its orchestrator | `[Task blocked](task:<uuid>?event=blocked)` |
| Historical Subtask blocked notice (no longer emitted) | `[Subtask blocked](task:<uuid>?event=child_blocked)` |
| A Subtask became cancelled, sent to its orchestrator | `[Subtask cancelled](task:<uuid>?event=child_cancelled)` |

Pass only the UUID to tools. Event values are exact lowercase URL metadata, not
Task fields, commands or inferred states. Generic references have no event title;
unknown events or malformed queries remain unclaimed. Use `task:`, not relative
`task/<id>` file-like paths.

The frontend renders an inline reference card and current-data detail dialog,
not a separate dashboard. Message reason is fixed; title, state, definition and
history are fetched from Task. Native session observations are labelled separately,
read on demand and never imply business progress or capability readiness.

Assigned work receives one `[Task updated]` at ready-to-blocked or blocked-to-ready
boundaries, for ordinary agreement changes while ready, reopen, or blocker cancellation.
Self-authored changes do not remind the actor. While blocked, ordinary edits and partial
resolution save silently, not as queued messages for later replay. Assignee-added text
conditions still send one `[Task blocked]` to the orchestrator. Cancellation sends the
assignee `[Task cancelled]` unless self-authored. Assignee notices use `mode:"immediate"`;
the whole message is the link. Acceptance is not ACK or user authorization, and uncertain
delivery never authorizes a retry or handwritten duplicate.

### One-shot status subscriptions

Default to no subscription. Any caller may register only when a future status enables that subscriber's concrete, necessary action—not merely knowing progress or confirming completion.
Do not invent work or approval gates to justify waiting. Choose the fewest useful
targets and withdraw the wait if the follow-up is no longer needed.
assignee never waits for subscription or notice consumption before delivering.

Registration already in a target state fails without subscribing or notifying.
Each Task permits one waiting subscription per subscriber; the first matching committed
transition consumes that subscriber's wait. An unmatched terminal transition expires it.
Same-state reports, edits, ACKs and activity alone do not trigger.
Unsubscribe cannot recall a consumed notification or host queue item.

The system enqueues one status_changed reference to the subscriber without interruption
or queue clearing. The subscriber reads current evidence, reassesses the necessary action
and does not automatically re-subscribe, poll or hold a model turn open.
This is not an assignee requirement-update/ACK notice or a dependency scheduler.

Inspect subscriptions for immutable trigger facts and delivery evidence.
Task results and notification_error are separate; failed delivery does not undo
saved outcomes. Unknown sends are not automatically retried or manually duplicated.
Assignee notices left pending by an earlier process expire synchronously when `TaskService` starts, before any request or replay can send them. After HTTP is listening, onReady recovers only other known-unattempted pending notices
in a bounded pass. One-shot triggering does not guarantee exactly-once host delivery.

### Task dependencies (blocked_by)

`blocked_by` accepts up to 20 unique `{task_id}` or `{condition}` items (legacy UUID
strings remain accepted). A condition states what is missing and what satisfies it.
Task references reject missing, self, ancestor, cancelled and cyclic prerequisites.
The active set can be replaced atomically on unfinished work (automation only before
start), without a false-ready interval. Assignees may add conditions; only their
orchestrator or the user resolves or replaces one. Full prerequisite requirements
belong in the referenced Task, not duplicated into both definitions.

Reads expose only active `{task_id,status}` / `{condition}` entries; no active entries
means `ready=true`. Assignment, automation start and Agent done reject `TASK_NOT_READY`
otherwise. Reading, ACK, discussion and definition changes remain possible. Completion
permanently resolves the active relation. Cancellation does not satisfy it; reopen
never revives old relations or wakes old dependents. A new gap needs a new explicit
dependency round after authorized, eligible rework has been arranged.

The last prerequisite's completion or explicit resolution notifies the assigned
assignee, or the orchestrator if undispatched, once unless self-authored. Cancellation
retains replanning notices. `task_read(view=dependencies)` pages active/resolved history;
`dependency_notices` pages delivery facts. Readiness neither dispatches nor overrides
authorization: a user's "wait until I say continue" remains in the agreement. A temporary
pause itself is not a blocker, lifecycle status or request for orchestrator help.
There is no polling, automatic assignment or session stop mechanism.

orchestrator may also record recognized but undecided follow-up as an unassigned planning
Task blocked by its prerequisites, plainly marked as a pending decision that must not
be dispatched as-is. On ready, orchestrator discusses it with the user, then rewrites it into
complete agreed requirements and dispatches, or cancels it with the user's decision.
This is orchestrator guidance only: no new status, kind or tool.

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

`dist/cockpit-task-0.3.1.tgz` contains runtime dependencies, backend/frontend assets,
the node role prompt, the tree Skill and the shared coding Skill. Its `.sha256` sidecar identifies the
archive. [Task CI](https://github.com/waksana/cockpit-task/blob/main/.github/workflows/task-board-ci.yml) retains these as the
`cockpit-task-module` artifact; an artifact is not an installation or deployment.

Installation is an explicit operator action on a compatible host. From the host
checkout, stage the local artifact using the host's module installer:

```sh
pnpm module install /absolute/path/to/cockpit-task-0.3.1.tgz --trust-local-code
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
orchestrator sessions, existing installations, credentials or live databases for fixtures.
## 焦点与详情阅读

详情使用原生 `dialog.showModal()`，不在打开后再次聚焦关闭按钮，也不重复浏览器的关闭返回。
定义版本使用原生 `details` / `summary`；展开时才挂载并读取完整版本，收起保留 summary 焦点。
仍保留三处局部连续性处理：重试替换当前按钮前移至结果区、原生状态刷新移至稳定标题、
分页使当前分页控件不可用时移至页码。它们不在后台刷新或首次打开时运行。
样式只使用公开 `ck-*` / `--ck-*`，焦点提示位于组件边界内。
