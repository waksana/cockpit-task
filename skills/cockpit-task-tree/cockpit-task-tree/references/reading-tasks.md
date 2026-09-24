# Task views, fields and pagination

Read this when view selection, a returned field or a truncated excerpt needs
explanation. Familiar reads do not require reloading it. These are the implemented
`task_read` projections, including opt-in overview groups, not an arbitrary fields engine.

## Orchestrator's default view

For an overview of your Subtasks, use `view=list` with `orchestrator` set to your session ID.
For one Task's direct Subtasks, use `view=list` with `parent_task_id` and `status=all`.
For the pre-dispatch conflict check across all orchestrators, use `view=list` with
`status=unfinished` and no orchestrator, assignee or parent filter.
Add `retro="unhandled"` for Tasks whose latest retro has findings but no handling, or
`retro="watching"`; with a retro filter, `status` defaults to `all`.
For one Task, use `view=overview` with its `task_id` and select only needed groups
with `include`. Context alone is `include=["context"]`.
The host supplies your session identity on every read. This is reported attribution and
definition-reminder context; it is not authentication or an automatic orchestrator filter.

Without `include`, the single-Task overview retains its existing compact shape:

| Fields | Meaning |
| --- | --- |
| `id`, `task_id`, `title` | Identity and human-readable work title |
| `kind`, `automation` | `agent` by default; automation runtime facts without an assignee or ACK obligation |
| `orchestrator`, `assignee`, `status` | Session that created and orchestrates the Task, assigned session or null, and declared lifecycle state |
| `revision`, `acknowledged_revision` | Current definition versus actual assignee confirmation; null means no ACK |
| `actor_role` | Your relation to this Task from its facts: `assignee` (your Task), `orchestrator` (your Subtask) or `none`; only rows written before schema v9 may show `orchestrator_and_assignee`. Derive your relation from this, not memory |
| `parent_task_id`, `depth` | Delegation lineage fixed at creation: the parent Task whose assignee created this Task, or null for top-level; `depth` 1–3. Not a readiness gate or authority |
| `blocked_by`, `ready` | Each declared blocker's `task_id` and current `status`, and whether all are `done`; `[]`/true without dependencies. Ready is a dispatch gate, not a status or instruction |
| `activity` | Latest activity or null, including its ID, revision, assignee, author, time and reported source |
| `activity.text`, `activity.truncated` | Up to 320 characters of that actual activity, not a generated summary; expand activity if truncated and relevant |
| `outcome` | `{available:false}` or latest outcome ID, revision, time, `available:true` and `current` |
| `retro` | Completion reflection status and attribution, without text; independent of outcome availability. With findings, `handling` gives the orchestrator's latest status and attribution, or `unhandled` |
| `created_at`, `updated_at` | Task record timestamps, not proof of live session activity |
| `write_context` | Opaque concurrency context for later writes, not business progress |
| `cancellation` | Reason, author and time when cancelled; single overview only |

List items use the same compact projection without the cancellation detail.
These legacy projections omit `description`, `references`, `metadata`, full outcome text,
all activities or the definition history. List pagination does not expand every
Task into its execution view.

An ACK gap means requirements have not been confirmed, not that the session is
currently reading, stuck or idle. `outcome.current` only compares its revision
with the current definition. An available/current outcome can still be partial;
combine its actual text with Task status and requirements before claiming delivery.

## Select the latest content for the decision

`include` is valid only with `view="overview"`: a nonempty array of at most seven
unique group names from `context`, `activity`, `outcome`, `retro`, `definition`,
`automation`, `cancellation`. Unknown names, duplicates, empty arrays and use with
other views are invalid. Omitting `include` preserves every existing view's shape.
This selects content groups, not arbitrary columns or a role-dependent projection.

Every selected response includes compact current context: `id`, `task_id`, `title`,
`orchestrator`, `assignee`, `status`, `revision`, `acknowledged_revision`, `created_at`,
`updated_at`, `write_context`, `kind`, `parent_task_id`, `depth`, `blocked_by`, `ready`, plus `actor_role` for
the calling session. Context is always returned even if not explicit;
`include=["context"]` returns only that context.

| Group | Additional content |
| --- | --- |
| `activity` | Latest complete activity record or null, not the legacy excerpt |
| `outcome` | Latest complete outcome record or null, including result references, excluding nested retro |
| `retro` | Independent completion reflection, with text including explicit null and provenance |
| `definition` | Current full description, references and metadata nested with revision, author, at, source and current |
| `automation` | Full immutable script/parameter snapshot and run facts, or null; no logs |
| `cancellation` | Cancellation object or null |

Activity/outcome records retain IDs, revision, `current`, source, author, assignee
and `at`; `current` compares revisions, not truth or delivery quality. Retro uses
`not_recorded`, `not_applicable` or `recorded`; the latest recorded retro is independent
of the latest outcome. Selecting outcome does not implicitly select retro.
Definition author and `at` identify the description revision, not later material edits.

Choose groups from the decision that prompted the read. A notice is only a pointer:
read necessary latest content in one bounded call where possible, not a fixed
overview-plus-outcomes sequence, speculative outcomes-then-activity, or every group.
These are independent synthetic `task_read` examples, not a checklist:

Status/assignment question, with no body needed:

```json
{"view":"overview","task_id":"11111111-1111-4111-8111-111111111111","include":["context"]}
```

A done notice unlocks an already-authorized decision needing delivery evidence:

```json
{"view":"overview","task_id":"11111111-1111-4111-8111-111111111111","include":["outcome"]}
```

A specific diagnosis needs both the latest blocker activity and partial result:

```json
{"view":"overview","task_id":"11111111-1111-4111-8111-111111111111","include":["activity","outcome"]}
```

A concrete reflection question needs the recorded findings, not routine acceptance:

```json
{"view":"overview","task_id":"11111111-1111-4111-8111-111111111111","include":["retro"]}
```

All selected content comes from one SQLite read transaction. Unselected bodies,
logs and histories are not retrieved. The result has a fixed 48,000 serialized
JSON character budget. An oversized result returns explicit `RESULT_TOO_LARGE`
(413) with group sizes, not truncation, a cursor or a cached continuation. Narrow
the groups or use existing full `execution` / `definition` views or bounded history
and log pages as appropriate to the question; do not loop through everything.

`definition_check` is unchanged and reads never ACK. The assignee still reads full
`execution` at start, resume and checkpoints and ACKs the exact current revision.
Selecting `definition` or any other overview groups cannot replace that requirement.

## Expand for a specific question

| Need | View |
| --- | --- |
| Current full agreement before editing | `definition` |
| Assigned work before execution or at a synchronization checkpoint | `execution` |
| Latest full progress/result | `overview` with only needed `include` groups |
| Earlier progress or results | `activity` / `outcomes` histories |
| Why requirements changed | `changelog` |
| Complete text of one past definition | `changelog` with `revision` |
| Whether a failed or uncertain request had an effect | `operation` with `request_id` |
| Records for an explicit one-shot status subscription | `subscriptions` with `task_id` |
| Ready/blocker-cancelled notices sent for a dependent Task | `dependency_notices` with the dependent's `task_id` |
| Done/blocked/cancelled notices sent for a Subtask | `child_notices` with the Subtask's `task_id` |
| Service-sent important-update notices and their delivery | `update_notices` with `task_id` |
| Every orchestrator decision on a Task's retros | `retro_handlings` with `task_id` |

`definition` and `execution` currently return the same complete Task projection:
identity, responsibility, status, revisions, timestamps, write context, description,
references and metadata. They do not bundle activity, outcomes or history.

They also include an independent `retro` object. Each `outcomes` history item
includes its own retro, without changing the saved outcome content:

- `{status:"recorded",text:string|null,revision,assignee,author,source:"reported",at,outcome_id,current,has_findings}`
  means an explicit completion submission. Null text means no useful findings,
  not missing reflection. Attribution comes from the same completion outcome.
- `{status:"not_recorded"}` means no recorded submission, including legacy data
  and ordinary non-completion outcomes; migration never invents old reflections.
- `{status:"not_applicable"}` is the script-automation path, with no Agent retro.

`has_findings` distinguishes non-null text from explicit no findings, not quality.
A recorded retro with findings also carries `handling`: `{status:"unhandled"}`, or the
orchestrator's latest `{id,status,author,at,note,references}` for that `outcome_id`, where
status is `fixed`, `followup`, `watching` or `dismissed`; overview/list omit note and
references. Null text has no `handling`. The `retro_handlings` history view pages every
handling of the Task, newest first, each with its `outcome_id`.
Without `include`, overview/list return the same status and attribution without `text`. A later
description edit preserves the recorded revision and sets `current:false`.
Recorded/current is not proof of thought, quality or delivery. The service adds
no notification or gate; the orchestrator handles findings per subtasks.md. Retro does not
replace outcome/blockers or authorize improvements or scope expansion.

For automation, `definition` / `execution` also include immutable `automation.script`
and `automation.parameters`; overview without `include` and lists contain runtime
facts only. Inspect run
state, exit code/signal/error, cancellation request and barrier independently of Task
status. Service-generated outcomes have automation provenance and a run ID, not a
fabricated assignee: `assignee:null`, `source:'automation'`,
`author:'automation:<run_id>'` (a service label, not a native session).
Automatic subscription transitions carry `event.source='automation'`, `event.run_id`
and `actor:null`, not a fabricated session identity.
Automation rejects assign/ack/report; existing read/edit/cancel
access does not grant create/start or Subtask authority.

`automation_log` requires `task_id` and accepts `offset` (default 0), `limit`
(default 4096, maximum 8192 characters), not a cursor. It returns retained combined
stdout/stderr as `text`, with `next_offset`, `retained_characters`,
`omitted_characters` and `complete`. The retention cap is 65536 characters; omitted
counts explicitly disclose truncation. Escaping may shorten pages. Read further
offsets only for a concrete question, never as a monitoring loop; a null next offset
does not prove execution finished, and complete does not mean success.

`changelog` pages contain revision, reason, author, time and
`description_available` / `description_length`, not generated change summaries
or the definition itself. Selecting a specific revision retrieves its full text.
`outcomes` and `activity` are separate paginated histories, not session transcripts.
Read the next page only if needed, using the returned cursor unchanged with the
same view, Task and filters.

Use `task_read(view=subscriptions)` only for a concrete subscription question.
Follow its schema and returned pagination cursor; do not poll while waiting.
A subscription/delivery record is not proof the orchestrator read a notice or the Task
is now complete. Select the latest evidence needed for the planned decision.
See [subscription handling](task-writes-and-recovery.md#one-shot-status-subscriptions)
for the one-shot lifecycle and uncertain effects. `dependency_notices` follows the
same pagination and delivery-record meaning for [Task dependencies](task-writes-and-recovery.md#task-dependencies-blocked_by),
and `child_notices` for [Subtasks](task-writes-and-recovery.md#subtasks-of-your-task).

List defaults to 20 items, maximum 50, with `status=unfinished` unless specified.
Use an explicit terminal status or `all` when the question includes finished work;
`query` searches titles only. Histories default to 5 items, maximum 10.
Both lists and histories have a 24,000-character serialized-page budget, excluding
the response envelope and definition check. A short page does not imply the end;
use `next_cursor`. History bodies are not silently truncated to fit.

A revision selector cannot be combined with a history cursor or limit. Current
full definitions and a selected past definition are not paginated; their separate
input-size limits bound the result. No view implicitly reads native chat.

For `operation`, the receipt's `status` (`pending` / `final`) is separate from
`result.operation.status`, step results and the Task's status. A finalized receipt
can still record an unknown external effect. Use
[Task writes and recovery](task-writes-and-recovery.md) if deciding whether anything may be retried.

## Projection and response boundaries

Views retain their existing projections; overview alone supports opt-in content
groups. There is no arbitrary `fields` selector and no automatic restriction based on the caller's role. Having
selected an orchestrator does not force `overview`, and the caller identity does not select
only that session's Subtasks.

Responses handled by the Task service carry `result`, `error` and a freshly computed
`definition_check`, including failed operations and replays. Transport/schema
rejection before service handling does not establish that a check occurred.
Compact data does not remove consistency reminders or failures.

The check covers the identified Task and, when applicable, the actor's current
unfinished assigned Task, not all orchestrated Tasks. `checked` reports that checkpoint;
`unavailable` means the check failed, not "no updates". `not_applicable` applies only
when there is no relevant Task. It is neither a role-readiness result nor proof
against later revisions, and never substitutes for reading and ACK.
