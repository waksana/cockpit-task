import { schemas } from './contracts.js';
import { canonical, fail, hash, now, uid, WorkError } from './store.js';
import { EffectUnknown } from './cockpit.js';

const terminal = new Set(['delivered', 'failed', 'cancelled']);
const statusGroups = {
  working: ['recorded', 'dispatched', 'active', 'result_reported'],
  blocked: ['blocked'], decision: ['needs_decision'], closed: ['delivered', 'failed', 'cancelled'],
};
const busy = meta => meta.status === 'running' || meta.loading || meta.closing || meta.cancelling ||
  meta.compacting || meta.nativeProcessing || meta.activeOperations > 0 || meta.activeMcpOperations > 0 ||
  meta.activeSubagents > 0 || meta.ask || meta.planRequest || meta.elicitation;

export class Work {
  constructor(store, cockpit, { publicUrl = 'http://127.0.0.1:8790', cockpitWeb = 'https://cockpit.rbym47.com' } = {}) {
    this.store = store; this.cockpit = cockpit; this.publicUrl = publicUrl; this.cockpitWeb = cockpitWeb;
    this.listeners = new Set();
  }
  changed() { for (const listener of this.listeners) listener(); }
  authorize(principal, role, task) {
    fail(principal.role !== role, 'FORBIDDEN', `Requires ${role} credential`, 403);
    if (task) {
      fail(role === 'caller' ? principal.session_id !== task.caller :
        principal.task_id !== task.id || principal.session_id !== task.owner,
      'WRONG_OWNER', 'Credential is not bound to this task and session', 403);
    }
  }
  visible(principal, task) {
    return principal.role === 'viewer' || principal.role === 'admin' ||
      (principal.role === 'caller' && principal.session_id === task.caller) ||
      (principal.role === 'owner' && principal.task_id === task.id && principal.session_id === task.owner);
  }
  current(task, version) {
    fail(task.version !== version, 'STALE_GOAL', `Current goal version is ${task.version}; old receipt cannot update it`);
  }
  summary(task) {
    return {
      taskId: task.id, workstream: task.workstream, goalVersion: task.version,
      ownerSessionId: task.owner, callerSessionId: task.caller,
      status: task.status, summary: task.summary, updatedAt: task.updated,
      ...(task.active_op ? { pendingOperationId: task.active_op } : {}),
    };
  }
  operation(id) {
    const op = this.store.get('SELECT * FROM operations WHERE id=?', id);
    fail(!op, 'NOT_FOUND', 'Operation not found', 404);
    return op;
  }
  operationSummary(id) {
    const op = this.operation(id);
    return {
      operationId: op.id, kind: op.kind, goalVersion: op.version, status: op.status,
      ...(op.step ? { step: op.step } : {}), ...(op.error ? { error: op.error } : {}),
      completedSteps: Object.keys(JSON.parse(op.steps)),
      metrics: JSON.parse(op.metrics),
    };
  }
  result(id) {
    const op = this.operation(id);
    return { task: this.summary(this.store.task(op.task_id)), operation: this.operationSummary(id) };
  }
  read(principal, input) {
    const s = this.store;
    if (input.taskId) {
      fail(input.view === 'board', 'INVALID_QUERY', 'board cannot be combined with taskId', 400);
      const task = s.task(input.taskId);
      fail(!this.visible(principal, task), 'FORBIDDEN', 'Task is outside credential scope', 403);
      if (input.view === 'events') {
        const items = s.all('SELECT * FROM events WHERE task_id=? AND seq<? ORDER BY seq DESC LIMIT ?',
          task.id, input.before ?? Number.MAX_SAFE_INTEGER, input.limit + 1);
        const more = items.length > input.limit;
        return { items: items.slice(0, input.limit).map(e => ({
          seq: e.seq, goalVersion: e.version, kind: e.kind, summary: e.summary,
          artifacts: JSON.parse(e.artifacts), at: e.created,
        })), nextBefore: more ? items[input.limit - 1].seq : null };
      }
      if (input.view === 'board') {
        fail(input.before || input.group || input.status, 'INVALID_QUERY', 'board returns independent first pages; page with group + summary', 400);
        return { groups: Object.fromEntries(Object.keys(statusGroups).map(group => [group, this.read(principal, { ...input, view: 'summary', group })])) };
      }
      if (input.view === 'operations') {
        const items = s.all('SELECT rowid,id FROM operations WHERE task_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?',
          task.id, input.before ?? Number.MAX_SAFE_INTEGER, input.limit + 1);
        return { items: items.slice(0, input.limit).map(op => this.operationSummary(op.id)),
          nextBefore: items.length > input.limit ? items[input.limit - 1].rowid : null };
      }
      const result = this.summary(task);
      if (input.view === 'detail') Object.assign(result, {
        goal: JSON.parse(s.get('SELECT goal FROM versions WHERE task_id=? AND version=?', task.id, task.version).goal),
        acceptedGoalVersion: task.accepted_version, artifacts: JSON.parse(task.artifacts),
        ownerUrl: task.owner ? `${this.cockpitWeb}/session/${encodeURIComponent(task.owner)}` : null,
        callerUrl: `${this.cockpitWeb}/session/${encodeURIComponent(task.caller)}`,
        workUrl: `${this.publicUrl}/#${task.id}`,
      });
      return result;
    }
    fail(input.view !== 'summary', 'INVALID_QUERY', 'Select taskId for detail/events/operations', 400);
    const where = []; const args = [];
    if (principal.role === 'caller') { where.push('caller=?'); args.push(principal.session_id); }
    else if (principal.role === 'owner') { where.push('id=? AND owner=?'); args.push(principal.task_id, principal.session_id); }
    else fail(!['viewer', 'admin'].includes(principal.role), 'FORBIDDEN', 'Unknown credential role', 403);
    if (input.status) { where.push('status=?'); args.push(input.status); }
    if (input.group) {
      const statuses = statusGroups[input.group];
      where.push(`status IN (${statuses.map(() => '?').join(',')})`); args.push(...statuses);
    }
    where.push('activity<?'); args.push(input.before ?? Number.MAX_SAFE_INTEGER, input.limit + 1);
    const items = s.all(`SELECT * FROM (
      SELECT tasks.*, (SELECT MAX(seq) FROM events WHERE task_id=tasks.id) AS activity FROM tasks
    ) WHERE ${where.join(' AND ')} ORDER BY activity DESC LIMIT ?`, ...args);
    return { items: items.slice(0, input.limit).map(t => this.summary(t)),
      nextBefore: items.length > input.limit ? items[input.limit - 1].activity : null };
  }
  async execute(principal, name, raw) {
    fail(!Object.hasOwn(schemas, name), 'UNKNOWN_TOOL', 'Unknown work operation', 404);
    const input = schemas[name].parse(raw);
    if (name === 'work_read') return this.read(principal, input);
    const expectedRole = ['work_report', 'work_deliver'].includes(name) ? 'owner' : 'caller';
    this.authorize(principal, expectedRole);
    const requestHash = hash(canonical({ name, input }));
    let run = false;
    const stored = this.store.tx(() => {
      const previous = this.store.get('SELECT * FROM mutations WHERE principal=? AND key=?', principal.digest, input.idempotencyKey);
      if (previous) {
        fail(previous.request_hash !== requestHash, 'IDEMPOTENCY_CONFLICT', 'Key already used for different input');
        return JSON.parse(previous.response);
      }
      let response;
      if (name === 'work_dispatch') { response = this.dispatch(principal, input); run = true; }
      else if (name === 'work_recover') { response = this.recover(principal, input); run = true; }
      else {
        const task = this.store.task(input.taskId);
        this.authorize(principal, expectedRole, task); this.current(task, input.goalVersion);
        if (name === 'work_amend') response = this.amend(task, input);
        else if (name === 'work_report') response = this.report(task, input);
        else { response = this.deliver(task, input); run = true; }
      }
      this.store.run('INSERT INTO mutations(principal,key,request_hash,response) VALUES(?,?,?,?)',
        principal.digest, input.idempotencyKey, requestHash, JSON.stringify(response));
      return response;
    });
    this.changed();
    if (stored.operationId) {
      if (run) await this.runOperation(stored.operationId);
      return this.result(stored.operationId);
    }
    return stored;
  }
  newOperation(task, kind, request) {
    fail(task.active_op, 'OPERATION_PENDING', `Resolve operation ${task.active_op} before another dispatch/change/delivery`);
    const id = uid();
    this.store.run('INSERT INTO operations(id,task_id,version,kind,request,status,created,updated) VALUES(?,?,?,?,?,?,?,?)',
      id, task.id, task.version, kind, JSON.stringify(request), 'running', now(), now());
    this.store.run('UPDATE tasks SET active_op=? WHERE id=?', id, task.id);
    return { operationId: id };
  }
  lock(sessionId, opId) {
    const lock = this.store.get('SELECT operation_id FROM session_locks WHERE session_id=?', sessionId);
    fail(lock && lock.operation_id !== opId, 'SESSION_CONFLICT', `Session reserved by operation ${lock?.operation_id}`);
    this.store.run('INSERT OR IGNORE INTO session_locks(session_id,operation_id) VALUES(?,?)', sessionId, opId);
  }
  dispatch(principal, input) {
    let task;
    if (input.selection === 'continue') {
      task = this.store.task(input.taskId); this.authorize(principal, 'caller', task); this.current(task, input.goalVersion);
      fail(terminal.has(task.status), 'TERMINAL_GOAL', 'Explicitly amend the goal/authorization before reopening');
      fail(!task.owner, 'NO_OWNER', 'Recover the original dispatch; do not create a replacement');
    } else {
      fail(this.store.get('SELECT id FROM tasks WHERE workstream=?', input.workstream), 'WORKSTREAM_EXISTS', 'Existing goal must continue its original task');
      const id = uid();
      this.store.run('INSERT INTO tasks(id,workstream,caller,version,status,summary,created,updated) VALUES(?,?,?,?,?,?,?,?)',
        id, input.workstream, principal.session_id, 1, 'recorded', 'Goal recorded; owner not yet dispatched', now(), now());
      this.store.run('INSERT INTO versions(task_id,version,goal,reason,created) VALUES(?,?,?,?,?)',
        id, 1, JSON.stringify(input.goal), 'Explicit initial assignment', now());
      task = this.store.task(id); this.store.event(task, 'created', 'Explicit goal recorded');
    }
    const response = this.newOperation(task, 'dispatch', input);
    if (task.owner) this.lock(task.owner, response.operationId);
    if (input.sourceSessionId) this.lock(input.sourceSessionId, response.operationId);
    return response;
  }
  amend(task, input) {
    fail(task.active_op, 'OPERATION_PENDING', `Resolve ${task.active_op} before changing the goal`);
    const next = task.version + 1;
    this.store.run('INSERT INTO versions(task_id,version,goal,reason,created) VALUES(?,?,?,?,?)',
      task.id, next, JSON.stringify(input.goal), input.reason, now());
    this.store.run(`UPDATE tasks SET version=?,accepted_version=NULL,status='recorded',summary=?,artifacts='[]',updated=? WHERE id=?`,
      next, `Goal changed; explicit dispatch required: ${input.reason}`, now(), task.id);
    const updated = this.store.task(task.id); this.store.event(updated, 'amended', input.reason);
    return { task: this.summary(updated) };
  }
  report(task, input) {
    fail(terminal.has(task.status), 'TERMINAL_GOAL', 'Goal already closed; no late progress');
    if (input.kind !== 'accepted') fail(task.accepted_version !== task.version, 'NOT_ACCEPTED', 'Accept this goal version first');
    else {
      fail(task.accepted_version === task.version, 'ALREADY_ACCEPTED', 'Goal already accepted; report progress instead');
      this.store.run('UPDATE tasks SET accepted_version=? WHERE id=?', task.version, task.id);
    }
    const status = { accepted: 'active', progress: 'active', blocked: 'blocked', needs_decision: 'needs_decision', result: 'result_reported' }[input.kind];
    this.store.run('UPDATE tasks SET status=?,summary=?,artifacts=?,updated=? WHERE id=?',
      status, input.summary, JSON.stringify(input.artifacts), now(), task.id);
    this.store.event(task, input.kind, input.summary, input.artifacts);
    return { task: this.summary(this.store.task(task.id)), notification: 'not_sent' };
  }
  deliver(task, input) {
    fail(terminal.has(task.status), 'ALREADY_DELIVERED', 'This version already has a final outcome');
    fail(task.accepted_version !== task.version, 'NOT_ACCEPTED', 'Accept this goal version first');
    fail(input.outcome === 'delivered' && input.artifacts.length === 0, 'MISSING_RESULT', 'Delivery requires a locatable result');
    const response = this.newOperation(task, 'notification', input);
    this.store.run('UPDATE tasks SET status=?,summary=?,artifacts=?,updated=? WHERE id=?',
      input.outcome, input.summary, JSON.stringify(input.artifacts), now(), task.id);
    this.store.event(task, input.outcome, input.summary, input.artifacts);
    // The final result commits before any notification. Notification failure cannot erase it.
    return response;
  }
  recover(principal, input) {
    const op = this.operation(input.operationId), task = this.store.task(op.task_id);
    this.authorize(principal, 'caller', task); this.current(task, op.version);
    fail(!['failed', 'unknown'].includes(op.status), 'NOT_RECOVERABLE', `Operation is ${op.status}`);
    if (op.status === 'unknown') {
      fail(!input.resolution, 'RESOLUTION_REQUIRED', `Resolve unknown ${op.step} with external evidence, not a blind retry`);
      const resolution = input.resolution;
      const steps = JSON.parse(op.steps);
      if (resolution.outcome === 'applied') {
        fail(op.step === 'create' && !resolution.sessionId, 'SESSION_ID_REQUIRED', 'Confirmed create/fork requires the real session ID');
        fail(op.step !== 'create' && resolution.sessionId, 'INVALID_RESOLUTION', 'sessionId only applies to creation');
        steps[op.step] = op.step === 'create' ? { sessionId: resolution.sessionId } : { recovered: true };
      }
      this.store.run('UPDATE operations SET steps=? WHERE id=?', JSON.stringify(steps), op.id);
      this.store.event(task, 'recovery', `${op.id}: ${op.step} ${resolution.outcome}; ${resolution.evidence}`);
    } else fail(input.resolution, 'UNNEEDED_RESOLUTION', 'No unknown side effect exists for this operation');
    this.store.run("UPDATE operations SET status='running',inflight=0,error=NULL,updated=? WHERE id=?", now(), op.id);
    return { operationId: op.id };
  }
  async step(id, name, action) {
    const op = this.operation(id), steps = JSON.parse(op.steps);
    if (Object.hasOwn(steps, name)) return steps[name];
    this.store.run('UPDATE operations SET step=?,inflight=1,updated=? WHERE id=?', name, now(), id);
    let result;
    try { result = await action(); }
    catch (error) {
      if (!(error instanceof EffectUnknown)) this.store.run('UPDATE operations SET inflight=0 WHERE id=?', id);
      throw error;
    }
    steps[name] = result;
    this.store.run('UPDATE operations SET steps=?,inflight=0,updated=? WHERE id=?', JSON.stringify(steps), now(), id);
    return result;
  }
  checkpoint(id, name) {
    this.store.run('UPDATE operations SET step=?,inflight=0,updated=? WHERE id=?', name, now(), id);
  }
  bindOwner(taskId, sessionId, opId) {
    this.store.tx(() => {
      const task = this.store.task(taskId);
      fail(task.owner && task.owner !== sessionId, 'OWNER_CONFLICT', 'Task already has another owner');
      const other = this.store.get('SELECT id FROM tasks WHERE owner=? AND id<>?', sessionId, taskId);
      fail(other, 'OWNER_REUSED', 'A session cannot own two independent goals');
      fail(task.caller === sessionId, 'CALLER_IS_OWNER', 'Discussion and owner sessions must be distinct');
      this.lock(sessionId, opId);
      this.store.run('UPDATE tasks SET owner=?,updated=? WHERE id=?', sessionId, now(), taskId);
    });
  }
  ensureOwnerCredential(task) {
    if (task.credential_path) return task.credential_path;
    const token = this.store.issue('owner', task.owner, task.id);
    const path = this.store.credentialFile(token, `owner-${task.id}-${uid()}`);
    this.store.run('UPDATE tasks SET credential_path=? WHERE id=?', path, task.id);
    return path;
  }
  prompt(task, input, credential) {
    const goal = JSON.parse(this.store.get('SELECT goal FROM versions WHERE task_id=? AND version=?', task.id, task.version).goal);
    return [
      'Use skill work-commander-owner. You are the sole owner of ONE complete goal.',
      `taskId=${task.id}; goalVersion=${task.version}; workstream=${task.workstream}`,
      `owner_session_id=${task.owner}; caller_session_id=${task.caller}`,
      `MCP work-commander credential=${credential} (path, not token; do not display file contents).`,
      `Objective: ${goal.objective}`, `Scope: ${goal.scope}`, `Acceptance: ${goal.acceptance}`, `Authorization: ${goal.authorization}`,
      input.message ? `Current instruction: ${input.message}` : '',
      'Read the current task if needed, accept this version with work_report, then own the full result. Report only meaningful progress to service; do not chat-notify caller.',
      'Acknowledge the current version, never inherit old execution permissions or callbacks. New/forked session is NOT a worktree/database isolation.',
      'Decisions/blockers: ask the user in THIS owner session. Finish ordinary work autonomously without stage-by-stage reassignment.',
      'Final: work_deliver persists the full outcome and notifies the bound caller. Do NOT send any separate caller final/ACK. Then deliver normally in this session.',
    ].filter(Boolean).join('\n');
  }
  async prepare(id, sessionId, input) {
    this.checkpoint(id, 'inspect');
    let meta = await this.cockpit.meta(sessionId);
    if (!meta.loaded) {
      // Cold resume reapplies native defaults. Prior connection/model checkpoints
      // cannot stand in for the configuration of a newly loaded native runtime.
      const steps = JSON.parse(this.operation(id).steps);
      for (const key of ['resume', 'mcp', 'skill', 'model']) delete steps[key];
      this.store.run('UPDATE operations SET steps=? WHERE id=?', JSON.stringify(steps), id);
      await this.step(id, 'resume', async () => {
        await this.cockpit.call('session/reload', { sessionId }); return { acknowledged: true };
      });
      this.checkpoint(id, 'inspect');
      meta = await this.cockpit.meta(sessionId);
    }
    const matches = m => m.currentModelId === input.modelId &&
      (input.reasoningEffort === undefined || m.currentReasoningEffort === input.reasoningEffort) &&
      (input.contextTier === undefined || m.currentContextTier === input.contextTier);
    if (!matches(meta)) {
      fail(busy(meta), 'BUSY_MODEL_MISMATCH', 'Session is busy; model was not changed and no prompt sent');
      await this.step(id, 'model', async () => {
        await this.cockpit.call('setModel', {
          sessionId, modelId: input.modelId,
          ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
          ...(input.contextTier ? { contextTier: input.contextTier } : {}),
        });
        return { acknowledged: true };
      });
      this.checkpoint(id, 'confirm_model');
      meta = await this.cockpit.meta(sessionId);
      fail(!matches(meta), 'MODEL_NOT_CONFIRMED', 'Requested model settings are not yet applied; no prompt sent');
    }
    return meta;
  }
  async runDispatch(op) {
    const input = JSON.parse(op.request), id = op.id;
    let task = this.store.task(op.task_id);
    if (!task.owner) {
      if (input.selection === 'fork' && !JSON.parse(op.steps).create) {
        this.checkpoint(id, 'inspect_source');
        const source = await this.cockpit.meta(input.sourceSessionId);
        fail(!source.loaded || busy(source), 'FORK_SOURCE_NOT_READY', 'Fork requires an explicitly loaded idle source; no automatic source resume');
      }
      const created = await this.step(id, 'create', async () => {
        const result = await this.cockpit.call(input.selection === 'fork' ? 'session/fork' : 'session/new',
          input.selection === 'fork' ? {
            sessionId: input.sourceSessionId, ...(input.toEventId ? { toEventId: input.toEventId } : {}),
          } : { cwd: input.cwd });
        if (!result.sessionId || typeof result.sessionId !== 'string') throw new EffectUnknown('Creation returned no valid session ID');
        return { sessionId: result.sessionId };
      });
      this.checkpoint(id, 'bind_owner');
      this.bindOwner(task.id, created.sessionId, id);
      task = this.store.task(task.id);
    }
    const completed = JSON.parse(this.operation(id).steps);
    if (!completed.prompt) {
      await this.prepare(id, task.owner, input);
      this.checkpoint(id, 'owner_credential');
      const credential = this.ensureOwnerCredential(task);
      await this.step(id, 'mcp', async () => {
        const result = await this.cockpit.call('mcp/session-toggle', { sessionId: task.owner, name: 'work-commander', on: true });
        if (result.status && result.status !== 'connected') throw new EffectUnknown('MCP enablement not confirmed connected');
        return { acknowledged: true };
      });
      await this.step(id, 'skill', async () => {
        await this.cockpit.call('skills/session-toggle', { sessionId: task.owner, name: 'work-commander-owner', enabled: true });
        return { acknowledged: true };
      });
      await this.step(id, 'prompt', async () => {
        const result = await this.cockpit.call('prompt', { sessionId: task.owner, text: this.prompt(task, input, credential), mode: 'enqueue' });
        return { accepted: true, queued: result.queued ?? null };
      });
    }
    this.store.tx(() => {
      // A fast owner may already have accepted while the prompt acknowledgement was in flight.
      this.store.run(`UPDATE tasks SET status=CASE WHEN status='recorded' THEN 'dispatched' ELSE status END,updated=? WHERE id=?`, now(), task.id);
      this.store.event(this.store.task(task.id), 'dispatch_accepted', 'Native prompt accepted; this is not owner acceptance or goal completion');
    });
  }
  async runNotification(op) {
    const task = this.store.task(op.task_id);
    this.checkpoint(op.id, 'notification_lock');
    this.store.tx(() => this.lock(task.caller, op.id));
    await this.step(op.id, 'notify', async () => {
      const result = await this.cockpit.call('prompt', {
        sessionId: task.caller, mode: 'enqueue',
        text: `workstream=${task.workstream}; taskId=${task.id}; goalVersion=${op.version}; final=${task.status}\nResult: ${task.summary}\nDetails: ${this.publicUrl}/#${task.id}\nOwner: ${this.cockpitWeb}/session/${task.owner}\nThis is the service's sole final notification. Record this goal version only; no ACK, auto-follow-up, or historical replay.`,
      });
      return { accepted: true, queued: result.queued ?? null };
    });
    this.store.event(task, 'notification_accepted', `Final notification accepted for caller ${task.caller}; reading by caller is not confirmed`);
  }
  async runOperation(id) {
    const op = this.operation(id);
    const action = async () => {
      if (op.kind === 'dispatch') await this.runDispatch(op);
      else await this.runNotification(op);
    };
    try {
      if (this.cockpit.track) {
        await this.cockpit.track((name, bytes, started) => {
          const metrics = JSON.parse(this.operation(id).metrics);
          metrics.responseBytes += bytes;
          if (started) { metrics.calls++; metrics.byIntent[name] = (metrics.byIntent[name] ?? 0) + 1; }
          this.store.run('UPDATE operations SET metrics=? WHERE id=?', JSON.stringify(metrics), id);
        }, action);
      } else await action();
      this.store.tx(() => {
        this.store.run("UPDATE operations SET status='succeeded',inflight=0,error=NULL,updated=? WHERE id=?", now(), id);
        this.store.run('UPDATE tasks SET active_op=NULL WHERE id=? AND active_op=?', op.task_id, id);
        this.store.run('DELETE FROM session_locks WHERE operation_id=?', id);
      });
    } catch (error) {
      const current = this.operation(id);
      const unknown = error instanceof EffectUnknown || current.inflight === 1;
      this.store.run('UPDATE operations SET status=?,error=?,updated=? WHERE id=?',
        unknown ? 'unknown' : 'failed', `${error.code ?? 'OPERATION_FAILED'}: ${error.message}`.slice(0, 1000), now(), id);
      this.store.event(this.store.task(op.task_id), 'operation_attention', `Operation ${id}: ${unknown ? 'unknown effect' : 'failed'} at ${current.step}`);
    }
    this.changed();
  }
}
