import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { TaskError, scriptSchema } from './contracts.js';

export const LOG_LIMIT = 65536;
const now = () => new Date().toISOString();
const fail = (code, message) => { throw new TaskError(code, message); };
export function scriptDigest(path) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) {
    fail('INVALID_SCRIPT', 'Scripts must be regular files no larger than 8 MiB');
  }
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
export function resolveScript(input) {
  const parsed = scriptSchema.safeParse(input);
  if (!parsed.success) fail('INVALID_SCRIPT', 'Script definition exceeds its bounds or has invalid fields');
  const script = parsed.data;
  for (const key of ['executable', 'script_path']) {
    if (!isAbsolute(script[key]) || script[key].includes('\0')) fail('INVALID_SCRIPT', `${key} must be an absolute local path`);
    script[key] = realpathSync(script[key]);
    if (!statSync(script[key]).isFile()) fail('INVALID_SCRIPT', `${key} must be a regular file`);
  }
  accessSync(script.executable, constants.X_OK);
  return { ...script, sha256: scriptDigest(script.script_path) };
}
export function scriptArguments(script, parameters) {
  const names = script.parameters.map(parameter => parameter.name);
  if (Object.keys(parameters).length !== names.length || Object.keys(parameters).some(name => !names.includes(name))) {
    fail('INVALID_PARAMETERS', 'Supply exactly the registered parameter names; all parameters are required');
  }
  const values = script.parameters.map(parameter => {
    const value = parameters[parameter.name];
    const valid = parameter.type === 'integer' ? Number.isSafeInteger(value) : typeof value === parameter.type;
    if (!valid) fail('INVALID_PARAMETERS', `${parameter.name} requires ${parameter.type}`);
    return String(value);
  });
  return [...script.argv, script.script_path, ...values];
}

export class AutomationStore {
  constructor(store) { this.store = store; this.db = store.db; }
  run(taskId) {
    const row = this.db.prepare('SELECT * FROM automation_runs WHERE task_id=?').get(taskId);
    if (!row) fail('NOT_AUTOMATION', 'This operation requires an automation Task');
    return row;
  }
  project(row, full = false) {
    const { seq, task_id, script, parameters, log, omitted_characters, ...facts } = row;
    return {
      ...facts, barrier: Boolean(row.barrier), cancel_requested: Boolean(row.cancel_requested),
      ...(full ? { script: JSON.parse(script), parameters: JSON.parse(parameters) } : {}),
    };
  }
  script(input) {
    if (input.script_id) {
      const row = this.db.prepare('SELECT * FROM scripts WHERE script_id=?').get(input.script_id);
      if (!row) fail('SCRIPT_NOT_FOUND', 'No registered script has this ID');
      return { ...JSON.parse(row.definition), registered_at: row.at, registered_by: row.author };
    }
    const scope = 'automation-scripts';
    const limit = input.limit ?? 20;
    const rows = this.db.prepare('SELECT * FROM scripts WHERE seq < ? ORDER BY seq DESC LIMIT ?')
      .all(this.store.cursor(input, scope), limit + 1);
    return this.store.page(rows, limit, scope, row => ({
      ...JSON.parse(row.definition), registered_at: row.at, registered_by: row.author,
    }));
  }
  register(input) {
    if (this.db.prepare('SELECT 1 FROM scripts WHERE script_id=?').get(input.script_id)) {
      fail('SCRIPT_EXISTS', 'Registrations are immutable; use a new script_id for a new version');
    }
    let script;
    try {
      const { actor_session_id, request_id, ...definition } = input;
      script = resolveScript(definition);
    } catch (error) {
      if (error instanceof TaskError) throw error;
      if (error.code && ['ENOENT', 'EACCES', 'ENOTDIR', 'ELOOP'].includes(error.code)) {
        fail('INVALID_SCRIPT', `Cannot access local script or executable: ${error.code}`);
      }
      throw error;
    }
    this.db.prepare('INSERT INTO scripts(script_id,definition,author,at) VALUES(?,?,?,?)')
      .run(script.script_id, JSON.stringify(script), input.actor_session_id, now());
    return { result: this.script({ script_id: script.script_id }) };
  }
  create(taskId, input) {
    const script = this.script({ script_id: input.script_id });
    scriptArguments(script, input.parameters);
    this.db.prepare("UPDATE tasks SET kind='automation' WHERE id=?").run(taskId);
    this.db.prepare("INSERT INTO automation_runs(run_id,task_id,script_id,script,parameters,state) VALUES(?,?,?,?,?,'created')")
      .run(randomUUID(), taskId, input.script_id, JSON.stringify(script), JSON.stringify(input.parameters));
  }
  start(input) {
    if (process.platform !== 'linux') fail('AUTOMATION_PLATFORM', 'Automation currently requires Linux process groups');
    const task = this.store.row(input.task_id), run = this.run(task.id);
    this.store.checkContext(task, input, true);
    this.store.currentRevision(task, input);
    if (task.status !== 'todo' || run.state !== 'created') fail('AUTOMATION_ALREADY_STARTED', 'An automation Task can be started once; never retry script side effects');
    this.db.prepare("UPDATE automation_runs SET state='queued',queued_at=?,revision=? WHERE task_id=?")
      .run(now(), task.revision, task.id);
    this.db.prepare('UPDATE tasks SET lifecycle=lifecycle+1,updated_at=? WHERE id=?').run(now(), task.id);
    return { result: this.store.effects(this.store.row(task.id)) };
  }
  log(input) {
    const run = this.run(input.task_id), offset = input.offset ?? 0;
    if (offset > run.log.length) fail('INVALID_LOG_OFFSET', 'Offset exceeds retained log length');
    let text = run.log.slice(offset, offset + (input.limit ?? 4096));
    while (JSON.stringify(text).length > 16000) text = text.slice(0, Math.floor(text.length / 2));
    return {
      task_id: run.task_id, run_id: run.run_id, offset, text,
      next_offset: offset + text.length < run.log.length ? offset + text.length : null,
      retained_characters: run.log.length, omitted_characters: run.omitted_characters,
      complete: !['created', 'queued', 'starting', 'running'].includes(run.state),
    };
  }
  append(taskId, text) {
    const run = this.run(taskId), available = LOG_LIMIT - run.log.length;
    if (!available) {
      this.db.prepare('UPDATE automation_runs SET omitted_characters=omitted_characters+? WHERE task_id=?').run(text.length, taskId);
      return;
    }
    this.db.prepare('UPDATE automation_runs SET log=?,omitted_characters=omitted_characters+? WHERE task_id=?')
      .run(run.log + text.slice(0, available), Math.max(0, text.length - available), taskId);
  }
  next() {
    if (this.db.prepare('SELECT 1 FROM automation_runs WHERE barrier=1 LIMIT 1').get()) return null;
    return this.db.prepare("SELECT * FROM automation_runs WHERE state='queued' ORDER BY queued_at,seq LIMIT 1").get() ?? null;
  }
  claim(taskId) {
    return this.store.transaction(() => {
      const run = this.next();
      if (run?.task_id !== taskId) return null;
      const task = this.store.row(taskId), at = now();
      this.db.prepare("UPDATE automation_runs SET state='starting',barrier=1,started_at=? WHERE task_id=?").run(at, taskId);
      this.db.prepare("UPDATE tasks SET status='in_progress',lifecycle=lifecycle+1,updated_at=? WHERE id=?").run(at, taskId);
      const subscription_ids = this.store.transitionSubscriptions(task, 'in_progress', this.actor(run), at);
      return { run: this.run(taskId), subscription_ids };
    });
  }
  actor(run) { return { request_id: `automation:${run.run_id}`, actor_session_id: null, source: 'automation', run_id: run.run_id }; }
  launched(taskId, pid) {
    this.db.prepare('UPDATE automation_runs SET pid=?,process_group=? WHERE task_id=?').run(pid, pid, taskId);
  }
  running(taskId) {
    this.db.prepare("UPDATE automation_runs SET state='running' WHERE task_id=? AND state='starting'").run(taskId);
  }
  finish(taskId, { state, exit_code = null, signal = null, error = null, barrier = false }) {
    const write = () => {
      const run = this.run(taskId), task = this.store.row(taskId), at = now();
      const status = task.status === 'cancelled' ? 'cancelled' : state === 'succeeded' ? 'done' : 'blocked';
      const actualState = task.status === 'cancelled' ? 'cancelled' : state;
      this.db.prepare('UPDATE automation_runs SET state=?,exit_code=?,signal=?,error=?,barrier=?,finished_at=? WHERE task_id=?')
        .run(actualState, exit_code, signal, error, Number(barrier), at, taskId);
      const summary = [
        `Automation ${actualState}; script ${run.script_id}; run ${run.run_id}.`,
        `Exit code: ${exit_code ?? 'unconfirmed'}; signal: ${signal ?? 'none'}.`,
        error, barrier ? 'Queue blocked: process-group termination is unconfirmed. Explicit reconciliation is required.' : null,
        `Retained combined stdout/stderr: ${run.log.length} characters; omitted: ${run.omitted_characters}.`,
        'Read task_read(view="automation_log") for bounded output. No automatic retry.',
      ].filter(Boolean).join('\n');
      this.db.prepare('INSERT INTO outcomes(id,task_id,revision,executor,author,summary,refs,at,run_id) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), taskId, run.revision ?? task.revision, null, `automation:${run.run_id}`, summary,
          JSON.stringify([{ label: 'Automation output (task_read automation_log)', target: `task:${taskId}` }]), at, run.run_id);
      this.db.prepare('UPDATE tasks SET status=?,lifecycle=lifecycle+?,updated_at=? WHERE id=?')
        .run(status, Number(task.status !== status), at, taskId);
      return this.store.transitionSubscriptions(task, status, this.actor(run), at);
    };
    return this.db.isTransaction ? write() : this.store.transaction(write);
  }
  cancel(taskId) {
    const run = this.run(taskId);
    this.db.prepare('UPDATE automation_runs SET cancel_requested=1 WHERE task_id=?').run(taskId);
    if (['created', 'queued'].includes(run.state)) this.finish(taskId, { state: 'cancelled', error: 'Cancelled before launch; no script was started.' });
  }
  recover() {
    const ids = [];
    for (const run of this.db.prepare("SELECT * FROM automation_runs WHERE state IN ('starting','running')").all()) {
      ids.push(...this.finish(run.task_id, {
        state: 'interrupted', error: 'Service stopped before completion was durably confirmed. Effects may have occurred; never automatically rerun.',
        barrier: true,
      }));
    }
    return ids;
  }
  reconcile(input, groupAlive) {
    const task = this.store.row(input.task_id), run = this.run(task.id);
    this.store.checkContext(task, input);
    if (!run.barrier || ['starting', 'running'].includes(run.state)) {
      fail('RECONCILE_NOT_READY', 'Only an interrupted or finished run with a termination barrier can be reconciled');
    }
    // A missing PID means the worker never received its launch handshake.
    if (run.process_group && groupAlive(run.process_group)) fail('PROCESS_GROUP_ACTIVE', 'The process group may still be active; no queue barrier was cleared');
    this.db.prepare('UPDATE automation_runs SET barrier=0,reconciled_at=?,reconciled_by=?,reconciliation_reason=? WHERE task_id=?')
      .run(now(), input.actor_session_id, input.reason, task.id);
    return { result: this.store.effects(this.store.row(task.id)) };
  }
}
