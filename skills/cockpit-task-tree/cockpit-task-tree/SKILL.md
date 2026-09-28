---
name: cockpit-task-tree
description: "Work as a node in a Task responsibility tree: recover the agreement, execute or orchestrate, use helpers in either mode, coordinate through Task facts, and close responsibility without abandoning children. Load when needed; reuse while in context."
---

# Task tree

## Model and relations

A Task is a continuing responsibility for an authorized result, not a permanent session
identity. Deliver directly (`execute`) or organize narrower children and integrate results
(`orchestrate`). Splitting never removes responsibility for the whole result.
Task is the only channel between formal Task nodes, not an approval chain.

| Current fact | Responsibility |
| --- | --- |
| `assignee` is you | Deliver it; one unfinished Task per session |
| Your Task is its parent | Coordinate that child, not take over |
| Your Task has a parent | `parent_assignee` integrates your result |
| No parent | Ordinary root, no special role/authority |

`created_by` is history, not control; use `actor_role` and current relations.
Done/cancelled releases occupancy but preserves assignee, assignments and outcomes.

## Rules

**R1 Identify the result and keep one agreement.**
Read the agreement/prior delivery. Continue unfinished work in its Task; `task_create` for
a new independent goal; `task_reopen` only for authorized correction/omission/defect in the
same completed delivery, not a new feature/result. Familiar context or a retained worktree
does not justify reopen. If unclear, ask the scope decision, not for readable facts.

Record goals, decisions, boundaries and completion requirements; reference external material.
Activity records important changes; outcome records delivery, remaining work and evidence.
Keep secrets out of Tasks.
Ask the user decisions directly; never repeat another node's question or ask through the
parent. Write changed agreements back. Discussion/preparation does not authorize
implementation or dispatch. Scope changes, trade-offs, cancellation, reopening and adding
a parent need consent. Follow project instructions and `github-coding` for repository changes.

**R2 Start and resume deliberately.**
Before starting, resuming, consequential actions and delivery, read full `execution` and
ACK its exact revision. Check mode, parent, intent, prerequisites and `definition_check`.

New Agent work is `todo/undecided`: clarify, not implement or create children.
Binding, ACK and activity do not start it. When ready, `task_start` atomically enters
`in_progress`; choose mode for this responsibility (R3), not the session's last Task.
A former orchestrator can execute a new Task; reopen preserves mode.
`task_report` cannot start todo or finish it directly; unstarted work can be cancelled.
Readiness never overrides a user pause. Task mode, lifecycle and native mode are separate;
do not synchronize them.

**R3 Fulfill responsibility.**
Choose `execute` for one bounded result, including discussion, research, design or coding.
Implementation/review/release steps do not themselves need intermediate Tasks.

Choose `orchestrate` for narrower independent continuing responsibilities while retaining
scope, interface, dependency, trade-off or integration work. Delegate sustained discussion,
research and design promptly, as with implementation; short questions need no Task.
Do not add layers to stay idle, preserve an old role or optimize Task/session counts.

**Both modes may use tools and helpers.** Helpers may only read Task tools; return results
to the main agent for all maintenance, including activity. Child Task main agents retain
their authority. Choose by responsibility, not tool names; review needs no Task.

If executing, first `task_convert` with reason, completed results and remaining work, then
put remaining work in narrower children, not unchanged pass-through delegation.
Orchestrators may research coordination decisions, but keep sustained
implementation/deep investigation in children. Zero children is valid; complex work may
recurse. Within the same Task, never downgrade to
`execute`/`undecided`, even after children end or reopening.

**R4 Coordinate through facts.**
Before dispatch, check all unfinished Tasks for conflicts; define requirements/prerequisites
and select/prepare a capable existing or new session. A suitable prior assignee can receive
a new Task without reopening its old one. Recheck ready/idle/no unfinished responsibility:
Task completion does not prove native idle. Do not take over assigned work.
The orchestrating parent creates children and uses `task_assign`.

For blocking work outside scope, atomically add a concrete `{condition}` to `blocked_by`:
what is missing and what satisfies it. Nonblocking needs go in the outcome.
The parent arranges work, revises agreements or substitutes a Task dependency within scope.
Responsibility facts go upward, not user questions.

A Task-ID dependency waits for that execution's `done`, not success. Cancellation does not
satisfy it; reopening does not revive resolved relations. Require success as a condition
when needed. Children are not automatic blockers: they limit parent termination, not coordination.

Resolve your own satisfied condition with `task_resolve_condition`: exact `dependency_id`,
recorded user answer/objective evidence. This cannot remove Task-ID dependencies, change
meaning or widen scope. A description edit alone does not resolve it.

Never message another formal Task node, even through a helper.

**R5 Close responsibility.**
Before `done` or final `cancelled`, all direct children must be `done` or `cancelled`.
This is not parent success or automatic closure. For done, satisfy prerequisites, correct gaps against
the agreement and integrate useful child retros.
Submit your own new outcome and evidence-based retro, or explicit `null` for no findings.
Never call partial work complete or cancelled children successful; seek scope consent if needed.

`task_cancel` records an Agent cancellation request, not terminal status.
Stop goal progress, close children and handle residuals; read/ACK, edit and record cleanup.
Only its assignee uses `task_cancel_finalize` with disposition; Web user finalizes unbound work.
Cancellation need not satisfy abandoned execution prerequisites or ACK. No blind cascade.
Ancestor intent blocks new progress, but existing child done may close under active
orchestrating ancestors' intent/blockers; own intent forbids own done.

A long-lived root may stay idle; do not invent work or close it because children finished.

**R6 Recover from facts.**
On failure or uncertainty, read the Task or original `operation`; never blindly retry,
redispatch, replace a Task or repeat external effects.
Replay keeps `request_id` and original inputs; new writes use current `write_context`.
Saved effects differ from notification failures. Missing authority/facts are blockers,
not permission to simulate the service through private state or messages.

Idle/unloaded sessions and accepted notices are not completion.
Never poll progress, chase ACKs or wait for notices to be read. Subscribe only
for a necessary follow-up unlocked by a future state; cancel obsolete waits, never auto-renew.

## Notices and situations

| Card | Received by | Next action |
| --- | --- | --- |
| `[Task assigned]` | assignee | Read/ACK; initialize (R2) |
| `[Task updated]` | assignee | Read/ACK changed agreement/prerequisites |
| `[Task cancellation requested]` | assignee | Read intent; cleanup/finalize (R5) |
| `[Task cancelled]` | legacy assignee | Read cancellation; stop, no execution reports |
| `[Task blocked]`, `[Subtask blocked]` | parent | Read unmet facts (R4) |
| `[Subtask done]` | parent | Integrate outcome; automation run/barriers too |
| `[Subtask cancelled]` | parent | Re-plan; no success inference |
| `[Subtask ready]` | dependent's parent | Read facts; authorized dispatch |
| `[Subtask blocker cancelled]` | dependent's parent | Re-plan; no automatic unblocking |
| `[Subscribed Task status changed]` | subscriber | Necessary follow-up only |

Bound dependents get updates instead. Delivery rechecks relations, never reroutes stale recipients.
No self-prompts or fabricated labels.

### Establish or recover the selected responsibility

Without unfinished bound work, create an unbound root, then `task_claim` it with your ready
Node; no self-dispatch or caller idle check. Blocked roots may be claimed for clarification.
Web user assigns roots; parents dispatch children. Initialize under R2.

For rework (R1), `task_reopen` checks original-assignment eligibility and ready Node capability.
Supply the complete agreement/reason; no later assignment or other unfinished Task is allowed.
Preserve assignee/mode/history; recover the workspace under `github-coding`.
Legally restore ended ancestors first; cancelled/ineligible ancestors prevent in-place reopen.
No replacement, redispatch or renewed subscriptions. Unknown legacy mode
cannot reopen or be repaired by API; never infer from child absence or session activity.

The new parent's assignee or Web user uses `task_attach` with both contexts and an authorized
reason. Another session owns the active orchestrating parent. Preserve root, binding, scope,
descendants and history; no fixed business depth cap or detach/reparent escape.

### Trusted automation

Only existing trusted repeatable scripts qualify, never invented to bypass Agent delivery.
Read [Automation](references/automation.md) to select, start, cancel or recover; the service
manages execution, not an Agent assignee/mode/ACK/report.

## Service boundary

Service checks data constraints, not same-goal judgment, success or consent.
No guessed migration or generic tool sandbox; keep native safeguards.
