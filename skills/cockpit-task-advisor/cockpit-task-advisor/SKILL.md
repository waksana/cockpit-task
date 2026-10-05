---
name: cockpit-task-advisor
description: "General read-only Task guidance for people and agents choosing or reconsidering a recipient: cross-check actual responsibility, scope and continuity, and choose Node capability without taking over or expanding authorization."
---

# Task advisor

## Scope and evidence

Use this guide to choose/reconsider recipients or Task tracking, not to justify a
previous choice. The advisor supplies only `task_read`, not an assignee role.
Session discovery, Chat reads, role selection and messaging require separately
available, authorized host capabilities. Do not invent missing tools.

Native session/Chat is the only source of business conversation. Task metadata
assists discovery; it cannot replace the actual session context. Task is authoritative
for recorded bindings and lifecycle, not business success. Read relevant Chat before
continuing a topic or presenting an answer. An absent Task is not an absent topic;
a failed/unavailable read is unknown, not evidence that no suitable session exists.

Understand the current goal, references and intent to locate responsibility. This is
not permission to analyze the business problem or invent a solution. An entry point
that delegates business thinking clarifies only topic, request scope or
discussion-versus-execution intent; the responsible session supplies business
analysis, proposals and decisions.

## Discover responsibility before choosing

Start with conversation and ordinary session discovery. Cross-check with `task_read`
when a goal spans responsibilities, plausible candidates compete, recent snippets
leave scope unclear, or the user corrects the overall scope. Reuse sufficient evidence
already read and still current; do not reload stable guidance or query on every turn.
This is a bounded additional index, not an exhaustive replacement directory:

1. Use `view: "list"` with a title `query` or candidate `assignee`. Lists default to
   unfinished work; use `status: "all"` when investigating prior discussions/deliveries.
   A match for one assignee proves neither overall fit nor absence of a better candidate.
   Check clearly relevant alternatives, not every session; follow cursors only as needed.
2. For candidate scope, use `view: "overview"` with `include: ["definition"]` for the
   complete agreement, not its default excerpt. Add full `activity` or `outcome` only
   as needed; context is always returned. Use `execution` for current execution detail.
3. Check `assignee`, `parent_task_id`, `parent_assignee`, `work_mode`, current scope,
   cancellation intent and prerequisites. Use bounded `ancestors` or direct children
   only for a relevant relationship; never recursively fetch the whole tree.
4. Return to native Chat to confirm continuity and what recent work means. Stop when
   evidence supports the needed responsibility and material candidate conflicts are
   resolved, not at the first matching title or assignee.

After a scope correction, reconsider relevant candidates rather than only checking
the first recipient's unfinished work or extending its responsibility. A read does
not authorize reassignment, cancellation or another send.

A long-lived agreement may stay idle. Judge scope from its current full definition,
binding and native Chat, not just the latest subtask.
Quiet periods and narrow recent activity do not end or shrink that agreement.
Past `orchestrate` work does not confer permanent responsibility for related topics.
`depth` is structural, not expertise or authority; `created_by` is historical, not
the current manager. `actor_role` describes a relation, not a role to assume.

## Choose by responsibility, then current suitability

For one Task, prefer its own assignee or its current direct parent's assignee by
actual scope, not hierarchy:

| Conversation need | Preferred recipient |
| --- | --- |
| Concrete work, reasoning or a decision | The assignee with that context |
| Execution corrections, constraints, materials or answers | The executing assignee, even when busy; use its current native ask when applicable |
| Cross-child scope, dependencies, priorities or integration | The parent whose agreement covers it, retaining child assignees |
| Independent discussion during heavy work | A matching discussion session, or its direct parent only if that parent can cover the question |
| Missing binding or conflicting scope | Inspect relevant sessions; clarify request ambiguity, not readable facts |

An established integration assignee receives the overall goal and owns its business
decomposition and formal child coordination. Do not bypass it with a parallel work
split or promote a partial executor merely because it received the first question.
Separately owned deliveries need not acquire a new parent just to share an outcome.

"Busy" is judged from recent work, workload, active continuations,
queues and pending questions. No single running/idle flag establishes it; unknown
activity is not idle. Readiness, status, activity and responsibility mode are separate.
Busy does not transfer ownership or authorize cancellation. Do not automatically
escalate, broadcast to worker and parent, climb the tree or create a session because
someone is working. Waiting silently can be appropriate. A different session may
have clearer responsibility; do not pretend a parent has the worker's answer.

Terminal Tasks retain historical assignees, not native idle or eligibility.
Check current relationships and unfinished work before reuse. Unbound Tasks and
service-managed automation have no agent assignee to message; do not guess from their
creator. For automation, inspect its parent for coordination and outcome for results.

## Choose Node capability for the work, not for every conversation

Task suits authorized continuing work needing an agreement, recovery, evidence or
coordination. Complex work favors Node for a new session; sustained research or
discussion can qualify without authorizing implementation. Short questions need
not create Tasks or sessions.

Prefer suitable existing context. Continue unfinished work in its Task; use a new
Task for an independent result, reopen only authorized rework of the same completed
delivery, never merely to reuse a session. A session has at most one unfinished Task;
do not hide a second goal in it or redirect assigned work to bypass that constraint.

For a justified, authorized new session, compose `{moduleId: "cockpit-task", roleId: "node"}`
with other needed roles through the host. Check actual role/tool/Skill readiness:
saved selection is not applied capability; enabled Skill is not a loaded body.
Role additions need authorized reload/cold load; never interrupt active work.

A ready Node may establish its authorized root: `task_create` unbound todo/undecided
work, then `task_claim`, full execution read and exact ACK before `task_start`.
Creation, binding and ACK do not start work. A child instead belongs to its active
orchestrating parent and follows parent dispatch, not a substitute self-created root.
These are the responsible Node's actions under `cockpit-task-tree`, not advisor writes
or permission to create/claim for someone else.

`execute` and `orchestrate` are per-Task modes of the same Node, not permanent roles.
Execute delivers a bounded result; orchestrate integrates narrower independent
continuing responsibilities, not pass-through delegation. Both may use helpers;
complexity alone does not require orchestration. Each new Task chooses its mode;
an execute Task explicitly converts before splitting; a reopened Task preserves its mode.

## Keep user conversation distinct from formal coordination

A separately authorized entry point may relay the user's conversation with its
messaging capabilities. Preserve wording, intent and authorization, adding only
necessary missing context. Do not turn questions into work orders, add analysis
requirements, demand ACKs or narrate internal handoffs. Integrate actual replies
without invented conclusions; accepted delivery, labels and pending work are not results.

Formal nodes coordinate through Task facts and service notices, never private messages
or helpers carrying orders. Use that protocol rather than calling coordination a user
relay. An advisor read creates no assignment, scope change, ACK or execution authority.
The responsible node asks business decisions directly and records authorized agreement
changes; the entry point neither pre-solves nor repeatedly re-asks those decisions.

Do not poll workers, chase ACKs, duplicate dispatches or silently retry uncertain sends.
Composition adds Task-owned guidance, not an intrinsic dependency in another module.
