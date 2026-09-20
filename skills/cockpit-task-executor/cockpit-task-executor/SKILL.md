---
name: cockpit-task-executor
description: "Execute one assigned Task completely: read and acknowledge current requirements, record activity, clarify revisions and deliver without messaging the Owner."
---

# Executor

Use project instructions and external work skills for implementation or research.
This skill describes collaboration only. One Executor delivers the entire Task;
use internal subagents, not child Tasks. Do not execute two unfinished Tasks at once.
If you also have Owner capabilities, they do not transfer your delivery responsibility.

## Reuse the workflow instructions

Load this Skill when first executing a Task, then reuse its instructions while
they remain available in context. Do not reload before every reply, new message,
Task reference or synchronization checkpoint. Read it again if relevant instructions
were lost through compaction or recovery, the Skill changed, or a workflow rule
needs clarification.

This does not cache Task requirements. Read current Task state at the checkpoints
below and acknowledge changed requirements even when the Skill needs no reload.

## Read, acknowledge, start

A first dispatch is `[Task assigned to you](task:<uuid>?event=assigned)`.
An explicit Owner update notice is `[Task updated](task:<uuid>?event=updated)`,
followed by an instruction to read and ACK the latest revision. These labels
explain why the message was sent even without UI rendering. Generic references
and old messages using `[Task](task:<uuid>)` remain valid.

Extract just the UUID as `task_id`, not the full URI or query. Call `task_read`
with view execution, task_id and your actor_session_id.
Read the complete description, references, metadata,
revision, assignment and status. Other details and history are separate views.
Use your session ID supplied by the host, not an ID guessed from a title.
Reported actor IDs are attribution, not authenticated authority.

Only lowercase `assigned` and `updated` are accepted event values. The event is
immutable message/reference metadata, not a Task type, status or command; the card
reads current Task data. Rendering uses the explicit URL event, not the label or
current status. Generic references have no event header; unknown events or malformed
queries are not silently reinterpreted as generic references. Use the generic
form for ordinary display, never relative `task/<id>` file-like paths.

Call `task_ack` for the exact current revision and returned write_context.
ACK changes neither status nor activity. Then call `task_report` explicitly with
status in_progress when work actually starts.

All writes require a stable request_id; new intent means a new ID, replay keeps
the exact original ID and input. Every existing-Task write uses the returned
write_context. Do not construct or modify concurrency contexts yourself.

## Synchronize at meaningful checkpoints

Read current requirements at start, between stages, before consequential actions,
before delivery and after resuming. Inspect definition_check on every Task MCP
response, including reads, failures, and replay. Reading is not ACK.
If revision changed, reconcile your work, then acknowledge the exact new revision.
Do not merely relabel old activity or outcomes as work against the new definition.

After interrupted or queued work resumes, reread the current Task before proceeding.
Do not rely only on the last cue or previous turn's memory. Do not ask the Owner to
queue instructions: ordinary updates live in Task.
On an explicit updated notice, reconcile the current requirements and ACK the latest
revision before continuing. The preserved-message summary is context, not a second
requirements document. `task_edit` does not automatically send notices; their use
is Owner's decision, not a new tool, Task field or scheduler. Do not duplicate the
first dispatch sent by `task_assign`.

Clarify genuine decisions directly with the user. Record changed requirements
with `task_edit`, supplying the complete new description and a reason.
An actual successful description edit attributed to the assigned Executor
automatically ACKs that new revision; unchanged text does not.
It does not change status or create an activity entry.

## Report facts and deliver

Use `task_report` for meaningful activity, explicit status and/or an outcome.
Activity alone does not change status; outcome alone does not mark done.
Activity references a revision actually ACKed for this assignment. Having read a
version, or ACKed a later version, does not acknowledge skipped versions.

An old ACKed activity may save after a definition update while status/outcome in
the same request are rejected. Inspect each saved/rejected field in result.
Do not replay the whole report or claim all parts failed when activity was saved.
Other invalid reports do not qualify for this partial-application exception.

Use blocked when genuinely blocked, with an activity explaining what is needed.
Use in_review only if the work calls for it. For delivery, read and ACK the current
definition, complete its requirements, and submit a new outcome together with
status done. No mandatory Owner approval is added by Task.

If the user cancels, call `task_cancel` with a truthful reason. Cancelled or done
Tasks cannot reopen; cancellation of a Task does not stop the native session.
No reassignment is supported.

Write progress, blockers and delivery into Task. **Never send the Owner progress,
completion or blocker messages**, including a final notification.
Respond normally in this session and use Task references when useful.
Tool availability permits cross-Task operations, but attribution and claims must
remain truthful; having an ACK tool does not prove another Executor read a Task.
