import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { LIMITS, TaskError, parseInput, definitionFits } from './contracts.js';

export { TaskError } from './contracts.js';
const terminal = status => status === 'done' || status === 'cancelled';
const now = () => new Date().toISOString();
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const fail = (code, message, status = 409, result = null) => { throw new TaskError(code, message, status, result); };
function decode(value, code) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (encode(parsed) !== value) throw new Error();
    return parsed;
  } catch { fail(code, `Invalid ${code === 'INVALID_CURSOR' ? 'cursor' : 'write_context'}`, 400); }
}

export class TaskStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, 'task-board.sqlite');
    this.db = new DatabaseSync(file);
    try {
      chmodSync(file, 0o600);
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > 2) fail('SCHEMA_TOO_NEW', 'Task database requires a newer module version', 500);
      this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS tasks (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL, description TEXT NOT NULL, owner TEXT NOT NULL,
        executor TEXT, status TEXT NOT NULL DEFAULT 'todo',
        revision INTEGER NOT NULL DEFAULT 1, acknowledged_revision INTEGER,
        refs TEXT NOT NULL, metadata TEXT NOT NULL,
        lifecycle INTEGER NOT NULL DEFAULT 1, editable INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, cancellation TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS executor_occupancy ON tasks(executor)
        WHERE executor IS NOT NULL AND status NOT IN ('done','cancelled');
      CREATE TABLE IF NOT EXISTS definitions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
        revision INTEGER NOT NULL, description TEXT NOT NULL, reason TEXT NOT NULL,
        author TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(task_id,revision)
      );
      CREATE TABLE IF NOT EXISTS acknowledgements (
        task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL,
        confirmed_for TEXT NOT NULL, author TEXT NOT NULL, at TEXT NOT NULL,
        PRIMARY KEY(task_id, revision), FOREIGN KEY(task_id,revision) REFERENCES definitions(task_id,revision)
      );
      CREATE TABLE IF NOT EXISTS activities (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL,
        executor TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outcomes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL,
        executor TEXT NOT NULL, author TEXT NOT NULL, summary TEXT NOT NULL,
        refs TEXT NOT NULL, at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operations (
        request_id TEXT PRIMARY KEY, tool TEXT NOT NULL, fingerprint TEXT NOT NULL,
        input TEXT NOT NULL, status TEXT NOT NULL, result TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, binding_context TEXT,
        resumed_by TEXT
      );
      CREATE INDEX IF NOT EXISTS activities_task ON activities(task_id,seq);
      CREATE INDEX IF NOT EXISTS outcomes_task ON outcomes(task_id,seq);
      CREATE INDEX IF NOT EXISTS definitions_task ON definitions(task_id,seq);
      CREATE TABLE IF NOT EXISTS subscriptions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(id), owner TEXT NOT NULL,
        actor_session_id TEXT NOT NULL, statuses TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('waiting','triggered','cancelled','expired')),
        created_at TEXT NOT NULL, ended_at TEXT, ended_by TEXT, event TEXT,
        delivery_status TEXT NOT NULL DEFAULT 'not_requested'
          CHECK(delivery_status IN ('not_requested','pending','unknown','accepted','queued','not_sent')),
        attempted_at TEXT, completed_at TEXT, delivery_error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_waiting_owner ON subscriptions(task_id,owner) WHERE state='waiting';
      CREATE INDEX IF NOT EXISTS subscriptions_task ON subscriptions(task_id,seq);
      CREATE INDEX IF NOT EXISTS subscriptions_pending ON subscriptions(seq) WHERE delivery_status='pending';
      PRAGMA user_version=2;
      COMMIT;
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  row(id) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!row) fail('TASK_NOT_FOUND', `Task ${id} does not exist`, 404);
    return row;
  }
  context(row) { return encode({ v: 1, task: row.id, lifecycle: row.lifecycle, editable: row.editable }); }
  checkContext(row, input, editable = false) {
    const context = decode(input.write_context, 'INVALID_WRITE_CONTEXT');
    if (context?.v !== 1 || context.task !== row.id || !Number.isSafeInteger(context.lifecycle) || !Number.isSafeInteger(context.editable)) {
      fail('INVALID_WRITE_CONTEXT', 'write_context is not a context for this Task', 400);
    }
    if (context.lifecycle !== row.lifecycle) fail('TASK_STATE_CONFLICT', 'Task assignment or lifecycle changed; read fresh write_context');
    if (editable && context.editable !== row.editable) fail('EDIT_CONFLICT', 'Task title or materials changed; read fresh write_context');
  }
  currentRevision(row, input) {
    if (input.revision !== row.revision) fail('DESCRIPTION_UPDATED', 'Task description has changed; read the current definition before retrying');
  }
  executable(row) {
    if (terminal(row.status)) fail('TASK_STATE_CONFLICT', 'Terminal Tasks cannot accept execution or acknowledgement');
    if (!row.executor) fail('ASSIGNMENT_REQUIRED', 'Task has no fixed Executor');
  }
  summary(row) {
    return {
      id: row.id, task_id: row.id, title: row.title, owner: row.owner, executor: row.executor,
      status: row.status, revision: row.revision, acknowledged_revision: row.acknowledged_revision,
      created_at: row.created_at, updated_at: row.updated_at, write_context: this.context(row),
    };
  }
  task(id) {
    const row = this.row(id);
    return { ...this.summary(row), description: row.description, references: JSON.parse(row.refs), metadata: JSON.parse(row.metadata) };
  }
  effects(row, status = 'applied') {
    return { status, task_id: row.id, revision: row.revision, acknowledged_revision: row.acknowledged_revision, task_status: row.status, executor: row.executor, write_context: this.context(row) };
  }
  operation(requestId) {
    const row = this.db.prepare('SELECT * FROM operations WHERE request_id=?').get(requestId);
    if (!row) fail('OPERATION_NOT_FOUND', 'Operation does not exist', 404);
    const input = JSON.parse(row.input);
    return {
      request_id: row.request_id, tool: row.tool, status: row.status,
      ...(typeof input.task_id === 'string' ? { task_id: input.task_id } : {}),
      result: row.result ? JSON.parse(row.result) : null, error: row.error ? JSON.parse(row.error) : null,
      created_at: row.created_at, updated_at: row.updated_at,
    };
  }
  receipt(name, input) {
    const existing = this.db.prepare('SELECT * FROM operations WHERE request_id=?').get(input.request_id);
    if (existing && existing.fingerprint !== hash({ tool: name, input })) {
      fail('REQUEST_ID_CONFLICT', 'request_id was already used with different input');
    }
    return existing;
  }
  insertReceipt(name, input, result = null) {
    const at = now();
    this.db.prepare('INSERT INTO operations(request_id,tool,fingerprint,input,status,result,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(input.request_id, name, hash({ tool: name, input }), JSON.stringify(input), 'pending', JSON.stringify(result), at, at);
  }
  saveReceipt(requestId, result, error, final = true) {
    const changed = this.db.prepare('UPDATE operations SET status=?,result=?,error=?,updated_at=? WHERE request_id=?')
      .run(final ? 'final' : 'pending', JSON.stringify(result), error ? JSON.stringify(error) : null, now(), requestId);
    if (!changed.changes) fail('OPERATION_NOT_FOUND', 'Operation does not exist', 404);
  }
  reserveOperation(name, rawInput) {
    const input = parseInput(name, rawInput);
    if (!['task_assign', 'task_session_create', 'task_session_prepare'].includes(name)) fail('INVALID_OPERATION', 'Only external operations require reservation', 400);
    return this.transaction(() => {
      if (this.receipt(name, input)) {
        const receipt = this.operation(input.request_id);
        return {
          replay: true, ...receipt,
          error: receipt.status === 'pending'
            ? { code: 'OPERATION_UNCONFIRMED', message: 'External operation is still pending or was interrupted; its host call must not be repeated' }
            : receipt.error,
        };
      }
      const operation = { request_id: input.request_id, status: 'unconfirmed', ...(input.task_id ? { task_id: input.task_id } : {}), message: 'External operation reserved; do not repeat an unconfirmed host call' };
      this.insertReceipt(name, input, { operation });
      return { replay: false, ...this.operation(input.request_id) };
    });
  }
  saveOperation(requestId, { result, error = null }, { final = result?.operation?.status !== 'running' } = {}) {
    return this.transaction(() => {
      const receipt = this.operation(requestId);
      if (receipt.status === 'final') {
        if (canonical(receipt.result) !== canonical(result) || canonical(receipt.error) !== canonical(error)) {
          fail('OPERATION_FINALIZED', 'A finalized operation cannot be overwritten');
        }
        return receipt;
      }
      this.saveReceipt(requestId, result, error, final);
      return this.operation(requestId);
    });
  }
  executeLocal(name, rawInput) {
    const input = parseInput(name, rawInput);
    if (name === 'task_read') return this.read(input);
    const handlers = {
      task_create: 'create', task_edit: 'edit', task_ack: 'ack', task_report: 'report', task_cancel: 'cancel',
      task_subscribe: 'subscribe', task_unsubscribe: 'unsubscribe',
    };
    if (!handlers[name]) fail('EXTERNAL_OPERATION_REQUIRED', 'This tool requires the host operation service', 400);
    const receipt = this.transaction(() => {
      if (this.receipt(name, input)) return this.operation(input.request_id);
      this.insertReceipt(name, input);
      // A savepoint prevents all business failures except explicitly returned stale-field results.
      this.db.exec('SAVEPOINT mutation');
      try {
        const { result, error = null } = this[handlers[name]](input);
        this.db.exec('RELEASE mutation');
        this.saveReceipt(input.request_id, result, error);
      } catch (error) {
        this.db.exec('ROLLBACK TO mutation; RELEASE mutation');
        if (!(error instanceof TaskError)) throw error;
        this.saveReceipt(input.request_id, error.result, { code: error.code, message: error.message, status: error.status });
      }
      return this.operation(input.request_id);
    });
    if (receipt.error) throw new TaskError(receipt.error.code, receipt.error.message, receipt.error.status || 409, receipt.result);
    return receipt.result;
  }
  create(input) {
    const id = randomUUID(), at = now();
    this.db.prepare('INSERT INTO tasks(id,title,description,owner,refs,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, input.title, input.description, input.owner, JSON.stringify(input.references || []), JSON.stringify(input.metadata || {}), at, at);
    this.db.prepare('INSERT INTO definitions(task_id,revision,description,reason,author,at) VALUES(?,?,?,?,?,?)')
      .run(id, 1, input.description, 'Initial definition', input.actor_session_id, at);
    return { result: this.effects(this.row(id)) };
  }
  edit(input) {
    const row = this.row(input.task_id);
    this.checkContext(row, input, true);
    this.currentRevision(row, input);
    const descriptionChanged = input.description !== undefined && input.description !== row.description;
    const references = input.references === undefined ? row.refs : JSON.stringify(input.references);
    const metadata = input.metadata === undefined ? row.metadata : JSON.stringify(input.metadata);
    if (!definitionFits({ description: input.description ?? row.description, references: JSON.parse(references), metadata: JSON.parse(metadata) })) {
      fail('INVALID_INPUT', 'Combined serialized description and materials exceed 64000 characters', 400);
    }
    const metadataChanged = (input.title !== undefined && input.title !== row.title)
      || canonical(JSON.parse(references)) !== canonical(JSON.parse(row.refs))
      || canonical(JSON.parse(metadata)) !== canonical(JSON.parse(row.metadata));
    if (!descriptionChanged && !metadataChanged) return { result: this.effects(row, 'unchanged') };
    const revision = row.revision + Number(descriptionChanged), at = now();
    this.db.prepare('UPDATE tasks SET title=?,description=?,refs=?,metadata=?,revision=?,editable=editable+?,updated_at=? WHERE id=?')
      .run(input.title ?? row.title, input.description ?? row.description, references, metadata, revision, Number(metadataChanged), at, row.id);
    if (descriptionChanged) {
      this.db.prepare('INSERT INTO definitions(task_id,revision,description,reason,author,at) VALUES(?,?,?,?,?,?)')
        .run(row.id, revision, input.description, input.reason, input.actor_session_id, at);
      if (!terminal(row.status) && row.executor === input.actor_session_id) this.recordAck(this.row(row.id), input.actor_session_id);
    }
    return { result: { ...this.effects(this.row(row.id)), description_changed: descriptionChanged, metadata_changed: metadataChanged } };
  }
  recordAck(row, author) {
    this.db.prepare('INSERT OR IGNORE INTO acknowledgements(task_id,revision,confirmed_for,author,at) VALUES(?,?,?,?,?)')
      .run(row.id, row.revision, row.executor, author, now());
    this.db.prepare('UPDATE tasks SET acknowledged_revision=?,updated_at=? WHERE id=?').run(row.revision, now(), row.id);
  }
  ack(input) {
    const row = this.row(input.task_id);
    this.checkContext(row, input);
    this.executable(row);
    this.currentRevision(row, input);
    if (row.acknowledged_revision === row.revision) return { result: this.effects(row, 'unchanged') };
    this.recordAck(row, input.actor_session_id);
    return { result: this.effects(this.row(row.id)) };
  }
  report(input) {
    const row = this.row(input.task_id);
    this.checkContext(row, input);
    this.executable(row);
    const ack = this.db.prepare('SELECT 1 FROM acknowledgements WHERE task_id=? AND revision=? AND confirmed_for=?')
      .get(row.id, input.revision, row.executor);
    if (!ack) fail('ACK_REQUIRED', 'The fixed Executor has not acknowledged the specified revision');
    const stale = input.revision !== row.revision;
    const field = requested => ({ status: requested ? 'rejected' : 'not_requested' });
    const fields = { activity: field(input.activity), task_status: field(input.status), outcome: field(input.outcome) };
    const at = now();
    let subscription_ids = [];
    if (input.activity) {
      const id = randomUUID();
      this.db.prepare('INSERT INTO activities(id,task_id,revision,executor,author,text,at) VALUES(?,?,?,?,?,?,?)')
        .run(id, row.id, input.revision, row.executor, input.actor_session_id, input.activity.text, at);
      fields.activity = { status: 'saved', id, revision: input.revision };
    }
    if (!stale) {
      if (input.outcome) {
        const id = randomUUID();
        this.db.prepare('INSERT INTO outcomes(id,task_id,revision,executor,author,summary,refs,at) VALUES(?,?,?,?,?,?,?,?)')
          .run(id, row.id, input.revision, row.executor, input.actor_session_id, input.outcome.summary, JSON.stringify(input.outcome.references || []), at);
        fields.outcome = { status: 'saved', id, revision: input.revision };
      }
      if (input.status) {
        this.db.prepare('UPDATE tasks SET status=?,lifecycle=lifecycle+? WHERE id=?').run(input.status, Number(input.status !== row.status), row.id);
        fields.task_status = { status: 'saved', value: input.status };
        subscription_ids = this.transitionSubscriptions(row, input.status, input, at);
      }
    }
    if (input.activity || (!stale && (input.status || input.outcome))) {
      this.db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(at, row.id);
    }
    const rejected = stale && Boolean(input.status || input.outcome);
    return {
      result: {
        ...this.effects(this.row(row.id), rejected ? (input.activity ? 'partially_applied' : 'rejected') : 'applied'), ...fields,
        ...(subscription_ids.length ? { subscription_ids } : {}),
      },
      error: rejected ? { code: 'DESCRIPTION_UPDATED', message: 'Task description has changed; requested status and outcome were not saved. Read the current definition; its acknowledgement belongs to the assigned Executor', status: 409 } : null,
    };
  }
  cancel(input) {
    const row = this.row(input.task_id);
    this.checkContext(row, input);
    if (row.status === 'cancelled') return { result: this.effects(row, 'unchanged') };
    if (row.status === 'done') fail('TASK_STATE_CONFLICT', 'A completed Task cannot be cancelled');
    const cancellation = { reason: input.reason, author: input.actor_session_id, source: 'reported', at: now() };
    this.db.prepare("UPDATE tasks SET status='cancelled',lifecycle=lifecycle+1,cancellation=?,updated_at=? WHERE id=?")
      .run(JSON.stringify(cancellation), cancellation.at, row.id);
    const subscription_ids = this.transitionSubscriptions(row, 'cancelled', input, cancellation.at);
    return { result: { ...this.effects(this.row(row.id)), cancellation, ...(subscription_ids.length ? { subscription_ids } : {}) } };
  }
  subscription(row) {
    return {
      subscription_id: row.id, task_id: row.task_id, owner: row.owner,
      actor_session_id: row.actor_session_id, statuses: JSON.parse(row.statuses), state: row.state,
      created_at: row.created_at, ended_at: row.ended_at, ended_by: row.ended_by,
      event: row.event ? JSON.parse(row.event) : null,
      notification: {
        status: row.delivery_status, attempted_at: row.attempted_at, completed_at: row.completed_at,
        error: row.delivery_error ? JSON.parse(row.delivery_error) : null,
      },
    };
  }
  getSubscription(id) {
    const row = this.db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id);
    if (!row) fail('SUBSCRIPTION_NOT_FOUND', 'Subscription does not exist', 404);
    return this.subscription(row);
  }
  subscribe(input) {
    const row = this.row(input.task_id);
    this.checkContext(row, input);
    if (input.statuses.includes(row.status)) fail('ALREADY_IN_TARGET_STATUS', 'Task is already in a target status; no subscription was created');
    if (terminal(row.status)) fail('TASK_STATE_CONFLICT', 'Terminal Tasks cannot transition; no subscription was created');
    if (this.db.prepare("SELECT 1 FROM subscriptions WHERE task_id=? AND owner=? AND state='waiting'").get(row.id, row.owner)) {
      fail('SUBSCRIPTION_EXISTS', 'This Task Owner already has a waiting subscription; inspect or cancel it explicitly');
    }
    const id = randomUUID();
    this.db.prepare("INSERT INTO subscriptions(id,task_id,owner,actor_session_id,statuses,state,created_at) VALUES(?,?,?,?,?,'waiting',?)")
      .run(id, row.id, row.owner, input.actor_session_id, JSON.stringify(input.statuses), now());
    return { result: { ...this.effects(row), subscription: this.getSubscription(id) } };
  }
  unsubscribe(input) {
    this.row(input.task_id);
    const subscription = this.getSubscription(input.subscription_id);
    if (subscription.task_id !== input.task_id) fail('SUBSCRIPTION_NOT_FOUND', 'Subscription does not belong to this Task', 404);
    if (subscription.state === 'cancelled') return { result: { status: 'unchanged', task_id: input.task_id, subscription } };
    if (subscription.state !== 'waiting') fail('SUBSCRIPTION_NOT_WAITING', 'Subscription already ended; a consumed notification cannot be recalled');
    this.db.prepare("UPDATE subscriptions SET state='cancelled',ended_at=?,ended_by=? WHERE id=? AND state='waiting'")
      .run(now(), input.actor_session_id, subscription.subscription_id);
    return { result: { status: 'applied', task_id: input.task_id, subscription: this.getSubscription(subscription.subscription_id) } };
  }
  transitionSubscriptions(row, status, input, at) {
    if (status === row.status) return [];
    const subscriptions = this.db.prepare("SELECT * FROM subscriptions WHERE task_id=? AND state='waiting'").all(row.id);
    const ids = [];
    for (const subscription of subscriptions) {
      if (JSON.parse(subscription.statuses).includes(status)) {
        const event = { event_id: randomUUID(), request_id: input.request_id, from_status: row.status, status, at, actor_session_id: input.actor_session_id };
        this.db.prepare("UPDATE subscriptions SET state='triggered',ended_at=?,event=?,delivery_status='pending' WHERE id=?")
          .run(at, JSON.stringify(event), subscription.id);
        ids.push(subscription.id);
      } else if (terminal(status)) {
        this.db.prepare("UPDATE subscriptions SET state='expired',ended_at=? WHERE id=?").run(at, subscription.id);
      }
    }
    return ids;
  }
  pendingNotificationBoundary() {
    return this.db.prepare("SELECT max(seq) AS seq FROM subscriptions WHERE delivery_status='pending'").get().seq ?? 0;
  }
  pendingNotifications(after, through, limit = 20) {
    return this.db.prepare("SELECT seq,id FROM subscriptions WHERE delivery_status='pending' AND seq>? AND seq<=? ORDER BY seq LIMIT ?")
      .all(after, through, limit);
  }
  claimNotification(id) {
    return this.transaction(() => {
      // Unknown is durable before any send. It is deliberately never a recovery candidate.
      const error = { code: 'NOTIFICATION_UNCONFIRMED', message: 'Notification attempt may be in flight or interrupted; inspect before taking any manual action. Never blindly resend.' };
      const changed = this.db.prepare("UPDATE subscriptions SET delivery_status='unknown',attempted_at=?,delivery_error=? WHERE id=? AND delivery_status='pending'")
        .run(now(), JSON.stringify(error), id);
      return changed.changes ? this.getSubscription(id) : null;
    });
  }
  finishNotification(id, expected, status, error = null) {
    return this.transaction(() => {
      this.db.prepare('UPDATE subscriptions SET delivery_status=?,delivery_error=?,completed_at=? WHERE id=? AND delivery_status=?')
        .run(status, error ? JSON.stringify(error) : null, now(), id, expected);
      return this.getSubscription(id);
    });
  }
  bindAssignment(rawInput) {
    const input = parseInput('task_assign', rawInput);
    return this.transaction(() => {
      const receipt = this.receipt('task_assign', input);
      if (!receipt || receipt.status !== 'pending') fail('OPERATION_NOT_PENDING', 'Assignment needs its own pending receipt');
      if (receipt.binding_context) fail('ASSIGNMENT_CONFLICT', 'This operation already bound the Task; do not repeat it');
      const row = this.row(input.task_id);
      this.checkContext(row, input);
      this.currentRevision(row, input);
      if (terminal(row.status)) fail('TASK_STATE_CONFLICT', 'Terminal Tasks cannot be assigned');
      if (input.resume_request_id) {
        const old = this.db.prepare('SELECT * FROM operations WHERE request_id=?').get(input.resume_request_id);
        const prior = old?.result ? JSON.parse(old.result)?.operation : null;
        const oldInput = old ? JSON.parse(old.input) : null;
        if (!old || old.tool !== 'task_assign' || old.status !== 'final' || old.resumed_by
          || oldInput.task_id !== input.task_id || oldInput.executor !== input.executor
          || prior?.message !== 'not_sent' || prior.assignment !== 'applied' || row.executor !== input.executor) {
          fail('UNSAFE_DISPATCH_RECOVERY', 'Recovery requires an unused finalized receipt proving this fixed assignment was not sent');
        }
        this.db.prepare('UPDATE operations SET resumed_by=? WHERE request_id=?').run(input.request_id, input.resume_request_id);
      } else {
        if (row.executor || row.status !== 'todo') fail('ASSIGNMENT_CONFLICT', 'Only an unassigned todo can be assigned');
        try {
          this.db.prepare('UPDATE tasks SET executor=?,lifecycle=lifecycle+1,updated_at=? WHERE id=?')
            .run(input.executor, now(), row.id);
        } catch (error) {
          if (error.code?.startsWith('ERR_SQLITE') && error.message.includes('tasks.executor')) {
            fail('EXECUTOR_OCCUPIED', 'Executor already has an unfinished Task');
          }
          throw error;
        }
      }
      const task = this.row(row.id);
      this.db.prepare('UPDATE operations SET binding_context=?,result=?,updated_at=? WHERE request_id=?')
        .run(this.context(task), JSON.stringify({ operation: { request_id: input.request_id, status: 'running', task_id: task.id, executor: task.executor, assignment: 'applied', message: 'not_sent', write_context: this.context(task) } }), now(), input.request_id);
      return this.summary(task);
    });
  }
  preparationPreflight(sessionId) {
    const task = this.db.prepare("SELECT id FROM tasks WHERE executor=? AND status NOT IN ('done','cancelled')").get(sessionId);
    if (task) fail('EXECUTOR_OCCUPIED', 'Select an Executor without an unfinished Task; preparation does not repair an existing assignment');
  }
  dispatchPreflight(rawInput) {
    const input = parseInput('task_assign', rawInput);
    const receipt = this.receipt('task_assign', input);
    if (!receipt || receipt.status !== 'pending' || !receipt.binding_context) fail('OPERATION_NOT_PENDING', 'No pending bound dispatch exists');
    const row = this.row(input.task_id);
    this.checkContext(row, { write_context: receipt.binding_context });
    this.currentRevision(row, input);
    this.executable(row);
    if (row.executor !== input.executor || row.status !== 'todo') fail('ASSIGNMENT_CONFLICT', 'Task is no longer awaiting this dispatch');
    return this.summary(row);
  }
  overview(row, includeCancellation = true) {
    const activity = this.db.prepare('SELECT id,revision,executor,author,text,at FROM activities WHERE task_id=? ORDER BY seq DESC LIMIT 1').get(row.id);
    const outcome = this.db.prepare('SELECT id,revision,at FROM outcomes WHERE task_id=? ORDER BY seq DESC LIMIT 1').get(row.id);
    return {
      ...this.summary(row),
      activity: activity ? { ...activity, source: 'reported', text: activity.text.slice(0, LIMITS.excerpt), truncated: activity.text.length > LIMITS.excerpt } : null,
      outcome: outcome ? { ...outcome, available: true, current: outcome.revision === row.revision } : { available: false },
      ...(includeCancellation && row.cancellation ? { cancellation: JSON.parse(row.cancellation) } : {}),
    };
  }
  cursor(input, scope) {
    if (!input.cursor) return Number.MAX_SAFE_INTEGER;
    const value = decode(input.cursor, 'INVALID_CURSOR');
    if (value?.v !== 1 || value.scope !== scope || !Number.isSafeInteger(value.before) || value.before < 1) fail('INVALID_CURSOR', 'Cursor does not match this view, Task or filter', 400);
    return value.before;
  }
  page(rows, limit, scope, project, extra = {}) {
    const items = [];
    let last;
    for (const row of rows.slice(0, limit)) {
      const item = project(row);
      // Reserve space for a continuation cursor even on a page that ends early.
      if (JSON.stringify({ ...extra, items: [...items, item], next_cursor: '' }).length + 256 > LIMITS.page) {
        if (!items.length) fail('RESULT_TOO_LARGE', 'A history entry exceeds the bounded page budget', 413);
        break;
      }
      items.push(item);
      last = row.seq;
    }
    return {
      ...extra, items,
      next_cursor: rows.length > items.length ? encode({ v: 1, scope, before: last }) : null,
    };
  }
  read(rawInput) {
    const input = parseInput('task_read', rawInput);
    if (input.view === 'operation') return this.operation(input.request_id);
    if (input.view === 'list') {
      const { owner, executor, query, status = 'unfinished' } = input;
      const scope = hash({ view: 'list', owner: owner ?? null, executor: executor ?? null, query: query ?? null, status });
      const clauses = ['seq < ?'], values = [this.cursor(input, scope)];
      if (owner) { clauses.push('owner=?'); values.push(owner); }
      if (executor) { clauses.push('executor=?'); values.push(executor); }
      if (status === 'unfinished') clauses.push("status NOT IN ('done','cancelled')");
      else if (status !== 'all') { clauses.push('status=?'); values.push(status); }
      if (query) { clauses.push('instr(lower(title), lower(?)) > 0'); values.push(query); }
      const limit = input.limit ?? 20;
      const rows = this.db.prepare(`SELECT * FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY seq DESC LIMIT ?`).all(...values, limit + 1);
      return this.page(rows, limit, scope, row => this.overview(row, false));
    }
    const row = this.row(input.task_id);
    if (input.view === 'subscriptions') {
      const scope = hash({ view: input.view, task_id: row.id });
      const limit = input.limit ?? 5;
      const rows = this.db.prepare('SELECT * FROM subscriptions WHERE task_id=? AND seq < ? ORDER BY seq DESC LIMIT ?')
        .all(row.id, this.cursor(input, scope), limit + 1);
      return this.page(rows, limit, scope, entry => this.subscription(entry), { task_id: row.id });
    }
    if (input.view === 'overview') return this.overview(row);
    if (input.view === 'execution' || input.view === 'definition') return this.task(row.id);
    if (input.view === 'changelog' && input.revision !== undefined) {
      const entry = this.db.prepare('SELECT revision,description,reason,author,at FROM definitions WHERE task_id=? AND revision=?').get(row.id, input.revision);
      if (!entry) fail('REVISION_NOT_FOUND', 'Definition revision does not exist', 404);
      return { task_id: row.id, ...entry, source: 'reported' };
    }
    const table = { changelog: 'definitions', activity: 'activities', outcomes: 'outcomes' }[input.view];
    const scope = hash({ view: input.view, task_id: row.id });
    const limit = input.limit ?? 5;
    const rows = this.db.prepare(`SELECT * FROM ${table} WHERE task_id=? AND seq < ? ORDER BY seq DESC LIMIT ?`)
      .all(row.id, this.cursor(input, scope), limit + 1);
    return this.page(rows, limit, scope, entry => {
      const { seq, description, refs, ...fields } = entry;
      return { ...fields, source: 'reported', ...(refs ? { references: JSON.parse(refs) } : {}), ...(description ? { description_available: true, description_length: description.length } : {}) };
    }, { task_id: row.id });
  }
  definitionCheck({ task_id, actor_session_id } = {}) {
    try {
      const rows = this.db.prepare("SELECT * FROM tasks WHERE id=? OR (executor=? AND status NOT IN ('done','cancelled'))")
        .all(task_id ?? null, actor_session_id ?? null);
      if (task_id && !rows.some(row => row.id === task_id)) fail('TASK_NOT_FOUND', `Task ${task_id} does not exist`, 404);
      if (!rows.length) return { status: 'not_applicable', tasks: [] };
      return {
        status: 'checked',
        tasks: rows.map(row => {
          const needs_ack = Boolean(row.executor) && !terminal(row.status) && row.acknowledged_revision !== row.revision;
          return {
            task_id: row.id, revision: row.revision, acknowledged_revision: row.acknowledged_revision, needs_ack,
            ...(needs_ack ? { message: row.acknowledged_revision === null
              ? "Awaiting the assigned Executor's acknowledgement of the current Task description"
              : "Task description has changed; awaiting the assigned Executor's acknowledgement of the current revision" } : {}),
          };
        }),
      };
    } catch (error) {
      return { status: 'unavailable', error: { code: error.code || 'DEFINITION_CHECK_FAILED', message: error.message } };
    }
  }
}
