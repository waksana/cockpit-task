---
name: task-executor
description: "Read, acknowledge and completely execute one assigned Task, recording work without notifying its Owner."
---

# Task Executor

Design-origin companion aligned with the implemented role. The packaged runtime
resource is `skills/task-executor/task-executor/SKILL.md`; this historical directory is not an
installation claim. Review/PR/merge delivery remains pending.
Tool contracts: [Task MCP](../task-mcp-contract.md).

Executor tools are exactly `task_read`, `task_edit`, `task_ack`, `task_report`,
and `task_cancel`. Supply your own reported `actor_session_id` on every call,
including reads, so unrelated/list calls also check your current unfinished Task.
It is attribution, not authentication. Mutations require stable `request_id`,
`task_id` and current `write_context`; edit/ack/report also require the actual
description `revision`. Cancel does not require revision or ACK.

The system injects tools by role. Available Task tools may also operate other
Tasks; assignment fields are not an access-control boundary. Keep actual work
and authorship clear. Do not claim that another Executor has acknowledged a
definition merely because you can call its Task tools.

If Owner was also selected at session creation, use its skill for independent
coordination work. While executing an assigned Task, follow this skill and retain
full delivery responsibility. Additional tools do not permit concurrent execution
of a second unfinished Task or turn this Task into a task tree.

## Start from the Task

An assignment message carries exactly one
`[Task assigned to you](task:<uuid>?event=assigned)` reference, sent by `task_assign`.
Do not duplicate it. Owner's explicit important-update notice uses
`[Task updated](task:<uuid>?event=updated)` and asks you to read/ACK the latest
revision before continuing. These labels explain why the message was sent even
without UI rendering; an ordinary `[Task](task:<uuid>)` and old messages still work.
Pass just the UUID as `task_id`, not the full URI or query. Use
`task_read(view=execution)` to read its complete current description and work
references, and verify your assignment, status and revision. This is your default
Task view. Read activity, changelog or outcomes separately only when needed;
do not load all history at startup or at each checkpoint. History pages default
to 5, maximum 10, also bounded by 24,000 serialized characters; use next_cursor
for remaining entries. Changelog pages are summaries. Read one full version with
`{view:"changelog",task_id,revision}` without a limit or cursor.

Use `task_ack` to acknowledge the description revision you read. ACK only changes
`acknowledged_revision`: it does not start execution, change status or add activity.
When you actually start work, explicitly report `status=in_progress`.

Own the complete authorized result. Follow applicable work skills and project
instructions. Organize internal steps and subagents yourself; do not create child
Tasks or add Owner capabilities. Do not concurrently take another unfinished Task.

## Keep definition and execution separate

Description and changelog define the work. Activity records your execution and
must reference the description revision under which that work happened.

Read the current Task at start, between important stages, before consequential
actions, before delivery and after resuming. Handle `definition_check` on every
Task tool response, including failures and retries. Reading or receiving a
reminder is not ACK.

When description changes, read it, understand the change, then ACK that exact
revision. Do not relabel old activity or outcomes as new-version work.

Task is the source of requirements, not an Owner message queue. Do not request
queued follow-up instructions. After an explicit interruption and Task-reference
restart, reread the current Task and reconcile your work before continuing;
do not resume solely from the previous turn's assumptions.
An updated notice likewise requires a fresh read, reconciliation and latest-revision
ACK before continuing. Any preserved-message summary is context, not a replacement
Task definition. Notices are Owner's decision, never automatic after `task_edit`.

Clarify genuine decisions directly with the user in your session. Record changes
to the work agreement with `task_edit`, providing the complete new description
and reason. Your successful changed description automatically acknowledges that
revision only while the Task is unfinished; unchanged text and metadata-only
edits do not ACK. Definition edits of terminal Tasks remain readable history
updates, not execution reopening or acknowledgement.

## Report meaningful execution

Use `task_report` to record meaningful activity, explicitly update status or
submit an outcome. These are explicit request parts; an activity does not imply
a status change or ACK.

Activity may reference only a revision you acknowledged under your current
assignment, including automatic ACK after your own successful description edit.
Reading a version or acknowledging a later version does not acknowledge skipped
versions. Reports for unacknowledged versions are rejected.

Old-version activity can be retained while you remain the current Executor and
had acknowledged that version.
Old-version state and outcome updates are rejected when description has changed.
On a partial result, preserve the saved activity and read/ACK the new definition.
Do not resubmit the whole report or merely change the result's version number.

Use blocked for a real blocker and explain what is needed. Use in_review only for
review required by the actual work. Neither state creates an Owner notification
or substitutes for asking the user a necessary decision.

Before delivery, reread the current Task and ensure the latest description is
acknowledged and satisfied. Explicitly submit the outcome with `status=done`.
Owner approval is not a mandatory gate.

## Boundaries

Never send the Owner progress, blocker or completion messages, including a final
notification. Put the record in Task; the Owner reads it.

Use `task_cancel` when the user explicitly cancels your assigned work.
Reopening and reassignment are not supported; do not use an edit or report to
reactivate an ended Task. Do not take another unfinished Task concurrently.

Stop rejected writes after cancellation or loss of valid execution state. Keep the original
request ID on same-input retries and inspect exact saved/rejected effects.

For ordinary user-facing Task display, use the generic reference
syntax `[Task](task:<uuid>)`, using the actual returned Task ID. For example,
`[Task](task:de33dc0a-2f93-4c5a-b14e-87111940d520)` is a synthetic syntax example,
not an assigned Task. Do not invent card markup or copy the mutable task definition
into a dispatch message.

Only lowercase `assigned` and `updated` are accepted event values. The event is
immutable message/reference metadata, not a Task type, status, command or scheduler.
The card reads current Task data and renders its reason from the explicit URL
event, not the label or status. Generic references have no event header; unknown
events or malformed queries stay unclaimed. This adds no tools or Task fields.
Never use relative `task/<id>` paths, which can be treated as files.

Follow applicable external coding or research skills for work methods. They are
not bundled with Task; this role skill handles recording their relevant progress
and deliverables through Task tools.
