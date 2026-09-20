# Task

Task is a Cockpit module for independent Tasks. It is not the legacy Work
Commander daemon. It requires the host's module roles/session capability contract,
Web API v2, UI v1 and Node.js 24 or later. Installing a module is an explicit
operator action; building or merging this repository does not install or activate it.

The companion host change is [waksana/cockpit#68](https://github.com/waksana/cockpit/pull/68),
merged at [`3eddcf1abe671d0e3b54bda5a951cc6b0d1ed5a6`](https://github.com/waksana/cockpit/commit/3eddcf1abe671d0e3b54bda5a951cc6b0d1ed5a6).
The follow-up simplification is [waksana/cockpit#69](https://github.com/waksana/cockpit/pull/69):
capability checks are on demand, without automatic queue advancement or projected
readiness. Use a host build containing both changes. The existing 0.2.6 release
label alone does not establish compatibility with these capabilities.

## Roles and records

Choose Owner, Executor, or both under Task when creating a Cockpit session. The host
assembles the selected role System Prompts, Skills and HTTP MCP configuration.
Role selections are shown in the session list and retained for cold resume.
Role labels describe configuration, not proof that a disconnected MCP is ready.
Capability readiness is checked explicitly on demand, including during Executor
creation and assignment. It is not projected into session lists, snapshots or
ordinary details, and there are no readiness badges or background checks.
Native busy state, pending messages and subagents are checked separately.

These are collaboration capabilities, not business identities. A session named
Cockpit Owner still owns Cockpit itself; choosing Owner does not make it responsible
for developing the Task module or bind it to a particular Task. Project instructions
and the session name express that business identity independently.
The module ID and MCP server key are `cockpit-task`; role IDs remain `owner` and
`executor`. Skills are `cockpit-task-owner` and `cockpit-task-executor`.
This identity change is not cosmetic: existing `task-board` installations require
the explicit offline cutover described below to preserve data and session associations.

Owner clarifies, creates and assigns independent Tasks, then reads their progress.
Owner may investigate read-only and answer questions, but delegates implementation
and state-changing delivery by default rather than doing it personally or hiding
it in its own subagents. A request for an outcome is not an instruction for personal
execution. An explicit user request for personal execution, or a real assignment
as a capable Executor, is an exception; missing delegation capability is a blocker,
not an implicit exception.
One Executor delivers the entire Task, using internal subagents if needed. An
Executor can execute at most one unfinished Task at a time, and may be reused after
completion or cancellation. There are no child Tasks, reassignment or reopening.
Coding and research skills are separate, not bundled into this module.

Role Skills are loaded when first needed and reused while their instructions remain
in context. New messages do not require repeated loading. Reload only for missing
instructions after compaction/recovery, changed Skill content, or a workflow rule
that needs clarification. This is distinct from reading mutable Task requirements
and checking revisions/ACK at meaningful checkpoints.

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
contains exactly one `[Task assigned to you](task:<uuid>?event=assigned)` reference,
sent by `task_assign`; Owner must not duplicate that first dispatch. Its label
explains why it was sent even without UI rendering. The card reads current data
from the module, not a snapshot in chat. Details and history are loaded on demand.

Use `[Task](task:<uuid>)` for an ordinary reference. Task IDs passed to tools are
just the UUID, not the full URI or its query. Only lowercase `assigned` and
`updated` are accepted event values. The event is immutable message/reference
metadata, not a Task type, status, command or event bus. The renderer uses the
explicit URL event, never the label or current Task status; generic and old
references remain compatible without an event header. Unknown events or malformed
queries are left unclaimed, not silently treated as generic Task references.

Ordinary requirement changes only edit Task. Executor reads/ACKs at startup,
checkpoints, before consequential actions, before delivery and after resuming.
Progress, blockers and completion never produce messages to the Owner.

For an exceptionally important update, Owner follows the Skill's
[exceptional update handoff](../skills/cockpit-task-owner/cockpit-task-owner/SKILL.md#exceptional-update-handoff):
read and preserve pending messages, clear the preserved items by ID, then
summarize them and append the following update notice in that same single message:

```text
[Task updated](task:<uuid>?event=updated)
Read the current Task and acknowledge its latest revision before continuing.
```

This replaces the former text-prefix notice. Do not copy the Task description.
The recommendation covers all pending sources, not only Task messages. New
arrivals, incomplete content and already-started work need explicit handling.
If necessary, interrupt the main turn once; do not use Stop to blindly discard
unread arrivals or silently cancel subagents. Confirm native readiness before
handoff, and distinguish sending acceptance from current-revision ACK.
This is Owner Skill guidance, not an automatic queue advancement mechanism.
`task_edit` never automatically sends this notice. Message events add no MCP tools,
Task schema fields or host changes; capability checks and ordinary busy state are
unchanged.
It replaces the retired `cockpit_advance_queue` helper. The host retains single
interrupt, per-item queue removal, native-state reads and sending; it does not
maintain an advancement loop or its operation receipts.

Missing capability rejects assignment; it does not install a role or repair an
existing session. Uncertain creation or dispatch is never automatically replayed.
Task cancellation does not cancel native work, and editing a terminal definition
does not reopen execution.

### File reference compatibility

The verified cockpit-file main commit `e58761b5831de2065aac09d4ae17efd829153b3c`
and v0.1.7 reject non-file schemes through `isLocalFileReference` in both capture
and rendering. `task:` references, including event queries, do not collide with
File references. Do not use relative `task/<id>` paths: File treats relative paths
as file candidates. The host already passes raw link target and label; no new
host protocol is needed. This is source compatibility, not a claim that File was
modified or deployed.

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
Roles are `cockpit-task/owner` and `cockpit-task/executor`. The host assembles the
shared MCP server `cockpit-task` with the selected role tool union and module
provenance. Use a host build supporting exact declared MCP server keys; the
historical generated `module_task-board__task` name is not an alias.

The database is `task-board.sqlite` under the host-provided module dataRoot.
No code opens or migrates the legacy work.db. Session histories, credentials and
native runtime state are not copied into Task storage.

Run `npm ci --ignore-scripts`, `npm test`, then `npm run package:module`.
The output `dist/cockpit-task-0.1.0.tgz` includes runtime dependencies and resources;
its `.sha256` sidecar identifies the archive. CI retains these as the
`cockpit-task-module` development artifact, not a release or deployment.
The host does not run npm during installation. Use the host's documented explicit
local module installation procedure with a compatible host build. The legacy
`npm start`, module.json and deployment scripts remain separate; do not use them
to start Task or overwrite an existing installation.

### Explicit existing-installation cutover

New installations use only `cockpit-task`. Existing `task-board` installations must
use the host's explicit offline module-identity migration capability;
installing the new identity alongside the old one is not a migration and would split
records and register two renderers for `task:` references. Do not activate both.
The old module ID is rejected by this backend; there is no runtime alias or fallback.

Migration must preserve the complete old module data directory and rewrite saved
role selections from `task-board` to `cockpit-task`, retaining `owner`/`executor`.
The database filename remains `task-board.sqlite` intentionally: it is internal
storage, not a public resource name. Its schema v1 contains UUID Task IDs, native
session IDs, operation receipts and opaque write contexts, but no module-ID binding.
Task references remain `task:<uuid>`; no database-row or message rewrite is needed.
Move the entire data directory offline, including any SQLite WAL/SHM sidecars;
never open a fresh empty database instead or rename only the database file.
Stored user-authored references and descriptions are not rewritten.

The host migration replaces the active identity and preserves saved associations
through a durable journal, rejecting conflicting target state rather than merging
or dropping it. It preserves enabled/config state and updates host-owned saved role
labels from the verified target manifest; it does not edit native session history
or personal Skill/MCP configuration.

After separate cutover authorization, use a host build containing the migration
CLI. Stage the target archive without `--enable`, stop every host/module writer
(including older host processes that do not participate in the cooperative lease),
hold automatic restarts stopped, and follow `docs/module-id-migration.md` in that
host checkout. These commands run from the host checkout, not this repository:

```sh
# Stage only: intentionally omit --enable.
pnpm module install /absolute/path/cockpit-task-0.1.0.tgz --trust-local-code

# Dry plan: use the exact version and digest of the installed, disabled target.
pnpm module migrate-id task-board cockpit-task \
  --version <installed-target-version> --digest <installed-target-sha256> --offline

# Explicit cutover: identical parameters, with --apply.
pnpm module migrate-id task-board cockpit-task \
  --version <installed-target-version> --digest <installed-target-sha256> --offline --apply

# Only for an interrupted journal: identical parameters, with --resume.
pnpm module migrate-id task-board cockpit-task \
  --version <installed-target-version> --digest <installed-target-sha256> --offline --resume
```

The host owns private backups, pending-migration startup protection and recovery.
`--offline` is required in every mode; `--apply` and `--resume` are mutually exclusive.
Do not remove its journal or retry with different parameters. Follow the host
procedure for any stale lock; do not bypass writer checks. Existing personal
legacy Skills, particularly the old executing `cockpit-task-owner`, require a
separately authorized retirement before new role use; this identity migration
does not remove them.

Implementing and testing this capability does not authorize a live cutover, data
move, session change or installation; those require separate approval.

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
