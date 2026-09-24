# Task links and notices

Read this for unfamiliar Task link syntax or assignment, definition or status notices; reuse the
format once understood rather than reloading it for every link.
This is about `task:` URLs in messages, not the Task's materials `references` field
or choosing a `task_read` view.

| Purpose | Exact form |
| --- | --- |
| Ordinary reference | `[Task](task:<uuid>)` |
| Initial assignment to Executor, sent by `task_assign` | `[As Executor: Task assigned to you](task:<uuid>?event=assigned)` |
| Owner's important-definition-update notice to Executor | `[As Executor: Task updated](task:<uuid>?event=updated)` |
| System notice to Task's Owner after an explicit status subscription matches | `[As Owner: Task status updated](task:<uuid>?event=status_changed)` |
| System notice to a dependent Task's Owner when its last `blocked_by` Task becomes done | `[As Owner: Task ready](task:<uuid>?event=ready)` |
| System notice to a dependent Task's Owner when one of its `blocked_by` Tasks is cancelled | `[As Owner: Task blocker cancelled](task:<uuid>?event=blocker_cancelled)` |
| System notice to a child Task's Owner (the parent Task's Executor) when the child becomes done | `[As Owner: child Task done](task:<uuid>?event=child_done)` |
| Same, when the child becomes blocked | `[As Owner: child Task blocked](task:<uuid>?event=child_blocked)` |
| Same, when the child is cancelled | `[As Owner: child Task cancelled](task:<uuid>?event=child_cancelled)` |

The label prefix names your role for the linked Task. Labels written before this prefix
(for example `[Task assigned to you](task:<uuid>?event=assigned)`) mean the same event.

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

`child_done`, `child_blocked` and `child_cancelled` point to the child Task and go to its
Owner, who is executing the parent Task. They are sent once per such transition while the
parent is unfinished, without a subscription; a waiting explicit subscription that matches
the same transition replaces the card rather than duplicating it. Read the child's outcome,
blocker or cancellation with one bounded overview, integrate it into your own Task, and
decide the next step for the parent; the card is not an ACK request or proof of delivery.
See [delegating child Tasks](task-writes-and-recovery.md#delegating-child-tasks).

`ready` and `blocker_cancelled` are system cards for the dependent Task's Owner.
They point to the dependent, not the blocker; nothing was assigned or started.
Owner reads the dependent, reassesses and decides whether to dispatch or revise it.
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
recorded child-Task lineage authorize their system notices.
