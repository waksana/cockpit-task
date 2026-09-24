---
name: cockpit-task-tree
description: "Guide every Task tree node: with a Task, own completing it by doing the work or orchestrating Subtasks; without one, stay available and delegate delivery through Tasks. Derive your relation to each Task from its facts. Load when first needed; reuse guidance still in context rather than loading again at each message or checkpoint."
---

# Task tree

Use the `cockpit-task` MCP for the shared Task record. Project instructions and work
skills define execution methods; Task mechanics live here, not in `github-coding`.

## 1. Principle: every session is a node

Every session is one node in a tree. The only judgment a node makes is whether to do
the work itself or split it into Subtasks. A node has at most one Task of its own and
owns completing it; every Task it creates is its Subtask, which it orchestrates.

**If you have a Task, you own completing it.** Do the work yourself, or split it into
Subtasks that you orchestrate. Subtasks are part of your Task: follow them until their
results are integrated, and only then complete your own Task. Keep working until done.
That is not being always busy or non-interactive: when a real decision, missing
information or a scope question arises, ask the user directly (via ask_user where
available), wait, revise your own Task if the agreement changes, and continue.

**Without a Task** (in practice the root session the user prompts directly) you have
nothing to complete; see [section 4](#4-root-node-no-task-of-your-own).

## Your relation comes from Task facts, not memory

For a given Task, `assignee` is you: it is your Task. `orchestrator` is you: it is your
Subtask. The service sets `orchestrator` to the calling session at creation and takes your
identity from the host, never from a parameter. Reads return `actor_role`
(`assignee`, `orchestrator` or `none`); notice cards say `Task …` about your Task and
`Subtask …` about Tasks you orchestrate. When unsure, read the Task. These relations are
collaboration responsibilities, not business identities or extra authority. The service
rejects self-assignment and assignment back up the lineage
([Subtasks of your Task](references/task-writes-and-recovery.md#subtasks-of-your-task)).

## 2. Doing your own Task

Confirm the agreement, ask the user directly, revise your Task when it changes, deliver
truthfully and submit a retro with done: [Doing your own Task](references/own-task.md).

## 3. Orchestrating Subtasks

You orchestrate every Subtask you create and keep their topology correct: split into more
specific parts, order them with `blocked_by` after a conflict check against all unfinished
Tasks, re-plan when changes make a Subtask obsolete, then follow, integrate and handle their
retros before your own done: [Orchestrating Subtasks](references/subtasks.md).

## 4. Root node: no Task of your own

Stay available for the user and delegate delivery through top-level Tasks rather than doing
long work yourself (brief read-only answers are fine). You are still their orchestrator: check
conflicts and order before dispatching, exactly as in section 3, but do not follow their
progress beyond a concrete necessary follow-up. This is a consequence of the principle, not
a separate role.

## 5. Mechanics references

| When | Read |
| --- | --- |
| A known trusted script should run as an automation Task | [Automation](references/automation.md) |
| An important definition change cannot wait for the assignee's next checkpoint | [Important updates](references/important-updates.md) |
| Views, fields, truncation and pagination | [Task views and fields](references/reading-tasks.md) |
| Write rules, conflicts, partial or uncertain effects, subscriptions, dependencies, Subtasks, reopen, retro handling | [Task writes and recovery](references/task-writes-and-recovery.md) |
| `task:` link syntax or an unfamiliar notice card | [Task links](references/task-links.md) |

A node doing its Task and orchestrating Subtasks reads both section 2 and section 3
guidance, each for its own Tasks. Load only the reference needed, not the whole set.

## Shared rules

Ask real decisions of the user in your own session; never message another Task's
orchestrator or assignee, directly or through other agents; an
[important update](references/important-updates.md) goes through `task_edit`
`notify_assignee`, never a handwritten note. Task is the shared
agreement and record. Use actual Task/session IDs, stable mutation request IDs and fresh
returned `write_context`; inspect errors and `definition_check` as well as results.
Use tool schemas for arguments.

Reuse this Skill while it remains in context; reload for missing/changed guidance or an
unclear rule, not each new message or checkpoint. This never replaces fresh Task reads,
state or precise ACK.
