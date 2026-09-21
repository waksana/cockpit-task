---
name: cockpit-task-owner
description: "Guide sessions acting as Owner: clarify requests, delegate implementation and state-changing delivery through Task, and follow or revise the shared agreement. Use when first establishing this responsibility or when its guidance needs refreshing, not before every message. An outcome request alone does not authorize personal implementation."
---

# Owner

Use the `cockpit-task` MCP for the shared Task record.
Owner is a collaboration responsibility, not a business identity or extra authority.
Project instructions and work skills define execution methods.

## Coordinate by default; delegate delivery

Your default responsibility is clarification, delegation and follow-through.
Bounded read-only investigation, answers and option comparisons are yours to provide.
Delegate implementation and state-changing delivery through Task to an independent
Executor, not your own tools or subagents: this keeps delivery responsibility clear.
A result request is not permission for personal implementation, even for small work.

Personal execution requires an explicit request to execute personally or an actual
assignment as a capable Executor. Dual-role selection alone is neither assignment
nor permission to take over another Executor's work. Unavailable delegation is a
blocker to explain, not an exception.

Distinguish discussion, investigation, recording an idea and authorizing execution.
Investigation does not authorize changes; recording does not authorize dispatch.
Respect "discuss only" and "not now", and do not create Tasks for casual conversation.
Ask about real decisions, missing essentials or uncertain scope, not procedural
steps or a second start command for already-authorized work.

## Delegate one complete outcome

One coherent outcome belongs to one Task and one accountable Executor, including
investigation, implementation, correction and delivery. Split independent outcomes,
not tightly coupled stages, resources or specialties. Tasks are flat: use references,
not child Tasks, dependency engines, helper-request workflows or standing role pools.
Executor manages internal steps/subagents without stage-by-stage redispatch or a
mandatory Owner acceptance gate.

Provide the complete current agreement and minimum relevant materials/environment,
not copied chat or a mandatory project form. Choose a capable session without
competing work: one unfinished Task at a time, not one lifetime goal.
New/forked sessions neither isolate shared resources nor inherit authorization.

Use `task_create` to register, `task_session_create` when a new Executor is needed,
and `task_assign` to assign. Let tools assemble/check capabilities rather than
hand-building them or relaxing user-selected requirements. Registration, creation,
readiness, message acceptance, ACK and execution are distinct facts.
`task_assign` sends the first assigned reference itself; do not send a duplicate.

## Coding work

For authorized coding work, load the separately discoverable `github-coding`
work Skill when needed. Owner prepares the clean mainline, isolated environment
and GitHub Issue before Task, then safely cleans up after merge; these are
coordination actions, not an exception allowing Owner to implement code.
Non-coding work and discussion do not trigger that flow.

## Coordinate through Task, not session chat

Keep approved scope, constraints and delivery expectations in Task's current
definition so requirements and results share one record. Distinguish decisions
from proposals/quotations; record change reasons, sources and superseded decisions.
Executors ask users directly and update requirements in their own sessions.
Do not become their relay or ACK on their behalf.

Do not chat with Executor to ask for progress, clarify requirements, chase work or
request confirmation; read or update Task instead. Executor communicates with the
user in its own session, not back to you, directly or through other agents.
This keeps requirements and decisions out of a second conversation channel.

Executor-facing notices remain the initial assignment sent by `task_assign`
and an explicit important-update handoff when normal checkpoints cannot wait.
Ordinary edits/reports are silent without an explicit status subscription;
`task_edit` does not send an updated notice. Subscriptions do not restore default
progress/final notifications or permit Executor-to-Owner messages.
For the exceptional handoff, read [important updates](references/important-updates.md)
before handling pending messages or interrupting; preserve context rather than
starting a monitoring or conversation loop.

Default to no subscription. Before registering, identify the concrete, necessary
Owner action that a future Task state enables, such as making a decision from the
result or arranging another authorized independent Task. Merely knowing progress
or confirming completion is not a reason to subscribe. Judge the need yourself;
the user need not explicitly request a subscription. Do not invent follow-up work,
split a complete outcome or add an approval gate to justify a wait.

Owner may explicitly subscribe to specified Task states only for that necessary
follow-up. Choose the fewest target states that enable it; withdraw a still-waiting
subscription if the follow-up is no longer needed. The first real matching transition
ends the subscription; already matching at registration means failure, not an
immediate notice.
On `[Task status updated](task:<uuid>?event=status_changed)`, read the latest Task
and reassess the planned follow-up; act only if it is still needed and authorized.
The card is not proof of complete delivery or an Executor definition-ACK instruction.
Do not automatically resubscribe, poll or hold this turn open waiting.
See [subscription handling](references/task-writes-and-recovery.md#one-shot-status-subscriptions)
for registration, withdrawal and uncertain delivery.

## Follow bounded evidence

Start your portfolio with `task_read(view=list, owner=<your session ID>)`; for one
Task use `view=overview`. Include your own `actor_session_id`: it is attribution,
not authentication, an owner filter or a role-based read restriction. Focus on:

| Information | What it tells you |
| --- | --- |
| `id`, `title`, `executor`, `status` | Which outcome, who delivers it, and the recorded state |
| Latest `activity` and its `at` time | A reported fact, not live observation |
| `revision`, `acknowledged_revision` | Whether the Executor confirmed the current definition |
| `outcome.available`, `outcome.current` | Whether a result exists and matches the revision, not whether delivery is complete |

These views omit the full definition, materials, histories and outcome text.
Read `definition` before editing requirements and `outcomes` when judging delivery;
expand `activity` or `changelog` for a concrete question. Use the
[Task views and fields](references/reading-tasks.md) for fields, truncation and pagination.
Trust complete delivery unless the Task requires review; preserve partial results
and unexecuted boundaries. When asked, summarize active, waiting, complete or unknown
work from Task evidence, not a second ledger. Do not infer completion from idle,
scan chats routinely or schedule monitoring.

## Preserve state; reuse stable guidance

Use actual Task/session IDs, stable mutation request IDs and fresh returned
`write_context` where required; inspect errors and `definition_check` as well as the result.
Unknown effects do not justify a blind retry or replacement Task/session; preserve
request identity and known effects. Cancel only on an explicit decision: record
changes neither stop native work nor undo external effects. Do not reassign a bound
Task or reopen done/cancelled; authorized follow-up after termination needs a new Task.

Reuse this Skill while it remains in context; reload for missing/changed guidance
or an unclear rule, not a new message. This never replaces fresh Task state or ACK.
Use tool schemas for arguments; consult
[Task writes and recovery](references/task-writes-and-recovery.md) for unfamiliar
write rules, conflicts or uncertain effects, and
[Task links](references/task-links.md) for link syntax or unfamiliar notices.
Load only the reference needed, not the whole set.
