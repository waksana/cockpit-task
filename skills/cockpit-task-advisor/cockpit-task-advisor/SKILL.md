---
name: cockpit-task-advisor
description: "General Task guidance for people and agents: use read-only responsibility metadata to find the right session, decide when new work needs Node capability, and understand execute/orchestrate without taking over or expanding authorization."
---

# Task advisor

## Scope and evidence

Use this guide when choosing whom to consult or whether work needs Task tracking.
It is not an instruction to become an assignee. The advisor role contributes only
`task_read`; session discovery, Chat reads, role selection and message delivery need
separately available, authorized host capabilities. Do not invent missing tools.

Native session/Chat is the only source of business conversation. Task data, like
other metadata, assists discovery; it cannot replace the actual session context.
Task is authoritative for its recorded bindings and lifecycle, not proof of business
success. Read the relevant conversation before continuing a topic or presenting an
answer. An absent Task is not an absent topic. A failed/unavailable read is unknown,
not proof that no suitable session exists.

Understand enough context to identify the topic, resolve references, choose a recipient
and preserve the user's meaning. This is not permission to analyze the business problem
or invent a solution. A conversation entry point that delegates business thinking keeps
that boundary: the responsible session supplies analysis, proposals and business
clarifications. If topic identity is ambiguous, clarify only which topic the user means.

## Find the topic, then its responsible session

Start with recent conversation and ordinary session discovery. Use `task_read` as an
additional, bounded index, not an exhaustive replacement directory:

1. Use `view: "list"` with a title `query` or candidate `assignee`. Lists default to
   unfinished work; use `status: "all"` when investigating prior discussions/deliveries.
   Follow cursors only as needed. Title matches are candidates, not routing decisions.
2. For a candidate Task, use `view: "overview"` with `include` selecting complete
   `definition`, `activity` or `outcome` groups (context is always returned). Defaults
   may be excerpts. Use `execution` for the full current agreement when needed.
3. Check `assignee`, `parent_task_id`, `parent_assignee`, `work_mode`, current scope,
   cancellation intent and prerequisites. Use bounded `ancestors` or a direct-child
   list only when the relationship matters; do not recursively fetch the whole tree.
4. Return to the candidate's actual session/Chat to confirm topic continuity and the
   meaning of recent work. Retrieve more detail only where needed for this exchange.

`depth` is structural (a root is depth 1), not expertise, authority over every topic,
or a reason to always go to the highest ancestor. `created_by` is historical, not
the current manager. `actor_role` describes the caller's relation, not a role to assume.
Readiness, status, native activity and responsibility mode are separate facts.

## Prefer the assignee or direct parent

For one Task, normally keep the conversation with its own assignee or its current
direct parent's assignee. Choose by the user's topic and actual responsibility:

| Conversation need | Preferred recipient |
| --- | --- |
| Continue concrete work, reasoning or a decision already discussed there | The assignee with that context |
| Coordinate scope, dependencies, priorities or integration across children | The direct parent responsible for that coordination |
| Avoid interrupting a heavily engaged worker, and the parent can cover the topic | The direct parent, without pretending to have the worker's answer |
| No parent, no binding, conflicting candidates or insufficient context | Inspect relevant sessions; clarify topic identity if still ambiguous |

"Busy" is a contextual judgment from recent work, workload, active continuations,
queued messages, pending questions and the nature of the current responsibility.
No single running/idle flag establishes it; unknown activity is not idle. Busy does
not transfer ownership, authorize cancellation or justify automatically escalating.
Do not broadcast to both people, recursively climb the tree, or force a new session
just because the preferred recipient is working. Waiting silently can be appropriate.
This is a preference, not a ban on consulting another session whose actual topic
responsibility is clearer; preserve continuity rather than treating hierarchy as routing.

Terminal Tasks retain historical assignees and context. They do not show that the
session is idle, still available or eligible for new work. Check current relationships
and unfinished work before proposing reuse. Unbound Tasks and service-managed automation
have no agent assignee to message; do not guess an owner from their creator. For automation,
inspect its current parent for coordination and its outcome separately from status.

## Choose Node capability for the work, not for every conversation

Task suits an authorized, continuing result that needs an explicit agreement, recovery,
progress/evidence or coordination. Complex work is a strong reason to select Node
when creating its responsible session. Sustained research, design or discussion can
also be a Task without authorizing implementation. A short question or casual topic
does not automatically need a Task or a new session.

Prefer a suitable existing session with the actual context. Continue unfinished work
in its existing Task; use a new Task for an independent result, and reopen only authorized
rework of the same completed delivery. Never reopen merely to reuse a familiar session.
A session may carry at most one unfinished Task; do not hide a second goal in its first
Task or redirect assigned work to bypass that constraint.

If a new responsible session is justified and creation is authorized, use the host's
ordinary role composition with `{moduleId: "cockpit-task", roleId: "node"}` alongside
other needed roles. The advisor role does not itself supply session-creation tools.
Check actual role/tool/Skill readiness; saved selection is not applied capability,
and enabled Skill is not a loaded body. Adding a role to an existing session only
saves it until an authorized reload/cold load applies it; never interrupt active work.

The ready Node can establish its own authorized ordinary root: `task_create` creates
unbound todo/undecided work, then `task_claim` binds it, full execution read and exact
ACK precede `task_start`. Creation, binding and ACK alone do not start work. A child
instead belongs to its active orchestrating parent and follows parent dispatch;
do not ask a new Node to self-create an unrelated root as a substitute for that child.
These are the responsible Node's actions under `cockpit-task-tree`, not instructions
for an advisor to call write tools or create/claim on someone else's behalf.

`execute` and `orchestrate` are per-Task modes of the same Node, not permanent executor
and orchestrator session roles. Execute delivers one bounded result, with helpers if
useful. Orchestrate owns coordination and integration of narrower independent continuing
responsibilities; it is not a pass-through stage. Complexity or helper use alone does
not require orchestration. A new Task chooses its own mode; an execute Task explicitly
converts before splitting, and a reopened Task preserves its mode.

## Keep user conversation distinct from formal coordination

A separately authorized conversation entry point may relay the user's conversation
using its existing messaging capabilities. Preserve intent, references, context and
authorization so the recipient can continue naturally; do not turn it into a work order,
add business assumptions, demand acknowledgements, or repeatedly narrate internal handoffs.
Integrate the responsible session's reply naturally without inventing conclusions or
representing accepted delivery, a Task label or pending work as a finished answer.

This is not a channel for one formal Task node to direct another. Formal nodes coordinate
through Task facts and service notices, never private messages or helpers carrying orders.
When acting as a formal node, use that protocol rather than calling coordination a user
relay. An advisor read creates no assignment, change of scope, ACK or execution authority.
The responsible node asks business decisions directly and records authorized agreement
changes; the entry point does not pre-solve or repeatedly re-ask those decisions.

Do not poll workers, chase ACKs, duplicate dispatches or silently retry uncertain sends.
Composition adds Task-owned guidance, not an intrinsic dependency in another module.
