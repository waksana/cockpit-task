# Lightweight automation Tasks

Agent is the default: one independent Executor delivers a complete authorized
outcome. Owner may instead choose automation for an already known, trusted,
repeatable local script. This is not arbitrary task-to-script conversion, a
workflow/dependency engine, a scheduler, or permission to invent child Tasks.
Registration, Task creation, optional subscription and execution are separate.

## Explicit script flow

1. Discover via `task_script_read`; inspect the complete registration and execution
   boundary. Register an existing reviewed script via `task_script_register` if needed.
2. Register immutable `script_id`, `title`, `description`, absolute `executable` and
   `script_path`, fixed-prefix `argv`, and ordered required parameter definitions
   `{name,type,description}`. Types are `string`, `integer` (safe integer), or `boolean`.
   Every declared value must be supplied exactly once by name; extra names and
   coercion are rejected. A changed registration/script needs a new ID.
3. Use `task_create` with `automation={script_id,parameters}` to snapshot the script
   configuration, SHA256 and typed inputs. Omit `automation` for an Agent Task.
   Creation never runs code. Script selection/input snapshots are never editable.
4. Default to no subscription. Only if a future state enables a concrete necessary
   authorized Owner action, register a
   one-shot subscription **before start**. Prefer `done` / `blocked`, adding
   `cancelled` only when necessary. There is no automatic subscription.
5. Explicitly call `task_automation_start` with actor, stable request ID, Task ID,
   latest `revision` and returned `write_context`. This enqueues once in the
   service's persistent single queue, not in an Agent session.

All required arguments and real JSON examples are in the independently packaged
[Owner reference](../skills/cockpit-task-owner/cockpit-task-owner/references/automation.md).
Exact schemas and bounds are in the [MCP contract](task-mcp-contract.md).

Execution uses `executable [...argv, script_path, ...typedStrings]` with no shell.
The registered parameter order determines positional mapping, regardless of object
key order; strings are literal, integers become decimal strings, booleans become
`"true"` / `"false"`. Fixed `argv` precedes the script path, never follows inputs.
The script must validate domain constraints; typed parameters do not make arbitrary
script behavior safe.

## Records and results

Reads expose `kind=agent|automation`; automation has no Executor, fabricated ACK,
assignment prompt or session occupancy. `task_assign`, `task_ack` and `task_report`
reject automation. Owner alone receives the four script/start/reconcile tools;
Executor retains existing read/edit/cancel access, not create/start or child-Task authority.
Definitions and editable materials freeze in `queued`, `starting`, `running`.

Run states are `created`, `queued`, `starting`, `running`, `succeeded`, `failed`,
`interrupted`, `cancelled`. A queued Task remains `todo`; claiming it changes Task
status to `in_progress`. Success writes `done` plus a service-generated outcome;
failure/interruption writes `blocked` plus an outcome (cancellation remains cancelled).
No Agent reporting or polling is involved. An available outcome is evidence, not
proof of every intended external effect: read its content and execution boundary.
Automatic subscription transitions record `event.source='automation'`,
`event.run_id` and `actor_session_id:null`. Service outcomes have `executor:null`,
`source:'automation'` and `author:'automation:<run_id>'`. That author is a service
label, not a native session to inspect, contact or treat as an Executor.

Default Task overview/list carry runtime facts in `automation`; `definition` / `execution`
also carry the immutable `script` / `parameters` snapshot. Runtime facts include
run identity/state, timestamps, PID/process group, exit code/signal/error,
cancellation request and barrier/reconciliation facts. When the next action needs
both run facts and delivery, read `overview` with `include=["automation","outcome"]`
once; this returns the full snapshot/facts and latest complete outcome without logs.
Use `include=["context"]` if only status/version is needed. History remains separate.

`task_read(view="automation_log",task_id,offset?,limit?)` reads retained combined
stdout/stderr, not chat. Offset defaults to 0; limit defaults to 4096, maximum 8192
characters. Response includes `text`, `next_offset`, `retained_characters`,
`omitted_characters`, and `complete`. Retention is capped at **65536 characters**;
nonzero omitted counts explicitly mean truncated evidence, not an empty successful log.
JSON escaping can shorten a page; use returned offsets. A null next offset means
no further retained text at that read, not that the process has finished.

On an optional status notice, select only the latest information needed, then perform
only still-needed authorized follow-up. Do not poll, automatically resubscribe,
schedule monitoring or keep an Agent turn open just to watch execution.

## Cancellation, restart and the queue barrier

Cancellation before launch prevents execution. Running cancellation requests
process-group termination, but never rolls back effects or proves exit. Read the
run's final outcome/barrier; Task `cancelled` alone is insufficient.
Restart never reruns started work: recovered starting/running runs become interrupted,
blocked with an outcome (or remain cancelled), and hold a persistent queue barrier.
Prelaunch queued work may resume, but cannot pass that barrier.

`task_automation_reconcile` requires actor, stable request ID, Task ID,
`write_context` and a reason. For a recorded process group, it clears an
interrupted/finished barrier only after the Linux kernel process-group probe
`kill(-pgid,0)` returns `ESRCH`, proving that the recorded group no longer exists.
If no durable PID/group exists, the script could not have received its launch
handshake; explicit reconciliation can clear that barrier without a probe, never
replaying the Task. Any existing group (including unreaped zombies),
`EPERM` or uncertain observation does not release the queue. Unreaped zombie groups
can keep the barrier until the host reaps them; never manually edit the database or
bypass the barrier. Shutdown cannot always prove exit; blocked plus a barrier is
the correct conservative result. Reconciliation does not kill
recovered processes, rerun anything, change blocked to done, or claim success.
Inspect possible effects first. A repeat needs new authorization and a new Task.

## Trust and delivery boundary

Linux process-group observation is required. Scripts and descendants must **not
daemonize, detach or escape the group**. This is same-user trusted local execution,
not a sandbox, verified actor authentication or a per-Task ACL. Group observation
cannot account for escaped processes. Immutable configuration and script SHA256
do not freeze runtime/interpreter bytes, imports, dependencies or external state.
Do not put secrets in Task inputs or retained output.

Current source/package version is **0.1.8**, including completion retro for Agent Tasks,
selective Task reads and updated Skill guidance.
Automation remains exempt from retro. Source changes and isolated validation
are not installation, production tests, deployment or restart authorization; no
existing installation is replaced or upgraded by this feature's documentation.
