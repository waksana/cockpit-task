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
For default Agent Tasks, delegate implementation and state-changing delivery through Task to an independent
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

One coherent Agent outcome belongs to one Task and one accountable Executor, including investigation, implementation, correction and delivery. Split independent outcomes,
not tightly coupled stages, resources or specialties. Tasks are flat: use references,
not child Tasks, dependency engines, helper-request workflows or standing role pools.
Executor manages internal steps/subagents without stage-by-stage redispatch or a
mandatory Owner acceptance gate.

When creating or revising description, preserve the complete current task-specific agreement: goal, scope, key decisions, authorization boundaries, special constraints
and completion conditions. Complete agreement is not complete prior context.
Reference general Skills, repository instructions and environment documentation as
needed instead of repeating them; keep execution-critical task-specific facts explicit.
Separate prior investigation from current requirements. Task is a shared work record,
not a raw evidence store: use accessible, locatable references for detailed evidence.
References cannot replace the essential agreement with "see Issue", hide requirements
in metadata or assume inherited context. Keep exact values needed to support conclusions
or resume safely; do not copy chat or impose a mandatory project form.
Exclude every Executor bound to an unfinished Task, even if native idle; one unfinished
Task at a time, not one lifetime goal. Choose a capable session without competing work.
New/forked sessions neither isolate shared resources nor inherit authorization.
Choose authorized resources/environment and existing discoverable Skill/MCP names, not guesses from Task text.
Use `task_create`, then `task_session_create` with selections or `task_session_prepare` for a loaded idle Executor
with its role applied and no pending role reload. Neither new nor reuse is mandatory; backlog does not dispatch.
Inspect the receipt, then `task_assign` once: it checks, never repairs. Unknown effects need inspection, not blind retry/replacement.
Preparation does not install/authenticate, reload, change global defaults or prompt; readiness is not authorization, acceptance, ACK or execution.
Skill enabled is not body loaded; Executor loads relevant bodies when first needed, without inheriting your context.
`task_assign` sends the first assigned reference itself; do not send a duplicate.

## Known scripts, not arbitrary automation

Agent remains the default. Owner may choose an automation Task only for an authorized, trusted repeatable known script, not to bypass delegation for arbitrary work.
Read [automation](references/automation.md) when choosing this path: discover/register, snapshot typed inputs, optionally subscribe for concrete follow-up, then explicitly start.
No Executor, ACK, session slot, child Tasks or workflow engine; no automatic rerun.
Only Owner gets `task_script_read`, `task_script_register`, `task_automation_start` and `task_automation_reconcile`; reconciliation clears a proven-safe barrier, never delivers work.

## Coding work

Load `github-coding` for authorized changes to version-controlled repository files, not
GitHub mentions or pure deployment using existing verified artifacts. Runtime configuration
alone does not trigger this flow; project policies still apply. For initially known changes,
prepare clean mainline, isolation and any GitHub Issue before Task; for changes discovered later,
coordinate preparation before edits within the existing Task. Mixed delivery stays one Task,
with Issue/PR only for repository changes. Preparation and cleanup are coordination, not personal
implementation. Separate release/deployment/restart/migration authorization and Owner's default delegation responsibility remain.

## Coordinate through Task, not session chat

Keep approved scope, constraints and delivery expectations in Task's current definition so requirements and results share one record. Distinguish decisions
from proposals/quotations; record change reasons, sources and superseded decisions.
Executors ask users directly and update requirements in their own sessions.
Even when blocked, their direct user question is not yours to relay or answer on
their behalf; ACK remains the Executor's responsibility.

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
authorized Owner action that a future Task state enables, such as making a decision from the
result or arranging another authorized independent Task. Merely knowing progress
or confirming completion, including repeated reporting, is not a reason to subscribe. Judge the need yourself;
the user need not explicitly request a subscription. Do not invent follow-up work,
split a complete outcome or add an approval gate to justify a wait.

Owner may explicitly subscribe to specified Task states only for that necessary
follow-up. Choose the fewest target states that enable it; withdraw a still-waiting
subscription if the follow-up is no longer needed. The first real matching transition
ends the subscription; already matching at registration means failure, not an
immediate notice.
On `[Task status updated](task:<uuid>?event=status_changed)`, read only necessary
latest content in one bounded call where possible and reassess the planned follow-up;
act only if it is still needed and authorized.
The card is not proof of complete delivery or an Executor definition-ACK instruction. Do not automatically resubscribe, poll or hold this turn open waiting.
See [subscription handling](references/task-writes-and-recovery.md#one-shot-status-subscriptions)
for registration, withdrawal and uncertain delivery.

## Follow bounded evidence

Start your portfolio with `task_read(view=list, owner=<your session ID>)`; for one
Task use `view=overview` with `include` chosen for the question. Include your own
`actor_session_id`: attribution, not authentication, an owner filter or a role-based read restriction.

Context always supplies identity, assignment, status, revision/ACK and write context.
For status alone use `include=["context"]`; for a delivery-dependent action use
`include=["outcome"]`. Select `["activity","outcome"]` only when diagnosis needs both.
Select `retro` only for a concrete reflection question, not routine acceptance.
Omitting `include` retains the legacy compact overview, not complete result text.

Read `definition` before editing requirements; use histories only for a historical
question. Avoid a fixed overview-then-outcomes sequence, guessing outcomes then
activity, or reading every group. See [Task views and fields](references/reading-tasks.md)
for complete selected records, provenance, size errors and bounded alternatives.
Trust complete delivery unless the Task requires review; preserve partial results
and unexecuted boundaries. When asked, summarize active, waiting, complete or unknown
work from Task evidence, not a second ledger. Do not infer completion from idle,
scan chats routinely or schedule monitoring.

Executor completes delivery, then submits a lightweight retro with done: useful
evidence-based observations or explicit null when there are no findings.
Read it on demand with `include=["retro"]`; overview without `include` and lists show
only status and attribution, not its text. `recorded` with null is an explicit
no-findings submission; `not_recorded` is missing history, and `not_applicable`
is automation, not a failed Agent reflection. The service guarantees submission,
not quality or thought. Retro does not replace outcome/blockers or authorize
improvements, scope expansion or dispatch. No mandatory Owner review, new
notification, subscription or completion gate is added.

## Preserve state; reuse stable guidance

Use actual Task/session IDs, stable mutation request IDs and fresh returned
`write_context` where required; inspect errors and `definition_check` as well as the result.
Unknown effects do not justify a blind retry or replacement Task/session; preserve
request identity and known effects. Cancel only on an explicit decision: record changes
do not stop Agent native work or undo external effects; automation cancellation requests termination, not rollback. Do not reassign a bound
Task or reopen done/cancelled; authorized follow-up after termination needs a new Task.

Reuse this Skill while it remains in context; reload for missing/changed guidance
or an unclear rule, not a new message. This never replaces fresh Task state or ACK.
Use tool schemas for arguments; consult
[Task writes and recovery](references/task-writes-and-recovery.md) for unfamiliar
write rules, conflicts or uncertain effects, and
[Task links](references/task-links.md) for link syntax or unfamiliar notices.
Load only the reference needed, not the whole set.
