# Trusted script Tasks

Read this only when considering or handling an automation Task. Agent work stays the
default for anything needing judgment. Use automation only for an existing, reviewed,
trusted and repeatable script within the user's authorization; registration never
authorizes running it, and never create a script, command template or workflow to bypass
Agent delivery. Automation needs a Linux (or WSL2) host.

1. **Select or register.** Inspect an existing registration with `task_script_read`, or
   register an existing script with `task_script_register` (it does not run it). A
   registration is immutable: changed code or configuration needs a new `script_id`. The
   tool descriptions define the exact argument vector; there is no shell.
2. **Create.** `task_create` with `automation` saves the complete agreement plus an
   immutable script and typed-input snapshot. Creation runs nothing. An automation Task has
   no assignee: never assign, ACK or report it.
3. **Subscribe only if needed, then start.** If a necessary follow-up of yours depends on
   the result, subscribe before `task_automation_start` so fast completion cannot race it.
   Start enqueues the run once; replaying the same request never reruns it.
4. **Read the result.** A finished run makes its Task `done` unless explicitly cancelled;
   neither status proves success or process-group exit.
   Read the outcome and the separate `succeeded`, `failed` or `interrupted` run fact, and
   logs only for a concrete question; a truncated log is not complete evidence. Do not poll.
5. **Cancel or recover.** Cancelling before launch prevents the run; during it, cancellation
   requests termination but proves neither exit nor rollback. Recovery never reruns started
   work: an interrupted run blocks the queue behind a barrier. Review its possible effects
   before `task_automation_reconcile`, which clears the barrier only when the service proves
   the process group is gone. Any repeat needs fresh authorization and a new Task.

This is a same-user trust boundary, not a sandbox. Scripts must not daemonize, detach or
escape their process group, and the fingerprint covers only the script bytes, not the
interpreter, dependencies or external state. When these constraints do not fit, use Agent
work under R3 without changing existing authorization or responsibility.
