---
name: cockpit-task-tree
description: "Operating manual for every Task tree node: Task is the only channel between nodes. With a Task, complete it yourself or through Subtasks you orchestrate; without one, stay available and delegate through Tasks. The service sends every notice. Load when first needed; reuse guidance still in context."
---

# Task tree

Use the `cockpit-task` MCP. Tool descriptions, schemas, results and error messages carry the
arguments, fields, views, limits, error codes and recovery steps; this Skill says how to act.

## Core idea

Task is the only channel between nodes. Every session is a node: with a Task, it owns
completing it; when the work is too big, it splits it into Subtasks and orchestrates them.
Nodes only read and write Tasks, and the service sends every notice. Decisions come from
the user, asked directly.

## Relations

For any Task, `assignee` is you: it is your Task, and you hold at most one unfinished Task.
`orchestrator` is you: you created it, so it is your Subtask (a top-level Task when you had
no Task). Reads return `actor_role`; when unsure, read the Task. The host supplies your
identity, a subagent acts for its session, and the service authorizes each write by relation:

| Caller | Tools |
| --- | --- |
| Only the assignee | `task_ack`, `task_report` |
| Orchestrator or assignee | `task_edit`, `task_cancel`, `task_reopen` |
| Only the orchestrator | `task_assign`, `task_automation_start`, `task_automation_reconcile` |
| Anyone | every other tool |

## Rules

**R1 Communicate only through Task.**
- Never send anything to another agent, not even a Task link.
- Put what others need in the Task. The description is the complete current agreement: goal,
  scope, key decisions, authorization boundaries and completion conditions. References,
  metadata and Issues only supplement it. Progress goes in activity, results in the outcome.
- The node facing a decision asks the user directly (ask_user where available). Do not ask
  a question someone is already asking, or ask for facts you can check yourself.
- Keep secrets out of Tasks.

**R2 Do your Task by the current agreement.**
- Before starting, resuming, taking a consequential action and delivering, read the full
  current Task (`execution`) and ACK its exact revision. A card is only a pointer; the Task
  decides.
- Follow project instructions and relevant work Skills for methods; use `github-coding`
  when changing repository files. Methods never widen authorization or change communication.
- When the agreement changes, for example the user changes their mind or you agree a new
  scope with them, revise your own Task.
- Record only meaningful facts in activity, report status truthfully, and never present
  partial work as complete.
- Mark done with a new outcome (result, evidence, limits) and a retro (evidence-based
  findings, or `null` when there are none).

**R3 Do it yourself, or split it.**
- Do what you can complete yourself. Split work that is too big or parallel into more
  specific Subtasks by independently deliverable result, not by stage or trade, and assign
  each to a new node. Each Subtask description carries every requirement of your Task that
  applies to it or to deeper levels. Do not do a delegated Subtask yourself; its assignee
  decides how.
- Before dispatching, check all unfinished Tasks for conflicting work on the same thing and
  order them with `blocked_by`.
- When things change, revise, reorder or cancel obsolete Subtasks.
- Verify each result against your Task's requirements. Errors and empty results are not
  results; revise or add a Subtask for gaps. Integrate, fold your Subtasks' retros into your
  own retro, and only then complete your Task.
- Without a Task (the root), you dispatch this way but do not follow progress, so give work
  that needs integration to one top-level Task and let its assignee split it.

**R4 Report work outside your Task upward.**
- If it blocks you, report `blocked` and state what must happen first, including any user
  decision you are waiting for.
- If it does not block you, put it in your outcome.
- An orchestrator reading this handles it within its own scope (create a Task, set
  `blocked_by`, revise a definition) or reports it upward the same way.

**R5 Authorization comes from the user.**
- Discussion, research and records do not authorize changes, dispatch or implementation;
  asking for a result does not authorize doing it yourself.
- Scope changes, trade-offs, cancellation and reopening need the user's explicit consent.

**R6 Act on Task facts; when unsure, read first.**
- On an unknown result, failure or conflict, read the Task or operation before deciding.
  Where a tool result names a safe recovery, follow it; otherwise never blindly retry,
  redispatch or replace.
- Read only what the current decision needs. Chat history, an idle session or a delivered
  notice is not evidence of delivery.
- Never poll, chase or wait for a notice to be read. Subscribe only when a future status
  unlocks a necessary follow-up of yours.

## Notices

| Card | Received by | Act |
| --- | --- | --- |
| `[Task assigned]` | assignee | F2 |
| `[Task updated]` | assignee: someone else changed the description or `blocked_by`, reopened the Task, or its blockers finished or were cancelled | F3 |
| `[Task cancelled]` | assignee: someone else cancelled the Task | F4 |
| `[Subtask done]`, `[Subtask blocked]`, `[Subtask cancelled]` | the Subtask's orchestrator | F5 |
| `[Subtask ready]`, `[Subtask blocker cancelled]` | orchestrator of an undispatched dependent | F5 |
| `[Subscribed Task status changed]` | the subscriber | the follow-up you subscribed for |

Cards are `task:` links with fixed text and never carry free-form notes. Older labels, such
as `[Task assigned to you]` or an `As Owner:` prefix, mean the same card. A top-level
Task's transitions reach the root only through its own subscription.

## Basic situations

- **F1 The root receives a request.** Discussion stays discussion. When the user wants a
  result: create a Task with complete requirements, check conflicts and order (R3), create a
  node (preparing explicitly needed existing Skills or MCP servers; readiness is not
  authorization), assign, then stop and stay available.
- **F2 `[Task assigned]`.** Read the full Task and ACK. Do it or split it (R3). Ask the user
  real decisions and revise your Task (R1, R2). Report status; finish with outcome and retro.
- **F3 `[Task updated]`.** Read the full Task, ACK the latest revision, continue by the
  current agreement, and address every changed requirement in your outcome, including why
  one does not apply.
- **F4 `[Task cancelled]`.** Read the cancellation, stop affected work, report nothing more.
- **F5 Subtask cards.** `done`: read the outcome, verify and integrate; handle anything
  reported upward (R4). `blocked`: read the reason; do not repeat a user question it is
  already waiting on, otherwise handle it (R4). `cancelled` or `blocker cancelled`:
  re-plan. `ready`: assign it.
- **F6 Cancel or reopen.** With the user's consent, cancel with a reason, or reopen a done
  Task with a complete description and reason; the service notifies the assignee.
- **F7 Trusted scripts.** Agent work is the default. Only an existing, trusted, repeatable
  script within the user's authorization runs as automation; never create a script to
  bypass Agent delivery, and registration does not authorize running it. See
  [Automation](references/automation.md).

## Service guarantees

You do not check or perform these yourself:
- **Rejected writes**: the service rejects, saving nothing:
  - self-assignment, assignment up the lineage, more than 3 levels, a second unfinished Task
    for a node, and dispatch before blockers are done;
  - `blocked_by` on an ancestor or in a cycle;
  - reports without an ACK of that revision, and stale status, outcome or retro;
  - done without an outcome and an explicit retro.
- **Idempotent writes**: writes replay by `request_id` and reject stale `write_context`.
- **Notices**: every notice above is sent by the service. Delivery results are recorded and
  never retried. Notices never clear or rewrite queued session messages.
- **Pending changes**: every response carries `definition_check` for your own Task.

Reuse this Skill while it remains in context; reload it only when guidance is missing,
changed or unclear. That never replaces fresh Task reads or an exact ACK.
