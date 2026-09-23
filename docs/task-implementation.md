# Task implementation contract

This document defines storage, concurrency, delivery and presentation boundaries.
See the [MCP contract](task-mcp-contract.md) for input/result shapes, the
[host contract](task-host-contract.md) for integration, and the
[lifecycle replay guide](task-lifecycle-testing.md) for isolated verification.

## Module and data

The module ID and MCP server key are `cockpit-task`, display name Task, version
`0.1.12` (released as v0.1.12). Its manifest is [cockpit.module.json](../cockpit.module.json).
`src/task-board/`, `web/task-board/` and the database filename `task-board.sqlite`
are current internal paths. Task runs inside Cockpit, not a standalone service.

The database lives in the host-provided module dataRoot. Task does not read
credentials, session histories, native runtime stores or other service databases.
Its HTTP API and HTTP MCP share one application service and set of business rules.

SQLite transactions protect local mutations. Separate tables hold Tasks,
description snapshots, exact revision acknowledgements, activities, outcomes,
operation receipts, subscriptions, assignment order, script registrations and automation runs. A partial unique index limits each
Executor to one unfinished Task. Subscription uniqueness permits one waiting
subscription per Task Owner; Owner is fixed for the Task.

Schema version 6 adds `task_dependencies(task_id, blocker_id, author, at)`, unique
per pair, no self-edge, indexed by blocker, and `dependency_notices` with
`UNIQUE(task_id, kind, blocker_id, blocker_lifecycle)` where kind is `ready` or
`blocker_cancelled`, plus the same pending/unknown/accepted delivery columns as
subscriptions. The v5→v6 migration only creates these tables; installed 0.1.12
opens schema v6, but installed 0.1.11 cannot. Schema v6 is roll-forward only.
Blocker sets are validated in the write transaction: at most
20 unique ids, existing same-Owner Tasks, no self or newly added cancelled blocker,
and no cycle (recursive CTE). Edits are allowed only while the dependent awaits
dispatch and bump `editable`, not the revision. A blocker's committed transition
into done/cancelled, in the same transaction, inserts notices for dependents still
awaiting dispatch (`ready` only when all blockers are done). Binding and automation
start reject `TASK_NOT_READY`; readiness never changes status or dispatches.
`report`/`cancel`/automation finish return these as `notice_ids`, delivered and
recovered through the same outbox path as `subscription_ids`.

Schema version 5 adds `task_assignments`: `seq INTEGER PRIMARY KEY AUTOINCREMENT`,
unique `task_id` referencing Tasks, and non-null `executor,author,at`, indexed by
executor/seq. Each new first binding records its assignment in the same transaction.
All Tasks assigned before upgrade are ineligible for reopen: migration leaves them
without assignment records, with no backfill or timestamp-based inference.
Previously created but still unassigned Tasks acquire a sequence on first binding
after upgrade. Retain assignment order after completion/cancellation and across
restart; reopening never records a new assignment or resets this history.
This is a forward migration: installed 0.1.9 cannot open schema v5, and switching
back to that package is not a database rollback. Validate an isolated consistent
copy before authorized deployment; never replace live data with a historical backup.

Schema version 4 added nullable `outcomes.retro TEXT` and
`outcomes.retro_recorded INTEGER NOT NULL DEFAULT 0` (restricted to 0/1).
Version 3 added Task kind, immutable scripts and automation run/log facts to
the v2 subscription and notification evidence. Opening a supported older Task
database upgrades it transactionally, preserving Agent Tasks and receipt rows;
unsupported newer schema versions fail with `SCHEMA_TOO_NEW`. Service-assigned
timestamps and retained histories are not caller-authenticated evidence.
Migration does not fabricate reflection or backfill historical outcomes as
explicit no-findings submissions.

Activation requires Module API v1, the exact module identity,
`context.serviceReadyVersion === 1` and `context.host.call` before storage opens
or migrates. Do not remove these guards or silently skip recovery on an
unsupported host. Web activation separately requires API v2, UI v1 and a portal.
Resource-aware create and explicit prepare additionally require
`context.host.resourcePreparationVersion === 1` before any external effect.
This operation-level guard does not disable legacy creation or module activation
on an otherwise compatible older host.

## Business context, not authentication

All mutations require `actor_session_id`, a reported session identifier.
Reads may omit it; browser readers do not invent a human session ID.
Skills include their actor on reads to check their currently assigned Task as
well as any explicit target. Actor is not an automatic list filter or credential.

Role assembly determines the available tool subset, not a per-Task ACL.
ACK history records the fixed Executor as `confirmed_for` and the reported actor
as `author`. Cross-Task operations remain callable, but Skills must not claim
another Executor has read a definition. The backend does not verify reading,
understanding or user authorization through actor IDs or chat inspection.

The host controls role management, including changes to existing sessions.
Task itself exposes no such mutation: session creation selects Executor for
the new session, while assignment checks existing capabilities without adding
roles, enabling resources or repairing the target.
Explicit preparation is separate: only loaded idle sessions with an applied
Executor role, no pending role reload and no unfinished Task are eligible.
There is no bound-Task repair mode or automatic resource selection from Task text.

## Concurrency and replay

Every write has a stable `request_id`. Its fingerprint covers the tool and
complete validated input, including actor. The same ID with different input
fails; exact-input replay returns the original effects without repeating them.
Local effects and final receipt commit atomically. `definition_check` is always
fresh, not stored as a permanent conclusion in a receipt.

`write_context` is an opaque concurrency snapshot, not a credential or a second
description version. Return it unchanged:

| Generation | Changes that advance it | Checks |
| --- | --- | --- |
| Description `revision` | Actual description changes or explicit reopen, including identical text | Definition edits, current ACK, assignment, reopen and reports as applicable |
| Lifecycle | First assignment or actual status transition | Existing-Task writes except subscription cancellation |
| Editable materials | Actual title/references/metadata changes | Definition edits |

ACK and activity do not invalidate unrelated writes. Subscription registration
checks lifecycle without advancing it. `task_unsubscribe` instead checks the
specified subscription's waiting state in its transaction; it neither changes
Task state nor recalls a consumed notice.

Description changes atomically write the complete text, next revision and
changelog snapshot. Only an actual changed-description edit by the assigned
Executor on an unfinished Task auto-ACKs that revision. Unchanged text,
materials-only edits and terminal edits do not. ACK never changes status or
creates activity.

Reports require an exact acknowledgement for the supplied revision and fixed
Executor. A later ACK does not cover skipped revisions. An acknowledged older
activity may save while stale status/outcome are rejected with
`DESCRIPTION_UPDATED`; no other report validation failure partially saves
activity. Results distinguish saved, rejected and not_requested fields.
Agent `done` requires a new outcome and explicit `retro` nonblank string or null
in that same request; omission is rejected, not defaulted to null. Only done
accepts retro; ordinary reports omit it. Completion status, outcome and retro
save atomically; the retro field also reports saved/rejected/not_requested.
All incoming done requests missing retro, including old-format replay attempts,
reject with `INVALID_INPUT` before any writes, including activity. Stored legacy
operations remain untouched and readable through side-effect-free
`task_read(view=operation,request_id=<original ID>)`. Do not auto-fill null or
retry modified input with the same request ID. Exact replay of a valid new
request retains its original saved result without duplicate effects.
Retro shares that outcome's revision, executor, author, reported source, time and ID.
The service guarantees submission/persistence, not reflection or content quality.
No new notifications, review gates or dispatch follow from retro; automation
keeps its service outcome path with retro not applicable.

Terminal Tasks reject execution reports and ACK. Their definition/history remain
readable and editable without reopening or auto-ACK. Old outcomes retain their
revision; overview marks whether the latest outcome matches the current definition.
Recorded retros likewise retain their revision and become `current:false` after
a description edit, without changing historic outcomes or reopening execution.

### Guarded original-Executor reopen

Only `task_reopen` can move a done Agent Task to in_progress for explicitly
user-authorized rework. It preserves Task/Owner/Executor and requires reported
actor equality with the original Executor; this is not authentication.
Cancelled and automation Tasks remain excluded; report/edit/assign do not reopen.
Eligibility requires a tracked post-v5 assignment, no later assignment to that
Executor (including other Tasks now done/cancelled), and no other unfinished Task.
Use durable sequence ordering, not timestamps or only current occupancy.

The service checks current Executor capability readiness through the public host
adapter, without requiring idle: the calling original session can be executing.
No dispatch, self-prompt, preparation, resource repair or workspace creation occurs.
Revalidate revision, lifecycle/material context, identity and assignment eligibility
inside the local mutation transaction, including after the host observation, so a
concurrent assignment or definition change cannot slip past an earlier check.

Atomically increment revision even for identical description, record the full
definition/reason/author/time, invoke the existing ACK helper for self-confirmation,
set in_progress and advance lifecycle context with the receipt. Histories and
references remain; old outcome/retro becomes current:false, and old ACK/outcome
cannot deliver the new revision. Subsequent done again needs a new outcome and
explicit retro text or null. No mandatory activity log or round state machine.
Ended subscriptions stay ended; do not renew or create duplicate notifications.
Exact replay returns original effects without reopening again; refresh
definition_check independently. No UI reopen control is added.

## Lightweight automation

Agent remains the default; only known trusted repeatable scripts use the explicit
automation path. Immutable registrations resolve absolute executable/script paths,
fingerprint script bytes with SHA256, and declare fixed-prefix argv plus ordered
required string/integer/boolean parameters. Creation snapshots configuration and
typed inputs without executing. Start checks revision/write_context and durably
queues once; a persistent single service queue executes
`executable [...argv, script_path, ...typedStrings]`, never a shell template.
No Agent Executor, ACK or session slot is invented; assign/ack/report reject this kind.

Definitions/materials freeze in queued/starting/running; script and input snapshots
are never mutable. Claim records starting/in_progress and a barrier. The worker
launch handshake follows durable PID/process-group storage. Success atomically
stores done plus a service outcome; failure/interruption stores blocked plus an
outcome, preserving cancellation. Automatic subscription transitions have
`event.source='automation'`, `event.run_id` and `actor_session_id:null`.
Outcomes have `executor:null`, `source:'automation'` and `author:'automation:<run_id>'`:
the author is a service label, never a native session or fabricated Executor.
Combined stdout/stderr retains at most 65536 characters,
counts omitted characters explicitly, and is read separately in offset pages up to
8192 characters. Definition/execution reads include snapshots; overview/list carry
runtime facts. See [MCP shapes](task-mcp-contract.md).

Cancellation before launch prevents execution; during execution it requests group
termination, never rollback or proof of exit. Recovery never reruns starting/running
work: it records interruption/outcome and a persistent barrier. Prelaunch queued
work may resume only without a barrier. For a recorded group, explicit reconciliation
probes the Linux process group with `kill(-pgid,0)`; only kernel `ESRCH` proves absence
and clears the barrier. If no durable PID/group exists, the launch handshake could
not have been sent: explicit reconciliation clears this pre-handshake barrier without
a probe or replay. Any existing group, including unreaped zombies, `EPERM` or observation
uncertainty keeps the barrier. Unreaped zombie groups can block until the host reaps
them; do not edit the database or bypass this guard. Shutdown cannot always prove
exit, so blocked plus a barrier is a correct conservative result.
Reconciliation never kills recovered processes, reruns work or changes
blocked to done. Repeating requires new authorization and a new Task.

Scripts must not daemonize/detach/escape the process group. This is same-user trusted
execution, not a sandbox or authentication. Immutable registration and script hash
do not freeze interpreters, runtime, imports or dependencies. Optional subscriptions
precede start only for concrete Owner follow-up; no automatic subscription, Agent
monitoring loop, workflow engine or production installation is introduced;
a `blocked_by` Task cannot start until every blocker is done.

## External operation receipts

Session creation, preparation and assignment persist a pending receipt before host calls.
Step results are updated durably. A crash during an external action leaves
unconfirmed evidence; startup does not automatically repeat creation or dispatch.
`task_read(view=operation,request_id)` exposes the known result without host refresh.

Creation retains a confirmed session ID even if capability inspection fails.
It does not bind a Task or send an initialization prompt, and replay never
creates a replacement.

Omitting `skills` and `mcp_servers` preserves legacy creation and its receipt.
Either field, including an empty array, requests the shared resource preparation
path after creation. `task_session_prepare` uses that path without creating,
renaming, changing model/roles, binding or sending. Same-target prepare/assign
calls are mutually excluded for their call lifetime within the loaded Task service,
not through a new durable lock or recovery workflow. The unfinished-Task unique
constraint still applies.

The host's narrow `session/resources-prepare` holds an idle lifecycle guard across
native resource validation, enablement, tool initialization and readback. It
preserves unrelated choices and checks requested raw MCP tool names against the
actual filtered offered table. It never installs, authenticates, changes global
defaults, bypasses policy, reloads/cold-loads or prompts. Task business eligibility
is checked by Task, not encoded in this generic host intent.
Initialize once when tool metadata is null or a selected resource enablement was
confirmed in this call, even if metadata remains non-null. This handles the stale
empty table retained after MCP enable as a confirmed configuration change, not a
filter bypass. An already-enabled/no-op selection with non-null metadata and genuinely
missing tools still fails without speculative rebuilding. Preserve confirmed effects.
MCP receipts return one actual offered raw-name witness for omitted/empty selections,
or only requested offered names for explicit selections, never a tool catalogue.
Error strings are bounded to 2,000 characters with an explicit truncation marker.

Preparation persists its known target and `preparation:not_prepared` before passive
inspection, then `preparation:unknown` before the native preparation call.
Cancellation is checked before starting the next Task-to-host call. Once the single
guarded `session/resources-prepare` call has been submitted, it may complete its
selected native steps despite caller cancellation. There is no per-inner-RPC
interruption, rollback or retry; the receipt records the actual result when available.

Preparation receipts retain `preparation=not_prepared|unknown|prepared|unavailable`,
the host `resources` receipt when available, and separate final Executor `capability`.
Per-resource enablement and tool initialization effects survive partial failure;
final readiness and idle checks still must pass. An initialized tool table is not
readiness, and readiness is not authorization, assignment or execution.
Read the durable receipt and current state before explicit continued preparation
under a new request after a known failure. Unknown effects cannot justify blind
retry/recreation. Replay never repeats resource effects or silently repairs assignment.

Assignment proceeds as follows:

1. Inspect current Executor capability and native idle/empty availability.
2. Bind the unassigned todo transactionally, enforcing single unfinished work.
3. Recheck capability/native state and the Task's version, lifecycle and binding.
4. Persist message uncertainty before calling host `prompt` once with the entire
   message `[Task assigned to you](task:<uuid>?event=assigned)` and `mode:"enqueue"`.

The idle checks and send are not atomic. Enqueue avoids proactively interrupting
a turn that starts in the race; an actual `queued:true` result is retained as
`UNEXPECTED_QUEUE`, not dispatch success or proof of non-delivery.
Accepted does not mean read, ACKed or executing.

Failures before or after binding retain their actual effects. Capability and
availability rejection details include capability `reasons`, native
`loaded/status`, fixed `availability_reasons` and `observed_at`, without message
or question bodies. These are failure-time observations, not live status;
receipt reads/replays do not refresh them or repair the session.

Exact request replay never resends. Explicit recovery requires a new request ID,
fresh context/revision, the same Task/Executor and `resume_request_id` pointing
to an unused finalized assignment receipt proving `assignment=applied` and
`message=not_sent`. Recovery consumes that receipt and repeats the safety checks.
Pending, unknown, queued or accepted sends cannot authorize recovery.
No recovery path reassigns, reopens a terminal Task or silently rolls back binding.

## One-shot status notifications

Subscription is optional and normally unused. Owner registers only for a concrete,
necessary future Owner action, not progress/completion watching; this is Skill
guidance rather than a server-side policy expression. Choose minimal targets,
withdraw unnecessary waits and never automatically re-subscribe. Executor work
does not depend on an Owner wait or notice being read.

Registration atomically checks lifecycle, current status and waiting uniqueness.
Already matching fails without registration or immediate notification.
A terminal Task cannot register for future transitions. The recipient is always
the saved Task Owner, not a caller-supplied destination.

A real matching status transition commits Task effects, receipt, subscription
consumption, immutable transition event and `pending` delivery together.
Same-status reports and failed transitions do not trigger; an unmatched terminal
transition expires the wait. Waiting cancellation races through the same
transaction boundary and cannot revoke an already triggered event.

The delivery record is a bounded durable outbox, not a second native queue or
scheduler. A passive `session/get` lookup first checks the original Owner exists.
Missing/unavailable Owners produce `not_sent` evidence; no replacement is created.
A compare-and-set claim persists `unknown` before the non-idempotent host send.
The only message is `[Task status updated](task:<uuid>?event=status_changed)`
(or, for a dependency notice, the dependent's `event=ready` / `event=blocker_cancelled` card).
Accepted/queued responses update evidence; ambiguous or interrupted sends remain
unknown and are never automatically retried. Busy Owner enqueue is normal and
does not interrupt, clear messages or prove reading.

Triggering writes preserve `result.subscription_ids` and separately return current
`notifications` / `notification_error`. Notification failure does not erase a
committed status or outcome and must not cause the whole report to be repeated.
Subscription history retains event/delivery facts for terminal Tasks too.
Cards show current Task data, not the immutable trigger snapshot.

Only the returned `onReady` callback starts pending recovery, after the host
runtime is started and HTTP is listening so resumed sessions can connect MCP.
Activation, pre-listen agent events and inbound reads do not trigger it.
Recovery uses bounded batches through a fixed high-water mark without waiting
for new Task traffic. Waiting subscriptions survive restart; only known-unattempted
pending notices recover. Unknown, accepted, queued and known failed attempts do
not replay. Shutdown prevents new claims and keeps storage open until in-flight
work records its outcome. There is no exactly-once guarantee for host prompt.

## Read boundaries and reference

Read views are fixed, not arbitrary projections:
`list`, `overview`, `execution`, `definition`, `changelog`, `activity`, `outcomes`,
`subscriptions`, `dependency_notices`, `automation_log`, `operation`. Owner discovers through an explicit
owner-filtered list and selects single-Task content by purpose; Executor reads full
execution requirements at start/resumption and synchronization checkpoints.
These are information choices, not ACLs.
Full current description appears in execution/definition or a selected changelog
revision, and optionally in overview's selected definition, never silently truncated.

`overview` accepts optional `include`, a nonempty unique allowlist of at most seven
groups: context, activity, outcome, retro, definition, automation, cancellation.
It cannot mix with other views or pagination/revision selectors. Omission preserves
all existing response shapes. Context is always returned; `["context"]` reads only
identity/status/revision/ACK/timestamps/write_context/kind. Other groups are opt-in:
latest complete activity/outcome (null if absent), latest recorded retro, current
definition/materials, full automation snapshot/facts without logs, cancellation.
Outcome excludes unselected retro. Records retain revision/current/source and
attribution; current is a revision comparison, not proof of delivery.

Selection uses a single deferred SQLite read transaction and explicit column
projections, including a body-free definition-check query. No unselected bodies,
histories or logs are loaded. The response's definition_check remains a separate
fresh checkpoint and may observe a newer revision after the read transaction.
The result has a fixed 48,000 serialized JSON character budget including escaping,
excluding the envelope/check. Overflow yields RESULT_TOO_LARGE (413) with selected
group sizes, not truncated content; narrow include or use existing complete
definition/execution and history/log pagination. No cache, saved snapshot or new
cursor lifecycle is introduced.

Execution/definition return an independent latest recorded `retro`; each outcomes
history item has its own retro projection:
`{status:'recorded',text:string|null,revision,executor,author,source:'reported',at,outcome_id,current,has_findings}`.
`has_findings` means text is non-null, not that its contents are useful.
Null text means explicit no findings. Missing records yield `{status:'not_recorded'}`;
automation yields `{status:'not_applicable'}`. Default overview/list omit text while
retaining status and attribution. Owner may read on demand, without required review.

| Data | Bound |
| --- | --- |
| Title / reason | 240 / 2,000 characters |
| Description | 24,000 characters |
| References | 20 entries; label 200 / target 2,000; 8,000 serialized characters total |
| Metadata | Plain JSON object, 8,000 serialized characters, depth at most 12 |
| Description + references + metadata | 64,000 serialized characters combined, including escaping |
| Activity text / outcome summary | 4,000 / 8,000 characters |
| Retro text | 2,000 characters; null explicitly records no findings |
| Activity / outcome input object; combined `{outcome,retro}` when supplied | 16,000 serialized characters, including outcome references and escaping |
| Overview activity excerpt | 320 characters with explicit `truncated` |
| List / history item counts | Default 20 / 5; maximum 50 / 10 |
| List/history page payload | 24,000 serialized characters, cursor for every remainder |
| Selected overview result | 48,000 serialized characters; explicit error and group sizes on overflow |

Page budgets exclude the envelope and definition check; requested counts are
upper bounds, not guarantees. Opaque keyset cursors are tied to view/filter/Task.
Changelog pages contain summaries; selecting one revision returns its full
snapshot and cannot combine with limit/cursor. Full current definitions and
single revisions are outside the page budget, bounded by input limits and
attribution to approximately 80,000 serialized characters. Oversized edits are
checked against retained fields too, not merely the supplied patch.

| Purpose | Exact reference form |
| --- | --- |
| Ordinary reference | `[Task](task:<uuid>)` |
| Entire first assignment message | `[Task assigned to you](task:<uuid>?event=assigned)` |
| Explicit important-update notice to Executor | `[Task updated](task:<uuid>?event=updated)` |
| Explicit subscription's system notice to Owner | `[Task status updated](task:<uuid>?event=status_changed)` |
| Dependent ready notice to Owner | `[Task ready](task:<uuid>?event=ready)` |
| Dependent blocker-cancelled notice to Owner | `[Task blocker cancelled](task:<uuid>?event=blocker_cancelled)` |

IDs passed to tools are bare UUIDs. The parser accepts only the `task:` scheme,
a UUID, and either no query or exactly one supported lowercase event form above.
Unknown events, extra/malformed queries, fragments and relative `task/<id>` paths
are not claimed; never discard a bad query to reinterpret it as a generic reference.
Relative paths can be mistaken for File references; Task stays in its own scheme.

Labels explain message intent without UI, but the renderer uses the explicit URL
event, not label or current Task status. Event metadata is immutable to the message,
not a Task field/type/status, command or event bus. Generic references remain
eventless. A delayed status_changed card need not show its triggering state.

The frontend renders an inline card with title, status, Executor, latest reported
activity and revision/ACK. An accessible detail dialog reads current definition
and independently paged histories on demand. Host invalidation refreshes visible
reads; reconnect refetches, and superseded reads cannot overwrite current results.
On-demand native observations use session/get only, are labelled separately, and
do not load sessions, poll, scan chat or fabricate live progress.

## Transport and packaging

Task adapts the official stateful Streamable HTTP MCP transport to host module
routes, preserving response headers/streams and cancellation signals. Later POST
cancellation reaches the original call; one cancelled call does not cancel other
calls on that connection. Protocol state is not trusted actor identity or business
storage. Expired transport sessions require explicit reconnection, not business
write retries. Connection capacity, disposal and host calls are defined in the
[host contract](task-host-contract.md).

Task ships backend/frontend assets, role prompts, two self-contained role Skills,
one shared `github-coding` work Skill and runtime dependencies. Both roles declare
the same work-Skill discovery root; no new loading API or Task schema is involved.
Installation does not resolve dependencies at runtime.
Modern build/install instructions are in [Task](task-board.md#module-api-and-packaging).
Packaging, testing and repository cleanup perform no production installation,
role/session changes or deployment.
