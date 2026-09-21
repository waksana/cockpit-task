# Task

Task is a Cockpit module for independent work records shared by Owner and Executor.
Its module ID and HTTP MCP key are `cockpit-task`, version `0.1.1`.
It runs in Cockpit, not a standalone daemon or dashboard.

## Requirements

Use Node.js 24 or later and a host with Module API v1, Web API v2/UI v1, module
roles, the public `context.host.call` bridge, exact declared MCP server keys, and
service-ready lifecycle v1. `context.serviceReadyVersion === 1` and the post-listen
`onReady` callback are required for pending notification recovery.
The service-ready requirement is checked before storage opens or migrates;
a release label or API-v1 alone is insufficient. Missing public capabilities fail
explicitly, without private-access fallbacks. See the
[host contract](https://github.com/waksana/cockpit-task/blob/main/docs/task-host-contract.md).

## Roles and records

Choose Owner, Executor or both through the host's role management. The host
assembles role System Prompts, Skills and HTTP MCP subsets, persists the selection
and reassembles it on cold resume. Host role changes for existing sessions are
separate from Task operations: Task does not expose that mutation or automatically
add capabilities during assignment.

| Role | Responsibility |
| --- | --- |
| Owner | Clarify, register, explicitly assign and follow independent Tasks |
| Executor | Deliver one entire assigned outcome, organizing internal steps/subagents |

Owner may investigate read-only and answer questions, but delegates implementation
and state-changing delivery by default. An outcome request is not a request for
personal execution. Explicit personal-execution instruction or a real assignment
as a capable Executor is an exception; dual-role selection alone is not.
Unavailable delegation is a blocker, not permission to take over.

One session can execute at most one unfinished Task, then be reused after
completion/cancellation. Tasks are flat references: no child Tasks, dependency
engine, reassignment or terminal reopening. Review is optional unless the Task's
requirements demand it; Executor can complete without a default Owner approval gate.
Coding/Research work skills are external to Task.

The active Skills are [cockpit-task-owner](../skills/cockpit-task-owner/cockpit-task-owner/SKILL.md)
and [cockpit-task-executor](../skills/cockpit-task-executor/cockpit-task-executor/SKILL.md).
Load when first needed, reuse guidance in context, and reload only when missing,
changed or unclear. Each bundles its own on-demand references; stable Skill reuse
does not replace fresh Task reads.

Description contains the full current agreement. Revision/changelog version only
that description. Activity records reported execution against an actually ACKed
revision, not live native progress. ACK never starts work or adds activity.
Only the assigned Executor's actual changed-description edit on an unfinished
Task auto-ACKs the new revision. Terminal definitions can be edited without reopening.

## Tools and normal use

| Tool | Use |
| --- | --- |
| `task_read` | Fixed bounded views; complete requirements and histories read separately |
| `task_create` | Register an unassigned todo |
| `task_session_create` | Create a new Executor with Task capabilities through the host |
| `task_assign` | Check an existing Executor, bind once and send one assigned reference |
| `task_edit` | Replace the complete description or edit title/materials |
| `task_ack` | Confirm the current definition separately from status |
| `task_report` | Explicit activity, status and/or outcome; done requires a new outcome |
| `task_cancel` | Cancel the Task without stopping its native session |
| `task_subscribe` | Optional one-shot Owner wait for explicit target statuses |
| `task_unsubscribe` | Cancel a still-waiting subscription |

Owner receives read/create/session_create/assign/edit/cancel/subscribe/unsubscribe;
Executor receives read/edit/ack/report/cancel (all `task_` prefixed). Both roles
take the union. Having a tool permits cross-Task operations: responsibility
fields are not per-record authorization. `actor_session_id` is reported provenance,
not verified identity.

1. Owner writes a complete Task, then explicitly creates or selects an Executor.
2. Assignment checks capability and native idle/empty state, binds, rechecks and
   sends exactly one assigned reference. Owner does not duplicate it.
3. Executor reads `execution`, ACKs the exact current revision, then explicitly
   reports `in_progress` when work starts.
4. At meaningful checkpoints and before consequential actions/delivery, read the
   latest requirements, reconcile changes and ACK as necessary.
5. Record meaningful activity and blockers. Deliver the full agreement with
   `status=done` and a new outcome in the same report.

Owner starts with `task_read(view=list, owner=<own session ID>)`, then overview
for one Task. Actor is not that filter. Read definition before editing and outcomes
before judging delivery; activity/changelog are separate pages. An available
current outcome does not itself prove complete delivery.

## Writes, failures and recovery

Every write requires a stable request_id. Exact-input replay preserves original
effects; the same ID with changed input conflicts. Existing-Task writes also
send back the read's opaque write_context, except unsubscribe, which checks the
specified subscription's waiting state. Description revision is not a general
lifecycle concurrency token.

Read `result`, `error` and fresh `definition_check` independently, including on
failure or replay. Old activity can save while stale status/outcome fail; do not
repeat saved activity or relabel it to satisfy new scope. Exact ACK history matters:
ACKing v3 does not prove a skipped v2 was acknowledged.

Creation, capability, binding, message acceptance, ACK and actual execution are
different facts. Assignment does not add roles, repair capability, reload or
create a replacement session. Capability readiness is explicit and on demand,
not a list/detail badge; native busy/queue/decisions/background work are checked
separately. The check and enqueue send are not atomic, so a race can produce
queued or unknown results. Neither is safe to resend.

Inspect `task_read(view=operation,request_id)` for durable step results.
Failure-time `availability_reasons` and `observed_at` explain an observation,
not live status; receipt reads/replay do not refresh them.
Preserve created or bound resources after partial failures.
Only an unused final assignment receipt proving `assignment=applied` and
`message=not_sent` supports explicit resume_request_id recovery with a new request
ID, fresh context/revision and the same Task/Executor. Unknown, queued, accepted
or pending sends do not. Cancellation does not stop native work or undo external effects.

## Collaboration and references

Requirements, decisions, progress and outcomes belong in Task, not a second chat
ledger. Executor asks the user directly in its own session; neither role starts
an Owner/Executor conversation for progress, confirmation or clarification.
No direct or subagent-relayed Executor messages to Owner. User-facing summaries
are allowed. Ordinary edits/reports stay silent without an explicit subscription.

| Purpose | Reference |
| --- | --- |
| Ordinary reference | `[Task](task:<uuid>)` |
| Entire automatic first dispatch | `[Task assigned to you](task:<uuid>?event=assigned)` |
| Explicit important-update notice | `[Task updated](task:<uuid>?event=updated)` |
| System notice from a status subscription | `[Task status updated](task:<uuid>?event=status_changed)` |

Pass only the UUID to tools. Event values are exact lowercase URL metadata, not
Task fields, commands or inferred states. Generic references have no event title;
unknown events or malformed queries remain unclaimed. Use `task:`, not relative
`task/<id>` file-like paths.

The frontend renders an inline reference card and current-data detail dialog,
not a separate dashboard. Message reason is fixed; title, state, definition and
history are fetched from Task. Native session observations are labelled separately,
read on demand and never imply business progress or capability readiness.

For an exceptionally important change that cannot wait for checkpoints, Owner
follows the [important-update handoff](../skills/cockpit-task-owner/cockpit-task-owner/references/important-updates.md):
save the updated Task, preserve pending content before removing saved IDs, handle
new arrivals explicitly, and if needed interrupt the main turn once while
preserving the queue. Send one preserved-context summary followed by an updated
reference and an instruction to read/ACK the latest revision. Do not copy description,
blindly Stop/clear unread messages, cancel background work or loop interruptions.
`task_edit` never sends this notice automatically.

### One-shot status subscriptions

Default to no subscription. Register only when a future status enables a concrete,
necessary Owner action—not merely knowing progress or confirming completion.
Do not invent work or approval gates to justify waiting. Choose the fewest useful
targets and withdraw the wait if the follow-up is no longer needed.
Executor never waits for subscription or notice consumption before delivering.

Registration already in a target state fails without subscribing or notifying.
Each Task permits one waiting subscription; the first matching committed
transition consumes it. An unmatched terminal transition expires it.
Same-state reports, edits, ACKs and activity alone do not trigger.
Unsubscribe cannot recall a consumed notification or host queue item.

The system enqueues one status_changed reference to Task.owner without interruption
or queue clearing. Owner reads current evidence, reassesses the necessary action
and does not automatically re-subscribe, poll or hold a model turn open.
This is not an Executor requirement-update/ACK notice or a dependency scheduler.

Inspect subscriptions for immutable trigger facts and delivery evidence.
Task results and notification_error are separate; failed delivery does not undo
saved outcomes. Unknown sends are not automatically retried or manually duplicated.
After HTTP is listening, onReady recovers only known-unattempted pending notices
in a bounded pass. One-shot triggering does not guarantee exactly-once host delivery.

## Module API and packaging

Relative to the host's protected, version-bound module API base:

- `POST /read` and `POST /tools/<tool-name>` share the business service.
- `GET /tasks/<uuid>/native` reads the assigned session without loading it.
- `/mcp` provides official stateful Streamable HTTP: POST requests/notifications,
  GET stream and DELETE protocol-session close. Cancellation reaches the original
  call without undoing completed effects.

Current backend/frontend paths remain `src/task-board/` and `web/task-board/`.
The database is `task-board.sqlite` under the host-provided dataRoot.
Task does not copy session histories, credentials or native runtime state.

From this repository, build the modern module:

```sh
npm ci --ignore-scripts
npm test
npm run package:module
```

`dist/cockpit-task-0.1.1.tgz` contains runtime dependencies, backend/frontend assets,
role prompts and both self-contained Skills. Its `.sha256` sidecar identifies the
archive. [Task CI](https://github.com/waksana/cockpit-task/blob/main/.github/workflows/task-board-ci.yml) retains these as the
`cockpit-task-module` artifact; an artifact is not an installation or deployment.

Installation is an explicit operator action on a compatible host. From the host
checkout, stage the local artifact using the host's module installer:

```sh
pnpm module install /absolute/path/to/cockpit-task-0.1.1.tgz --trust-local-code
```

This command deliberately omits automatic enablement. Follow that host's documented
module-management procedure to inspect and explicitly enable the installed module;
the host does not run npm during installation. Do not bypass compatibility guards.
These are instructions, not a claim that cleanup or packaging installed anything.

## Further contracts and validation

- [Product design](https://github.com/waksana/cockpit-task/blob/main/docs/task-design.md) and [record schema](https://github.com/waksana/cockpit-task/blob/main/docs/task-schema.md)
- [MCP tools](https://github.com/waksana/cockpit-task/blob/main/docs/task-mcp-contract.md) and [role guidance](https://github.com/waksana/cockpit-task/blob/main/docs/task-tools-skills.md)
- [Host integration](https://github.com/waksana/cockpit-task/blob/main/docs/task-host-contract.md) and [implementation](https://github.com/waksana/cockpit-task/blob/main/docs/task-implementation.md)
- [Lifecycle replay methodology](https://github.com/waksana/cockpit-task/blob/main/docs/task-lifecycle-testing.md), including isolated
  model-driven cases and opt-in host integration

Use isolated storage and synthetic sessions for validation. Never substitute real
Owner sessions, existing installations, credentials or live databases for fixtures.
