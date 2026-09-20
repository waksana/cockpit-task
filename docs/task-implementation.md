# Task Board implementation contract

Queue workflow update: the packaged [Owner Skill](../skills/task-owner/task-owner/SKILL.md#exceptional-update-handoff)
now guides explicit pending-message preservation, cleanup and a single summary
followed by a Task updated reference. It supersedes the advancement-helper
recommendation below. The existing host implementation is described for historical
accuracy; this Skill-only change does not remove that tool or add event-card rendering.

This document closes the technical choices left by the design drafts. The user
has authorized continuous implementation and delivery of both Task and the
required host changes; only material unresolved product decisions require a pause.

Status: the Task core, module integration, role resources and required host
capabilities are implemented and independently reviewed. Delivery is tracked by
[Task PR #3](https://github.com/waksana/cockpit-task/pull/3) and
[waksana/cockpit#68](https://github.com/waksana/cockpit/pull/68);
this is not a publication or production-deployment claim.
Earlier node/draft wording in the design history records decision provenance,
not a requirement to wait for another stage before implementing.

## Module and data

The new module is `task-board`, separate from the legacy Work Commander service.
Its entry is `cockpit.module.json`; it runs in Cockpit, not a standalone daemon.
Legacy launch commands, databases and installations are not automatically changed.
The module uses `task-board.sqlite` under its host-provided dataRoot. It does not
open or migrate the old service database.

Task HTTP API and HTTP MCP share one application service. SQLite transactions
protect local changes. Description snapshots, activity, outcomes, acknowledgements
and operation receipts have distinct tables. Executor has a partial unique index
across unfinished Tasks. Acknowledgements retain each confirmed revision, not just
the greatest number. Database timestamps are assigned by the service.
HTTP MCP uses the official stateful Streamable HTTP transport so cancellation
notifications on a later POST reach the original request. Protocol sessions are
transport state, not a separate daemon or trusted business actor identity.

## Business context, not authentication

Mutation input includes `actor_session_id`, the caller's reported session identifier.
This is labelled `reported`, not an authenticated caller identity. It supplies
authorship, the Executor's current Task lookup for definition reminders, and the
existing rule for automatic ACK on an Executor's own definition edit.
HTTP callers supply the same context; browsing a session is not proof of authorship.
There is no per-Task actor ACL, and no role argument grants or revokes tool access.
Read-only calls may omit actor_session_id, as a human card is not an acting session.
Skills pass it on reads as well so the response can check their current assigned Task.

ACK records both the Task's fixed executor (`confirmed_for`) and the reported
actor (`author`). Cross-Task ACK operations remain callable as agreed; they assert
the Executor's acknowledgement, not proof that the caller or Executor read a text.
Skills require truthful attribution. Reports retain the same distinction.

## Concurrency and replay

All writes require request_id. The request fingerprint includes operation name,
actor and complete validated input. One ID with different input is a conflict.
Local mutation and final receipt commit atomically; retries replay effects but
always perform a fresh definition_check.

write_context is an opaque encoded concurrency snapshot returned by reads/writes,
not a credential. It contains separate lifecycle and editable-metadata generations.
Assignment and state changes advance lifecycle generation. Title/references/metadata
changes advance editable generation. Description has its own revision. Activity and
ACK do not invalidate unrelated writes.

Every existing-Task write checks lifecycle context. Definition edits also check
editable generation and supplied revision. ACK checks the current revision.
Reports permit activity against an actually ACKed older revision, but reject stale
status/outcome. No other report validation error partially writes activity.
done requires a new outcome in that same report. Terminal Tasks do not accept
execution reports or ACK; their definition/history remain readable and may be edited
without reopening execution or automatically ACKing a terminal Task.

## External operation receipts

Session creation and dispatch write a durable pending receipt before calling host.
A process interruption during an external call leaves an unconfirmed receipt;
no startup recovery automatically repeats the call. Expose all known step results
through task_read(view=operation). Definition checks are not stored in receipts.

task_assign first validates an unassigned todo and existing Executor capability
and current native readiness, binds the Task transactionally, then checks the
Task/version and native state again before sending one ID reference to start
execution while idle. The adapter calls host `prompt` with `mode:"enqueue"`:
after the idle/empty-queue checks this starts normally without interrupting a turn.
It deliberately does not use native `immediate`, which could interrupt work that
starts during the race. If readiness changes and the host returns `queued:true`,
the operation records that real queueing as `UNEXPECTED_QUEUE`, not successful
dispatch or confirmed non-delivery. The checks and send are not atomic.

Known not-sent, failed or unknown steps remain visible, including a fixed assignment
that already committed. Replaying request_id never resends. An explicit recovery
of a confirmed not-sent dispatch may use task_assign with resume_request_id and a
new request_id, same Task/executor and fresh context/revision. It must verify the
original receipt proves no send occurred. This is operation recovery, not Task
reopening or reassignment. Unknown sends cannot use this path.

Session creation with a known ID but failed readiness returns that ID and capability
details; it never creates a replacement on retry. Ordinary host reload/recovery is
explicit, not performed by Task assignment.

## Read boundaries and reference

The module uses the standard Markdown link `[Task](task:<id>)`. Task IDs are UUIDs.
This is also the entire dispatch message: no duplicated title or description.
Only this scheme and valid ID are claimed by the Markdown renderer.

Read views follow task-mcp-contract.md. Default list page is 20, maximum 50;
histories use opaque keyset cursors tied to view/filter/Task. List defaults to
unfinished Tasks. Full description is returned only in execution/definition views
or a requested changelog entry. Overview excerpts are bounded and mark truncation.
Description maximum is 24,000 characters; transport results must remain bounded
without silently truncating full definitions. History summaries page separately
from a selected full revision. Outcome text and activity have explicit limits.

Concrete bounds in `src/task-board/contracts.js`:

| Data | Limit |
| --- | --- |
| Title / reason | 240 / 2,000 characters |
| Description | 24,000 characters, never silently truncated |
| References | 20 entries; label 200 / target 2,000 characters; 8,000 serialized characters total |
| Metadata | Plain JSON object, 8,000 serialized characters, depth at most 12 |
| Description + references + metadata | 64,000 serialized characters combined, including escaping |
| Activity text / outcome summary | 4,000 / 8,000 characters |
| Each activity / outcome input object | 16,000 serialized characters, including outcome references |
| Overview activity excerpt | 320 characters, with explicit `truncated` flag |
| History page count | Default 5, maximum 10 |
| List/history page payload | 24,000 serialized characters, with a cursor for every remainder |

Page limits are upper bounds, not promises of an exact item count. Budgets apply
to the store result, excluding the response envelope and definition check. Full
current definitions and individually selected changelog revisions are outside the
page budget; combined input bounds plus attribution keep these responses below
approximately 80,000 serialized characters. Oversized input fails explicitly,
including when an edit combines new materials with the saved description.
Changelog pages contain summaries; `task_read({view:"changelog",task_id,revision})`
returns one full snapshot and cannot be combined with `limit` or `cursor`.

The inline card shows title, Task status, executor, latest reported activity and
revision/ACK. An accessible detail dialog loads current definition and independently
paged histories on demand. The card reads current data, not the historical state
when the reference was sent. Host events invalidate visible reads; reconnect refetches.
Native session state, if available through the public API, is labelled separately.
No chat scanning, fabricated live progress, independent dashboard or notifications.

## Packaging and integration

Task ships its own HTTP MCP implementation, backend entry, frontend assets,
role instructions and two packaged SKILL.md resources. Runtime dependencies must
be included in the module artifact; installation never runs dependency resolution.
Use the existing Node test runner and package manager, without adding test frameworks.

The module bridge is `context.host.call(name, body)`, with these implemented
contracts (camelCase is the host API, unlike Task tool snake_case):

- `session/new({cwd,roles:[{moduleId:"task-board",roleId:"executor"}]})`
  returns `{sessionId}`.
- `session/get({sessionId})` returns `{meta}`; unknown sessions have `meta:null`.
- `roles/readiness({sessionId,roles?})` returns
  `{sessionId,loaded,ready,roles,reasons}`.
- `prompt({sessionId,text,mode:"enqueue"})` returns `{ok,queued?}`.

Role injection is exactly Owner `task_read/task_create/task_session_create/
task_assign/task_edit/task_cancel` and Executor `task_read/task_edit/task_ack/
task_report/task_cancel`. Combined roles take the union. Coding/Research work
skills are not part of this module or the `task_session_create` input.

The implemented host MCP `cockpit_advance_queue` accepts
`{action:"start"|"get"|"cancel",session_id,operation_id?}`. It preserves the native
queue while advancing to its dynamically latest tail; it is not a ninth Task
business tool. Use it only after an explicit important-update decision, not as
an edit side effect. Ordinary prompt enqueue and queue advancement are separate
explicit operations, not a new Task queue.

The host contract is implemented separately in the isolated host worktree. The
module explicitly rejects a host lacking required role/session capabilities.
Both repositories get independent read-only review of actual changes, targeted
validation and protected PR delivery. No production deployment is included.
