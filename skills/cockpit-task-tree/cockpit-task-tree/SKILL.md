---
name: cockpit-task-tree
description: "Guide every Task tree node: with a Task, own completing it by doing the work or orchestrating child Tasks; without one, stay available and delegate delivery through Tasks. Derive your role for each Task from its facts. Load when first needed; reuse guidance still in context rather than loading again at each message or checkpoint."
---

# Task tree

Use the `cockpit-task` MCP for the shared Task record. Project instructions and work
skills define execution methods; Task mechanics live here, not in `github-coding`.

## One principle: every session is a node

Every session is one node in a tree. The only judgment a node makes is whether to do
the work itself or split it into child Tasks.

**If you have a Task, you own completing it.** Do the work yourself, or split it into child
Tasks that you orchestrate. Child Tasks are part of your Task: follow them until their
results are integrated, and only then complete your own Task. Keep working until done.
That is not being always busy or non-interactive: when a real decision, missing
information or a scope question arises, ask the user directly (via ask_user where
available), wait, revise your own Task if the agreement changes, and continue.

**Without a Task** (in practice the root session the user prompts directly) you have
nothing to complete. So you stay available for the user, delegate delivery through Tasks
rather than doing long work yourself (brief read-only answers are fine), and do not follow
what you delegated beyond a concrete necessary follow-up. This is a consequence of the
principle, not a separate role.

## Your role comes from Task facts, not memory

For a given Task, `executor` is you: you are its Executor. `owner` is you: you are its Owner.
You execute at most one Task, your own job; everything you create while executing it is
delegation inside that job and is owned by you. Reads that include your `actor_session_id`
return `actor_role`, and notice cards are labelled "As Executor: …" or "As Owner: …".
When unsure, read the Task. Owner and Executor are collaboration responsibilities, not
business identities or extra authority. The service rejects self-assignment, assignment
back up the lineage and mismatched child creation
([delegating child Tasks](references/task-writes-and-recovery.md#delegating-child-tasks)).

## Read the guidance for your current responsibility

| When | Read |
| --- | --- |
| A Task is assigned to you: start, resume, report, rework after done | [Executing](references/executing.md) |
| You create, dispatch, follow or revise Tasks you own, including child Tasks | [Delegating](references/delegating.md) |
| A known trusted script should run as an automation Task | [Automation](references/automation.md) |
| An important definition change cannot wait for the Executor's next checkpoint | [Important updates](references/important-updates.md) |
| Views, fields, truncation and pagination | [Task views and fields](references/reading-tasks.md) |
| Write rules, conflicts, partial or uncertain effects, subscriptions, dependencies, child Tasks | [Task writes and recovery](references/task-writes-and-recovery.md) |
| `task:` link syntax or an unfamiliar notice card | [Task links](references/task-links.md) |

A node holding a Task and owning its children reads both Executing and Delegating, each for
its own Task. Load only the reference needed, not the whole set.

## Shared rules

Ask real decisions of the user in your own session; never message another Task's Owner or
Executor, directly or through other agents. Task is the shared agreement and record.
Use actual Task/session IDs, your own `actor_session_id`, stable mutation request IDs and
fresh returned `write_context`; inspect errors and `definition_check` as well as results.
Use tool schemas for arguments.

Reuse this Skill while it remains in context; reload for missing/changed guidance or an
unclear rule, not each new message or checkpoint. This never replaces fresh Task reads,
state or precise ACK.
