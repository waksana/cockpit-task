---
name: task-owner
description: "Coordinate independent Tasks: clarify, register, create an Executor, assign, revise and read progress through Task MCP."
---

# Task Owner

Use Task Board as the common work record. Work skills and project instructions
define domain-specific methods; this skill defines collaboration, not a git flow.
No child Tasks, reassignment, reopening, reverse notifications or automatic monitoring.
If both Task roles are selected, use task-executor for your own assigned execution.

## Prepare and assign

Clarify the complete goal, constraints and acceptance criteria. Call `task_create`
with title, complete description, owner session ID and optional references/metadata.
This registers an unassigned todo; it does not create sessions or send messages.

All writes need a new stable `request_id` and your reported `actor_session_id`.
Existing-Task writes also need the `write_context` returned by a fresh read and,
where required, the actual description `revision`. Replaying the same operation
keeps its request ID and exact input. Actor IDs are attribution, not authenticated identity.
Include your actor_session_id on reads too, so any Task you also execute is checked.

When a new Executor is needed, call `task_session_create(cwd, ...)`. It creates
and configures the Executor role through Cockpit; do not manually assemble MCP,
Skill or role System Prompt. Inspect creation and readiness separately. A known
session ID with failed readiness is not permission to create a replacement.

Alternatively, choose an existing Executor candidate from Cockpit's session list
and its recorded roles. A role label is not current capability proof.
`task_assign` checks existing capability; it never installs missing capability.
One session can execute at most one unfinished Task.

Read `task_read(view="overview", task_id, ...)`, then call `task_assign` with the
selected Executor, revision and context. It binds the Task and sends exactly one
`[Task assigned to you](task:<uuid>?event=assigned)` as the entire first dispatch.
Do not send a second manual dispatch. Known busy targets are not interrupted
or queued. Acceptance is not reading, ACK or actual work.

If an external step fails, inspect `task_read(view="operation", request_id, ...)`.
Do not retry an uncertain send or creation with a new ID. Only a confirmed
not-sent dispatch can be explicitly resumed using `resume_request_id`, a new
request ID and fresh Task context; it retains the same Task and Executor.

## Follow and revise

Use `view="list"` filtered by owner for an overview, and `view="overview"` for one
Task's status, Executor, latest reported activity, revision/ACK and outcome availability.
Use `view="definition"` before editing; read changelog/activity/outcomes on demand,
not all history every time. Changelog pages contain summaries; select a revision
to read its complete definition.

`task_edit` accepts a complete replacement description and reason. Ordinary edits
only update Task. Do not queue follow-up requirements, reminders or "read later"
cues. ACK belongs to the Executor. Do not turn their activity into a separate
progress summary or treat it as real-time native activity.

### Exceptional update handoff

Only intervene when you judge an update too important to wait for a checkpoint.
Save the complete updated requirements in Task first. Queue handling is your
decision, guided by this Skill, not an automatic module or host advancement loop.
Do not use `cockpit_advance_queue` for this workflow.

1. Read the Executor's current native state and full exposed pending queue, not
   just message previews. Before clearing anything, preserve each pending item's
   ID, text and available references in your working context. Display text is not
   a lossless attachment or native-event backup; do not discard content you
   cannot adequately read or preserve.
2. Aim to clear all pending items for this explicit handoff, including messages
   from other sessions or subagents, after preserving their content. Use
   `cockpit_remove_queued` for the saved IDs. A message that is no longer pending
   may already have started; inspect the result rather than assuming it was
   removed or replaying its work. Re-read the queue and handle new arrivals
   separately; a snapshot does not lock the queue.
3. If the current main turn must be interrupted, use the public
   `session/interrupt` operation once. Do not use Stop / `cockpit_cancel_turn`
   as a queue-cleanup shortcut: it can discard unread concurrent arrivals.
   Do not repeatedly interrupt or silently cancel background work.
4. Inspect the resulting native state, including pending messages and active
   subagents. An interrupt receipt or an idle label alone does not establish
   readiness. If work still prevents a handoff, resolve it explicitly or wait;
   do not claim the queue is empty or force a fresh message into known waiting work.
5. Summarize the preserved messages, retaining their sources, unresolved requests,
   useful results, constraints and references. Do not silently omit non-Task
   messages or turn quoted requests into approved Task requirements. Any intended
   requirement changes belong in Task, not only in this summary.
6. Re-read Task and confirm it is still active and assigned to this Executor.
   Send one message containing the summary followed by the update notice below.
   Omit the summary section when there were no pending messages. Do not resend
   individual messages or send the Task reference a second time.

```text
Pending context:
<summary of the preserved pending messages>

[Task updated](task:<uuid>?event=updated)
Read the current Task and acknowledge its latest revision before continuing.
```

Replace `<uuid>` with the actual Task ID. This replaces the old text-prefix
notice. Its label explains why it was sent even without card rendering; it does
not duplicate the Task description. Cleanup and sending are not atomic.
If sending is queued or unconfirmed, inspect the actual result, not another send.
Acceptance is not reading or ACK; use the Executor's recorded ACK of the current
revision as confirmation when checking alignment. Never perform this workflow
automatically after an edit, pending ACK or a timer.

Trust the Executor's delivery; in_review is optional, not mandatory Owner approval.
Use `task_cancel` only for an explicit cancellation decision, with a reason.
Cancellation does not stop the native session.

## References and results

Reference a Task with `[Task](task:<uuid>)`; the ID comes from Task MCP.
Pass only the UUID as `task_id`, never the full URI or query. Use the event-bearing
forms above only for their stated message reasons; only lowercase `assigned` and
`updated` are accepted. The event is immutable message/reference metadata, not a
Task type, status, command or event bus. Rendering uses the URL event, not the label or Task
status. Generic references and old messages remain compatible without an event
header; unknown events and malformed queries stay unclaimed. The frontend resolves
current data without changing the message reason.
Do not use relative `task/<id>` links, which may be treated as files.
Do not copy description into dispatch messages. These references add no tool,
Task field, scheduler or automatic notification after `task_edit`.
References between independent Tasks are links, not dependencies or child Tasks.

Every response separates `result`, `error` and `definition_check`. Check all three,
including on replay or failure. If activity saved but stale status/outcome failed,
do not blindly replay or relabel the old work. Tool access permits cross-Task
operations, but never claim someone else read or completed work without evidence.
