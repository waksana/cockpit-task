---
name: cockpit-task-tree
description: "Operating manual for Task nodes: keep work-specific records and choose direct work, internal subagents or Task delegation as needed. Coordinate formal Task nodes through Tasks; retain responsibility and user authorization. Load when first needed; reuse guidance still in context."
---

# Task tree

Use `cockpit-task` MCP. Tool schemas/results define fields, limits and recovery;
this Skill guides decisions.

## Core idea

Every session is a node. With an assigned Task, you own its delivery. Internal subagents
are helpers whose results you integrate; launching one does not transfer Task responsibility.
Task is the only channel between formal Task nodes, and the service sends every notice.
Decisions come from the user, asked directly.

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

**R1 Coordinate Task nodes through Task.**
- Do not message another Task node, even with a Task link or through a helper.
- Keep the description to work-specific goals, decisions, boundaries and completion
  requirements. Reference external material instead of copying common knowledge, existing
  rules, procedures, unnecessary implementation detail or history.
- Record important changes in activity; put actual delivery, remaining work and evidence
  links in the outcome.
- The node facing a decision asks the user directly (ask_user where available). Do not ask
  a question someone is already asking, or ask for facts you can check yourself.
- Keep secrets out of Tasks.

**R2 Do your Task by the current agreement.**
- Before starting, resuming, taking a consequential action and delivering, read the full
  current Task (`execution`) and ACK its exact revision. A card is only a pointer; the Task
  decides.
- Follow project instructions and relevant work Skills for methods; use `github-coding`
  when changing repository files. Methods never widen authorization or change communication.
- When the agreement changes, revise your own Task. A notice or ready prerequisite is not
  permission to resume work the user paused.
- Report status truthfully: a Task's delivery state is
  not live session or tool activity. Never call partial work complete.
- Mark done with a new outcome and a retro (evidence-based
  findings, or `null` when there are none).

**R3 Choose how to do the work.**
- Work directly when the relevant context is already in hand and direct handling fits.
- Use internal subagents for parallel work, context separation or independent judgment;
  integrate their results yourself. Independent review need not create a Task or session.
- Delegate a Task when work needs an independent owner to keep it moving, deliver separately
  or coordinate dependencies. Give it the work-specific requirements and references it needs
  (R1); do not take over assigned work.
- These are judgment criteria, not a fixed priority or per-use approval gate. Choose a
  suitable existing or new session for a Task; neither new sessions nor fewer Tasks are goals.
- Before dispatching, check all unfinished Tasks for conflicting work on the same thing and
  order them with `blocked_by`.
- When things change, revise, reorder or cancel obsolete Subtasks.
- Verify each result against the agreed requirements and have errors or gaps corrected.
  Integrate results and fold Subtask retros into your own before completing your Task.

**R4 Report work outside your Task upward.**
- If it blocks you, atomically add a concrete `{condition}` to `blocked_by`: state what is
  missing and what satisfies it.
- If it does not block you, put it in your outcome.
- An orchestrator reading this handles it within its own scope (create a Task, set
  `blocked_by`, atomically replace the condition with `{task_id}`, revise the definition),
  explicitly resolves the condition, or reports it upward the same way.

**R5 Authorization comes from the user.**
- Discussion, research and records do not authorize changes, dispatch or implementation.
  Choosing a helper or Task does not widen authorization or transfer an existing assignment.
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
a new assignee-recorded unmet condition also sends `[Task blocked]` once.

## Basic situations

- **F1 The root receives a request.** Clarify the authorized result and choose how to do it
  (R3). For Task delegation, record the requirements and references, check conflicts, select
  or prepare a capable existing or new node, and assign. Then stay available without
  following progress; the assignee owns delivery.
- **F2 `[Task assigned]`.** Read the full Task and ACK. Do it or split it (R3).
  Handle decisions under R1; revisions, reporting and completion under R2.
- **F3 `[Task updated]`.** Read the full Task, ACK the latest revision, and act within the
  current agreement and prerequisites. Address every changed requirement in your outcome,
  including why one does not apply.
- **F4 `[Task cancelled]`.** Read the cancellation, stop affected work, report nothing more.
- **F5 Dependency/Subtask cards.** `done`: read the outcome, verify and integrate; for
  automation, also inspect run facts and any barrier (F7).
  `Task blocked` or legacy `Subtask blocked`: read current requirements and blocking
  evidence, then handle unmet needs (R4). `cancelled` or `blocker cancelled`: re-plan.
  `ready`: the orchestrator reads current facts and dispatches an unassigned Task when
  authorized (R3, R5); for an assigned Task, its assignee reads/ACKs the latest agreement
  and continues permitted work (R2).
- **F6 Cancel or reopen.** With the user's consent, cancel with a reason, or reopen a done
  Task with a complete description and reason.
  Reopening does not revive resolved dependencies. Handle newly discovered gaps through R4.
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
