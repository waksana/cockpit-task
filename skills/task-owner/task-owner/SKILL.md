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
Skill or system instructions. Inspect creation and readiness separately. A known
session ID with failed readiness is not permission to create a replacement.

Alternatively, choose an existing Executor candidate from Cockpit's session list
and its recorded roles. A role label is not current capability proof.
`task_assign` checks existing capability; it never installs missing capability.
One session can execute at most one unfinished Task.

Read `task_read(view="overview", task_id, ...)`, then call `task_assign` with the
selected Executor, revision and context. It binds the Task and sends its reference
once. Do not send a second manual dispatch. Known busy targets are not interrupted
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

When an update is exceptionally important and cannot wait for a checkpoint,
explicitly enqueue `[Task](task:<id>)` once, then use Cockpit's
`cockpit_advance_queue` with action start. Retain its operation ID; use get for
the actual result and cancel to stop future interruptions. Do not poll rapidly.
It preserves messages and follows new arrivals to the latest queue tail, leaving
the last turn running. It has no business timeout and does not require idle.
The final message need not remain your Task reference. It never clears queues.
Cancellation does not cancel the target session or retract an issued interrupt.
An uncertain start requires querying the current operation, not another enqueue.
Never trigger this automatically after edits, pending ACK or a timer.

Trust the Executor's delivery; in_review is optional, not mandatory Owner approval.
Use `task_cancel` only for an explicit cancellation decision, with a reason.
Cancellation does not stop the native session.

## References and results

Reference a Task with `[Task](task:<uuid>)`; the ID comes from Task MCP.
The frontend resolves current data. Do not copy description into dispatch messages.
References between independent Tasks are links, not dependencies or child Tasks.

Every response separates `result`, `error` and `definition_check`. Check all three,
including on replay or failure. If activity saved but stale status/outcome failed,
do not blindly replay or relabel the old work. Tool access permits cross-Task
operations, but never claim someone else read or completed work without evidence.
