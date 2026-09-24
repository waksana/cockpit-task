# Exceptional important-update notice

Orchestrator only: read this when an important requirement change to a Subtask cannot wait
for its assignee's normal checkpoints, including a new coordination order after a conflict
check. Ordinary edits, delayed ACKs and routine progress do not trigger this notice. This is
an explicit judgment, not a background loop. The system's `status_changed` subscription
notice to the orchestrator is separate: receiving it does not trigger this assignee-directed
`updated` notice.

Put every explanation in the Task definition. Never add explanations, change summaries or
instructions through chat, and never relay the user's instructions to the assignee: a second
channel can drift from the Task and loses its record. The notice only points at the Task.

Freshly read Task context and confirm it is an unfinished Agent Task still assigned to the
same assignee. Then save the complete updated requirements with one `task_edit` that changes
the description and sets `notify_assignee: true`. The service sends the assignee, in
`immediate` mode, only the fixed card and fixed instruction:

```text
[Task updated](task:<uuid>?event=updated)
Read the full current Task execution view and ACK its exact latest revision before continuing affected work.
```

There is no free-text field. If the current definition already holds the change and no real
definition edit is needed, send no notice: the assignee aligns at its next checkpoint. The service rejects `notify_assignee` with
`UPDATE_NOTICE_NOT_APPLICABLE`, saving nothing, when the Task is unassigned, finished,
automation, the description does not change, or the assignee would notify itself. Without the
parameter `task_edit` stays silent. Never send the card yourself with `cockpit_send_prompt`
or any other message.

The card is only a reference; Task remains the agreement authority. `immediate` interjects
into a running native turn; it does not start a fresh turn, answer a pending ask, plan or
elicitation, or replace an authorized stop or cancel. Leave queued user and subagent messages
intact, and do not stop or interrupt the assignee's work merely to notify.

Inspect `notifications` and `notification_error` separately from the saved edit; the
`update_notices` view keeps each notice's delivery record. Acceptance is
not consumption or ACK. On failure or an unconfirmed result, report uncertainty truthfully:
no blind retry, handwritten duplicate, replacement session, subscription, polling or
automatic escalation to interruption. A notice left pending by a module restart is recorded as
`UPDATE_NOTICE_EXPIRED`, not sent later; edit again with the parameter only if the assignee
still needs it. Current-revision ACK confirms alignment when next read; do not request an
assignee-to-orchestrator acknowledgement message.
