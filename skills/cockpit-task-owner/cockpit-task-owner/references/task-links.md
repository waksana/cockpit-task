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

Replace `<uuid>` with the actual Task ID. Tool inputs take only that UUID, not the
whole URI or its query. Do not copy the Task description into a dispatch message
or send a second assignment after `task_assign`.

For `assigned` or `updated`, as the assigned Executor, read the current Task, confirm assignment and valid
execution state, and ACK its exact current revision if not already acknowledged.
A delayed or duplicated notice does not authorize restarting a terminal Task or
taking over someone else's assignment. The notice identifies why it was sent,
not a snapshot of requirements. Old dispatch instructions and preserved-message
summaries do not override the current agreement.

`status_changed` is a separate system card for the Owner's one-shot subscription,
not an Executor instruction or a request to ACK a notification. It is distinct from
`updated`, which asks Executor to read and ACK the current definition.
Owner reads the latest Task and relevant outcome before deciding any follow-up;
receiving the card does not establish complete delivery. It does not authorize
automatic resubscription, polling or manual Executor messages to Owner.

Only lowercase `assigned`, `updated` and `status_changed` are supported event values. Event metadata
belongs to the message/reference, not a Task status, type or action to execute.
Generic and older references remain valid. Do not infer events from link labels
or current Task status. Malformed or unknown queries are not alternative commands
and must not be stripped into a seemingly valid generic reference.

Use the `task:` scheme, not relative `task/<id>` paths that may be treated as files.
A link alone neither creates a subscription nor authorizes editing or scheduling.
Unsubscribed ordinary activity and edits remain silent; only the explicitly
registered one-shot status subscription authorizes its system notice.
