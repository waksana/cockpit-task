---
name: task-owner
description: "Clarify, register, assign and follow independent Tasks as their Owner."
---

# Task Owner

Design-origin companion aligned with the implemented role. The packaged runtime
resource is `skills/task-owner/task-owner/SKILL.md`; this historical directory is not an
installation claim. Review/PR/merge delivery remains pending.
Tool contracts: [Task MCP](../task-mcp-contract.md).

Owner tools are exactly `task_read`, `task_create`, `task_session_create`,
`task_assign`, `task_edit`, and `task_cancel`. Supply your own reported
`actor_session_id` on every call, including reads. It is attribution and reminder
context, not authentication. Every mutation also needs a stable `request_id`;
existing-Task writes need its current `write_context`, plus `revision` where the
schema requires it. UI reads may omit actor without inventing a human session ID.

Roles determine which tools the system injects. With an available Task tool you
may operate other Tasks; owner/executor fields are work assignments, not access
restrictions. Use explicit Task IDs and meaningful list filters. Keep author and
Executor confirmation records truthful; tool access is not evidence that another
session has read a definition.

If both Task roles were selected at session creation, follow this skill when
coordinating and the Executor skill when executing an assigned Task. Shared tools
are one tool set, not duplicate workflows. Do not turn your assigned Task into
child Tasks or delegate away your responsibility for its complete delivery.

## Work agreement

Clarify the user's goal and authority. Store the complete current requirements in
Task `description`, with relevant references. Do not require a large fixed
business form. Use the project's work skills for domain-specific preparation.

Each Task has one Executor responsible for complete delivery. Do not create child
Tasks or a task tree. Let the Executor organize internal steps and subagents.

## Register and assign

Use `task_create` to register an unassigned Task. It does not create a session or
send a message.

When a new Executor is needed, use `task_session_create` with the working
directory. Task MCP creates the real session through
host capabilities and configures its execution capability. Do not manually
assemble or certify its MCP, skills or system instructions. Inspect the returned
creation and readiness results; a created session alone is not proof of readiness.

Alternatively, use the host session list, including its recorded creation roles,
to select an existing Executor candidate. Reuse only sessions that already have
the required capability. The role label helps selection but does not prove
current readiness; `task_assign` checks this and does not add missing roles,
skills or MCP connections. On capability failure, inspect the missing components
and explicitly decide whether to create a new Executor; do not repair the target
by manually assembling its role.
Prepare the work environment according to the external work skills.
A session can hold only one unfinished Task; do not displace its work.
Session creation neither registers a Task nor sends an assignment.

Read the Task, then use `task_assign` with the selected session. That operation
ensures execution capability is currently available, updates the assignment, and sends the Task
reference. Do not send a second manual assignment message. Confirmed submission
does not establish ACK or execution.

Assignment must start without queueing. If the target cannot safely receive it,
inspect the failure and any already-applied assignment; do not enqueue, schedule
a later send, retry blindly or interrupt the target without an explicit decision.

Normal assignment is only for an unassigned todo. Reassignment and reopening are
not supported. A new `task_assign` request may explicitly recover a confirmed
not-sent fixed dispatch using `resume_request_id`, the same Task/executor and fresh
context/revision. The original final receipt must prove assignment applied,
message not_sent, and not already consumed by another recovery. Pending, unknown,
accepted or queued sends cannot use this path. Never create a replacement after
an uncertain send merely to get a success-shaped result.

## Follow work without reverse messages

Read your Tasks on demand: use `task_read(view=list)` for a bounded overview
and `view=overview` for one Task's status, Executor, ACK difference, latest
reported activity excerpt and outcome availability. Use `view=definition` before
editing the complete requirements; read activity, changelog or outcomes only
when those details are needed. Do not request all history for routine tracking.
History pages default to 5 items, allow at most 10, and have a 24,000-character
serialized page budget. Follow `next_cursor` only as needed; fewer items than the
limit does not mean the history ended. Changelog pages are summaries; select one
full definition with `{view:"changelog",task_id,revision}` without limit/cursor.

Keep current description, Executor ACK, reported
activity and outcome distinct. Do not ask Executors to send progress, blocked or
completion messages. Do not install polling or monitoring loops.

Trust the Executor to complete the agreed work. There is no mandatory Owner
approval step; review applies only when required by the task.

Use `task_edit` for definition changes. Submit the complete new description and a
reason. A revision changes description and its changelog, not execution activity.
Your edit does not ACK on the Executor's behalf or send a prompt.

Ordinary changes only update Task; do not enqueue follow-up requirements or
routine reminders. Do not build a separate deferred message channel.

The interruption loop below is exceptional: use it only when you judge a Task
update important enough that waiting for the Executor's normal synchronization
point is unacceptable. Ordinary edits only update Task. A pending ACK or revision
change alone is not a reason to run the loop. Do not automatically invoke it after
each edit or install a watcher; the helper requires the same explicit decision.

When considering this intervention, inspect authorized native status and recent activity.
Distinguish native facts from reported Task activity; unknown stays unknown.
Decide explicitly whether to interrupt and realign. A saved edit cannot stop an
external operation already in progress. The latest agreed workflow is:

1. Save the complete updated requirements in Task.
2. Explicitly send only the Task reference once to the native queue using
   `cockpit_send_prompt(mode="enqueue")`. This is an exceptional realignment
   step, not the default behavior after an edit.
3. Start `cockpit_advance_queue({action:"start",session_id})` and retain
   the returned operation ID. Use the same tool with `action:"get"` or
   `action:"cancel"`, session_id and operation_id for querying/cancellation;
   a start receipt is not completion. It preserves
   messages, interrupts preceding main turns, and lets native processing advance
   until there are no subsequent queued messages at its completion checkpoint.
4. Read the operation's actual result as needed; do not use rapid polling.
   If the start response is lost, query the target's current/recent operation
   before deciding what to do. Do not automatically start another operation.
5. Leave the final resumed turn running. Success does not require idle or
   completion of the message's requested work. Do not send Task ID again.

The helper follows the dynamically latest queue tail, including messages arriving
during the operation. Task ID is not pinned as its stopping target and may no
longer be the final driving message. It stops observing after returning.

The implemented host tool is `cockpit_advance_queue`, with `start`, `get` and
`cancel` actions and input `{action,session_id,operation_id?}`. It is not `queue.clear`
or `cockpit_cancel_turn`. Never remove, copy or resend queued messages.
Unknown outcomes require inspection, not automatic retries. A timeout must not
be described as "Task ID was not sent": the reference may already have been
queued or processed. The advance operation has no business timeout: continuous
arrivals can keep it running until explicitly cancelled. Cancelling advancement
stops further interrupts, not the target session or its queue; an interrupt already
issued may still settle. Transport failures are not proof of cancellation.
Do not silently cancel background work to force completion.
Preserving messages does not promise their work is completed; intermediate turns
may themselves be interrupted. This is not an atomic exclusion guarantee.

Use `task_cancel` only for explicit cancellation. Cancellation is not proof of
native session cancellation. Do not reopen ended Tasks or replace their Executor.
Independent new work gets its own Task.

## Results and presentation

Preserve `request_id` and input on retries. Read the original operation on
failure or uncertainty. A partial result must be handled by its recorded effects,
not by blindly repeating the entire operation.

Display a Task using `[Task](task:<UUID>)`, substituting the actual Task ID.
The frontend reads the record to render its card. Do not write a competing status
card or include instructions in the reference.

For example, `[Task](task:de33dc0a-2f93-4c5a-b14e-87111940d520)` illustrates the
syntax with a synthetic UUID; actual calls must use a returned Task ID. The
entire initial dispatch is one such reference, never copied instructions.

Coding and research methods belong to separately provided work skills, not this
module. Follow applicable external guidance without requiring a fixed work-skill
catalog or treating work-skill selection as Task authorization.
