---
name: github-coding
description: "Use when authorized work requires changing version-controlled repository files: the implementing node reuses or creates the Issue, creates its own branch and worktree from fresh mainline, delivers through the authorized review/merge boundary and safely cleans up after merge. Choose collaboration through cockpit-task-tree. Not triggered by GitHub mentions or deployment using existing artifacts alone. Keep Git isolation without GitHub; reuse guidance already in context."
---

# GitHub coding

This is a work Skill, not a Task role or authority to change scope. Task guidance
governs assignment, current-definition reads/ACK, reporting and communication.
Follow repository instructions; "main" means its agreed mainline.
Choose responsibility mode with `cockpit-task-tree`; both modes may use helpers.
The implementing node is the assignee for delegated work, otherwise the current node;
it implements in `execute`. `orchestrate` arranges children and integrates results,
not sustained implementation. Same isolation, review and delivery rules apply.

## Agree on the result before creating work

Apply to changes intended for commit, not mentions of GitHub, main or Releases.
Installing verified artifacts, runtime configuration and restart need no Issue/PR/worktree
under this Skill; project policies, including immutable installation directories, still apply.
Version bumps, build configuration, code and repository documentation follow this flow.
Keep an agreed mixed result in one Task; Issue/PR scope covers necessary repository changes,
not an umbrella deployment Issue or stage Tasks.

Distinguish discussion, investigation and authorized implementation. Short questions
need no Issue, Task or worktree; independent sustained discussion/research may be a Task
under `cockpit-task-tree`, without authorizing coding. For coding delivery,
confirm the repository, intended result and completion boundary. A full delivery
normally includes merge; investigation-only, patch-only or PR-only authorization
stops at that boundary. Ask about real ambiguity, not a second start command.

Choose responsibility before environment: continue unfinished work, create for a new
independent goal, reopen only same-delivery rework. A suitable session can take a new Task
with a new mode after prior work ends. Familiarity, Issue and worktree do not justify reopen.
Reuse a suitable Issue; verify workspace ownership and base for this result below.
For Git repositories not hosted on GitHub, keep the isolation, delivery and cleanup
principles, skipping inapplicable Issue/PR steps. Non-coding work is unaffected.
Release/tag creation, installation, deployment, restart and data migration are not
default coding stages and require separate authorization.

## For Task delegation: state the result

When delegating, the orchestrator states what should change, which repositories are involved and
the delivery boundary, and references an existing suitable Issue when there is one.
Orchestrator means the parent assignee, not the creator.
The orchestrator does not prepare or clean up branches or worktrees; setting up and releasing
the work environment is the assignee's job. Do not take over assigned work, directly or
through a helper, or invent repository changes just to create a deployment Task.

Keep Task descriptions to work-specific goals, decisions, boundaries and completion
requirements; reference project instructions, methods and prior evidence instead of copying
them. Use `references` for Issue/PR and supporting material, `metadata` for repository and
worktree locators, and `outcome.references` for evidence. GitHub holds review and repository
facts; Task holds the current agreement and important changes, not a mirrored history.

Environment cleanup is not a reason to wait for or wake the orchestrator. Default to no subscription.
Only if a future status unlocks specific necessary authorized orchestrator work, register
the smallest one-shot subscription before assignment to avoid a fast-completion race.
Completion confirmation or repeated reporting is not that work. Follow the existing
subscription guidance without polling, automatic renewal or a new script/timer.

Worktrees the orchestrator prepared before this workflow may be cleaned up by the orchestrator once,
using the same safety checks as assignee cleanup below; this is not a routine duty.

## Implementing node: create your own isolated worktree

Your session cwd is normally a repository's shared main checkout, there so repository
instructions and Skills load. Treat it as read-only: fetching is fine, but never edit,
switch, pull into, reset or stash it, and never touch another worker's worktree.
Tools default to the session cwd, so after creating your worktree direct every edit,
build, test and Git command at worktree paths explicitly.

New checkouts do not inherit untracked or ignored local environment files. Follow
the project guide to prepare this worktree; another runnable worktree does not prove readiness.

Before editing repository files, reuse or create the Issue describing goal, scope and
completion conditions, then create a dedicated branch and isolated worktree from
freshly fetched remote mainline. Reuse an existing environment only after verifying it
is yours for this result, with a sound base. When using a Task, record the Issue in
`references` and the branch and worktree path in `metadata`; this is the Task-facing
record, not a separate ledger. For several repositories, do the same for each and
record every Issue, branch and path.

If the same result needs changes not covered by the agreed scope, including in other
code or repositories, ask the user directly before editing, not the orchestrator; scope is the
user's decision. Once authorized, keep any assigned Task current and set up that
repository's Issue, branch and worktree the same way.
Unrelated work stays outside this agreement; do not make drive-by changes.

## Implementing node: deliver through the authorized boundary

Only after selecting authorized same-delivery rework and legally reopening the done Task,
default to reusing the retained worktree and branch when they still exist, even after its
previous PR merged. Reusing a session for a new goal instead follows the new-work setup above.
Verify path, repository/project, branch, retained work and ownership/no conflicting worker;
metadata is not ownership proof, and unrelated transcripts must not be scanned.
If your worktree was already removed after merge, create a fresh branch and worktree from freshly fetched mainline as above. Repurposed or conflicting worktrees require explicit resolution with the user, never taking over or switching another worker's checkout. Reopen itself creates no workspace. Preserve the same eligible Task and responsibility, without replacement, redispatch, self-prompt, orchestrator messages or subscription renewal.
Safely fetch and merge current mainline into a retained branch as needed, preserving work;
never force-push, reset, amend prior delivered commits or discard work. After a merged PR,
create a follow-up PR linking prior results and the suitable Issue. Review, deliver within
authorization and clean up as below; rework implies no release, install, deployment, restart or migration.

Read the linked Issue and repository instructions and verify your own worktree before editing.
For Task work, read/ACK the agreement; `task_start` todo in execute before implementation.
Do not assume inherited Skill context. Reuse this Skill; synchronize at meaningful checkpoints.

Own implementation, relevant verification, independent read-only review and fixes.
Give the reviewer the complete change and requirements, not just a desired verdict.
Independent review may use an internal helper; it does not require a separate Task or session.
Resolve actionable findings and rerun affected checks; a scripted check is not an
independent code review. Keep secrets and unrelated changes out of commits.
Do not hand each stage back to the orchestrator or wait for a subscription/notice to be read.

Create or update an Issue-linked PR and add its link to your Task when present. Use closing
links only when the agreed work resolves that Issue. Keep any assigned Task current
when the agreed scope changes, rather than relying on an outdated handoff.
Handle review, CI and mainline changes within that scope. After new
commits or conflict resolution, confirm checks on the exact latest PR head, not an
earlier green run. Merge normally only within the authorized boundary and repository
protections; never bypass them. PR creation is not merge, and merge is not deployment.
If blocked, preserve the branch and report the actual blocker rather than claiming
delivery or transferring routine completion to the orchestrator.

## Implementing node: clean up after merge

After merge, clean up your own environment before reporting done. Verify merge
against the PR and target branch, including squash or rebase merges where original
commit ancestry alone cannot establish delivery. Confirm nobody still uses the
worktree: you, your subagents or other work; an idle label alone does not establish
that. Inspect for uncommitted, untracked, ignored or otherwise needed artifacts and
unmerged work, and preserve anything that must survive rather than forcing removal.
Then remove only this work's worktree and local/remote branches, except those retained
by repository policy, using normal Git worktree/branch management, not broad directory
deletion or cleanup of other sessions' resources. Never remove a session's cwd,
including the shared checkout.

If merge or use is uncertain, keep the resources and record why. When a user decision
would unblock cleanup, ask it directly, one focused question at a time; reread Task/PR
and recheck use and files before resuming, since an answer alone does not prove safety.
Limited delivery without merge keeps the branch and worktree for its next step.

Report delivery, remaining work, Issue/PR and evidence links, and the cleanup result.
Use existing worktree metadata; name retained resources and their reasons without repeating
the execution history. For an assigned Task, record that outcome and report done against the
latest acknowledged agreement with explicit retro text or null, including on reopened delivery.
Do not manually message the orchestrator, directly or through subagents, even if notification
delivery fails. Task done means the complete agreed result, including separately
authorized non-coding work in mixed delivery, not code merge alone, resource cleanup
or an idle native session.
