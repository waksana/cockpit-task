# Executing: acting as Executor

Read this when a Task's `executor` is your session: your one assignment. Executor is a
collaboration responsibility, not a business identity or extra authority.
Use project instructions and work skills for execution methods.

Automation Tasks are service-managed, not Executor assignments. You may read their
`kind`, `automation` facts, outcomes and bounded `automation_log`; do not ACK or report
them. Executing a Task does not grant create/start or script registration;
only [delegating](delegating.md) guidance covers trusted automation, including as a child Task.

## Own the whole authorized result

Start with `task_read(view=execution)` for the complete current description,
references, metadata, assignment, status, revision and ACK. Confirm that this is
your assignment, not an inference from a title, role, idle status or old chat.
History and outcomes are separate; read them for a concrete question.
New/forked sessions neither inherit authorization nor isolate shared resources.
Preparation/readiness is not assignment, authorization, ACK or execution.
Skill enabled is not body loaded; load relevant Skill bodies when first needed,
without assuming inherited Owner context. MCP connected is not tool offered,
and initialized tool metadata is not final readiness.

Own the entire authorized result: investigation, execution, correction and delivery,
not just a proposal or stage. Keep working until done; that is not being non-interactive. Organize internal steps/subagents without helper-request
workflows, stage-by-stage redispatch or transferring responsibility; delegate child Tasks
only by scope, below. Hold one unfinished Task at a time, not one lifetime goal;
owning child Tasks does not change that limit: they are delegation inside this one job.

Respect "discuss only", "not now" and scope: investigation does not authorize changes
or unrelated follow-up work. Ask real decisions, consequential scope changes or
missing essentials directly of the user here, not through Owner. Do not wait for
stage-by-stage redispatch or repeat requests for already-granted permission.

## Deliver directly or delegate by scope

Roles are per Task: Executor for your assignment, Owner for child Tasks you create for it.
Deliver a coherent result directly. Split only for several independent outcomes, item-by-item
trade-off discussion with the user, or follow-up detail that would crowd your context; lean
toward delegation as load grows. Then follow [delegating](delegating.md) for each child:
more specific than your Task, never passed down unchanged, within its authorized scope.
You still own your Task: integrate and verify child outcomes before done; never implement a
child you delegated, accept your own work or fake delegation without ready delegation capability
([delegating child Tasks](task-writes-and-recovery.md#delegating-child-tasks)).
The service wakes you with one `child_done`, `child_blocked` or `child_cancelled` card per
such child transition; read that child's outcome or blocker and integrate, without polling.

## Coding work

For assigned coding work, load the separately discoverable `github-coding` work
Skill when needed; do not assume Owner's reading loaded it for you. Follow it to set up
your own isolated environment, deliver through the authorized review/PR/merge boundary
and clean up after merge; nobody prepares or cleans it for you. Ask the user, not Owner,
before scope changes. Do not wait for stage handoffs. Non-coding work keeps its own methods.

## Explicitly authorized rework after done

When the user explicitly authorizes rework of your completed Agent Task, read full
current `execution` and use `task_reopen` yourself only if eligible. Keep the same
Task, Owner and original Executor; do not ask for redispatch or self-prompt.
The service requires a tracked assignment made after schema v5 upgrade, no other
Task assigned to you since that assignment (even one now done/cancelled), and no
other unfinished Task. Pre-upgrade assignments are ineligible; timestamps, old
chat and metadata cannot establish eligibility. Busy execution of your own current
session is not an idle-gate failure, but current Executor capability must be ready.

Submit the complete new agreement and reason recording the user's decision, with
fresh revision/write_context and a stable request ID. Reopen atomically enters
`in_progress`, creates and self-ACKs a new revision even if the text is identical,
and preserves all history. Old ACKs/outcomes do not deliver the new agreement;
complete again with a new outcome and explicit retro text or null.
Ended subscriptions remain ended; do not renew them or message Owner.
For coding, follow `github-coding` on reusing a retained worktree and branch.
If eligibility fails or a retained workspace conflicts, explain the specific blocker to the user;
do not take over, reassign or bypass the checks.
Cancelled Tasks and automation never use this path; a new authorized Task is needed
when the original Task cannot validly continue.

## Refresh the agreement, not the Skill

Requirements can change silently. At start, on resumption, between stages, before
consequential actions and before delivery, read the latest Task. Understand its
complete requirements with `task_read(view=execution)` and ACK the exact current
revision if not already acknowledged. Selective overview reads never replace this
execution read or precise ACK; use them only for other focused evidence questions.
ACK neither changes status nor creates activity; explicitly report `in_progress`
when execution starts.

Inspect `definition_check` on every Task response, including errors and replays.
Reconcile changes before continuing; an unavailable check does not mean "unchanged".
Old ACKs do not cover newer definitions; later ACKs do not confirm skipped revisions.
Do not relabel old work to satisfy new scope.

Save direct user changes as the complete updated Task definition with reason/source
and the decision superseded. Distinguish approval from proposals/quotations; do not
copy chat, hide requirements in metadata or require an Owner relay/self-prompt.
When editing description, preserve the task-specific goal, scope, key decisions,
authorization boundaries, special constraints and completion conditions, not complete
prior context. Reference general Skills, repository instructions and environment
documentation as needed instead of repeating them; keep execution-critical task-specific
facts explicit and separate prior investigation from current requirements.
Your successful changed-definition edit on your unfinished Task ACKs that revision;
check for newer changes. Notices point to Task, not a substitute agreement or authority.

## Record meaningful facts; deliver truthfully

Task is the sole shared work record, not a raw evidence store. Lead activity with
meaningful new changes, findings, decisions or blockers and necessary remaining work,
not a restatement of the brief, fixed-interval updates, invented percentages or tool logs.
State what a blocker needs. Use accessible, locatable references for detailed evidence,
not "see Issue" instead of the essential agreement or an assumption of inherited context.
Keep exact values needed to support conclusions or resume safely.
Activity is reported, not live; partial results, message
acceptance and idle do not prove completion. Activity alone does not update status;
outcome alone does not mark done.

Fulfill the latest acknowledged agreement, then report `done` with a new outcome
in the same request, explicit `retro` text or `null`, and useful result references.
Omitting retro is rejected; ordinary reports omit it, and only done accepts it.
Explain achievements and unexecuted
boundaries without presenting partial delivery as complete. Lead outcome with the
delivered result, how it meets the agreement and remaining limitations, then necessary
supporting evidence. Research results may be detailed: distinguish conclusions,
reasoning and unverified points. Use `in_review` only
when the work requires it, not as a mandatory Owner acceptance gate.

After completing delivery, before done, briefly reflect on the actual work.
Keep only useful, actionable observed automation candidates, a specific slow or
repeated sticking point, or Skill/MCP discovery, contract or capability harness gaps.
Ground findings in locatable evidence such as a repeated command, failed call or
receipt; never fabricate timings or infer a bottleneck from elapsed time alone.
Distinguish observation from hypothesis and external waits from improvable work.
There is no mandatory multi-section template: write concise useful findings
(at most 2,000 characters), or submit `retro:null` when there are none, not filler.
Retro is separate from outcome and blockers; it does not authorize improvements,
scope expansion or another dispatch. Owner may read it on demand, with no required
review, new notification or completion gate. The service guarantees explicit
submission and persistence, not thoughtful reflection or the quality of the text.
Automation has no Agent retro. See the completion examples in
[Task writes and recovery](task-writes-and-recovery.md#completion-retro).

Communicate with the user here (via ask_user where available), wait for the answer, revise your
own Task if the agreement changes, and continue. Do not send Owner questions,
confirmations, progress, blockers or completion messages, directly or via subagents.
Reports/ordinary edits are silent without an explicit Owner status subscription, except
that a child Task's done/blocked/cancelled transition notifies its Owner, your parent Task's Executor.
Do not wait for Owner to subscribe or read a notice before continuing authorized
work or delivering it.
Only the system sends that one-shot notice to Task's Owner; this gives Executor
no subscription capability or permission to notify Owner. A `status_changed` card
is not an instruction to execute or ACK a notification; `updated` remains the
Executor's cue to read and ACK the current definition. Do not request reminders.
Owner reads Task. Normal user-facing replies are allowed, not a second maintained ledger.

## Preserve facts through conflicts and uncertainty

Use actual Task/session IDs, your own `actor_session_id` on reads/writes, stable
mutation request IDs and fresh returned `write_context` where required. Identity is attribution,
not authentication or a per-Task ACL. Preserve newer requirements and replay identity.
Old activity may save while stale status/outcome are rejected; inspect actual effects,
not a blanket success/failure. If reporting is unavailable, say so and preserve
evidence, without redoing external work or replacing a Task/session to bypass uncertainty.

Respect cancellation or invalid state before further consequential work. Record
changes do not stop Agent native work or undo external effects; automation cancellation
requests process-group termination, not rollback or proof of exit. Bound Agent Tasks cannot change
Executor. Cancelled Tasks cannot reopen; done Agent Tasks have only the explicit
original-Executor rework path above, never revival from old instructions, notices,
definition edits or an ordinary backwards status report.

Use tool schemas for arguments. Consult [Task views and fields](reading-tasks.md)
for unclear fields/views, [Task writes and recovery](task-writes-and-recovery.md)
for unfamiliar write rules, conflicts or partial/uncertain results, and
[Task links](task-links.md) for unfamiliar notices or link syntax.
Load only the reference needed, not the whole set.
