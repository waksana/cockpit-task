# Task writes and recovery

This reference explains how to change Task records without overwriting new
requirements, duplicating effects or mistaking partial success for completion.
It is not a general implementation-safety guide.

Read the relevant section for unfamiliar write rules, a version conflict, a partial
report, status subscriptions or uncertain effects. Reuse understood guidance; exact arguments
belong in tool schemas, not a per-turn checklist.

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
It does not send messages. An already-confirmed current revision needs no duplicate
ACK. Report actual status changes explicitly with `task_report`; activity alone
does not change status, and outcome alone does not mark done.
An activity must refer to a revision genuinely ACKed for the assignment.
Reading a version or acknowledging a later one does not ACK skipped versions.

An old-version activity may be saved while the same request's stale status or
outcome is rejected. Inspect `result`, `error` and `definition_check` together;
do not resubmit already-saved activity or claim the entire request had no effect.
Before current-version status or delivery, reconcile and ACK current requirements.
Marking done requires a new outcome in the same report, not a previously stored draft.
For example, if v2 activity was saved but its status/outcome were rejected after a
v3 edit, retain the v2 fact, read and ACK v3, then assess the work against v3 before
any new report. Do not re-submit the activity or simply re-label the old result.

`definition_check` describes the response checkpoint, independently of the original
effects, and is refreshed even on replay. A newer revision in that check does not
undo an already-saved report. An unavailable check is not evidence of alignment.

## Creating and assigning

Task registration, Executor-session creation and assignment are distinct actions.
`task_session_create` assembles a new Executor; it does not assign or start a Task.
Choose new versus existing deliberately; creation is not an automatic fallback.
`task_assign` checks an existing candidate's capabilities and availability without
installing missing roles or interrupting a busy session.
It binds the Task and sends one assigned reference; do not send it again manually.
The idle/empty checks and enqueue send are not atomic. A race may leave a queued
or unconfirmed send; inspect the per-step receipt instead of assuming nothing sent.
Role labels or earlier readiness are not permanent proof of current capability.
First assignment does not change the definition, ACK, status or activity.

Creation or dispatch can partially apply. Read the operation receipt using its
`request_id` before deciding what remains to do. Preserve a confirmed created
session even when readiness failed. A timeout or error is not proof that no
session was created or no message was sent.

Only an unused, finalized receipt proving `assignment=applied` and `message=not_sent`
allows explicit dispatch recovery with `resume_request_id`, the same Task and
Executor, and fresh context/revision under a new request ID. Task must still be
eligible for that initial dispatch; recovery neither reopens it nor reassigns it.
Pending, unknown, queued or accepted sends cannot use that path.
Do not create a second Executor or resend to manufacture a successful receipt.
An accepted message is not an ACK or evidence of actual work.

## One-shot status subscriptions

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
Read the current Task on receipt and decide whether any follow-up is needed;
do not automatically resubscribe or turn this into ongoing monitoring.

For a triggering `task_report` or `task_cancel`, distinguish saved Task effects
from notification delivery. The original `result`, including `subscription_ids`,
is retained alongside `notifications` and an independent `notification_error`.
A notification failure can set MCP `isError=true` while `error` remains null;
saved Task status and outcome are not rolled back. Read the actual subscription
facts with `task_read(view=subscriptions)`. Do not repeat a saved report, redo
delivery or manually send a replacement notice to Owner because notification failed.

Preserve request identity and inspect subscription/operation records on uncertain
effects. Queued or accepted does not mean read. Without host prompt idempotency,
do not claim exactly-once delivery. An unknown send does not authorize a blind
resend, replacement Task or another subscription. The system exception neither
restores default progress/final notifications nor permits Executor-to-Owner messages.

## Ending and preserving work

Use cancellation only for an explicit cancellation decision. A cancelled Task
does not prove its native session stopped; record changes do not reverse external
effects. Completed/cancelled Tasks cannot resume execution or change Executor.
Even a permitted definition edit on a terminal Task does not reopen or ACK it.
Do not keep performing consequential work after cancellation or invalid execution state.

Temporary reporting failure is not a reason to repeat completed real-world work.
Preserve truthful evidence, inspect actual effects and tell the user reporting is
unavailable. Record the missing facts in Task when possible without duplicating
saved effects. This is not a second ongoing progress ledger or permission to message
Owner; uncertainty must not be disguised as success or safe-to-retry failure.
