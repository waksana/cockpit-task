# Task views, fields and pagination

Read this when view selection, a returned field or a truncated excerpt needs
explanation. Familiar reads do not require reloading it. These are the implemented
`task_read` projections, not a new Owner-specific API or a proposed fields engine.

## Owner's default view

For an overview of your work, use `view=list` with `owner` set to your session ID.
For one Task, use `view=overview` with its `task_id`.
Include your own `actor_session_id` on reads. This is reported attribution and
definition-reminder context; it is not authentication or an automatic owner filter.

The single-Task overview contains:

| Fields | Meaning |
| --- | --- |
| `id`, `task_id`, `title` | Identity and human-readable work title |
| `owner`, `executor`, `status` | Coordination responsibility, assigned session or null, and declared lifecycle state |
| `revision`, `acknowledged_revision` | Current definition versus actual Executor confirmation; null means no ACK |
| `activity` | Latest activity or null, including its ID, revision, Executor, author, time and reported source |
| `activity.text`, `activity.truncated` | Up to 320 characters of that actual activity, not a generated summary; expand activity if truncated and relevant |
| `outcome` | `{available:false}` or latest outcome ID, revision, time, `available:true` and `current` |
| `created_at`, `updated_at` | Task record timestamps, not proof of live session activity |
| `write_context` | Opaque concurrency context for later writes, not business progress |
| `cancellation` | Reason, author and time when cancelled; single overview only |

List items use the same compact projection without the cancellation detail.
Neither view includes `description`, `references`, `metadata`, full outcome text,
all activities or the definition history. List pagination does not expand every
Task into its execution view.

An ACK gap means requirements have not been confirmed, not that the session is
currently reading, stuck or idle. `outcome.current` only compares its revision
with the current definition. An available/current outcome can still be partial;
combine its actual text with Task status and requirements before claiming delivery.

## Expand for a specific question

| Need | View |
| --- | --- |
| Current full agreement before editing | `definition` |
| Assigned work before execution or at a synchronization checkpoint | `execution` |
| Exact recent progress or an excerpt's full text | `activity` |
| Actual result text and result references | `outcomes` |
| Why requirements changed | `changelog` |
| Complete text of one past definition | `changelog` with `revision` |
| Whether a failed or uncertain request had an effect | `operation` with `request_id` |
| Records for an explicit one-shot status subscription | `subscriptions` with `task_id` |

`definition` and `execution` currently return the same complete Task projection:
identity, responsibility, status, revisions, timestamps, write context, description,
references and metadata. They do not bundle activity, outcomes or history.

`changelog` pages contain revision, reason, author, time and
`description_available` / `description_length`, not generated change summaries
or the definition itself. Selecting a specific revision retrieves its full text.
`outcomes` and `activity` are separate paginated histories, not session transcripts.
Read the next page only if needed, using the returned cursor unchanged with the
same view, Task and filters.

Use `task_read(view=subscriptions)` only for a concrete subscription question.
Follow its schema and returned pagination cursor; do not poll while waiting.
A subscription/delivery record is not proof the Owner read a notice or the Task
is now complete. Re-read current Task state and actual outcomes to assess delivery.
See [subscription handling](task-writes-and-recovery.md#one-shot-status-subscriptions)
for the one-shot lifecycle and uncertain effects.

List defaults to 20 items, maximum 50, with `status=unfinished` unless specified.
Use an explicit terminal status or `all` when the question includes finished work;
`query` searches titles only. Histories default to 5 items, maximum 10.
Both lists and histories have a 24,000-character serialized-page budget, excluding
the response envelope and definition check. A short page does not imply the end;
use `next_cursor`. History bodies are not silently truncated to fit.

A revision selector cannot be combined with a history cursor or limit. Current
full definitions and a selected past definition are not paginated; their separate
input-size limits bound the result. No view implicitly reads native chat.

For `operation`, the receipt's `status` (`pending` / `final`) is separate from
`result.operation.status`, step results and the Task's status. A finalized receipt
can still record an unknown external effect. Use
[Task writes and recovery](task-writes-and-recovery.md) if deciding whether anything may be retried.

## Projection and response boundaries

Views are fixed response projections selected by the caller. There is no arbitrary
`fields` selector and no automatic restriction based on the caller's role. Having
selected Owner does not force `overview`, and `actor_session_id` does not select
only that session's owned Tasks.

Responses handled by the Task service carry `result`, `error` and a freshly computed
`definition_check`, including failed operations and replays. Transport/schema
rejection before service handling does not establish that a check occurred.
Compact data does not remove consistency reminders or failures.

The check covers the identified Task and, when applicable, the actor's current
unfinished assigned Task, not all owned Tasks. `checked` reports that checkpoint;
`unavailable` means the check failed, not "no updates". `not_applicable` applies only
when there is no relevant Task. It is neither a role-readiness result nor proof
against later revisions, and never substitutes for reading and ACK.
