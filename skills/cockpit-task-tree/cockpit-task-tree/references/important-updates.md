# Exceptional important-update handoff

Owner only: read this when an important requirement change cannot wait for the
Executor's normal checkpoints. Ordinary edits, delayed ACKs and routine progress
do not trigger this procedure. This is an explicit judgment, not a background loop.
The system's `status_changed` subscription notice to Owner is separate: receiving
it does not trigger this Executor-directed `updated` handoff.

Save the complete updated requirements in Task first. Freshly read Task context to
confirm it is unfinished, still assigned to the same Executor, and its latest
revision is not already ACKed. If already aligned, do not send a redundant notice.
Inspect public native state only as needed for the correct target and delivery
conditions. A pending ask, plan or elicitation requires its native response;
`immediate` cannot answer it or bypass that decision.

Use the existing public `cockpit_send_prompt` once, targeting that Executor's
session ID with `mode:"immediate"`. During a running native turn, this interjects
into the current turn; it does not start a fresh turn or require an interruption.
Replace both placeholders with the actual IDs:

```json
{
  "session_id": "<executor-session-id>",
  "mode": "immediate",
  "text": "[As Executor: Task updated](task:<uuid>?event=updated)\nRead the full current Task execution view and ACK its exact latest revision before continuing affected work."
}
```

The message is only a notice/reference; Task remains the agreement authority.
Do not duplicate its full requirements. `task_edit` remains silent and does not
send this notice automatically.

Leave queued user and subagent messages intact: do not copy, remove or replay them.
Do not stop or interrupt the main turn or background work merely to notify.
An explicit user stop/cancel or other authorized interruption is separate from
this handoff; `immediate` is not a substitute for stopping work.

Acceptance is not consumption or ACK. On failure or an unconfirmed result, use
bounded inspection of the receipt and relevant current state and report uncertainty
truthfully. No blind retry, duplicate prompt, replacement session, subscription,
polling or automatic escalation to interruption. Current-revision ACK confirms
alignment when next read; do not request an Executor-to-Owner acknowledgement message.
