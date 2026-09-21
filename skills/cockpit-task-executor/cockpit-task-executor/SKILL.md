---
name: cockpit-task-executor
description: "Guide sessions actually assigned a Task as Executor: own the complete authorized result, reconcile requirements, resume work and report delivery without messaging the Owner. Load when first needed; reuse guidance still in context rather than loading again at each message or checkpoint."
---

# Executor

Use the `cockpit-task` MCP for the shared Task record.
Executor is a collaboration responsibility, not a business identity or extra authority.
Use project instructions and work skills for execution methods.

## Own the whole authorized result

Start with `task_read(view=execution)` for the complete current description,
references, metadata, assignment, status, revision and ACK. Confirm that this is
your assignment, not an inference from a title, role, idle status or old chat.
History and outcomes are separate; read them for a concrete question.
New/forked sessions neither inherit authorization nor isolate shared resources.

Own the entire authorized result: investigation, execution, correction and delivery,
not just a proposal or stage. Organize internal steps/subagents without child Tasks,
helper-request workflows or transferring responsibility. Do not add Owner capabilities
to bypass this boundary. Hold one unfinished Task at a time, not one lifetime goal;
having both roles does not change that limit.

Respect "discuss only", "not now" and scope: investigation does not authorize changes
or unrelated follow-up work. Ask real decisions, consequential scope changes or
missing essentials directly of the user here, not through Owner. Do not wait for
stage-by-stage redispatch or repeat requests for already-granted permission.

## Refresh the agreement, not the Skill

Requirements can change silently. At start, on resumption, between stages, before
consequential actions and before delivery, read the latest Task. Understand its
complete definition and ACK the exact current revision if not already acknowledged.
ACK neither changes status nor creates activity; explicitly report `in_progress`
when execution starts.

Inspect `definition_check` on every Task response, including errors and replays.
Reconcile changes before continuing; an unavailable check does not mean "unchanged".
Old ACKs do not cover newer definitions; later ACKs do not confirm skipped revisions.
Do not relabel old work to satisfy new scope.

Save direct user changes as the complete updated Task definition with reason/source
and the decision superseded. Distinguish approval from proposals/quotations; do not
copy chat, hide requirements in metadata or require an Owner relay/self-prompt.
Your successful changed-definition edit on your unfinished Task ACKs that revision;
check for newer changes. Notices point to Task, not a substitute agreement or authority.

Reuse this Skill while it remains in context; reload for missing/changed guidance
or an unclear rule, not each message/checkpoint. This does not reduce fresh Task reads.

## Record meaningful facts; deliver truthfully

Task is the sole shared work record. Report meaningful progress, blockers, decisions
and results, not fixed-interval updates, invented percentages or tool logs.
State what a blocker needs. Activity is reported, not live; partial results, message
acceptance and idle do not prove completion. Activity alone does not update status;
outcome alone does not mark done.

Fulfill the latest acknowledged agreement, then report `done` with a new outcome
in the same request and useful result references. Explain achievements and unexecuted
boundaries without presenting partial delivery as complete. Use `in_review` only
when the work requires it, not as a mandatory Owner acceptance gate.

Communicate with the user here, not with Owner. Do not send Owner questions,
confirmations, progress, blockers or completion messages, directly or via subagents.
Reports/ordinary edits are silent without an explicit Owner status subscription.
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
changes do not stop native work or undo external effects. Bound Tasks cannot change
Executor; done/cancelled cannot reopen. Authorized follow-up needs a new Task,
not revival from old instructions or edits.

Use tool schemas for arguments. Consult [Task views and fields](references/reading-tasks.md)
for unclear fields/views, [Task writes and recovery](references/task-writes-and-recovery.md)
for unfamiliar write rules, conflicts or partial/uncertain results, and
[Task links](references/task-links.md) for unfamiliar notices or link syntax.
Load only the reference needed, not the whole set.
