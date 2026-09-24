# Orchestrating Subtasks

Read this when you create, dispatch, order, follow or revise Tasks you orchestrate: Subtasks
of your own Task, or top-level Tasks when you have no Task (see the node principle and the
root node in [SKILL.md](../SKILL.md)). A Task is your Subtask when its `orchestrator` is your
session; the service sets it to you when you create the Task. Orchestrating is a
collaboration responsibility, not a business identity or extra authority. Project
instructions and work skills define execution methods.

You orchestrate all of your Subtasks together: keep the topology among them, and between
them and your own Task, correct at all times. That means splitting, ordering with a
conflict check, re-planning on change, and following through to integration.

## Coordinate by default; delegate delivery

Without a Task of your own, your default responsibility is clarification, delegation and follow-through.
With a Task, the same orchestration rules apply to each Subtask you create for it.
Bounded read-only investigation, answers and option comparisons are yours to provide.
For default Agent Tasks, delegate implementation and state-changing delivery through Task to an independent
assignee, not your own tools or subagents: this keeps delivery responsibility clear.
A result request is not permission for personal implementation, even for small work.

Personal execution requires an explicit request to execute personally or an actual
assignment to you as assignee. Holding the node role alone is neither assignment
nor permission to take over another assignee's work, including a Subtask you delegated.
The service rejects assigning a Task to its own orchestrator for every node; when new work
appears after your Task is done, use authorized reopen or another node.
Unavailable delegation is a blocker to explain, not an exception.

Distinguish discussion, investigation, recording an idea and authorizing execution.
Investigation does not authorize changes; recording does not authorize dispatch.
Respect "discuss only" and "not now", and do not create Tasks for casual conversation.
Ask about real decisions, missing essentials or uncertain scope, not procedural
steps or a second start command for already-authorized work.

Keep independent requests' dispositions distinct: discussion, record-only and paused
items do not authorize dispatch. Pausing one item does not pause unrelated authorized
work; honor a broader pause or stop when requested. After an interjected topic, return
to remaining authorized requests not yet handed off, completing needed clarification
before dispatch. An Issue or verbal
commitment is not a completed Task handoff: use the successful assignment receipt as
handoff evidence, not as assignee ACK or proof of execution or delivery. Surface real
blockers rather than silently abandoning a request.

## Split: delegate one complete outcome per Subtask

One coherent Agent outcome belongs to one Task and one accountable assignee, including investigation, implementation, correction and delivery. Split independent outcomes,
not tightly coupled stages, resources or specialties. Link related Tasks with references and
`blocked_by` readiness gates, not workflow engines, helper-request workflows or standing role pools;
hierarchy arises only from [Subtasks of your Task](#subtasks-of-your-own-task).
The assignee manages internal steps/subagents without stage-by-stage redispatch or a
mandatory orchestrator acceptance gate.

When creating or revising description, preserve the complete current task-specific agreement: goal, scope, key decisions, authorization boundaries, special constraints
and completion conditions. Complete agreement is not complete prior context.
Reference general Skills, repository instructions and environment documentation as
needed instead of repeating them; keep execution-critical task-specific facts explicit.
Separate prior investigation from current requirements. Task is a shared work record,
not a raw evidence store: use accessible, locatable references for detailed evidence.
References cannot replace the essential agreement with "see Issue", hide requirements
in metadata or assume inherited context. Keep exact values needed to support conclusions
or resume safely; do not copy chat or impose a mandatory project form.
Exclude every node that is assignee of an unfinished Task, even if native idle; one unfinished
Task at a time, not one lifetime goal. Choose a capable session without competing work.
New/forked sessions neither isolate shared resources nor inherit authorization.
Choose authorized resources/environment and existing discoverable Skill/MCP names, not guesses from Task text.
Use `task_create`, then `task_session_create` with selections or `task_session_prepare` for a loaded idle node
with its role applied and no pending role reload. Neither new nor reuse is mandatory; backlog does not dispatch.
Inspect the receipt, then `task_assign` once: it checks, never repairs. Unknown effects need inspection, not blind retry/replacement.
Preparation does not install/authenticate, reload, change global defaults or prompt; readiness is not authorization, acceptance, ACK or execution.
Skill enabled is not body loaded; the assignee loads relevant bodies when first needed, without inheriting your context.
`task_assign` sends the first assigned reference itself; do not send a duplicate.

## Subtasks of your own Task

Relations are per Task: assignee of your Task, orchestrator (this reference) of the Subtasks you create
for it. Delegation follows scope, not a preset lead identity: split only for several independent
outcomes, item-by-item trade-off discussion with the user, or follow-up detail that would crowd
your context; deliver a coherent result directly, leaning toward delegation as load grows.
A Subtask is more specific than its parent, never passed down unchanged, and within the parent's
authorized scope; ask the user before anything outside it. Assign Subtasks to other sessions,
never implement them yourself, and integrate their outcomes before reporting your Task done.
The service records lineage and caps it at 3 levels; pending-decision Tasks go to a new session
([Subtasks of your Task](task-writes-and-recovery.md#subtasks-of-your-task)).

## Topology: order with a conflict check

Decide which Subtasks may run in parallel and which must run in sequence, and express the
order with `blocked_by`. Before dispatching a new Subtask, check every unfinished Task
(`todo`, `in_progress`, `blocked` and `in_review`, whether or not it is assigned and whoever
created it; not `done` or `cancelled`) for parallel changes to the same repository, the same
files or the same scope. This is your judgment; the service does not check it.

When there is a conflict, fix the order instead of letting both change the same place.
For a Subtask not yet dispatched, add `blocked_by` on the Task that must finish first;
blockers may belong to any orchestrator, but never to an ancestor of the dependent Task
(the service rejects that with `BLOCKER_ANCESTOR`, since the ancestor waits for it).
For Subtasks already executing, write the coordination order into each one's requirements
and send the affected assignee one [important update](important-updates.md). For a
conflicting Task you do not orchestrate, order your own Subtask after it, or ask the user.

## Re-plan when things change

When a new requirement, a new Subtask or a new result makes an existing Subtask obsolete,
changes its scope or changes the order, revise it, change its dependencies or cancel it
with a recorded reason. Do not leave stale work running or waiting. Cancel only on that
explicit decision: cancellation does not stop Agent native work or undo external effects.

## Known scripts, not arbitrary automation

Agent remains the default. An orchestrator may choose an automation Task only for an authorized, trusted repeatable known script, not to bypass delegation for arbitrary work.
Read [automation](automation.md) when choosing this path: discover/register, snapshot typed inputs, optionally subscribe for concrete follow-up, then explicitly start.
No assignee, ACK, session slot, Subtasks or workflow engine; no automatic rerun.
`task_script_read`, `task_script_register`, `task_automation_start` and `task_automation_reconcile` are orchestrator work, used only under this guidance; reconciliation clears a proven-safe barrier, never delivers work.

## Coding work

Load `github-coding` for authorized changes to version-controlled repository files, not
GitHub mentions or pure deployment using existing verified artifacts. Runtime configuration
alone does not trigger this flow; project policies still apply. State the requirements and
reference any existing Issue; the assignee sets up and cleans up its own environment, so you do
not prepare or clean branches/worktrees. Create the assignee session with cwd at a target
repository's shared main checkout (any involved one for cross-repository work). Mixed delivery
stays one Task. Separate release/deployment/restart/migration authorization and your default delegation responsibility remain.

## Coordinate through Task, not session chat

Keep approved scope, constraints and delivery expectations in Task's current definition so requirements and results share one record. Distinguish decisions
from proposals/quotations; record change reasons, sources and superseded decisions.
Assignees ask users directly and update requirements in their own sessions.
Even when blocked, their direct user question is not yours to relay or answer on
their behalf; ACK remains the assignee's responsibility.

Do not chat with an assignee to ask for progress, clarify requirements, chase work or
request confirmation; read or update Task instead. The assignee communicates with the
user in its own session, not back to you, directly or through other agents.
This keeps requirements and decisions out of a second conversation channel.

Assignee-facing notices remain the initial assignment sent by `task_assign`
and an explicit important-update handoff when normal checkpoints cannot wait.
Ordinary edits/reports are silent without an explicit status subscription;
`task_edit` does not send an updated notice. Subscriptions do not restore default
progress/final notifications or permit assignee-to-orchestrator messages.
For the exceptional handoff, read [important updates](important-updates.md)
before sending one `immediate` notice; leave queued messages and ongoing work intact,
without starting a monitoring or conversation loop.

## Follow up and integrate

Default to no subscription. Before registering, identify the concrete, necessary
authorized orchestrator action that a future Task state enables, such as making a decision from the
result or arranging another authorized independent Task. Merely knowing progress
or confirming completion, including repeated reporting, is not a reason to subscribe. Judge the need yourself;
the user need not explicitly request a subscription. Do not invent follow-up work,
split a complete outcome or add an approval gate to justify a wait.
For Subtasks of your own Task, do not subscribe to done/blocked/cancelled: the
service already sends one `Subtask done`, `Subtask blocked` or `Subtask cancelled` card per such
transition ([Task links](task-links.md)). Follow each Subtask until its result is integrated.

An orchestrator may explicitly subscribe to specified Task states only for that necessary
follow-up. Choose the fewest target states that enable it; withdraw a still-waiting
subscription if the follow-up is no longer needed. For authorized "do B after A" work, create B at once as an unassigned Task with `blocked_by`
and a complete description instead of subscribing; private notes never wake you. On its `Subtask ready` (`event=ready`) or `Subtask blocker cancelled` (`event=blocker_cancelled`) card, reassess before dispatching or revising B; an undecided follow-up may be a pending-decision planning Task, dispatched to a new session that discusses it with the user before delivering, delegating or cancelling ([dependencies](task-writes-and-recovery.md#task-dependencies-blocked_by)).
The first real matching transition ends the subscription; already matching at registration means failure, not an immediate notice.
On `[Subtask status changed](task:<uuid>?event=status_changed)`, read only necessary
latest content in one bounded call where possible and reassess the planned follow-up;
act only if it is still needed and authorized.
The card is not proof of complete delivery or an assignee definition-ACK instruction. Do not automatically resubscribe, poll or hold this turn open waiting.
See [subscription handling](task-writes-and-recovery.md#one-shot-status-subscriptions)
for registration, withdrawal and uncertain delivery.

Start your portfolio with `task_read(view=list, orchestrator=<your session ID>)`; for one
Task use `view=overview` with `include` chosen for the question. The host supplies your
identity: attribution, not authentication, an orchestrator filter or a role-based read restriction.

Context always supplies identity, assignment, status, revision/ACK and write context.
For status alone use `include=["context"]`; for a delivery-dependent action use
`include=["outcome"]`. Select `["activity","outcome"]` only when diagnosis needs both.
Select `retro` only for a concrete reflection question, not routine acceptance.
Omitting `include` retains the legacy compact overview, not complete result text.

Read `definition` before editing requirements; use histories only for a historical
question. Avoid a fixed overview-then-outcomes sequence, guessing outcomes then
activity, or reading every group. See [Task views and fields](reading-tasks.md)
for complete selected records, provenance, size errors and bounded alternatives.
Trust complete delivery unless the Task requires review; preserve partial results
and unexecuted boundaries. When asked, summarize active, waiting, complete or unknown
work from Task evidence, not a second ledger. Do not infer completion from idle,
scan chats routinely or schedule monitoring.

The assignee completes delivery, then submits a lightweight retro with done: useful
evidence-based observations or explicit null when there are no findings.
Read it on demand with `include=["retro"]`; overview without `include` and lists show
only status and attribution, not its text. `recorded` with null is an explicit
no-findings submission; `not_recorded` is missing history, and `not_applicable`
is automation, not a failed Agent reflection. The service guarantees submission,
not quality or thought. Retro does not replace outcome/blockers or authorize
improvements, scope expansion or dispatch. The service adds no notification,
subscription or completion gate; handling it is Skill work, below.

## Handle retros of your Subtasks

Repeated findings show across Tasks, not in one retro, so the node that created a Task,
its orchestrator, handles that Task's retro with findings. Record each decision with
`task_retro_handle`: `task_id`, the retro's `outcome_id`, `status`, a `note` and
optional `references`.

| `status` | Meaning |
| --- | --- |
| `fixed` | Already fixed; reference the PR or commit where one exists |
| `followup` | A follow-up Task or Issue holds the work; reference required. Terminal: do not revisit this retro when the follow-up finishes |
| `watching` | Seen, no action yet; decide if the finding recurs |
| `dismissed` | Not worth acting on; the note says why |

Only the orchestrator handles; an assignee never handles its own retro, and null retro needs
nothing. A reopened delivery's new retro needs its own handling; rewriting appends
history (`view=retro_handlings`). Handling sends no message and changes no Task status.

While doing a Task with Subtasks, handle every Subtask retro with findings before
your own done: list `parent_task_id=<your Task>` with `retro="unhandled"`, read each
retro, group repeated findings and check whether each is already fixed. Handling is a
record, not authorization: fixes and follow-ups stay within your Task's scope or the
user's decision. Findings the subtree cannot handle, needing broader authority or
beyond its Tasks, go into your own retro for your orchestrator to handle in turn.

Without a Task (the root), do not digest retros routinely. When the user asks, list
your Tasks with `retro="unhandled"` (or `"watching"`), read text as needed, discuss
with the user and record each decision.

## Preserve state

Use actual Task/session IDs, stable mutation request IDs and fresh returned
`write_context` where required; inspect errors and `definition_check` as well as the result.
Unknown effects do not justify a blind retry or replacement Task/session; preserve
request identity and known effects. Cancel only on an explicit decision: record changes
do not stop Agent native work or undo external effects; automation cancellation requests termination, not rollback. Do not reassign a bound
Task or impersonate its assignee. Prefer eligible original-assignee `task_reopen` for user-authorized done Agent rework, not replacement/redispatch;
see [rework eligibility](task-writes-and-recovery.md#original-assignee-rework-after-done). Cancelled/automation/ineligible work needs a new authorized Task.

Use tool schemas for arguments; consult
[Task writes and recovery](task-writes-and-recovery.md) for unfamiliar
write rules, conflicts or uncertain effects, and
[Task links](task-links.md) for link syntax or unfamiliar notices.
Load only the reference needed, not the whole set.
