---
name: github-coding
description: "Use when authorized work requires changing version-controlled repository files: Owner prepares isolation and any GitHub Issue (Executor only for user-authorized emergent same-result changes), Executor delivers through the authorized review/merge boundary, and Owner safely cleans up. Not triggered by GitHub mentions or deployment using existing artifacts alone. Keep Git isolation without GitHub; reuse guidance already in context."
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
this Skill's applicability are separate questions; neither changes Owner's default
delegation responsibility.

## Owner: prepare, then delegate

Confirm the repository, branch and worktree state before changing it. Bring your
main working directory to clean, freshly fetched main without discarding anyone's
work. A dirty directory, divergence or another user's active checkout is a reason
to preserve and resolve the conflict, not to reset, stash or delete it to look clean.
Do not switch or update another worker's checkout.

From that mainline, prepare a dedicated branch and worktree for this independent
result, with the necessary environment and repository instructions available.
If a suitable environment already exists, verify its ownership, base and readiness
and reuse it. Record the actual paths; a new session alone does not isolate files.
Executor performs code operations in this worktree, not a shared mutable checkout.

For initially known GitHub repository changes, find and reuse the corresponding
Issue or create one describing their goal, scope and completion conditions, and
prepare the isolated environment **before creating and assigning Task**.
Do not speculate about repository changes just to create a deployment Task.
If changes emerge during execution that the same result needs, including in other code or repositories, Executor asks the user directly before editing, not Owner.
After the user authorizes, Executor may reuse or create the corresponding Issue and a dedicated branch and worktree from freshly fetched mainline, record them in Task references/metadata with the full requirements kept current in its description, then deliver through the flow below.
Never edit a shared checkout or another worker's worktree, or switch someone else's checkout; Owner still cleans up.
Unrelated changes need a separate Task, not a drive-by fix.
Owner's Issue maintenance and preparing/cleaning of work environments are coordination,
not permission to implement the code personally or through Owner's subagents.

Create one Task for the complete result, including development, validation, review
and authorized merge. Its description is the complete current execution agreement,
not just "see Issue." Use existing `references` for Issue/PR and repository material,
optional `metadata` for repository, target/working branches and worktree, and
`outcome.references` for final evidence. Do not hide requirements in metadata.
GitHub holds review and repository facts; Task holds the agreement and meaningful
work facts. Link them rather than mirroring every comment or log.

Identify who will clean up and record the PR, branch and worktree path as they become
known. Routine post-merge worktree cleanup may be deferred or batched; it does not
automatically require an immediate per-Task Owner wakeup. Default to no subscription.
Only if a future status unlocks specific necessary authorized Owner work, register
the smallest one-shot subscription before assignment to avoid a fast-completion race.
Completion confirmation or repeated reporting is not that work. Follow the existing
subscription guidance without polling, automatic renewal or a new script/timer.

## Executor: deliver through the authorized boundary

For explicitly authorized original-Executor `task_reopen`, default to reusing the retained worktree and branch, even after its previous PR merged. Verify actual path, repository/project, branch, retained work and ownership/no conflicting worker; metadata is not ownership proof, and unrelated transcripts must not be scanned.
Removed, repurposed or conflicting worktrees require explicit resolution with the user, not automatic workspace recreation or switching another worker's checkout. Reopen creates no workspace. Preserve the same eligible Task and responsibility, without replacement, redispatch, self-prompt, Owner messages or subscription renewal.
Safely fetch and normally merge current mainline into the retained branch as needed, preserving work and resolving conflicts; never force-push, reset, amend prior delivered commits or discard work. After a merged PR, create a new follow-up PR linking prior results and the suitable Issue.
Independently review the complete follow-up and normally merge only within authorization. Source-only stays source-only: no release, install, deployment, restart or data migration is implied. Owner retains safe cleanup responsibility.

Read the latest Task, linked Issue and repository instructions; confirm and ACK
the current agreement and verify the designated (or authorized self-prepared) worktree before editing. Do not
assume you inherited Owner's Skill context. Read this Skill when first needed,
then reuse it while available. Continue Task synchronization at meaningful checkpoints.

Own implementation, relevant verification, independent read-only review and fixes.
Give the reviewer the complete change and requirements, not just a desired verdict.
Resolve actionable findings and rerun affected checks; a scripted check is not an
independent code review. Keep secrets and unrelated changes out of commits.
Do not hand each stage back to Owner or wait for a subscription/notice to be read.

Create or update an Issue-linked PR and promptly add its link to Task. Use closing
links only when the agreed work resolves that Issue. Reconcile important scope
changes into Task rather than relying on chat or an outdated handoff.
Handle review, CI and mainline changes yourself within the assignment. After new
commits or conflict resolution, confirm checks on the exact latest PR head, not an
earlier green run. Merge normally only within the authorized boundary and repository
protections; never bypass them. PR creation is not merge, and merge is not deployment.
If blocked, preserve the branch and report the actual blocker rather than claiming
delivery or transferring routine completion to Owner.

When the agreed boundary is met, record an outcome with Issue/PR links, the actual
merge or limited-delivery result, useful evidence, every PR/branch/worktree path and
any remaining cleanup. Record explicit release evidence: which workers have stopped
using each worktree, any outstanding users and artifacts to preserve. Do not claim
release while you or subagents still use it; Executor must not delete its own cwd.
Report done against the latest acknowledged agreement with that new outcome and explicit retro text or null, including on every reopened delivery.
Do not manually message Owner, directly or through subagents, even if notification
delivery fails. Task done means the complete agreed result, including separately
authorized non-coding work in mixed delivery, not code merge alone, resource cleanup
or an idle native session.

## Owner: finish the environment cleanup

When resuming cleanup, read only necessary latest Task content (usually selected
outcome with its context) and actual Issue/PR results; a status card alone is
not evidence of merge or permission to remove files. Confirm the agreed result is
merged and the worktree is no longer used by Executor, subagents or other work.
Neither Task done nor an idle label alone establishes that. If use is uncertain,
preserve the environment and explain the remaining cleanup instead of deleting it.

If cleanup is blocked, ask the user directly in this session about the specific
blocker and the decision or condition needed to continue, using `ask_user` when
available. Ask one focused question at a time. Do not merely say you are waiting or imply you will wake automatically:
any consumed done subscription does not notify again when the environment clears.
On the user's answer or explicit continuation, reread Task/PR and recheck workspace
use and files before resuming cleanup; an answer alone does not prove it is safe.
Do not create another Task, resubscribe to done or start polling.

Inspect for uncommitted, untracked, ignored or otherwise needed artifacts and
unmerged work. Preserve anything that must survive; do not force removal to obtain
a clean result. Verify merge against the PR and target branch, including squash or
rebase merges where original commit ancestry alone cannot establish delivery.
Remove only this work's merged temporary worktree and local/remote branches, except
those retained by repository policy. Use normal Git worktree/branch management, not
broad directory deletion or cleanup of other sessions' resources.

Return your main working directory to clean, freshly fetched main, preserving any
intervening user changes rather than overwriting them. Only then call the complete
coding flow finished. Unsafe or incomplete cleanup remains explicitly outstanding.
This is Owner follow-through, not another Task, new status or mandatory acceptance
gate for Executor's delivery.
