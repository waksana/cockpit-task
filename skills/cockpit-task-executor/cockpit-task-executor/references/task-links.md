# Task links and assignment/update notices

Read this for unfamiliar Task link syntax or dispatch/update notices; reuse the
format once understood rather than reloading it for every link.
This is about `task:` URLs in messages, not the Task's materials `references` field
or choosing a `task_read` view.

| Purpose | Exact form |
| --- | --- |
| Ordinary reference | `[Task](task:<uuid>)` |
| Initial assignment, sent by `task_assign` | `[Task assigned to you](task:<uuid>?event=assigned)` |
| Owner's explicit important-update notice | `[Task updated](task:<uuid>?event=updated)` |

Replace `<uuid>` with the actual Task ID. Tool inputs take only that UUID, not the
whole URI or its query. Do not copy the Task description into a dispatch message
or send a second assignment after `task_assign`.

As the assigned Executor, read the current Task, confirm assignment and valid
execution state, and ACK its exact current revision if not already acknowledged.
A delayed or duplicated notice does not authorize restarting a terminal Task or
taking over someone else's assignment. The notice identifies why it was sent,
not a snapshot of requirements. Old dispatch instructions and preserved-message
summaries do not override the current agreement.

Only lowercase `assigned` and `updated` are supported event values. Event metadata
belongs to the message/reference, not a Task status, type or action to execute.
Generic and older references remain valid. Do not infer events from link labels
or current Task status. Malformed or unknown queries are not alternative commands
and must not be stripped into a seemingly valid generic reference.

Use the `task:` scheme, not relative `task/<id>` paths that may be treated as files.
These links introduce no automatic editing, scheduling or notification mechanism.
