# Task links and notices

Read this for unfamiliar Task link syntax or assignment, definition or status notices; reuse the
format once understood rather than reloading it for every link.
This is about `task:` URLs in messages, not the Task's materials `references` field
or choosing a `task_read` view.

| Purpose | Exact form |
| --- | --- |
| Ordinary reference | `[Task](task:<uuid>)` |
| Initial assignment to Executor, sent by `task_assign` | `[Task assigned to you](task:<uuid>?event=assigned)` |
| Owner's important-definition-update notice to Executor | `[Task updated](task:<uuid>?event=updated)` |
| System notice to Task's Owner after an explicit status subscription matches | `[Task status updated](task:<uuid>?event=status_changed)` |
| System notice to a dependent Task's Owner when its last `blocked_by` Task becomes done | `[Task ready](task:<uuid>?event=ready)` |
| System notice to a dependent Task's Owner when one of its `blocked_by` Tasks is cancelled | `[Task blocker cancelled](task:<uuid>?event=blocker_cancelled)` |

Replace `<uuid>` with the actual Task ID. Tool inputs take only that UUID, not the
whole URI or its query. Do not copy the Task description into a dispatch message
or send a second assignment after `task_assign`.

For `assigned` or `updated`, as the assigned Executor, read full current `execution`, confirm assignment and valid
execution state, and ACK its exact current revision if not already acknowledged.
A delayed or duplicated notice does not authorize restarting a terminal Task or
taking over someone else's assignment. The notice identifies why it was sent,
not a snapshot of requirements. Old dispatch instructions and preserved-message
summaries do not override the current agreement.
Explicit user-authorized original-Executor `task_reopen` is a separate guarded
operation, never an effect or authorization inferred from a notice. It sends no
new assigned/updated/status_changed card and does not renew ended subscriptions.

`status_changed` is a separate system card for the Owner's one-shot subscription,
not an Executor instruction or a request to ACK a notification. It is distinct from
`updated`, which asks Executor to read and ACK the current definition.
Owner selects only the latest content needed for the authorized follow-up, in one
bounded overview call where possible: `include=["outcome"]` for delivery evidence,
`["activity","outcome"]` only if diagnosis needs both, or `["context"]` for status.
See [selective reads](reading-tasks.md#select-the-latest-content-for-the-decision);
there is no universal read bundle. Receiving the card does not establish complete
delivery or authorize automatic resubscription, acceptance, polling or manual
Executor messages to Owner. A blocked Executor's user question is not an Owner relay.

`ready` and `blocker_cancelled` are system cards for the dependent Task's Owner.
They point to the dependent, not the blocker; nothing was assigned or started.
Owner reads the dependent, reassesses and decides whether to dispatch or revise it.
See [Task dependencies](task-writes-and-recovery.md#task-dependencies-blocked_by).

Only lowercase `assigned`, `updated`, `status_changed`, `ready` and `blocker_cancelled` are supported event values. Event metadata
belongs to the message/reference, not a Task status, type or action to execute.
Generic and older references remain valid. Do not infer events from link labels
or current Task status. Malformed or unknown queries are not alternative commands
and must not be stripped into a seemingly valid generic reference.

Use the `task:` scheme, not relative `task/<id>` paths that may be treated as files.
A link alone neither creates a subscription nor authorizes editing or scheduling.
Unsubscribed ordinary activity and edits remain silent; only the explicitly
registered one-shot status subscription and declared `blocked_by` dependencies
authorize their system notices.
