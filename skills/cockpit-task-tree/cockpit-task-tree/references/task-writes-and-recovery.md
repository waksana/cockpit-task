# Task writes and recovery

This reference explains how to change Task records without overwriting new
requirements, duplicating effects or mistaking partial success for completion.
It is not a general implementation-safety guide.

Read the relevant section for unfamiliar write rules, a version conflict, a partial
report, status subscriptions or uncertain effects. Reuse understood guidance; exact arguments
belong in tool schemas, not a per-turn checklist.

The assignment, ACK and report sections below describe Agent Tasks. Automation is
service-managed: no Executor, ACK, session slot or Agent report. Executor read/edit/cancel
access does not authorize create/start; only Owner guidance covers it. Script/inputs never change;
queued/starting/running definitions and materials are frozen. Success writes a service
done+outcome, failure/interruption blocked+outcome; no automatic rerun. Reconciliation
only releases a proven-safe process-group barrier, never turns blocked into done.

## Identity and concurrency

Supply your actual host-provided session ID as `actor_session_id`, including on
reads. It is attribution, not an ACL or proof that another session read the Task.
Tool access is not permission to claim another Executor's work or ACK for them.
Keep credentials and tokens out of Task text, metadata and messages.

Use a stable `request_id` for one intended mutation. An exact replay retains both
that ID and the complete original input; a different intent uses a new ID.
Do not change IDs merely because the previous response was lost.

For a new mutation, supply fresh returned `write_context` or definition `revision`
only where required by the tool schema; `task_cancel` does not require a revision or ACK.
The context protects assignment/lifecycle and editable materials, while revision
protects the definition. Do not construct contexts or increment revisions yourself.
Read current state on conflict. A corrected request with new inputs is a new intent,
not an exact replay; first establish the old request's effects so it cannot duplicate
saved work or overwrite newer requirements.

Definition edits replace the complete description and record a reason. Pure
metadata edits do not change the definition or authorize execution.
Title, references and metadata do not advance the description revision; do not hide
new requirements there. Supplied references/metadata replace the whole field;
omitting one preserves it, while an empty collection explicitly clears it.
Record decision provenance in the description/reason as appropriate; there is no
separate `source` input to invent.
Successful changed-description edits by the assigned Executor on an unfinished
Task ACK that revision; unchanged text or metadata-only edits do not.

## ACK, activity and delivery

`task_ack` confirms a revision without starting execution or adding activity.
Executor reads full `execution` at start, resume and checkpoints before confirming
the exact current revision; selected overview groups never replace that read.
It does not send messages. An already-confirmed current revision needs no duplicate
ACK. Report actual status changes explicitly with `task_report`; activity alone
does not change status, and outcome alone does not mark done.
An activity must refer to a revision genuinely ACKed for the assignment.
Reading a version or acknowledging a later one does not ACK skipped versions.

An old-version activity may be saved while the same request's stale status or
outcome is rejected. Inspect `result`, `error` and `definition_check` together;
do not resubmit already-saved activity or claim the entire request had no effect.
Before current-version status or delivery, reconcile and ACK current requirements.
Marking done requires a new outcome and explicit `retro` string or null in the same
report, not a previously stored draft. Ordinary reports omit retro; only done
accepts it. Missing retro is rejected, not interpreted as no findings.
Every incoming done request missing retro, including an old-format replay,
returns `INVALID_INPUT` before any writes, including activity. Legacy operations
remain untouched: read `task_read(view=operation,request_id=<original ID>)` to
inspect the saved result without side effects. Do not auto-fill null or retry
modified input with the same request ID. Exact replay of a valid new request
retains its original saved result without duplicate effects.
For example, if v2 activity was saved but its status/outcome were rejected after a
v3 edit, retain the v2 fact, read and ACK v3, then assess the work against v3 before
any new report. Do not re-submit the activity or simply re-label the old result.

`definition_check` describes the response checkpoint, independently of the original
effects, and is refreshed even on replay. A newer revision in that check does not
undo an already-saved report. An unavailable check is not evidence of alignment.
An ACK reminder describes the assigned Executor's responsibility, not an instruction
for Owner or another reader to ACK on their behalf.

## Completion retro

Complete delivery first, then briefly reflect before done. Record only useful
actionable observations: automation candidates, specific slow/repeated sticking
points, or Skill/MCP discovery, contract or capability harness gaps. Cite actual
evidence, not fabricated timings; distinguish observation from hypothesis and
external waits. No mandatory sections or filler: no findings means explicit null.
Retro is not an outcome, blocker report or authorization to improve/expand scope.
It adds no notification, dispatch or Owner review gate. The service enforces
submission and persistence, not thought or text quality. Script automation has
no Agent retro.

These are alternative complete `task_report` arguments for synthetic Tasks, not
two calls to execute in sequence. Replace IDs, revision and returned write context
with actual values; text must describe your own evidence.

```json
{
  "task_id": "11111111-1111-4111-8111-111111111111",
  "actor_session_id": "executor-session",
  "request_id": "complete-with-finding",
  "write_context": "returned-write-context",
  "revision": 1,
  "status": "done",
  "outcome": {
    "summary": "Delivered the agreed validation report; all agreed checks passed.",
    "references": [{"label": "Validation evidence", "target": "reports/validation.txt"}]
  },
  "retro": "Observed: reports/validation.txt records the same parameter-validation command for three fixtures. A reusable fixture command is an automation candidate; time savings are unmeasured. No improvement work was performed."
}
```

```json
{
  "task_id": "22222222-2222-4222-8222-222222222222",
  "actor_session_id": "executor-session",
  "request_id": "complete-with-no-findings",
  "write_context": "returned-write-context",
  "revision": 1,
  "status": "done",
  "outcome": {"summary": "Delivered the agreed report with its validation evidence."},
  "retro": null
}
```

Retro text is nonblank and at most 2,000 characters. The combined serialized
`{outcome,retro}` is at most 16,000 characters, including references and escaping.
The report's `retro` effect is `saved`, `rejected` or `not_requested`; completion
status, new outcome and retro save atomically. A stale completion may preserve
its acknowledged old-version activity while rejecting status, outcome and retro.
Inspect each effect before any corrected request; never relabel old work.
The retro inherits that outcome's revision, Executor, author, reported source,
time and outcome ID. Later definition edits leave these facts intact and show
`current:false`; neither reopens the Task nor creates a new reflection.

## Creating, preparing and assigning

Task registration, Executor-session creation/preparation and assignment are distinct.
`task_session_create` assembles a new session with the single Task `node` role (Executor
for its own assignment, Owner for child Tasks it may delegate), optionally preparing explicit
`skills` / `mcp_servers`; it does not assign or start a Task. Readiness checks that the
`node` role is applied; sessions still carrying removed `owner`/`executor` roles must be
given the `node` role before assignment.
Omitting both selections preserves legacy creation; an explicit empty array still
requests preparation. Choose existing discoverable native names, never inferred
resources from Task text. Requested MCP tools are raw names checked against the
actual filtered offered table; `*` is rejected, and omitted/empty tools still require
an offered raw tool. Preparation initializes once for null metadata or confirmed
selected resource enablement, even if metadata remains non-null after MCP enable.
Already-enabled/no-op selections with non-null metadata and genuinely missing tools
still fail without speculative rebuild; preserve effects, do not reload or toggle
unrelated resources. Omitted/empty selections return one actual offered raw-name
witness, not a catalogue; explicit selections return only requested offered names.
Receipt errors are at most 2,000 characters, with truncation explicitly marked.
Choose new versus existing deliberately; creation is not an automatic fallback.
Owner can use `task_session_prepare` for an already loaded idle Executor with its
role applied and no pending role reload. Exclude any Executor bound to unfinished
work even if native idle; there is no `task_id` repair mode. Preparation neither
creates/renames nor changes model/roles, binds a Task or sends a prompt. It preserves
unrelated choices, does not install/authenticate, change global defaults, bypass
policy or reload/cold-load. Unsupported hosts reject explicit preparation before
effects; do not replace it with manual toggle/initialization choreography.
`task_assign` checks an existing candidate's capabilities and availability without
installing missing roles or interrupting a busy session.
It binds the Task and sends one assigned reference; do not send it again manually.
After binding it tries once to title an auto/default-named Executor session with the
Task title; `operation.session_title` reports renamed, unchanged, skipped (custom name
kept or host lacks provenance) or failure. That step never changes the assignment;
do not rename or retry manually unless the user asks.
The idle/empty checks and enqueue send are not atomic. A race may leave a queued
or unconfirmed send; inspect the per-step receipt instead of assuming nothing sent.
Role labels or earlier readiness are not permanent proof of current capability.
First assignment does not change the definition, ACK, status or activity.

Creation, preparation or dispatch can partially apply. Read the operation receipt using its
`request_id` before deciding what remains to do. Preserve a confirmed created
session even when readiness failed. A timeout or error is not proof that no
session was created or no message was sent.
For resource-aware create/prepare, inspect `preparation`, host `resources` per-step
effects and separate final `capability`. Prepared/initialized is not ready; ready
is not authorization, assignment or execution. Skill enabled is not body loaded.
After a known preparation failure, read the receipt and current state before an
explicit new request to continue safely. Unknown effects never justify blind retry,
replacement or claiming success; replay retains the original effects without
repeating external actions. Same-target prepare/assign conflicts are rejected for
the call lifetime within the loaded Task service, not through a new durable lock.
Caller cancellation gates the next Task-to-host call; a submitted preparation call
may still complete its selected native steps. Inspect actual receipt effects, not
an assumption of interruption, rollback or safe retry.
For capability/availability rejections, inspect `operation.details.reasons` and
`availability_reasons`. They describe the recorded `observed_at` checkpoint, not
current live state; receipt reads do not refresh it. Missing diagnostics do not
justify guessing a busy reason, repairing capability or retrying automatically.

Only an unused, finalized receipt proving `assignment=applied` and `message=not_sent`
allows explicit dispatch recovery with `resume_request_id`, the same Task and
Executor, and fresh context/revision under a new request ID. Task must still be
eligible for that initial dispatch; recovery neither reopens it nor reassigns it.
Pending, unknown, queued or accepted sends cannot use that path.
Do not create a second Executor or resend to manufacture a successful receipt.
An accepted message is not an ACK or evidence of actual work.

## Task dependencies (blocked_by)

`blocked_by` is the complete set of Task IDs (at most 20, same Owner) that must all
be `done` before a Task is ready. Set it with `task_create`, or replace the whole set
with `task_edit` while the Task awaits dispatch: unassigned `todo`, or automation not
yet started; `[]` clears it. The service rejects an unknown Task, another Owner's Task
(notices go to the dependent's Owner, who coordinates both), a cancelled blocker,
self-dependency and cycles. Changes refresh `write_context` but not the description
revision, and send nothing.

Ready means every blocker is `done`. `task_assign` and `task_automation_start`
reject `TASK_NOT_READY` otherwise, before any Executor check; there is no override.
Readiness never changes status, assigns, starts or dispatches: the dependent stays
unassigned `todo` and dispatch remains Owner's authorized judgment. Reads show
`blocked_by` (each blocker's ID and status) and `ready` on list, overview, execution
and selected `context`.

When the last blocker of a Task still awaiting dispatch becomes `done`, the system
sends one `[As Owner: Task ready](task:<uuid>?event=ready)` card for the dependent to its Owner.
When a blocker is cancelled, it sends one `[As Owner: Task blocker cancelled](task:<uuid>?event=blocker_cancelled)`
card; the dependent stays not ready until Owner removes that blocker or cancels the
dependent. Owner edits that make a Task ready send nothing. A blocker reopened and
completed again can send a new ready card. There is no polling, automatic assignment,
reminder or workflow engine. On either card, read the dependent (`include=["context"]`
shows readiness; add groups only as the decision needs), reassess whether B is still
needed and authorized, then dispatch or revise it. Inspect delivery with
`task_read(view=dependency_notices)`; the same no-blind-resend rules as subscriptions apply.

Follow-up recognized but not yet decided with the user may also be recorded as an
unassigned planning Task `blocked_by` its prerequisites. Its description states plainly
that it is a pending decision (what must be discussed, candidate items, links) and must
not be executed before that discussion. Owner may still cancel it before dispatch on the
user's decision. On its ready card, assign it to a new session rather than claiming it
yourself. That Executor discusses it with the user, records the agreed requirements as its
own Task's complete definition, then delivers directly or delegates more specific child
Tasks. If the user decides against it, cancel it with the user's decision as the reason. This is guidance only: no new status, kind or tool.

## Delegating child Tasks

A session's role is decided per Task: Executor for the Task assigned to it (ACK, deliver,
report), Owner for child Tasks it creates for that Task (state requirements, dispatch, follow
up). Derive the role from Task facts, not memory: `executor` is you means Executor, `owner`
is you means Owner; reads with your `actor_session_id` return it as `actor_role`, and cards
are labelled "As Executor" / "As Owner". When unsure, read the Task. Owner and Executor
guidance stay separate: no self-acceptance, Owner does not implement a delegated child, and
one unfinished assignment per session still holds, so children go to other sessions.
`task_session_create` gives new sessions the `node` role, so a child's Executor may delegate
further by the same rules without a reload.

There are no preset domain-lead identities. Split and delegate when a Task contains several
independent outcomes, needs item-by-item trade-off discussion with the user, or its follow-up
detail would crowd its own context; deliver a single coherent result directly. The heavier
the load, the more the session leans toward delegating. A child must be more specific than its
parent, never passed down unchanged, and within the parent's authorized scope; anything
outside that scope is asked of the user directly. Its description is the complete child
agreement and references the parent. Record which child covers what in the parent's
activity. The parent integrates and verifies child results before completing its own Task.
Child Tasks are part of the parent's Task: follow each one until its result is integrated.
The service wakes the parent's Executor, as the child's Owner, with one `child_done`,
`child_blocked` or `child_cancelled` card per such transition while the parent is unfinished;
no subscription, polling or reminder is needed, and a waiting explicit subscription that
matches the same transition replaces the card rather than duplicating it. On the card, read
the child with one bounded overview and integrate, unblock, revise or replace it within your
authorized scope; a card never changes the parent's agreement. Without ready delegation
capability, deliver directly or ask the user; never fake delegation.

Pending-decision planning Tasks are assigned to a new session that discusses them with the
user and then delivers or delegates; the Owner does not claim them itself.

When `task_create` is called with an `owner` that is executing an unfinished Agent Task,
the service records that Task as the new Task's `parent_task_id` and sets `depth` to the
parent's depth plus one; otherwise the Task is top-level (`parent_task_id: null`,
`depth: 1`). Delegation is capped at 3 levels: creating beneath a depth-3 Task fails with
`DELEGATION_DEPTH_EXCEEDED` and saves nothing; deliver directly or ask the user how to
restructure. Lineage is fixed at creation, survives the parent finishing and is never
inferred for Tasks created before schema v7. It records where a child came from; it does
not change `blocked_by` readiness, notices, assignment or authority. Child notices go to the
child's Owner, which is the parent's Executor. Read direct children with
`task_read(view=list, parent_task_id=<Task ID>, status=all)`; delivery evidence for child
cards is in `task_read(view=child_notices, task_id=<child ID>)`.

The service rejects role confusion before any effect:
- `DELEGATION_OWNER_MISMATCH`: a session executing an unfinished Agent Task creates Tasks
  only with itself as `owner` (they are its children), and no other session can create a
  Task owned by a session that is executing one;
- `SELF_ASSIGNMENT`: a Task is never assigned to its own Owner; assign another session.
  Doing the work yourself without a Task fits only a node that already holds a Task, or
  an explicit user instruction, never a root node's default delegation;
- `DELEGATION_CYCLE`: a child is never assigned to a session that owns or executes one of
  its ancestor Tasks, so work cannot loop back up the lineage.

## One-shot status subscriptions

Default to no subscription. Owner registers only when a future state enables a
concrete, necessary authorized Owner follow-up, not simply to track progress, know
completion or repeat a report.
For example, evidence may be needed for an Owner decision or another authorized
independent Task; a standalone delivery with no Owner action needs no wait.
Owner judges this need without asking the user to name or approve the subscription.
Do not invent follow-up work, split an outcome or add an approval gate to justify it.
Choose the fewest target states that enable the needed action. If that action is
no longer needed, withdraw the still-waiting subscription instead of retaining a
completion reminder. Executor's authorized work never waits for Owner to subscribe
or read a notice.
An Executor's direct user question, even when blocked, stays in that session;
Owner does not subscribe to relay it or turn it into an acceptance step.

Sequenced follow-up uses [Task dependencies](#task-dependencies-blocked_by), not
per-prerequisite subscriptions. When the user has authorized "do B after A completes",
create B immediately as an unassigned Task with `blocked_by` and its complete
description; the system notifies Owner when B becomes ready. Keep one-shot
subscriptions for other necessary follow-ups, such as a decision from a result.
Private Owner notes, todos and plans trigger no reminder: without a dependency or
subscription, a status-dependent follow-up waits until the user prompts it.

Owner can explicitly register with `task_subscribe`, withdraw with `task_unsubscribe`,
and inspect records with `task_read(view=subscriptions)`. Use current tool schemas
for inputs, not inferred fields. At most one subscription may be waiting per Task.
Its recipient is derived from Task's `owner`, not an arbitrary addressee or the
reported actor. This adds no subscription capability to Executor.
Unsubscribe cancels only a waiting subscription; it cannot retract a triggered
notification. If Task enters a terminal status outside the selected targets,
the waiting subscription expires without notification.

Only a real transition into a selected Task status satisfies the subscription,
on the first match, after which the subscription ends. It does not listen to
activity, definition changes or native busy/idle state, and requires no polling.
If the Task already has a selected status at registration, registration fails
because it is already in that state: no subscription is created and no notice sent.
Do not toggle status or replace the Task to manufacture a future transition.

The system sends a separate `status_changed` card to the Owner as a new prompt.
It does not keep the subscribing turn suspended; host enqueue queues it when busy
without interrupting. This is not the `updated` handoff to Executor: do not clear
queues, interrupt work or request a notification ACK for a status subscription.
Read only necessary latest content on receipt in one bounded
`task_read(view=overview, include=[...])` call where possible, choosing groups for
the decision, not a fixed bundle. Use `["outcome"]` for delivery evidence,
`["activity","outcome"]` only when diagnosis needs both, or `["context"]` for status.
See [selective reads](reading-tasks.md#select-the-latest-content-for-the-decision)
for the group and size contract. Reassess the planned follow-up; act only if
it is still needed and authorized; do not automatically resubscribe or turn this
into ongoing monitoring.

For a triggering `task_report` or `task_cancel`, distinguish saved Task effects
from notification delivery. The original `result`, including `subscription_ids`,
is retained alongside `notifications` and an independent `notification_error`.
A notification failure can set MCP `isError=true` while `error` remains null;
saved Task status and outcome are not rolled back. Read the actual subscription
facts with `task_read(view=subscriptions)`; dependency cards appear as `notice_ids`
and in `task_read(view=dependency_notices)` on the dependent Task. Do not repeat a saved report, redo
delivery or manually send a replacement notice to Owner because notification failed.

Preserve request identity and inspect subscription/operation records on uncertain
effects. Queued or accepted does not mean read. Without host prompt idempotency,
do not claim exactly-once delivery. An unknown send does not authorize a blind
resend, replacement Task or another subscription. The system exception neither
restores default progress/final notifications nor permits Executor-to-Owner messages.

## Original-Executor rework after done

Only explicit user authorization for rework permits the original Executor to use
`task_reopen` on its done Agent Task. Read full current `execution`, reconcile the
complete new agreement, and submit `task_id,actor_session_id,request_id,write_context,
revision,description,reason`. Description is full text; reason records the user
decision, not an authentication credential. Actor must equal the recorded Executor;
do not impersonate it. Reopen is not `task_assign` dispatch recovery.

Eligibility is durable: the assignment must have been recorded after schema v5
upgrade, no other Task may have been assigned to that Executor since it, and no
other unfinished Task may occupy it. Even later done/cancelled assignments disqualify.
All pre-upgrade assignments are ineligible; no timestamps or historical backfill
can establish order. The service uses monotonic assignment order and rechecks
eligibility transactionally. Host capability readiness is required, not native
idleness: the original Executor can call while executing this very user request.
No prepare, self-prompt, dispatch or workspace creation is part of reopen.

One atomic change preserves identity and histories, enters `in_progress`, creates
a new description revision even for identical text, self-ACKs it and advances
lifecycle context. The changelog keeps author, reason and time; references, activities,
old ACKs, outcomes and completion retros remain. The prior outcome/retro is
`current:false`; an old ACK/outcome cannot deliver the new revision. Complete again
with a new outcome and explicit retro text or null, without mandatory status-log
activities or a separate round state machine. Ended subscriptions stay ended;
reopen sends no notice and does not renew or duplicate an earlier notification.

`REOPEN_NOT_ELIGIBLE` means missing tracked assignment or an intervening assignment;
`EXECUTOR_MISMATCH` means the actor differs from the original Executor;
`EXECUTOR_OCCUPIED` means other unfinished work; `TASK_STATE_CONFLICT` means not done;
`AUTOMATION_MANAGED` excludes automation. Existing revision/context, capability and
request-replay checks still apply. Inspect saved effects on uncertainty rather
than changing request IDs or retrying external work.

For coding, follow `github-coding` for retained worktree reuse, fresh setup when it
was removed, and the follow-up PR. Resolve a conflicting workspace explicitly.
Owner does not create a replacement when eligible original-Executor continuation
can meet the request; otherwise use an appropriate new authorized Task.

## Ending and preserving work

Use cancellation only for an explicit cancellation decision. A cancelled Task
does not prove its native session stopped; record changes do not reverse external
effects. Cancelled Tasks cannot resume, and bound Tasks cannot change Executor.
Done Agent Tasks may resume only through the explicit rework path above, never
ordinary reports, old instructions or definition edits.
For automation, prelaunch cancellation prevents launch and running cancellation requests
process-group termination, not proof of exit or rollback. Read the run outcome/barrier.
Started work never reruns on recovery; repeating requires new authorization and a new Task.
Even a permitted definition edit on a terminal Task does not reopen or ACK it.
Do not keep performing consequential work after cancellation or invalid execution state.

Temporary reporting failure is not a reason to repeat completed real-world work.
Preserve truthful evidence, inspect actual effects and tell the user reporting is
unavailable. Record the missing facts in Task when possible without duplicating
saved effects. This is not a second ongoing progress ledger or permission to message
Owner; uncertainty must not be disguised as success or safe-to-retry failure.
