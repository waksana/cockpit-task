# Task links and notices

Read this for unfamiliar Task link syntax or assignment, definition or status notices; reuse the
format once understood rather than reloading it for every link.
This is about `task:` URLs in messages, not the Task's materials `references` field
or choosing a `task_read` view.

| Purpose | Exact form |
| --- | --- |
| Ordinary reference | `[Task](task:<uuid>)` |
| Initial assignment to the assignee, sent by `task_assign` | `[Task assigned](task:<uuid>?event=assigned)` |
| Service-sent important-update notice to the assignee (`task_edit` `notify_assignee`) | `[Task updated](task:<uuid>?event=updated)` |
| System notice to the Task's orchestrator after an explicit status subscription matches | `[Subtask status changed](task:<uuid>?event=status_changed)` |
| System notice to a dependent Task's orchestrator when its last `blocked_by` Task becomes done | `[Subtask ready](task:<uuid>?event=ready)` |
| System notice to a dependent Task's orchestrator when one of its `blocked_by` Tasks is cancelled | `[Subtask blocker cancelled](task:<uuid>?event=blocker_cancelled)` |
| System notice to a Subtask's orchestrator (the parent Task's assignee) when the Subtask becomes done | `[Subtask done](task:<uuid>?event=child_done)` |
| Same, when the Subtask becomes blocked | `[Subtask blocked](task:<uuid>?event=child_blocked)` |
| Same, when the Subtask is cancelled | `[Subtask cancelled](task:<uuid>?event=child_cancelled)` |

Labels name the relation, not a role or pronoun: `Task …` is about the Task you are doing,
`Subtask …` is about a Task you orchestrate. Older labels mean the same event: for example
`[Task assigned to you](task:<uuid>?event=assigned)`, `[As Executor: Task assigned to you](task:<uuid>?event=assigned)`
or `[As Owner: child Task done](task:<uuid>?event=child_done)`. The event value, not the label, decides.

Replace `<uuid>` with the actual Task ID. Tool inputs take only that UUID, not the
whole URI or its query. Do not copy the Task description into a dispatch message
or send a second assignment after `task_assign`.

For `assigned` or `updated`, as the assignee, read full current `execution`, confirm assignment and valid
execution state, and ACK its exact current revision if not already acknowledged.
A delayed or duplicated notice does not authorize restarting a terminal Task or
taking over someone else's assignment. The notice identifies why it was sent,
not a snapshot of requirements. Old dispatch instructions and preserved-message
summaries do not override the current agreement.
Explicit user-authorized original-assignee `task_reopen` is a separate guarded
operation, never an effect or authorization inferred from a notice. It sends no
new assigned/updated/status_changed card and does not renew ended subscriptions.

`status_changed` is a separate system card for the orchestrator's one-shot subscription,
not an assignee instruction or a request to ACK a notification. It is distinct from
`updated`, which asks the assignee to read and ACK the current definition.
The orchestrator selects only the latest content needed for the authorized follow-up, in one
bounded overview call where possible: `include=["outcome"]` for delivery evidence,
`["activity","outcome"]` only if diagnosis needs both, or `["context"]` for status.
See [selective reads](reading-tasks.md#select-the-latest-content-for-the-decision);
there is no universal read bundle. Receiving the card does not establish complete
delivery or authorize automatic resubscription, acceptance, polling or manual
assignee messages to the orchestrator. A blocked assignee's user question is not an orchestrator relay.

`child_done`, `child_blocked` and `child_cancelled` point to the Subtask and go to its
orchestrator, who is doing the parent Task. They are sent once per such transition while the
parent is unfinished, without a subscription; a waiting explicit subscription that matches
the same transition replaces the card rather than duplicating it. Read the Subtask's outcome,
blocker or cancellation with one bounded overview, integrate it into your own Task, and
decide the next step for the parent; the card is not an ACK request or proof of delivery.
See [Subtasks of your Task](task-writes-and-recovery.md#subtasks-of-your-task).

`ready` and `blocker_cancelled` are system cards for the dependent Task's orchestrator.
They point to the dependent, not the blocker; nothing was assigned or started.
The orchestrator reads the dependent, reassesses and decides whether to dispatch or revise it.
See [Task dependencies](task-writes-and-recovery.md#task-dependencies-blocked_by).

Only lowercase `assigned`, `updated`, `status_changed`, `ready`, `blocker_cancelled`, `child_done`, `child_blocked` and `child_cancelled` are supported event values. Event metadata
belongs to the message/reference, not a Task status, type or action to execute.
Generic and older references remain valid. Do not infer events from link labels
or current Task status. Malformed or unknown queries are not alternative commands
and must not be stripped into a seemingly valid generic reference.

Use the `task:` scheme, not relative `task/<id>` paths that may be treated as files.
A link alone neither creates a subscription nor authorizes editing or scheduling.
Unsubscribed ordinary activity and edits remain silent; only the explicitly
registered one-shot status subscription, declared `blocked_by` dependencies and
recorded Subtask lineage authorize their system notices.
