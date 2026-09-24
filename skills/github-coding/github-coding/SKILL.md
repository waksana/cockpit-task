---
name: github-coding
description: "Use when authorized work requires changing version-controlled repository files: the orchestrator states requirements and any existing Issue; the assignee reuses or creates the Issue, creates its own branch and worktree from fresh mainline, delivers through the authorized review/merge boundary and safely cleans up after merge. Not triggered by GitHub mentions or deployment using existing artifacts alone. Keep Git isolation without GitHub; reuse guidance already in context."
---

# GitHub coding

This is a work Skill, not a Task role or authority to change scope. Task guidance
still governs assignment, current-definition reads/ACK, reporting and communication.
Follow repository instructions for implementation methods and branch policy.
Here, "main" means the repository's agreed target mainline, not a required branch name.

## Agree on the result before creating work

Apply this Skill to changes intended for commit to version-controlled repository
files, not mentions of GitHub, main, Releases or deployment. Installing existing
verified artifacts, configuring the runtime and safely restarting use Task without
this Skill requiring an Issue, PR, branch or worktree. Existing project policies
and reliability requirements, including immutable installation directories, still apply.
Runtime configuration is distinct from repository changes: version bumps, build
configuration, code and repository documentation intended for commit follow this flow.
Mixed delivery stays one complete Task; Issue/PR scope covers only necessary repository
changes, not an extra umbrella deployment Issue or separate stage Tasks.

Distinguish discussion, investigation and authorized implementation. Questions and
idea exploration do not require an Issue, Task or worktree. For coding delivery,
confirm the repository, intended result and completion boundary. A full delivery
normally includes merge; investigation-only, patch-only or PR-only authorization
stops at that boundary. Ask about real ambiguity, not a second start command.

Use an existing suitable Issue or work environment rather than duplicating it.
For Git repositories not hosted on GitHub, keep the isolation, delivery and cleanup
principles, skipping inapplicable Issue/PR steps. Non-coding work is unaffected.
Release/tag creation, installation, deployment, restart and data migration are not
default coding stages and require separate authorization. That authorization and
this Skill's applicability are separate questions; neither changes the orchestrator's default
delegation responsibility.

## Orchestrator: state the requirements, then delegate

The orchestrator states what should change, which repository or repositories are involved and
the delivery boundary, and references an existing suitable Issue when there is one.
The orchestrator does not prepare or clean up branches or worktrees; setting up and releasing
the work environment is always the assignee's job. The orchestrator's Issue references are
coordination, not permission to implement the code personally or through the orchestrator's
subagents. Do not speculate about repository changes just to create a deployment Task.

Create one Task for the complete result, including development, validation, review
and authorized merge. Its description is the complete current execution agreement,
not just "see Issue." Use existing `references` for Issue/PR and repository material,
optional `metadata` for repository and target branch, and `outcome.references` for
final evidence. Do not hide requirements in metadata.
GitHub holds review and repository facts; Task holds the agreement and meaningful
work facts. Link them rather than mirroring every comment or log.

Environment cleanup is not a reason to wait for or wake the orchestrator. Default to no subscription.
Only if a future status unlocks specific necessary authorized orchestrator work, register
the smallest one-shot subscription before assignment to avoid a fast-completion race.
Completion confirmation or repeated reporting is not that work. Follow the existing
subscription guidance without polling, automatic renewal or a new script/timer.

Worktrees the orchestrator prepared before this workflow may be cleaned up by the orchestrator once,
using the same safety checks as assignee cleanup below; this is not a routine duty.

## Assignee: create your own isolated worktree

Your session cwd is normally a repository's shared main checkout, there so repository
instructions and Skills load. Treat it as read-only: fetching is fine, but never edit,
switch, pull into, reset or stash it, and never touch another worker's worktree.
Tools default to the session cwd, so after creating your worktree direct every edit,
build, test and Git command at worktree paths explicitly.

Before editing repository files, reuse or create the Issue describing goal, scope and
completion conditions, then create a dedicated branch and isolated worktree from
freshly fetched remote mainline. Reuse an existing environment only after verifying it
is yours for this result, with a sound base. Promptly record the Issue in Task
`references` and the branch and worktree path in `metadata`; this is the Task-facing
record, not a separate ledger. For several repositories, do the same for each and
record every Issue, branch and path.

If the same result needs changes not covered by the agreed scope, including in other
code or repositories, ask the user directly before editing, not the orchestrator; scope is the
user's decision. Once authorized, keep the Task description current and set up that
repository's Issue, branch and worktree the same way.
Unrelated changes need a separate Task, not a drive-by fix.

## Assignee: deliver through the authorized boundary

When your done Task is reopened with explicit authorization (by you or its orchestrator), default to reusing the retained worktree and branch when they still exist, even after its previous PR merged. Verify actual path, repository/project, branch, retained work and ownership/no conflicting worker; metadata is not ownership proof, and unrelated transcripts must not be scanned.
If your worktree was already removed after merge, create a fresh branch and worktree from freshly fetched mainline as above. Repurposed or conflicting worktrees require explicit resolution with the user, never taking over or switching another worker's checkout. Reopen itself creates no workspace. Preserve the same eligible Task and responsibility, without replacement, redispatch, self-prompt, orchestrator messages or subscription renewal.
Safely fetch and normally merge current mainline into a retained branch as needed, preserving work and resolving conflicts; never force-push, reset, amend prior delivered commits or discard work. After a merged PR, create a new follow-up PR linking prior results and the suitable Issue.
Independently review the complete follow-up and normally merge only within authorization. Source-only stays source-only: no release, install, deployment, restart or data migration is implied. Clean up again afterwards.

Read the latest Task, linked Issue and repository instructions; confirm and ACK
the current agreement and verify your own worktree before editing. Do not
assume you inherited the orchestrator's Skill context. Read this Skill when first needed,
then reuse it while available. Continue Task synchronization at meaningful checkpoints.

Own implementation, relevant verification, independent read-only review and fixes.
Give the reviewer the complete change and requirements, not just a desired verdict.
Resolve actionable findings and rerun affected checks; a scripted check is not an
independent code review. Keep secrets and unrelated changes out of commits.
Do not hand each stage back to the orchestrator or wait for a subscription/notice to be read.

Create or update an Issue-linked PR and promptly add its link to Task. Use closing
links only when the agreed work resolves that Issue. Reconcile important scope
changes into Task rather than relying on chat or an outdated handoff.
Handle review, CI and mainline changes yourself within the assignment. After new
commits or conflict resolution, confirm checks on the exact latest PR head, not an
earlier green run. Merge normally only within the authorized boundary and repository
protections; never bypass them. PR creation is not merge, and merge is not deployment.
If blocked, preserve the branch and report the actual blocker rather than claiming
delivery or transferring routine completion to the orchestrator.

## Assignee: clean up after merge

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

Record an outcome with Issue/PR links, the actual merge or limited-delivery result,
useful evidence, every PR/branch/worktree path and the cleanup result: what was removed,
and anything kept with its reason, outstanding users and artifacts to preserve.
Report done against the latest acknowledged agreement with that new outcome and explicit retro text or null, including on every reopened delivery.
Do not manually message the orchestrator, directly or through subagents, even if notification
delivery fails. Task done means the complete agreed result, including separately
authorized non-coding work in mixed delivery, not code merge alone, resource cleanup
or an idle native session.
