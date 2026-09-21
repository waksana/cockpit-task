# Task implementation contract

This document defines storage, concurrency, delivery and presentation boundaries.
See the [MCP contract](task-mcp-contract.md) for input/result shapes, the
[host contract](task-host-contract.md) for integration, and the
[lifecycle replay guide](task-lifecycle-testing.md) for isolated verification.

## Module and data

The module ID and MCP server key are `cockpit-task`, display name Task, version
`0.1.3` (source preparation; no deployment implied). Its manifest is [cockpit.module.json](../cockpit.module.json).
`src/task-board/`, `web/task-board/` and the database filename `task-board.sqlite`
are current internal paths. Task runs inside Cockpit, not a standalone service.

The database lives in the host-provided module dataRoot. Task does not read
credentials, session histories, native runtime stores or other service databases.
Its HTTP API and HTTP MCP share one application service and set of business rules.

SQLite transactions protect local mutations. Separate tables hold Tasks,
description snapshots, exact revision acknowledgements, activities, outcomes,
operation receipts and subscriptions. A partial unique index limits each
Executor to one unfinished Task. Subscription uniqueness permits one waiting
subscription per Task Owner; Owner is fixed for the Task.

Schema version 2 includes subscriptions and notification evidence. Opening a v1
Task database upgrades it transactionally, preserving Task and receipt rows;
unsupported newer schema versions fail with `SCHEMA_TOO_NEW`. Service-assigned
timestamps and retained histories are not caller-authenticated evidence.

Activation requires Module API v1, the exact module identity,
`context.serviceReadyVersion === 1` and `context.host.call` before storage opens
or migrates. Do not remove these guards or silently skip recovery on an
unsupported host. Web activation separately requires API v2, UI v1 and a portal.

## Business context, not authentication

All mutations require `actor_session_id`, a reported session identifier.
Reads may omit it; browser readers do not invent a human session ID.
Skills include their actor on reads to check their currently assigned Task as
well as any explicit target. Actor is not an automatic list filter or credential.

Role assembly determines the available tool subset, not a per-Task ACL.
ACK history records the fixed Executor as `confirmed_for` and the reported actor
as `author`. Cross-Task operations remain callable, but Skills must not claim
another Executor has read a definition. The backend does not verify reading,
understanding or user authorization through actor IDs or chat inspection.

The host controls role management, including changes to existing sessions.
Task itself exposes no such mutation: session creation selects Executor for
the new session, while assignment checks existing capabilities without adding
roles, enabling resources or repairing the target.

## Concurrency and replay

Every write has a stable `request_id`. Its fingerprint covers the tool and
complete validated input, including actor. The same ID with different input
fails; exact-input replay returns the original effects without repeating them.
Local effects and final receipt commit atomically. `definition_check` is always
fresh, not stored as a permanent conclusion in a receipt.

`write_context` is an opaque concurrency snapshot, not a credential or a second
description version. Return it unchanged:

| Generation | Changes that advance it | Checks |
| --- | --- | --- |
| Description `revision` | Actual description changes only | Definition edits, current ACK, assignment and reports as applicable |
| Lifecycle | First assignment or actual status transition | Existing-Task writes except subscription cancellation |
| Editable materials | Actual title/references/metadata changes | Definition edits |

ACK and activity do not invalidate unrelated writes. Subscription registration
checks lifecycle without advancing it. `task_unsubscribe` instead checks the
specified subscription's waiting state in its transaction; it neither changes
Task state nor recalls a consumed notice.

Description changes atomically write the complete text, next revision and
changelog snapshot. Only an actual changed-description edit by the assigned
Executor on an unfinished Task auto-ACKs that revision. Unchanged text,
materials-only edits and terminal edits do not. ACK never changes status or
creates activity.

Reports require an exact acknowledgement for the supplied revision and fixed
Executor. A later ACK does not cover skipped revisions. An acknowledged older
activity may save while stale status/outcome are rejected with
`DESCRIPTION_UPDATED`; no other report validation failure partially saves
activity. Results distinguish saved, rejected and not_requested fields.
`done` requires a new outcome in that same request.

Terminal Tasks reject execution reports and ACK. Their definition/history remain
readable and editable without reopening or auto-ACK. Old outcomes retain their
revision; overview marks whether the latest outcome matches the current definition.

## External operation receipts

Session creation and assignment persist a pending receipt before host calls.
Step results are updated durably. A crash during an external action leaves
unconfirmed evidence; startup does not automatically repeat creation or dispatch.
`task_read(view=operation,request_id)` exposes the known result without host refresh.

Creation retains a confirmed session ID even if capability inspection fails.
It does not bind a Task or send an initialization prompt, and replay never
creates a replacement.

Assignment proceeds as follows:

1. Inspect current Executor capability and native idle/empty availability.
2. Bind the unassigned todo transactionally, enforcing single unfinished work.
3. Recheck capability/native state and the Task's version, lifecycle and binding.
4. Persist message uncertainty before calling host `prompt` once with the entire
   message `[Task assigned to you](task:<uuid>?event=assigned)` and `mode:"enqueue"`.

The idle checks and send are not atomic. Enqueue avoids proactively interrupting
a turn that starts in the race; an actual `queued:true` result is retained as
`UNEXPECTED_QUEUE`, not dispatch success or proof of non-delivery.
Accepted does not mean read, ACKed or executing.

Failures before or after binding retain their actual effects. Capability and
availability rejection details include capability `reasons`, native
`loaded/status`, fixed `availability_reasons` and `observed_at`, without message
or question bodies. These are failure-time observations, not live status;
receipt reads/replays do not refresh them or repair the session.

Exact request replay never resends. Explicit recovery requires a new request ID,
fresh context/revision, the same Task/Executor and `resume_request_id` pointing
to an unused finalized assignment receipt proving `assignment=applied` and
`message=not_sent`. Recovery consumes that receipt and repeats the safety checks.
Pending, unknown, queued or accepted sends cannot authorize recovery.
No recovery path reassigns, reopens a terminal Task or silently rolls back binding.

## One-shot status notifications

Subscription is optional and normally unused. Owner registers only for a concrete,
necessary future Owner action, not progress/completion watching; this is Skill
guidance rather than a server-side policy expression. Choose minimal targets,
withdraw unnecessary waits and never automatically re-subscribe. Executor work
does not depend on an Owner wait or notice being read.

Registration atomically checks lifecycle, current status and waiting uniqueness.
Already matching fails without registration or immediate notification.
A terminal Task cannot register for future transitions. The recipient is always
the saved Task Owner, not a caller-supplied destination.

A real matching status transition commits Task effects, receipt, subscription
consumption, immutable transition event and `pending` delivery together.
Same-status reports and failed transitions do not trigger; an unmatched terminal
transition expires the wait. Waiting cancellation races through the same
transaction boundary and cannot revoke an already triggered event.

The delivery record is a bounded durable outbox, not a second native queue or
scheduler. A passive `session/get` lookup first checks the original Owner exists.
Missing/unavailable Owners produce `not_sent` evidence; no replacement is created.
A compare-and-set claim persists `unknown` before the non-idempotent host send.
The only message is `[Task status updated](task:<uuid>?event=status_changed)`.
Accepted/queued responses update evidence; ambiguous or interrupted sends remain
unknown and are never automatically retried. Busy Owner enqueue is normal and
does not interrupt, clear messages or prove reading.

Triggering writes preserve `result.subscription_ids` and separately return current
`notifications` / `notification_error`. Notification failure does not erase a
committed status or outcome and must not cause the whole report to be repeated.
Subscription history retains event/delivery facts for terminal Tasks too.
Cards show current Task data, not the immutable trigger snapshot.

Only the returned `onReady` callback starts pending recovery, after the host
runtime is started and HTTP is listening so resumed sessions can connect MCP.
Activation, pre-listen agent events and inbound reads do not trigger it.
Recovery uses bounded batches through a fixed high-water mark without waiting
for new Task traffic. Waiting subscriptions survive restart; only known-unattempted
pending notices recover. Unknown, accepted, queued and known failed attempts do
not replay. Shutdown prevents new claims and keeps storage open until in-flight
work records its outcome. There is no exactly-once guarantee for host prompt.

## Read boundaries and reference

Read views are fixed, not arbitrary projections:
`list`, `overview`, `execution`, `definition`, `changelog`, `activity`, `outcomes`,
`subscriptions`, `operation`. Owner defaults to explicit owner-filtered list and
overview; Executor defaults to execution. These are information defaults, not ACLs.
Full current description appears in execution/definition or a selected changelog
revision, never silently truncated into an overview.

| Data | Bound |
| --- | --- |
| Title / reason | 240 / 2,000 characters |
| Description | 24,000 characters |
| References | 20 entries; label 200 / target 2,000; 8,000 serialized characters total |
| Metadata | Plain JSON object, 8,000 serialized characters, depth at most 12 |
| Description + references + metadata | 64,000 serialized characters combined, including escaping |
| Activity text / outcome summary | 4,000 / 8,000 characters |
| Each activity / outcome input object | 16,000 serialized characters, including outcome references |
| Overview activity excerpt | 320 characters with explicit `truncated` |
| List / history item counts | Default 20 / 5; maximum 50 / 10 |
| List/history page payload | 24,000 serialized characters, cursor for every remainder |

Page budgets exclude the envelope and definition check; requested counts are
upper bounds, not guarantees. Opaque keyset cursors are tied to view/filter/Task.
Changelog pages contain summaries; selecting one revision returns its full
snapshot and cannot combine with limit/cursor. Full current definitions and
single revisions are outside the page budget, bounded by input limits and
attribution to approximately 80,000 serialized characters. Oversized edits are
checked against retained fields too, not merely the supplied patch.

| Purpose | Exact reference form |
| --- | --- |
| Ordinary reference | `[Task](task:<uuid>)` |
| Entire first assignment message | `[Task assigned to you](task:<uuid>?event=assigned)` |
| Explicit important-update notice to Executor | `[Task updated](task:<uuid>?event=updated)` |
| Explicit subscription's system notice to Owner | `[Task status updated](task:<uuid>?event=status_changed)` |

IDs passed to tools are bare UUIDs. The parser accepts only the `task:` scheme,
a UUID, and either no query or exactly one supported lowercase event form above.
Unknown events, extra/malformed queries, fragments and relative `task/<id>` paths
are not claimed; never discard a bad query to reinterpret it as a generic reference.
Relative paths can be mistaken for File references; Task stays in its own scheme.

Labels explain message intent without UI, but the renderer uses the explicit URL
event, not label or current Task status. Event metadata is immutable to the message,
not a Task field/type/status, command or event bus. Generic references remain
eventless. A delayed status_changed card need not show its triggering state.

The frontend renders an inline card with title, status, Executor, latest reported
activity and revision/ACK. An accessible detail dialog reads current definition
and independently paged histories on demand. Host invalidation refreshes visible
reads; reconnect refetches, and superseded reads cannot overwrite current results.
On-demand native observations use session/get only, are labelled separately, and
do not load sessions, poll, scan chat or fabricate live progress.

## Transport and packaging

Task adapts the official stateful Streamable HTTP MCP transport to host module
routes, preserving response headers/streams and cancellation signals. Later POST
cancellation reaches the original call; one cancelled call does not cancel other
calls on that connection. Protocol state is not trusted actor identity or business
storage. Expired transport sessions require explicit reconnection, not business
write retries. Connection capacity, disposal and host calls are defined in the
[host contract](task-host-contract.md).

Task ships backend/frontend assets, role prompts, two self-contained role Skills,
one shared `github-coding` work Skill and runtime dependencies. Both roles declare
the same work-Skill discovery root; no new loading API or Task schema is involved.
Installation does not resolve dependencies at runtime.
Modern build/install instructions are in [Task](task-board.md#module-api-and-packaging).
Packaging, testing and repository cleanup perform no production installation,
role/session changes or deployment.
