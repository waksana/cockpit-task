# Exceptional important-update handoff

Owner only: read this when an important requirement change cannot wait for the
Executor's normal checkpoints. Ordinary edits, delayed ACKs and routine progress
do not trigger this procedure. This is an explicit judgment, not a background loop.
The system's `status_changed` subscription notice to Owner is separate: receiving
it does not trigger this Executor-directed `updated` handoff or queue intervention.

## Preserve before changing the queue

Save the complete updated requirements in Task first. Before touching pending
messages, use public native state to understand actual work, questions and subagents.
An idle label or an interrupt receipt alone does not prove the session can proceed.
Use the host's published schemas for the available operations, not a guessed
helper, private endpoint or retired automatic queue-advance operation.

Preserve all exposed pending message IDs and their complete available content
before removing anything, not just queue previews or a lossy early summary.
Include other-session and subagent messages; retain sources, unresolved requests
and useful references. Display text is not a lossless attachment backup.
If content cannot be adequately read and preserved, leave it pending and explain
the blocker rather than delete it.

## Intervene once, only if needed

Remove only the saved message IDs. Check what actually remained pending: a missing
item may already have started. Handle concurrent arrivals separately; a snapshot
does not lock the queue. Do not replay consumed messages as new instructions.

If necessary, interrupt the main turn once using the queue-preserving public
operation. Do not use Stop / `cockpit_cancel_turn` as a cleanup shortcut, since it
can discard unread concurrent messages. Do not repeatedly interrupt or silently
cancel background work. Wait or resolve a real blocker instead of forcing a send.
If the available host operation cannot preserve the queue, do not substitute a
destructive stop. Capability readiness, main-turn status and background work are
different facts.

## Send one context-preserving notice

Recheck that Task is active and still assigned to the same Executor. Send one
message when native state permits it, containing the preserved-context summary
followed by:

```text
[Task updated](task:<uuid>?event=updated)
Read the current Task and acknowledge its latest revision before continuing.
```

Use the real Task UUID. Omit the summary only if there was no pending context.
The summary is supporting context, not a replacement definition or authorization
for quoted proposals or subagent instructions. Put actual requirement changes in
Task; do not duplicate its full description in the notice.

Do not send the original messages individually or duplicate the Task notice.
Removal and sending are not atomic. If sending is queued or unconfirmed, inspect
the result and current state rather than resend or create a replacement session.
Keep the preserved context available if the handoff cannot complete; report the
partial effect truthfully. Current-revision ACK, not acceptance, confirms alignment
when next read. It does not invite a polling loop, a second interruption, reminders
or an Executor-to-Owner acknowledgement message.
