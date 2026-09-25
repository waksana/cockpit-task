---
name: cockpit-task-tree
description: "Operating manual for every Task tree node: Task is the only channel between nodes. With a Task, complete it yourself or through Subtasks you orchestrate; without one, stay available and delegate through Tasks. The service sends every notice. Load when first needed; reuse guidance still in context."
---

# Task tree

Use `cockpit-task` MCP. Tool schemas/results define fields, limits and recovery;
this Skill guides decisions.

## Core idea

Task is the only channel between nodes. Every session is a node: with a Task, it owns
completing it; when the work is too big, it splits it into Subtasks and orchestrates them.
Nodes only read and write Tasks, and the service sends every notice. Decisions come from
the user, asked directly.

## Relations

If `assignee` is you, it is your Task (at most one unfinished). If `orchestrator` is you,
you created it (a Subtask when you had a Task). Read `actor_role` when unsure. Host identity
determines write authority; a subagent acts for its session:

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
- Record meaningful activity, report status truthfully, and never call partial work complete.
- Mark done with a new outcome (result, evidence, limits) and a retro (evidence-based
  findings, or `null` when there are none).
- Lifecycle is `todo`, `in_progress`, `done` or `cancelled`. `in_progress` means started,
  not continuously running. Review is work, not a lifecycle state.
- A user's temporary pause is not a blocker or an escalation. Keep any explicit
  "wait until I say continue" in the agreement; a notice or ready prerequisite cannot
  override it. Task records do not stop native sessions or running tools.

**R3 Do it yourself, or split it.**
- Work yourself or split by independently deliverable result, not by stage or trade.
  Each Subtask description carries every requirement applicable to it or deeper levels.
  Assign a new node; do not take over delegated work.
- Before dispatching, check all unfinished Tasks for conflicting work on the same thing and
  order them with `blocked_by`.
- When things change, revise, reorder or cancel obsolete Subtasks.
- Verify each result against your Task's requirements. Errors and empty results are not
  results; revise or add a Subtask for gaps. Integrate, fold your Subtasks' retros into your
  own retro, and only then complete your Task.
- Without a Task (the root), you dispatch this way but do not follow progress, so give work
  that needs integration to one top-level Task and let its assignee split it.

**R4 Report work outside your Task upward.**
- If it blocks you, atomically add a concrete `{condition}` to `blocked_by`: state what is
  missing and what satisfies it. The service notifies your orchestrator once.
- If it does not block you, put it in your outcome.
- An orchestrator reading this handles it within its own scope (create a Task, set
  `blocked_by`, atomically replace the condition with `{task_id}`, revise the definition),
  explicitly resolves the condition, or reports it upward the same way.

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
| `[Task updated]` | assignee: a ready Task's agreement changed, it became blocked/ready, it reopened, or a blocker was cancelled; not self-authored | F3 |
| `[Task cancelled]` | assignee: someone else cancelled the Task | F4 |
| `[Task blocked]` | orchestrator: the assignee recorded a concrete unmet condition | F5 |
| `[Subtask done]`, `[Subtask cancelled]` | the Subtask's orchestrator | F5 |
| `[Subtask blocked]` | legacy card to the Subtask's orchestrator; no new transition emits it | F5 |
| `[Subtask ready]`, `[Subtask blocker cancelled]` | orchestrator of an undispatched dependent | F5 |
| `[Subscribed Task status changed]` | the subscriber | the follow-up you subscribed for |

Cards are `task:` links with fixed text and never carry free-form notes. Older labels, such
as `[Task assigned to you]` or an `As Owner:` prefix, mean the same card. A top-level
Task's lifecycle transitions reach the root only through its own subscription;
a new assignee-recorded unmet condition also sends `[Task blocked]`.

## Basic situations

- **F1 The root receives a request.** Discussion stays discussion. When the user wants a
  result: create a Task with complete requirements, check conflicts and order (R3), create a
  node (preparing explicitly needed existing Skills or MCP servers; readiness is not
  authorization), assign, then stop and stay available.
- **F2 `[Task assigned]`.** Read the full Task and ACK. Do it or split it (R3). Ask the user
  real decisions and revise your Task (R1, R2). Report status; finish with outcome and retro.
- **F3 `[Task updated]`.** Read the full Task, ACK the latest revision, and act within the
  current agreement and prerequisites. Address every changed requirement in your outcome,
  including why one does not apply.
- **F4 `[Task cancelled]`.** Read the cancellation, stop affected work, report nothing more.
- **F5 Dependency/Subtask cards.** `done`: read the outcome, verify and integrate; for
  automation, inspect run facts and any barrier, not just Task status (F7).
  `Task blocked` or legacy `Subtask blocked`: read current requirements and blocking
  evidence, then handle unmet needs (R4). `cancelled` or `blocker cancelled`: re-plan.
  `ready`: the orchestrator reads current facts and dispatches an unassigned Task when
  authorized (R3, R5); for an assigned Task, its assignee reads/ACKs the latest agreement
  and continues permitted work (R2).
- **F6 Cancel or reopen.** With the user's consent, cancel with a reason, or reopen a done
  Task with a complete description and reason; the service notifies the assignee.
  Reopen never revives resolved dependencies. A dependent with a new gap records a new
  condition; its orchestrator explicitly replaces it with a new Task reference after
  authorized, eligible rework is arranged. Other old dependents are unaffected.
- **F7 Trusted scripts.** Agent work is the default. Only an existing, trusted, repeatable
  script within the user's authorization runs as automation; never create a script to
  bypass Agent delivery, and registration does not authorize running it. See
  [Automation](references/automation.md).

## Service guarantees

You do not check or perform these yourself:
- **Rejected writes**: the service rejects, saving nothing:
  - self-assignment, assignment up the lineage, more than 3 levels, a second unfinished Task
    for a node, and dispatch or done while prerequisites are unmet;
  - a Task blocker on an ancestor or in a cycle, and an assignee trying to resolve a
    textual condition without its orchestrator;
  - reports without an ACK of that revision, and stale status, outcome or retro;
  - done without an outcome and an explicit retro.
- **Idempotent writes**: writes replay by `request_id` and reject stale `write_context`.
- **Notices**: every notice above is sent by the service. Delivery results are recorded and
  never retried. Notices never clear or rewrite queued session messages.
- **Pending changes**: every response carries `definition_check` for your own Task.

Reuse this Skill while it remains in context; reload it only when guidance is missing,
changed or unclear. That never replaces fresh Task reads or an exact ACK.
