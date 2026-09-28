---
name: cockpit-task-tree
description: "Work as a node in a Task responsibility tree: recover the agreement, execute or orchestrate, use helpers in either mode, coordinate through Task facts, and close responsibility without abandoning children. Load when needed; reuse while in context."
---

# Task tree

Use `cockpit-task` MCP; contracts define fields/authority/limits/recovery.

## Model and relations

A Task is a continuing responsibility within user authorization. Its Agent session delivers
directly (`execute`) or organizes narrower children and integrates results (`orchestrate`).
Splitting never removes responsibility for the whole result.
Task is the only channel between formal Task nodes; service notices are pointers.
Every node asks the user directly; the tree is not an approval chain.

| Current fact | Responsibility |
| --- | --- |
| `assignee` is you | Deliver it; one unfinished Agent Task per session |
| Your Task is its parent | Coordinate that child, not take over |
| Your Task has a parent | `parent_assignee` integrates your result |
| No parent | Ordinary root, no special role/authority |

Only the own assignee is bound. `created_by` is history, not control. Use current relations,
`actor_role` and host identity; never infer missing bindings.

## Rules

**R1 Keep one current agreement.**
Describe work-specific goals, decisions, boundaries and completion requirements. Reference
external material. Activity records important changes; outcome records delivery, remaining
work and evidence. Keep secrets out of Tasks.

Ask the user decisions directly; do not ask for readable facts, repeat another node's question
or make the parent ask again. Write changed agreements back; cross-Task effects use R4.
Discussion/records/preparation do not authorize implementation or dispatch. Scope changes,
trade-offs, cancellation, reopening and adding a parent need user consent. Methods/helpers
never widen it. Follow project instructions; use `github-coding` for repository changes.

**R2 Start and resume deliberately.**
Before starting, resuming, consequential actions and delivery, read full `execution` and
ACK its exact revision. Check mode, parent, intent, prerequisites and `definition_check`.

New Agent work is `todo/undecided`: read, clarify and do limited discovery, not implementation
or child creation. Binding, ACK and activity do not start it. When ready, `task_start`
atomically enters `in_progress` with `execute` or `orchestrate`, within existing authorization.
`task_report` cannot start todo or finish it directly; unstarted work can be cancelled.
Readiness never overrides a user pause. Task mode, lifecycle and native session interaction
mode are separate; do not synchronize them.

**R3 Fulfill responsibility.**
`execute` delivers research, implementation or review. `orchestrate` divides responsibility,
arranges interfaces/dependencies, handles blockers and integrates results.

**Both modes may use tools and helpers.** You integrate helper results; calls do not change
mode or ownership. Independent review need not create a Task/session. Use children for
independent continuing delivery responsibility, not based on tool names. No fixed priority
or per-use approval gate chooses between these means.

If executing, first `task_convert` with reason, completed results and remaining work, then
put remaining implementation in narrower children. Keep Task and assignee; no unchanged
pass-through delegation. Orchestrators may research coordination decisions, but keep sustained
implementation/deep investigation in children. No children yet is valid; never downgrade to
`execute`/`undecided`, even after children end or reopening.

**R4 Coordinate through facts.**
Before dispatch, check all unfinished Tasks for conflicts, define narrower requirements and
prerequisites, and select/prepare a capable existing or new session. Session/Task counts are
not goals; do not take over assigned work. An active, acknowledged, ready orchestrating parent
uses `task_create`; `task_assign` binds another eligible session and sends the pointer.
Preparation, binding and message acceptance are separate, not execution proof.

For blocking work outside scope, atomically add a concrete `{condition}` to `blocked_by`:
what is missing and what satisfies it. Put nonblocking needs in the outcome. The parent
arranges work, revises agreements or replaces a condition with a Task dependency within its
scope. Responsibility facts go upward, not user questions.

A Task-ID dependency waits for that execution's `done`, not success. Cancellation does not
satisfy it; reopening does not revive resolved relations. Express success as an actual
condition when needed. Children are not automatically blockers: unfinished children limit
parent termination, not coordination.

Resolve your own satisfied condition with `task_resolve_condition`: exact `dependency_id`,
recorded user answer/objective evidence and useful references. Parent/Web user may also
resolve. This cannot remove Task-ID dependencies, change meaning or widen scope. A description
edit alone does not resolve it. Missing facts/authority use R6, not repeated user approval.

Never message another formal Task node, even through a helper; no private requirements ledger.

**R5 Close responsibility.**
Before `done` or final `cancelled`, all direct children must be `done` or `cancelled`.
This gate is not parent success or automatic closure. For done, satisfy prerequisites,
judge actual results against your agreement, correct gaps and integrate useful child retros.
Submit your own new outcome and evidence-based retro, or explicit `null` for no findings.
Never call partial work complete. Cancelled children may need authorized scope change,
not invented success.

`task_cancel` records an Agent cancellation request, not terminal status, even for a leaf.
Stop goal progress; read/ACK, edit and record cleanup activity; close children and handle
residuals. Only its assignee uses `task_cancel_finalize` with disposition; Web user finalizes unbound work.
Cancellation need not satisfy abandoned execution prerequisites or ACK. No blind cascade.
Ancestor intent blocks new progress, but existing child done may close under active
orchestrating ancestors' intent/blockers; own intent forbids own done.

A long-lived root may stay idle; do not invent work or close it because children finished.

**R6 Recover from facts.**
On failure, conflict or uncertainty, read the Task or original `operation`. Use only supported
recovery; never blindly retry, redispatch, replace a Task or repeat external effects.
Replay keeps `request_id` and original inputs; new writes use current `write_context`.
Saved effects differ from delivery failures. Missing authority/facts are blockers, not
permission to simulate the service through private state or messages.

Read only needed facts. Session activity, idle/unloaded state and accepted notices
are not completion. Never poll progress, chase ACKs or wait for notices to be read. Subscribe
only for a necessary follow-up unlocked by a future state; cancel obsolete waits, never auto-renew.

## Notices and situations

| Card | Received by | Next action |
| --- | --- | --- |
| `[Task assigned]` | assignee | Read/ACK; initialize (R2) |
| `[Task updated]` | assignee | Read/ACK; account for changed requirements and prerequisites |
| `[Task cancellation requested]` | assignee | Read intent; cleanup/finalize (R5) |
| `[Task cancelled]` | legacy assignee | Read cancellation; stop, no execution reports |
| `[Task blocked]`, `[Subtask blocked]` | parent (latter legacy) | Read current unmet facts (R4) |
| `[Subtask done]` | parent | Read/integrate outcome; automation run facts/barriers too |
| `[Subtask cancelled]` | parent | Re-plan; no success inference |
| `[Subtask ready]` | unbound dependent's parent | Read facts; authorized dispatch |
| `[Subtask blocker cancelled]` | unbound dependent's parent | Re-plan; no automatic dependency removal |
| `[Subscribed Task status changed]` | subscriber | Necessary follow-up only |

Bound dependents get updates. Delivery rechecks relations, never reroutes stale recipients.
No self-prompts, fabricated labels or retries.

### Establish, reopen or extend a tree

Without bound work, create an unbound root, then `task_claim` your ready Node: no self-dispatch,
title change, start, ACK or caller idle check. Blocked roots may be claimed for clarification.
Web user can assign
roots; parents dispatch children. Initialize under R2.

`task_reopen` needs an authorized complete agreement/reason, original-assignment eligibility
and safe workspace recovery. Preserve assignee/mode. Legally
restore ended ancestors first; cancelled/ineligible ancestors prevent in-place reopen.
No silent replacement, renewed subscriptions or revived dependencies. Unknown legacy mode
cannot reopen or be repaired by API; never infer from child absence or session activity.

The new parent's assignee or Web user uses `task_attach` with both current contexts and an
authorized reason. A different session owns the active orchestrating parent. Preserve root
Task, binding, scope, descendants and history. Cycle/lifecycle/resource checks apply, with
no fixed business depth cap, detach or arbitrary reparent escape; scope does not expand.

### Trusted automation

Agent work is default; only existing trusted repeatable scripts qualify, never invented to
bypass delivery. Automation children need orchestrating parents; no Agent mode/assignee/ACK/report.
Read [Automation](references/automation.md) to select, start, cancel or recover.

## Service boundary

Service checks data constraints, not judgment, success or consent. No generic tool sandbox
or guessed migration. Keep native safeguards. Reuse this Skill, not stale Task reads/ACKs.
