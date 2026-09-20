# Task Board

Task Board is a Cockpit module for independent Tasks. It is not the legacy Work
Commander daemon. It requires the host's module roles/session capability contract,
Web API v2, UI v1 and Node.js 24 or later. Installing a module is an explicit
operator action; building or merging this repository does not install or activate it.

The companion host change is [waksana/cockpit#68](https://github.com/waksana/cockpit/pull/68),
implemented at [`3de3c3826fdeab9c4a9ecd665b52cfa5acb034f2`](https://github.com/waksana/cockpit/commit/3de3c3826fdeab9c4a9ecd665b52cfa5acb034f2).
Use a host build containing that change. The existing 0.2.6 release label alone
does not establish compatibility with these additive capabilities.

## Roles and records

Choose Task Owner, Task Executor, or both when creating a Cockpit session. The host
assembles the selected role instructions, Skills and HTTP MCP configuration.
Role selections are shown in the session list and retained for cold resume.
Role labels describe configuration, not proof that a disconnected MCP is ready.

Owner clarifies, creates and assigns independent Tasks, then reads their progress.
One Executor delivers the entire Task, using internal subagents if needed. An
Executor can execute at most one unfinished Task at a time, and may be reused after
completion or cancellation. There are no child Tasks, reassignment or reopening.
Coding and research skills are separate, not bundled into this module.

description contains the complete current requirements. revision and changelog
version that definition only. activity records execution facts against an actually
acknowledged revision; the latest activity is the latest reported situation, not
real-time native activity. ACK neither starts work nor adds activity.
An Executor's own definition change also acknowledges the new revision.

## Tools

| Tool | Use |
| --- | --- |
| task_read | Select overview, execution, definition or bounded history views |
| task_create | Register a todo without creating or starting a session |
| task_session_create | Create a capability-ready Executor through the host |
| task_assign | Check an existing Executor, bind it and send one Task reference |
| task_edit | Replace requirements or edit optional metadata |
| task_ack | Acknowledge the current definition separately from work status |
| task_report | Record activity, status and/or outcome explicitly |
| task_cancel | Cancel the Task without stopping its native session |

Owner and Executor receive role-specific subsets; selecting both takes their union.
Having a tool allows operating other Tasks: owner/executor fields are responsibility,
not per-record authorization. All writes still enforce data consistency.
actor_session_id is reported provenance, not verified identity.

Use the host-provided session ID for actor_session_id. Writes include request_id;
writes to existing Tasks also send back the read's opaque write_context. A description
revision is not a concurrency token for unrelated state changes.
Repeated requests preserve their original ID and exact input. After a response is
lost, inspect the operation before doing anything with an external side effect.

Each response separates result, error and a fresh definition_check.
Process reminders even on reads, failures or replay. If an old acknowledged activity
is saved but stale status/outcome are rejected, do not repeat the whole report or
relabel the work as current. done requires a new outcome in that report.

## Collaboration

Create the Task, explicitly create or select an Executor, then assign. Dispatch
contains only `[Task](task:<uuid>)`. Its card reads current data from the module;
it does not snapshot the Task into chat. Details and history are loaded on demand.

Ordinary requirement changes only edit Task. Executor reads/ACKs at startup,
checkpoints, before consequential actions, before delivery and after resuming.
Progress, blockers and completion never produce messages to the Owner.

For an exceptionally important update, Owner may explicitly enqueue the Task
reference once and invoke the host's cockpit_advance_queue operation. It preserves
messages, advances toward the dynamic newest queue tail and leaves the last turn
running. It is not Task's own tool or an automatic response to revision changes.
It has start/get/cancel and no business timeout. Cancellation stops further
interruptions, not the target session, and cannot retract an issued interrupt.

Missing capability rejects assignment; it does not install a role or repair an
existing session. Uncertain creation or dispatch is never automatically replayed.
Task cancellation does not cancel native work, and editing a terminal definition
does not reopen execution.

## Module API and packaging

The module's ordinary HTTP API and HTTP MCP share the same operations and database.
POST `/read` selects read views; POST `/tools/<tool-name>` performs a tool operation.
GET `/tasks/<uuid>/native` reads only the assigned session's current public
observation, on demand. It never loads that session and does not persist its state.
`/mcp` is the official Streamable HTTP MCP endpoint: POST for requests, GET for
the protocol stream and DELETE to close a protocol session. Cancellation
notifications reach the original in-flight call; completed external effects
are not rolled back. These paths are relative
to Cockpit's digest-bound module API base, not an independently exposed service.
The host applies its existing access boundary. Module MCP configuration carries
the current endpoint and required module version header.
The module requires `context.host.call` for `session/new`, `session/get`,
`roles/readiness` and `prompt`; it has no fallback to private runtime access.
Roles are `task-board/owner` and `task-board/executor`. The host assembles the
shared MCP server `module_task-board__task` with the selected role tool union.

The database is `task-board.sqlite` under the host-provided module dataRoot.
No code opens or migrates the legacy work.db. Session histories, credentials and
native runtime state are not copied into Task storage.

Run `npm ci --ignore-scripts`, `npm test`, then `npm run package:module`.
The output `dist/task-board-0.1.0.tgz` includes runtime dependencies and resources;
its `.sha256` sidecar identifies the archive. CI retains these as the
`task-board-module` development artifact, not a release or deployment.
The host does not run npm during installation. Use the host's documented explicit
local module installation procedure with a compatible host build. The legacy
`npm start`, module.json and deployment scripts remain separate; do not use them
to start Task Board or overwrite an existing installation.

For the optional cross-repository integration test, prepare the compatible host
checkout using its frozen dependency workflow, then run:

```sh
npm run package:module
mkdir -p .task-board-host-runner
HOST_SOURCE=/absolute/path/to/compatible/cockpit
TMPDIR="$PWD/.task-board-host-runner" TSX_DISABLE_CACHE=1 \
  TASK_BOARD_HOST_WORKTREE="$HOST_SOURCE" \
  "$HOST_SOURCE/packages/core/node_modules/.bin/tsx" --test test/task-board-host-integration.test.js
rmdir ".task-board-host-runner/tsx-$(id -u)" .task-board-host-runner
```

This uses the actual archive, installer, native SDK and module roles with empty
temporary home/config/state directories and a synthetic loopback model provider.
It does not contact a real model provider or use existing sessions. The default
unit-test command skips this opt-in test when no host checkout is specified.
