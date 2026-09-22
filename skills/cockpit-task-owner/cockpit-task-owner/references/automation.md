# Trusted script Tasks

Read this only when considering or handling an automation Task. Agent remains the
default for investigation, implementation and work needing judgment. Owner may choose
automation for an already known, trusted, repeatable script within the user's authorized
scope. Registration does not authorize execution. Do not manufacture an arbitrary
script, command template or child-Task workflow to bypass independent Agent delivery.

## Discover and register an immutable script

Owner has `task_script_read`, `task_script_register`, `task_automation_start` and
`task_automation_reconcile` in addition to existing Owner tools. Executor does not.
Use actual session IDs, unique stable mutation request IDs and returned Task IDs/context;
the examples below are JSON argument objects, not commands to run unchanged.
The sample script must already exist and have been reviewed on the service filesystem.
No installation, deployment or production testing is implied.

`task_script_read` lists the catalog (default 20, maximum 50) with `next_cursor`:

```json
{"actor_session_id":"owner-session","limit":20}
```

Select a known registration with `{"actor_session_id":"owner-session","script_id":"inventory-v1"}`;
do not combine `script_id` with pagination. Inspect its full description, paths,
fixed arguments, ordered input definitions and SHA256 before selecting it.
If no suitable registration exists, `task_script_register` registers an existing
trusted local script without running it:

```json
{
  "actor_session_id":"owner-session",
  "request_id":"register-inventory-v1",
  "script_id":"inventory-v1",
  "title":"Read inventory",
  "description":"Read an authorized inventory directory and print a bounded inventory summary; no writes or detached children.",
  "executable":"/usr/bin/python3",
  "script_path":"/srv/task-scripts/inventory.py",
  "argv":["-I"],
  "parameters":[
    {"name":"source","type":"string","description":"Authorized inventory directory to read."},
    {"name":"sample_limit","type":"integer","description":"Maximum records to inspect."},
    {"name":"include_archived","type":"boolean","description":"Whether to include archived records."}
  ]
}
```

`script_id` is immutable: new script code/configuration requires a new ID. Both
`executable` and `script_path` are absolute local file paths, resolved at registration;
the executable must be executable, and the script a regular file up to 8 MiB.
`argv` is the fixed prefix, not a caller-supplied shell command. The ordered
`parameters` list declares unique names, `type` (`string|integer|boolean`) and
`description`; all inputs are required, with no extra names or implicit coercion.
Integers must be safe integers. Up to 32 parameters and 32 fixed arguments are allowed.

Execution is exactly `executable [...argv, script_path, ...typedStrings]`, with no shell.
Values map by the registration's parameter order, not JSON key order. For the example
inputs below the actual argument vector is
`["-I","/srv/task-scripts/inventory.py","/srv/inventory","25","false"]`.
Booleans are the literal strings `true` / `false`, never flags or `1` / `0`.
Strings pass literally: quoting, pipes, substitutions and wildcards have no shell expansion.
The script must validate its own domain constraints and safely interpret positional values.

## Snapshot, optionally subscribe, then explicitly start

`task_create` preserves the complete agreement plus an immutable script/configuration
and typed-input snapshot:

```json
{
  "actor_session_id":"owner-session",
  "request_id":"create-inventory-review",
  "owner":"owner-session",
  "title":"Read the authorized inventory",
  "description":"Run inventory-v1 once against /srv/inventory, inspect at most 25 records, exclude archives. Read-only scope; no installation or production changes. Owner will use the result for the already requested inventory decision.",
  "automation":{
    "script_id":"inventory-v1",
    "parameters":{"source":"/srv/inventory","sample_limit":25,"include_archived":false}
  }
}
```

Omit `automation` for an ordinary Agent Task. Creation never executes anything.
Automation has `kind=automation`, no Executor or fake ACK, and consumes no session
assignment slot. Do not use `task_assign`, `task_ack` or `task_report` on it.
The script selection and inputs can never be edited; title/description/materials
are also frozen while queued, starting or running. Record scope changes before
start where permitted; changed inputs require a newly authorized Task.

Default to no subscription, just as for Agent work. If the next necessary authorized
Owner action needs the result, subscribe **before start** so fast completion cannot
race registration. Completion confirmation or repeated reporting is not such an action.
Choose only statuses that unlock that action. In this example the already-requested
inventory decision needs success evidence or the failure reason, so it uses
`done` and `blocked`; `cancelled` is not needed:

```json
{
  "actor_session_id":"owner-session",
  "request_id":"subscribe-inventory-decision",
  "task_id":"11111111-1111-4111-8111-111111111111",
  "write_context":"<returned-write-context>",
  "statuses":["done","blocked"]
}
```

Replace the sample UUID/context with the actual creation/read result. Read the
latest definition and use its actual revision/context for `task_automation_start`:

```json
{
  "actor_session_id":"owner-session",
  "request_id":"start-inventory-review",
  "task_id":"11111111-1111-4111-8111-111111111111",
  "revision":1,
  "write_context":"<returned-write-context>"
}
```

Start explicitly enqueues once in the service's persistent single queue. It does
not subscribe automatically. Exact request replay does not rerun; if a response
is uncertain, read `task_read(view=operation)` and current Task facts, never change
request IDs to retry external effects.

## Read results, not a monitoring loop

Success becomes `done` with a service-generated outcome; failure or interruption
becomes `blocked` with an outcome. These are service facts, not Executor reports.
Automatic subscription transitions have `event.source='automation'`, `event.run_id`
and `actor_session_id:null`. Outcomes have `executor:null`, `source:'automation'`
and `author:'automation:<run_id>'`; the author is a service label, not a native session.
On a one-shot status notice, select only needed latest content in one bounded
overview call where possible, then do only the still-necessary authorized follow-up.
For the inventory decision, `include=["outcome"]` supplies the latest full result
and current context; add `automation` only if run facts or the immutable snapshot
are necessary:

```json
{"actor_session_id":"owner-session","view":"overview","task_id":"11111111-1111-4111-8111-111111111111","include":["outcome"]}
```

No automatic resubscription, acceptance, polling,
scheduled monitor or turn held open waiting for completion.

`task_read` without `include` preserves existing views. Select `automation` on
overview for the full stored script/parameter snapshot and run facts, without logs;
`definition` / `execution` also retain the snapshot. See
[selective reads](reading-tasks.md#select-the-latest-content-for-the-decision).
Inspect run state, exit code,
signal, error, cancellation and barrier separately from Task status.
Read retained combined stdout/stderr only for a concrete question:

```json
{
  "actor_session_id":"owner-session",
  "view":"automation_log",
  "task_id":"11111111-1111-4111-8111-111111111111",
  "offset":0,
  "limit":4096
}
```

Offset is a character offset, not a history cursor. Limit defaults to 4096, maximum
8192; JSON escaping can shorten a page. Follow `next_offset` only as needed.
Output is capped at 65536 retained characters; `retained_characters` and
`omitted_characters` explicitly disclose truncation. `complete` means log capture
has ended, not successful delivery; a null next offset alone is not completion.
Do not present truncated logs as complete evidence or place secrets in parameters/output.

## Cancellation and recovery

`task_cancel` before launch prevents execution. During execution it requests process-group
termination; cancelled is not proof of exit and never rolls back external effects.
Read the outcome and barrier before assuming the queue is safe.
Recovery never reruns started work: starting/running work becomes interrupted/blocked
(an already cancelled Task stays cancelled), with an outcome and persistent queue barrier.
Prelaunch queued work may resume, but no queued run advances through an unresolved barrier.

Inspect effects before requesting `task_automation_reconcile`:

```json
{
  "actor_session_id":"owner-session",
  "request_id":"reconcile-inventory-interruption",
  "task_id":"11111111-1111-4111-8111-111111111111",
  "write_context":"<latest-returned-write-context>",
  "reason":"Reviewed the interrupted run and its possible effects; request service verification of process-group termination before releasing the queue."
}
```

When a durable process group was recorded, reconcile clears an interrupted/finished
run's barrier only when the Linux kernel
process-group probe `kill(-pgid,0)` returns `ESRCH`, proving the group no longer exists.
If both durable PID and process group are absent, explicit reconciliation needs no
probe: the service could not have sent the launch handshake, so the script never
started. This still does not replay that Task.
Any existing group (including unreaped zombies), `EPERM` or observation uncertainty
keeps the barrier. Unreaped zombie groups can block until the host reaps them;
never manually edit the database or bypass the barrier. Shutdown cannot always
prove exit; blocked plus a barrier is the correct conservative result.
Reconciliation does not kill recovered
processes, rerun the script, turn blocked into done or claim rollback/success.
Any repeat requires fresh authorization and a new Task, never a new start on the old one.

This is a same-user trusted execution boundary, not a sandbox or authentication
system. Scripts must NOT daemonize, detach or escape their process group. Review
the executable, fixed prefix, script and descendants as trusted code; a Linux
group proof cannot account for escaped processes. Immutable registration and
script SHA256 detect script-byte changes but do not freeze the interpreter,
runtime, imports, dependencies or external state. If these constraints do not fit,
use an Agent Task or stop for a real authorization decision, not a workflow engine.
