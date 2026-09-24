import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { LIMITS, TaskError, parseInternal, definitionFits } from './contracts.js';
import { AutomationStore } from './automation-store.js';
import { groupAlive } from './automation-runner.js';

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
// Replays match on tool, input and actor session, not on which agent inside that session retried.
const fingerprint = (tool, { invocation, ...input }) => hash({ tool, input });
const fail = (code, message, status = 409, result = null) => { throw new TaskError(code, message, status, result); };
const notificationTable = table => {
  if (!['subscriptions', 'dependency_notices', 'child_notices'].includes(table)) throw new Error('Unknown notification table');
  return table;
};
function decode(value, code) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (encode(parsed) !== value) throw new Error();
    return parsed;
  } catch { fail(code, `Invalid ${code === 'INVALID_CURSOR' ? 'cursor' : 'write_context'}`, 400); }
}

export class TaskStore {
  constructor(directory, { platform = process.platform } = {}) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, 'task-board.sqlite');
    this.db = new DatabaseSync(file);
    try {
      chmodSync(file, 0o600);
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > 9) fail('SCHEMA_TOO_NEW', 'Task database requires a newer module version', 500);
      this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      BEGIN IMMEDIATE;
      `);
      // Schemas before v9 are built with their historical names, then renamed once by v9.
      if (version < 9) this.db.exec(`
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
      `);
      if (version < 3) this.db.exec(`
        ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent';
        ALTER TABLE outcomes RENAME TO outcomes_old;
        CREATE TABLE outcomes (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL,
          executor TEXT, author TEXT NOT NULL, summary TEXT NOT NULL,
          refs TEXT NOT NULL, at TEXT NOT NULL, run_id TEXT
        );
        INSERT INTO outcomes(seq,id,task_id,revision,executor,author,summary,refs,at)
          SELECT seq,id,task_id,revision,executor,author,summary,refs,at FROM outcomes_old;
        DROP TABLE outcomes_old;
        CREATE INDEX outcomes_task ON outcomes(task_id,seq);
      `);
      if (version < 4) this.db.exec(`
        ALTER TABLE outcomes ADD COLUMN retro TEXT;
        ALTER TABLE outcomes ADD COLUMN retro_recorded INTEGER NOT NULL DEFAULT 0
          CHECK(retro_recorded IN (0,1));
      `);
      if (version < 9) this.db.exec(`
        CREATE TABLE IF NOT EXISTS task_assignments (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
          executor TEXT NOT NULL, author TEXT NOT NULL, at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS task_assignments_executor ON task_assignments(executor,seq);
        CREATE TABLE IF NOT EXISTS scripts (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, script_id TEXT NOT NULL UNIQUE,
          definition TEXT NOT NULL, author TEXT NOT NULL, at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS automation_runs (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id), script_id TEXT NOT NULL,
          script TEXT NOT NULL, parameters TEXT NOT NULL, state TEXT NOT NULL,
          revision INTEGER, queued_at TEXT, started_at TEXT, finished_at TEXT,
          pid INTEGER, process_group INTEGER, exit_code INTEGER, signal TEXT, error TEXT,
          barrier INTEGER NOT NULL DEFAULT 0, cancel_requested INTEGER NOT NULL DEFAULT 0,
          log TEXT NOT NULL DEFAULT '', omitted_characters INTEGER NOT NULL DEFAULT 0,
          reconciled_at TEXT, reconciled_by TEXT, reconciliation_reason TEXT
        );
        CREATE TABLE IF NOT EXISTS task_dependencies (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL REFERENCES tasks(id), blocker_id TEXT NOT NULL REFERENCES tasks(id),
          author TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(task_id, blocker_id), CHECK(task_id <> blocker_id)
        );
        CREATE INDEX IF NOT EXISTS task_dependencies_blocker ON task_dependencies(blocker_id);
        CREATE TABLE IF NOT EXISTS dependency_notices (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL REFERENCES tasks(id), blocker_id TEXT NOT NULL REFERENCES tasks(id),
          blocker_lifecycle INTEGER NOT NULL, owner TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('ready','blocker_cancelled')),
          event TEXT NOT NULL, created_at TEXT NOT NULL,
          delivery_status TEXT NOT NULL DEFAULT 'pending'
            CHECK(delivery_status IN ('pending','unknown','accepted','queued','not_sent')),
          attempted_at TEXT, completed_at TEXT, delivery_error TEXT,
          UNIQUE(task_id, kind, blocker_id, blocker_lifecycle)
        );
        CREATE INDEX IF NOT EXISTS dependency_notices_task ON dependency_notices(task_id,seq);
        CREATE INDEX IF NOT EXISTS dependency_notices_pending ON dependency_notices(seq) WHERE delivery_status='pending';
      `);
      // Schema v7 records delegation lineage. Existing Tasks stay top-level; nothing is inferred retroactively.
      const taskColumns = new Set(this.db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name));
      if (!taskColumns.has('parent_task_id')) this.db.exec('ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id)');
      if (!taskColumns.has('depth')) this.db.exec('ALTER TABLE tasks ADD COLUMN depth INTEGER NOT NULL DEFAULT 1 CHECK(depth >= 1)');
      if (version < 9) this.db.exec(`
        CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_task_id,seq) WHERE parent_task_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS child_notices (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL REFERENCES tasks(id), parent_task_id TEXT NOT NULL REFERENCES tasks(id),
          child_lifecycle INTEGER NOT NULL, owner TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('done','blocked','cancelled')),
          event TEXT NOT NULL, created_at TEXT NOT NULL,
          delivery_status TEXT NOT NULL DEFAULT 'pending'
            CHECK(delivery_status IN ('pending','unknown','accepted','queued','not_sent')),
          attempted_at TEXT, completed_at TEXT, delivery_error TEXT,
          UNIQUE(task_id, status, child_lifecycle)
        );
        CREATE INDEX IF NOT EXISTS child_notices_task ON child_notices(task_id,seq);
        CREATE INDEX IF NOT EXISTS child_notices_pending ON child_notices(seq) WHERE delivery_status='pending';
        -- Schema v8: Owner handling of one recorded retro, append-only; nothing is backfilled.
        CREATE TABLE IF NOT EXISTS retro_handlings (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL REFERENCES tasks(id), outcome_id TEXT NOT NULL REFERENCES outcomes(id),
          status TEXT NOT NULL CHECK(status IN ('fixed','followup','watching','dismissed')),
          note TEXT NOT NULL, refs TEXT NOT NULL, author TEXT NOT NULL, at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS retro_handlings_outcome ON retro_handlings(outcome_id,seq);
        CREATE INDEX IF NOT EXISTS retro_handlings_task ON retro_handlings(task_id,seq);
      `);
      if (version < 9) this.migrateVocabulary();
      this.db.exec('PRAGMA user_version=9; COMMIT;');
      this.automation = new AutomationStore(this, { platform });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  migrateVocabulary() {
    // Schema v9 renames Owner/Executor to orchestrator/assignee in place; rows are otherwise unchanged.
    const renameEvent = table => `UPDATE ${table} SET event=json_remove(json_set(event,'$.actor',json_extract(event,'$.actor_session_id')),'$.actor_session_id')
      WHERE event IS NOT NULL AND json_type(event,'$.actor_session_id') IS NOT NULL;`;
    this.db.exec(`
      DROP INDEX IF EXISTS executor_occupancy;
      DROP INDEX IF EXISTS task_assignments_executor;
      DROP INDEX IF EXISTS subscriptions_waiting_owner;
      ALTER TABLE tasks RENAME COLUMN owner TO orchestrator;
      ALTER TABLE tasks RENAME COLUMN executor TO assignee;
      ALTER TABLE activities RENAME COLUMN executor TO assignee;
      ALTER TABLE outcomes RENAME COLUMN executor TO assignee;
      ALTER TABLE task_assignments RENAME COLUMN executor TO assignee;
      ALTER TABLE subscriptions RENAME COLUMN owner TO orchestrator;
      ALTER TABLE subscriptions RENAME COLUMN actor_session_id TO author;
      ALTER TABLE dependency_notices RENAME COLUMN owner TO orchestrator;
      ALTER TABLE child_notices RENAME COLUMN owner TO orchestrator;
      ALTER TABLE operations ADD COLUMN invocation TEXT;
      CREATE UNIQUE INDEX assignee_occupancy ON tasks(assignee)
        WHERE assignee IS NOT NULL AND status NOT IN ('done','cancelled');
      CREATE INDEX task_assignments_assignee ON task_assignments(assignee,seq);
      CREATE UNIQUE INDEX subscriptions_waiting_orchestrator ON subscriptions(task_id,orchestrator) WHERE state='waiting';
      ${renameEvent('subscriptions')}
      ${renameEvent('dependency_notices')}
      ${renameEvent('child_notices')}
      UPDATE operations SET input=json_remove(json_set(input,'$.assignee',json_extract(input,'$.executor')),'$.executor')
        WHERE tool='task_assign' AND json_type(input,'$.executor') IS NOT NULL;
      UPDATE operations SET result=json_remove(json_set(result,'$.operation.assignee',json_extract(result,'$.operation.executor')),'$.operation.executor')
        WHERE tool='task_assign' AND json_type(result,'$.operation.executor') IS NOT NULL;
    `);
  }

  close() { this.db.close(); }
  transaction(fn, { readOnly = false } = {}) {
    this.db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
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
    if (row.kind === 'automation') fail('AUTOMATION_MANAGED', 'Automation has no Agent assignee or ACK; execution facts are written only by the service');
    if (terminal(row.status)) fail('TASK_STATE_CONFLICT', 'Terminal Tasks cannot accept execution or acknowledgement');
    if (!row.assignee) fail('ASSIGNMENT_REQUIRED', 'Task has no fixed assignee');
  }
  identity(row) {
    return {
      id: row.id, task_id: row.id, title: row.title, orchestrator: row.orchestrator, assignee: row.assignee,
      status: row.status, revision: row.revision, acknowledged_revision: row.acknowledged_revision,
      created_at: row.created_at, updated_at: row.updated_at, write_context: this.context(row),
      kind: row.kind, parent_task_id: row.parent_task_id ?? null, depth: row.depth ?? 1,
      ...this.dependencies(row.id),
    };
  }
  currentAssignment(session) {
    // Occupancy guarantees at most one unfinished Agent assignment per session.
    return this.db.prepare("SELECT id,depth FROM tasks WHERE assignee=? AND kind='agent' AND status NOT IN ('done','cancelled')").get(session) ?? null;
  }
  delegationParent(actor) {
    // The creator orchestrates the new Task; if it is executing a Task, the new Task is that Task's Subtask.
    const parent = this.currentAssignment(actor);
    if (!parent) return { parent_task_id: null, depth: 1 };
    if (parent.depth >= LIMITS.delegationDepth) {
      fail('DELEGATION_DEPTH_EXCEEDED', `You are executing Task ${parent.id} at delegation level ${parent.depth}; Subtasks are limited to ${LIMITS.delegationDepth} levels. Deliver this level directly, or ask the user how to restructure the work`);
    }
    return { parent_task_id: parent.id, depth: parent.depth + 1 };
  }
  lineage(row) {
    const ancestors = [];
    for (let id = row.parent_task_id; id && ancestors.length < LIMITS.delegationDepth; ) {
      const ancestor = this.db.prepare('SELECT id,orchestrator,assignee,parent_task_id FROM tasks WHERE id=?').get(id);
      if (!ancestor) break;
      ancestors.push(ancestor);
      id = ancestor.parent_task_id;
    }
    return ancestors;
  }
  assertAssignable(row, assignee) {
    if (assignee === row.orchestrator) {
      fail('SELF_ASSIGNMENT', 'A Task cannot be assigned to its own orchestrator; assign another session. For explicitly authorized rework of your own completed Task use task_reopen');
    }
    const loop = this.lineage(row).find(ancestor => ancestor.orchestrator === assignee || ancestor.assignee === assignee);
    if (loop) {
      fail('DELEGATION_CYCLE', `Session ${assignee} already orchestrates or is assigned ancestor Task ${loop.id}; assign Subtasks to a session outside their lineage`);
    }
  }
  actorRole(row, actor) {
    if (!actor) return undefined;
    const orchestrator = row.orchestrator === actor, assignee = row.assignee === actor;
    // Self-assignment is rejected; only legacy rows can hold both relations.
    return orchestrator && assignee ? 'orchestrator_and_assignee' : assignee ? 'assignee' : orchestrator ? 'orchestrator' : 'none';
  }
  dependencies(taskId) {
    const blocked_by = this.db.prepare(`SELECT d.blocker_id AS task_id, t.status FROM task_dependencies d
      JOIN tasks t ON t.id=d.blocker_id WHERE d.task_id=? ORDER BY d.seq`).all(taskId).map(entry => ({ ...entry }));
    return { blocked_by, ready: blocked_by.every(entry => entry.status === 'done') };
  }
  awaitingDispatch(row) {
    if (row.status !== 'todo' || row.assignee) return false;
    return row.kind !== 'automation' || this.automation.run(row.id, { includeLog: false }).state === 'created';
  }
  assertReady(row) {
    const waiting = this.dependencies(row.id).blocked_by.filter(entry => entry.status !== 'done');
    if (waiting.length) {
      fail('TASK_NOT_READY', `Task is blocked by ${waiting.length} Task(s) not yet done (${waiting.map(entry => `${entry.task_id}: ${entry.status}`).join(', ')}); dispatch after every blocker is done, or edit blocked_by`);
    }
  }
  setBlockers(row, requested, author, at) {
    const next = requested.map(value => value.toLowerCase());
    const current = this.db.prepare('SELECT blocker_id FROM task_dependencies WHERE task_id=?').all(row.id).map(entry => entry.blocker_id);
    const added = next.filter(value => !current.includes(value));
    const removed = current.filter(value => !next.includes(value));
    if (!added.length && !removed.length) return false;
    if (!this.awaitingDispatch(row)) {
      fail('DEPENDENCY_LOCKED', 'blocked_by can change only while the Task awaits dispatch (unassigned todo, or automation not yet started)');
    }
    for (const id of added) {
      if (id === row.id) fail('DEPENDENCY_SELF', 'A Task cannot be blocked by itself', 400);
      const blocker = this.db.prepare('SELECT id,status FROM tasks WHERE id=?').get(id);
      if (!blocker) fail('BLOCKER_NOT_FOUND', `Blocker Task ${id} does not exist`, 404);
      // An ancestor finishes only after its Subtasks, so waiting on it would deadlock.
      if (this.lineage(row).some(ancestor => ancestor.id === id)) {
        fail('BLOCKER_ANCESTOR', `Blocker Task ${id} is an ancestor of this Task and can only finish after it; order work among siblings instead`);
      }
      if (blocker.status === 'cancelled') fail('BLOCKER_CANCELLED', `Blocker Task ${id} is cancelled and can never become done`);
    }
    for (const id of removed) this.db.prepare('DELETE FROM task_dependencies WHERE task_id=? AND blocker_id=?').run(row.id, id);
    for (const id of added) {
      this.db.prepare('INSERT INTO task_dependencies(task_id,blocker_id,author,at) VALUES(?,?,?,?)').run(row.id, id, author, at);
    }
    const cycle = added.length && this.db.prepare(`WITH RECURSIVE reachable(id) AS (
        SELECT blocker_id FROM task_dependencies WHERE task_id=?
        UNION SELECT d.blocker_id FROM task_dependencies d JOIN reachable r ON d.task_id=r.id
      ) SELECT 1 FROM reachable WHERE id=? LIMIT 1`).get(row.id, row.id);
    if (cycle) fail('DEPENDENCY_CYCLE', 'blocked_by would create a dependency cycle');
    return true;
  }
  summary(row) {
    return {
      ...this.identity(row),
      automation: row.kind === 'automation' ? this.automation.project(this.automation.run(row.id)) : null,
    };
  }
  task(id) {
    const row = this.row(id);
    return {
      ...this.summary(row), description: row.description, references: JSON.parse(row.refs), metadata: JSON.parse(row.metadata),
      retro: this.latestRetro(row, true),
      ...(row.kind === 'automation' ? { automation: this.automation.project(this.automation.run(row.id), true) } : {}),
    };
  }
  effects(row, status = 'applied') {
    return {
      status, task_id: row.id, revision: row.revision, acknowledged_revision: row.acknowledged_revision,
      task_status: row.status, assignee: row.assignee, write_context: this.context(row),
      kind: row.kind, ...(row.kind === 'automation' ? { automation: this.automation.project(this.automation.run(row.id)) } : {}),
    };
  }
  operation(requestId) {
    const row = this.db.prepare('SELECT * FROM operations WHERE request_id=?').get(requestId);
    if (!row) fail('OPERATION_NOT_FOUND', 'Operation does not exist', 404);
    const input = JSON.parse(row.input);
    return {
      request_id: row.request_id, tool: row.tool, status: row.status,
      ...(typeof input.task_id === 'string' ? { task_id: input.task_id } : {}),
      result: row.result ? JSON.parse(row.result) : null, error: row.error ? JSON.parse(row.error) : null,
      ...(typeof input.actor === 'string' ? { actor: input.actor } : {}),
      ...(row.invocation ? { invocation: JSON.parse(row.invocation) } : {}),
      created_at: row.created_at, updated_at: row.updated_at,
    };
  }
  receipt(name, input) {
    const existing = this.db.prepare('SELECT * FROM operations WHERE request_id=?').get(input.request_id);
    if (existing && existing.fingerprint !== fingerprint(name, input)) {
      fail('REQUEST_ID_CONFLICT', 'request_id was already used with different input or by a different session');
    }
    return existing;
  }
  insertReceipt(name, input, result = null) {
    const at = now();
    const { invocation, ...fields } = input;
    // The invocation records which agent (main or subagent) inside the actor session made the call.
    this.db.prepare('INSERT INTO operations(request_id,tool,fingerprint,input,status,result,created_at,updated_at,invocation) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(input.request_id, name, fingerprint(name, input), JSON.stringify(fields), 'pending', JSON.stringify(result), at, at,
        invocation ? JSON.stringify(invocation) : null);
  }
  saveReceipt(requestId, result, error, final = true) {
    const changed = this.db.prepare('UPDATE operations SET status=?,result=?,error=?,updated_at=? WHERE request_id=?')
      .run(final ? 'final' : 'pending', JSON.stringify(result), error ? JSON.stringify(error) : null, now(), requestId);
    if (!changed.changes) fail('OPERATION_NOT_FOUND', 'Operation does not exist', 404);
  }
  reserveOperation(name, rawInput) {
    const input = parseInternal(name, rawInput);
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
  executeLocal(name, rawInput, { validate = () => {} } = {}) {
    const input = parseInternal(name, rawInput);
    if (name === 'task_read') return this.read(input);
    if (name === 'task_script_read') return this.automation.script(input);
    const handlers = {
      task_create: 'create', task_edit: 'edit', task_ack: 'ack', task_report: 'report', task_cancel: 'cancel', task_reopen: 'reopen',
      task_subscribe: 'subscribe', task_unsubscribe: 'unsubscribe', task_retro_handle: 'handleRetro',
      task_script_register: 'registerScript', task_automation_start: 'startAutomation',
      task_automation_reconcile: 'reconcileAutomation',
    };
    if (!handlers[name]) fail('EXTERNAL_OPERATION_REQUIRED', 'This tool requires the host operation service', 400);
    const receipt = this.transaction(() => {
      if (this.receipt(name, input)) return this.operation(input.request_id);
      this.insertReceipt(name, input);
      // A savepoint prevents all business failures except explicitly returned stale-field results.
      this.db.exec('SAVEPOINT mutation');
      try {
        validate();
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
  registerScript(input) { return this.automation.register(input); }
  startAutomation(input) { return this.automation.start(input); }
  reconcileAutomation(input) { return this.automation.reconcile(input, groupAlive); }
  create(input) {
    if (input.automation) this.automation.assertPlatform();
    const id = randomUUID(), at = now();
    const { parent_task_id, depth } = this.delegationParent(input.actor);
    this.db.prepare('INSERT INTO tasks(id,title,description,orchestrator,refs,metadata,created_at,updated_at,parent_task_id,depth) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, input.title, input.description, input.actor, JSON.stringify(input.references || []), JSON.stringify(input.metadata || {}), at, at, parent_task_id, depth);
    this.recordDefinition(this.row(id), 'Initial definition', input.actor, at);
    if (input.automation) this.automation.create(id, input.automation);
    if (input.blocked_by?.length) this.setBlockers(this.row(id), input.blocked_by, input.actor, at);
    return { result: { ...this.effects(this.row(id)), ...this.dependencies(id) } };
  }
  edit(input) {
    const row = this.row(input.task_id);
    this.checkContext(row, input, true);
    this.currentRevision(row, input);
    if (row.kind === 'automation' && ['queued', 'starting', 'running'].includes(this.automation.run(row.id).state)) {
      fail('AUTOMATION_DEFINITION_LOCKED', 'Queued/running automation definitions are frozen; cancel rather than changing an in-flight agreement');
    }
    const descriptionChanged = input.description !== undefined && input.description !== row.description;
    const references = input.references === undefined ? row.refs : JSON.stringify(input.references);
    const metadata = input.metadata === undefined ? row.metadata : JSON.stringify(input.metadata);
    if (!definitionFits({ description: input.description ?? row.description, references: JSON.parse(references), metadata: JSON.parse(metadata) })) {
      fail('INVALID_INPUT', 'Combined serialized description and materials exceed 64000 characters', 400);
    }
    const at = now();
    const blockersChanged = input.blocked_by !== undefined && this.setBlockers(row, input.blocked_by, input.actor, at);
    const metadataChanged = (input.title !== undefined && input.title !== row.title)
      || canonical(JSON.parse(references)) !== canonical(JSON.parse(row.refs))
      || canonical(JSON.parse(metadata)) !== canonical(JSON.parse(row.metadata)) || blockersChanged;
    const dependencyResult = input.blocked_by !== undefined ? { blockers_changed: blockersChanged, ...this.dependencies(row.id) } : {};
    if (!descriptionChanged && !metadataChanged) return { result: { ...this.effects(row, 'unchanged'), ...dependencyResult } };
    const revision = row.revision + Number(descriptionChanged);
    this.db.prepare('UPDATE tasks SET title=?,description=?,refs=?,metadata=?,revision=?,editable=editable+?,updated_at=? WHERE id=?')
      .run(input.title ?? row.title, input.description ?? row.description, references, metadata, revision, Number(metadataChanged), at, row.id);
    if (descriptionChanged) {
      this.recordDefinition(this.row(row.id), input.reason, input.actor, at);
      if (!terminal(row.status) && row.assignee === input.actor) this.recordAck(this.row(row.id), input.actor);
    }
    return {
      result: {
        ...this.effects(this.row(row.id)), description_changed: descriptionChanged, metadata_changed: metadataChanged,
        ...dependencyResult,
      },
    };
  }
  recordDefinition(row, reason, author, at) {
    this.db.prepare('INSERT INTO definitions(task_id,revision,description,reason,author,at) VALUES(?,?,?,?,?,?)')
      .run(row.id, row.revision, row.description, reason, author, at);
  }
  recordAck(row, author) {
    this.db.prepare('INSERT OR IGNORE INTO acknowledgements(task_id,revision,confirmed_for,author,at) VALUES(?,?,?,?,?)')
      .run(row.id, row.revision, row.assignee, author, now());
    this.db.prepare('UPDATE tasks SET acknowledged_revision=?,updated_at=? WHERE id=?').run(row.revision, now(), row.id);
  }
  reopenCandidate(input) {
    const row = this.row(input.task_id);
    this.checkContext(row, input, true);
    this.currentRevision(row, input);
    if (row.kind !== 'agent') fail('AUTOMATION_MANAGED', 'Automation Tasks cannot reopen');
    if (row.status !== 'done') fail('TASK_STATE_CONFLICT', 'Only a done Agent Task can reopen');
    if (!row.assignee || row.assignee !== input.actor) {
      fail('ASSIGNEE_MISMATCH', 'Only the recorded original assignee may reopen its Task');
    }
    const assignment = this.db.prepare('SELECT seq FROM task_assignments WHERE task_id=? AND assignee=?').get(row.id, row.assignee);
    if (!assignment) fail('REOPEN_NOT_ELIGIBLE', 'Tasks assigned before assignment-order tracking cannot reopen');
    const occupied = this.db.prepare("SELECT 1 FROM tasks WHERE assignee=? AND status NOT IN ('done','cancelled')").get(row.assignee);
    if (occupied) fail('ASSIGNEE_OCCUPIED', 'Assignee already has an unfinished Task');
    const later = this.db.prepare('SELECT 1 FROM task_assignments WHERE assignee=? AND seq>? LIMIT 1').get(row.assignee, assignment.seq);
    if (later) fail('REOPEN_NOT_ELIGIBLE', 'Assignee has since been assigned another Task, including completed or cancelled work');
    if (!definitionFits({ description: input.description, references: JSON.parse(row.refs), metadata: JSON.parse(row.metadata) })) {
      fail('INVALID_INPUT', 'Combined serialized description and materials exceed 64000 characters', 400);
    }
    return row;
  }
  reopen(input) {
    const row = this.reopenCandidate(input), at = now();
    // This runs under the same write transaction as assignment and its ordering record.
    this.db.prepare("UPDATE tasks SET status='in_progress',description=?,revision=revision+1,lifecycle=lifecycle+1,updated_at=? WHERE id=?")
      .run(input.description, at, row.id);
    const current = this.row(row.id);
    this.recordDefinition(current, input.reason, input.actor, at);
    this.recordAck(current, input.actor);
    return { result: this.effects(this.row(row.id)) };
  }
  ack(input) {
    const row = this.row(input.task_id);
    this.checkContext(row, input);
    this.executable(row);
    this.currentRevision(row, input);
    if (row.acknowledged_revision === row.revision) return { result: this.effects(row, 'unchanged') };
    this.recordAck(row, input.actor);
    return { result: this.effects(this.row(row.id)) };
  }
  report(input) {
    input = parseInternal('task_report', input);
    const row = this.row(input.task_id);
    this.checkContext(row, input);
    this.executable(row);
    const ack = this.db.prepare('SELECT 1 FROM acknowledgements WHERE task_id=? AND revision=? AND confirmed_for=?')
      .get(row.id, input.revision, row.assignee);
    if (!ack) fail('ACK_REQUIRED', 'The fixed assignee has not acknowledged the specified revision');
    const stale = input.revision !== row.revision;
    const field = requested => ({ status: requested ? 'rejected' : 'not_requested' });
    const fields = {
      activity: field(input.activity), task_status: field(input.status), outcome: field(input.outcome),
      retro: field(input.retro !== undefined),
    };
    const at = now();
    let subscription_ids = [], notice_ids = [];
    if (input.activity) {
      const id = randomUUID();
      this.db.prepare('INSERT INTO activities(id,task_id,revision,assignee,author,text,at) VALUES(?,?,?,?,?,?,?)')
        .run(id, row.id, input.revision, row.assignee, input.actor, input.activity.text, at);
      fields.activity = { status: 'saved', id, revision: input.revision };
    }
    if (!stale) {
      if (input.outcome) {
        const id = randomUUID();
        this.db.prepare('INSERT INTO outcomes(id,task_id,revision,assignee,author,summary,refs,at,retro,retro_recorded) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(id, row.id, input.revision, row.assignee, input.actor, input.outcome.summary, JSON.stringify(input.outcome.references || []), at,
            input.retro ?? null, Number(input.retro !== undefined));
        fields.outcome = { status: 'saved', id, revision: input.revision };
        if (input.retro !== undefined) fields.retro = { status: 'saved', outcome_id: id, revision: input.revision };
      }
      if (input.status) {
        this.db.prepare('UPDATE tasks SET status=?,lifecycle=lifecycle+? WHERE id=?').run(input.status, Number(input.status !== row.status), row.id);
        fields.task_status = { status: 'saved', value: input.status };
        subscription_ids = this.transitionSubscriptions(row, input.status, input, at);
        notice_ids = [...this.transitionDependents(row, input.status, input, at), ...this.transitionChild(row, input.status, input, at, subscription_ids)];
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
        ...(notice_ids.length ? { notice_ids } : {}),
      },
      error: rejected ? { code: 'DESCRIPTION_UPDATED', message: 'Task description has changed; requested status, outcome and retro were not saved. Read the current definition; its acknowledgement belongs to the assignee', status: 409 } : null,
    };
  }
  cancel(input) {
    const row = this.row(input.task_id);
    this.checkContext(row, input);
    if (row.status === 'cancelled') return { result: this.effects(row, 'unchanged') };
    if (row.status === 'done') fail('TASK_STATE_CONFLICT', 'A completed Task cannot be cancelled');
    const cancellation = { reason: input.reason, author: input.actor, source: 'reported', at: now() };
    this.db.prepare("UPDATE tasks SET status='cancelled',lifecycle=lifecycle+1,cancellation=?,updated_at=? WHERE id=?")
      .run(JSON.stringify(cancellation), cancellation.at, row.id);
    const subscription_ids = this.transitionSubscriptions(row, 'cancelled', input, cancellation.at);
    const notice_ids = [...this.transitionDependents(row, 'cancelled', input, cancellation.at), ...this.transitionChild(row, 'cancelled', input, cancellation.at, subscription_ids)];
    if (row.kind === 'automation') this.automation.cancel(row.id);
    return {
      result: {
        ...this.effects(this.row(row.id)), cancellation,
        ...(subscription_ids.length ? { subscription_ids } : {}), ...(notice_ids.length ? { notice_ids } : {}),
      },
    };
  }
  subscription(row) {
    return {
      subscription_id: row.id, task_id: row.task_id, orchestrator: row.orchestrator,
      author: row.author, statuses: JSON.parse(row.statuses), state: row.state,
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
    if (terminal(row.status)) fail('TASK_STATE_CONFLICT', 'Subscriptions require an unfinished Task; no subscription was created');
    if (this.db.prepare("SELECT 1 FROM subscriptions WHERE task_id=? AND orchestrator=? AND state='waiting'").get(row.id, row.orchestrator)) {
      fail('SUBSCRIPTION_EXISTS', 'This Task orchestrator already has a waiting subscription; inspect or cancel it explicitly');
    }
    const id = randomUUID();
    this.db.prepare("INSERT INTO subscriptions(id,task_id,orchestrator,author,statuses,state,created_at) VALUES(?,?,?,?,?,'waiting',?)")
      .run(id, row.id, row.orchestrator, input.actor, JSON.stringify(input.statuses), now());
    return { result: { ...this.effects(row), subscription: this.getSubscription(id) } };
  }
  unsubscribe(input) {
    this.row(input.task_id);
    const subscription = this.getSubscription(input.subscription_id);
    if (subscription.task_id !== input.task_id) fail('SUBSCRIPTION_NOT_FOUND', 'Subscription does not belong to this Task', 404);
    if (subscription.state === 'cancelled') return { result: { status: 'unchanged', task_id: input.task_id, subscription } };
    if (subscription.state !== 'waiting') fail('SUBSCRIPTION_NOT_WAITING', 'Subscription already ended; a consumed notification cannot be recalled');
    this.db.prepare("UPDATE subscriptions SET state='cancelled',ended_at=?,ended_by=? WHERE id=? AND state='waiting'")
      .run(now(), input.actor, subscription.subscription_id);
    return { result: { status: 'applied', task_id: input.task_id, subscription: this.getSubscription(subscription.subscription_id) } };
  }
  transitionSubscriptions(row, status, input, at) {
    if (status === row.status) return [];
    const subscriptions = this.db.prepare("SELECT * FROM subscriptions WHERE task_id=? AND state='waiting'").all(row.id);
    const ids = [];
    for (const subscription of subscriptions) {
      if (JSON.parse(subscription.statuses).includes(status)) {
        const event = {
          event_id: randomUUID(), request_id: input.request_id, from_status: row.status, status, at, actor: input.actor,
          ...(input.source === 'automation' ? { source: 'automation', run_id: input.run_id } : {}),
        };
        this.db.prepare("UPDATE subscriptions SET state='triggered',ended_at=?,event=?,delivery_status='pending' WHERE id=?")
          .run(at, JSON.stringify(event), subscription.id);
        ids.push(subscription.id);
      } else if (terminal(status)) {
        this.db.prepare("UPDATE subscriptions SET state='expired',ended_at=? WHERE id=?").run(at, subscription.id);
      }
    }
    return ids;
  }
  transitionDependents(row, status, input, at) {
    // Only a real transition of a blocker into done/cancelled can notify, once per dependent.
    if (status === row.status || !terminal(status)) return [];
    const blocker = this.row(row.id);
    const dependents = this.db.prepare(`SELECT t.* FROM task_dependencies d JOIN tasks t ON t.id=d.task_id
      WHERE d.blocker_id=? ORDER BY d.seq`).all(row.id).filter(dependent => this.awaitingDispatch(dependent));
    const ids = [];
    for (const dependent of dependents) {
      const kind = status === 'done' ? 'ready' : 'blocker_cancelled';
      if (kind === 'ready' && !this.dependencies(dependent.id).ready) continue;
      const id = randomUUID();
      const event = {
        event_id: randomUUID(), blocker_id: row.id, blocker_status: status, request_id: input.request_id, at,
        actor: input.actor,
        ...(input.source === 'automation' ? { source: 'automation', run_id: input.run_id } : {}),
      };
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO dependency_notices(id,task_id,blocker_id,blocker_lifecycle,orchestrator,kind,event,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(id, dependent.id, row.id, blocker.lifecycle, dependent.orchestrator, kind, JSON.stringify(event), at);
      if (inserted.changes) ids.push(id);
    }
    return ids;
  }
  transitionChild(row, status, input, at, triggered = []) {
    // A Subtask's done/blocked/cancelled transition wakes its orchestrator (the parent's assignee) while the parent is unfinished.
    if (!row.parent_task_id || status === row.status || !['done', 'blocked', 'cancelled'].includes(status)) return [];
    if (triggered.length) return [];
    const parent = this.row(row.parent_task_id);
    if (terminal(parent.status) || parent.assignee !== row.orchestrator) return [];
    const child = this.row(row.id);
    const id = randomUUID();
    const event = {
      event_id: randomUUID(), parent_task_id: parent.id, from_status: row.status, status, request_id: input.request_id, at,
      actor: input.actor,
      ...(input.source === 'automation' ? { source: 'automation', run_id: input.run_id } : {}),
    };
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO child_notices(id,task_id,parent_task_id,child_lifecycle,orchestrator,status,event,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, row.id, parent.id, child.lifecycle, row.orchestrator, status, JSON.stringify(event), at);
    return inserted.changes ? [id] : [];
  }
  childNotice(row) {
    return {
      notice_id: row.id, task_id: row.task_id, parent_task_id: row.parent_task_id, orchestrator: row.orchestrator,
      kind: `child_${row.status}`, status: row.status, event: JSON.parse(row.event), created_at: row.created_at,
      notification: {
        status: row.delivery_status, attempted_at: row.attempted_at, completed_at: row.completed_at,
        error: row.delivery_error ? JSON.parse(row.delivery_error) : null,
      },
    };
  }
  notice(row) {
    return {
      notice_id: row.id, task_id: row.task_id, blocker_id: row.blocker_id, orchestrator: row.orchestrator, kind: row.kind,
      event: JSON.parse(row.event), created_at: row.created_at,
      notification: {
        status: row.delivery_status, attempted_at: row.attempted_at, completed_at: row.completed_at,
        error: row.delivery_error ? JSON.parse(row.delivery_error) : null,
      },
    };
  }
  getNotice(id) {
    const row = this.db.prepare('SELECT * FROM dependency_notices WHERE id=?').get(id);
    if (!row) fail('NOTICE_NOT_FOUND', 'Dependency notice does not exist', 404);
    return this.notice(row);
  }
  notificationChannel(id) {
    // Subscriptions and dependency notices share one durable delivery discipline.
    if (this.db.prepare('SELECT 1 FROM subscriptions WHERE id=?').get(id)) {
      return { table: 'subscriptions', event: 'status_changed', read: () => this.getSubscription(id) };
    }
    const child = this.db.prepare('SELECT * FROM child_notices WHERE id=?').get(id);
    if (child) {
      const read = () => this.childNotice(this.db.prepare('SELECT * FROM child_notices WHERE id=?').get(id));
      return { table: 'child_notices', event: `child_${child.status}`, read };
    }
    const notice = this.getNotice(id);
    return { table: 'dependency_notices', event: notice.kind, read: () => this.getNotice(id) };
  }
  pendingNotificationBoundary(table = 'subscriptions') {
    return this.db.prepare(`SELECT max(seq) AS seq FROM ${notificationTable(table)} WHERE delivery_status='pending'`).get().seq ?? 0;
  }
  pendingNotifications(after, through, limit = 20, table = 'subscriptions') {
    return this.db.prepare(`SELECT seq,id FROM ${notificationTable(table)} WHERE delivery_status='pending' AND seq>? AND seq<=? ORDER BY seq LIMIT ?`)
      .all(after, through, limit);
  }
  claimNotification(id) {
    const { table, read } = this.notificationChannel(id);
    return this.transaction(() => {
      // Unknown is durable before any send. It is deliberately never a recovery candidate.
      const error = { code: 'NOTIFICATION_UNCONFIRMED', message: 'Notification attempt may be in flight or interrupted; inspect before taking any manual action. Never blindly resend.' };
      const changed = this.db.prepare(`UPDATE ${table} SET delivery_status='unknown',attempted_at=?,delivery_error=? WHERE id=? AND delivery_status='pending'`)
        .run(now(), JSON.stringify(error), id);
      return changed.changes ? read() : null;
    });
  }
  finishNotification(id, expected, status, error = null) {
    const { table, read } = this.notificationChannel(id);
    return this.transaction(() => {
      this.db.prepare(`UPDATE ${table} SET delivery_status=?,delivery_error=?,completed_at=? WHERE id=? AND delivery_status=?`)
        .run(status, error ? JSON.stringify(error) : null, now(), id, expected);
      return read();
    });
  }
  bindAssignment(rawInput) {
    const input = parseInternal('task_assign', rawInput);
    return this.transaction(() => {
      const receipt = this.receipt('task_assign', input);
      if (!receipt || receipt.status !== 'pending') fail('OPERATION_NOT_PENDING', 'Assignment needs its own pending receipt');
      if (receipt.binding_context) fail('ASSIGNMENT_CONFLICT', 'This operation already bound the Task; do not repeat it');
      const row = this.row(input.task_id);
      if (row.kind === 'automation') fail('AUTOMATION_MANAGED', 'Automation Tasks cannot be assigned to an Agent');
      this.checkContext(row, input);
      this.currentRevision(row, input);
      if (terminal(row.status)) fail('TASK_STATE_CONFLICT', 'Terminal Tasks cannot be assigned');
      if (input.resume_request_id) {
        const old = this.db.prepare('SELECT * FROM operations WHERE request_id=?').get(input.resume_request_id);
        const prior = old?.result ? JSON.parse(old.result)?.operation : null;
        const oldInput = old ? JSON.parse(old.input) : null;
        if (!old || old.tool !== 'task_assign' || old.status !== 'final' || old.resumed_by
          || oldInput.task_id !== input.task_id || oldInput.assignee !== input.assignee
          || prior?.message !== 'not_sent' || prior.assignment !== 'applied' || row.assignee !== input.assignee) {
          fail('UNSAFE_DISPATCH_RECOVERY', 'Recovery requires an unused finalized receipt proving this fixed assignment was not sent');
        }
        this.db.prepare('UPDATE operations SET resumed_by=? WHERE request_id=?').run(input.request_id, input.resume_request_id);
      } else {
        if (row.assignee || row.status !== 'todo') fail('ASSIGNMENT_CONFLICT', 'Only an unassigned todo can be assigned');
        this.assertAssignable(row, input.assignee);
        this.assertReady(row);
        try {
          this.db.prepare('UPDATE tasks SET assignee=?,lifecycle=lifecycle+1,updated_at=? WHERE id=?')
            .run(input.assignee, now(), row.id);
        } catch (error) {
          if (error.code?.startsWith('ERR_SQLITE') && error.message.includes('tasks.assignee')) {
            fail('ASSIGNEE_OCCUPIED', 'Assignee already has an unfinished Task');
          }
          throw error;
        }
        this.db.prepare('INSERT INTO task_assignments(task_id,assignee,author,at) VALUES(?,?,?,?)')
          .run(row.id, input.assignee, input.actor, now());
      }
      const task = this.row(row.id);
      this.db.prepare('UPDATE operations SET binding_context=?,result=?,updated_at=? WHERE request_id=?')
        .run(this.context(task), JSON.stringify({ operation: { request_id: input.request_id, status: 'running', task_id: task.id, assignee: task.assignee, assignment: 'applied', message: 'not_sent', write_context: this.context(task) } }), now(), input.request_id);
      return this.summary(task);
    });
  }
  moduleSessionTitle(sessionId, excludeRequestId) {
    // Only this module's own confirmed rename counts as module-set; the latest one wins.
    const row = this.db.prepare(`SELECT json_extract(result,'$.operation.session_title.title') AS title FROM operations
      WHERE tool='task_assign' AND request_id<>? AND json_extract(result,'$.operation.assignee')=?
        AND json_extract(result,'$.operation.session_title.status')='renamed'
      ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(excludeRequestId, sessionId);
    return typeof row?.title === 'string' ? row.title : null;
  }
  preparationPreflight(sessionId) {
    const task = this.db.prepare("SELECT id FROM tasks WHERE assignee=? AND status NOT IN ('done','cancelled')").get(sessionId);
    if (task) fail('ASSIGNEE_OCCUPIED', 'Select a session without an unfinished Task; preparation does not repair an existing assignment');
  }
  dispatchPreflight(rawInput) {
    const input = parseInternal('task_assign', rawInput);
    const receipt = this.receipt('task_assign', input);
    if (!receipt || receipt.status !== 'pending' || !receipt.binding_context) fail('OPERATION_NOT_PENDING', 'No pending bound dispatch exists');
    const row = this.row(input.task_id);
    this.checkContext(row, { write_context: receipt.binding_context });
    this.currentRevision(row, input);
    this.executable(row);
    if (row.assignee !== input.assignee || row.status !== 'todo') fail('ASSIGNMENT_CONFLICT', 'Task is no longer awaiting this dispatch');
    return this.summary(row);
  }
  overview(row, includeCancellation = true) {
    const activity = this.db.prepare('SELECT id,revision,assignee,author,text,at FROM activities WHERE task_id=? ORDER BY seq DESC LIMIT 1').get(row.id);
    const outcome = this.db.prepare('SELECT id,revision,at FROM outcomes WHERE task_id=? ORDER BY seq DESC LIMIT 1').get(row.id);
    return {
      ...this.summary(row),
      activity: activity ? { ...activity, source: 'reported', text: activity.text.slice(0, LIMITS.excerpt), truncated: activity.text.length > LIMITS.excerpt } : null,
      outcome: outcome ? { ...outcome, available: true, current: outcome.revision === row.revision } : { available: false },
      retro: this.latestRetro(row),
      ...(includeCancellation && row.cancellation ? { cancellation: JSON.parse(row.cancellation) } : {}),
    };
  }
  retro(row, outcome, includeText = true) {
    if (row.kind === 'automation') return { status: 'not_applicable' };
    if (!outcome?.retro_recorded) return { status: 'not_recorded' };
    return {
      status: 'recorded', outcome_id: outcome.id, revision: outcome.revision,
      assignee: outcome.assignee, author: outcome.author, at: outcome.at, source: 'reported',
      current: outcome.revision === row.revision, has_findings: outcome.retro !== null,
      ...(includeText ? { text: outcome.retro } : {}),
      ...(outcome.retro !== null ? { handling: this.retroHandling(outcome.id, includeText) } : {}),
    };
  }
  handlingEntry(entry, full = true) {
    return {
      id: entry.id, status: entry.status, author: entry.author, at: entry.at,
      ...(full ? { note: entry.note, references: JSON.parse(entry.refs) } : {}),
    };
  }
  retroHandling(outcomeId, full = true) {
    const entry = this.db.prepare('SELECT * FROM retro_handlings WHERE outcome_id=? ORDER BY seq DESC LIMIT 1').get(outcomeId);
    return entry ? this.handlingEntry(entry, full) : { status: 'unhandled' };
  }
  handleRetro(input) {
    const row = this.row(input.task_id);
    if (row.kind === 'automation') fail('AUTOMATION_MANAGED', 'Automation has no Agent retro to handle');
    if (row.orchestrator !== input.actor) {
      fail('ORCHESTRATOR_REQUIRED', 'Only the Task orchestrator, the node that created it, handles its retro; an assignee never handles its own retro');
    }
    const outcome = this.db.prepare('SELECT * FROM outcomes WHERE task_id=? AND id=? AND retro_recorded=1').get(row.id, input.outcome_id.toLowerCase());
    if (!outcome) fail('RETRO_NOT_FOUND', 'outcome_id is not a recorded retro of this Task; read the Task retro or outcomes and use its outcome_id');
    if (outcome.retro === null) fail('RETRO_NO_FINDINGS', 'This retro was submitted as null (no findings) and needs no handling');
    const refs = JSON.stringify(input.references || []);
    const previous = this.db.prepare('SELECT * FROM retro_handlings WHERE outcome_id=? ORDER BY seq DESC LIMIT 1').get(outcome.id);
    const base = { task_id: row.id, outcome_id: outcome.id };
    if (previous && previous.status === input.status && previous.note === input.note && canonical(JSON.parse(previous.refs)) === canonical(input.references || [])) {
      return { result: { status: 'unchanged', ...base, handling: this.handlingEntry(previous) } };
    }
    const id = randomUUID(), at = now();
    this.db.prepare('INSERT INTO retro_handlings(id,task_id,outcome_id,status,note,refs,author,at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, row.id, outcome.id, input.status, input.note, refs, input.actor, at);
    return { result: { status: 'applied', ...base, handling: this.retroHandling(outcome.id) } };
  }
  latestRetro(row, includeText = false) {
    const outcome = row.kind === 'automation' ? null : this.db.prepare(
      'SELECT id,revision,assignee,author,at,retro,retro_recorded FROM outcomes WHERE task_id=? AND retro_recorded=1 ORDER BY seq DESC LIMIT 1',
    ).get(row.id);
    return this.retro(row, outcome, includeText);
  }
  selected(input) {
    const include = new Set(input.include);
    // Explicit projections keep unrequested bodies out of the read, not just the response.
    const columns = [
      'id', 'title', 'orchestrator', 'assignee', 'status', 'revision', 'acknowledged_revision',
      'created_at', 'updated_at', 'lifecycle', 'editable', 'kind', 'parent_task_id', 'depth',
      ...(include.has('definition') ? ['description', 'refs', 'metadata'] : []),
      ...(include.has('cancellation') ? ['cancellation'] : []),
    ];
    const row = this.db.prepare(`SELECT ${columns.join(',')} FROM tasks WHERE id=?`).get(input.task_id);
    if (!row) fail('TASK_NOT_FOUND', `Task ${input.task_id} does not exist`, 404);
    const result = this.identity(row);
    if (include.has('activity')) {
      const entry = this.db.prepare('SELECT id,task_id,revision,assignee,author,text,at FROM activities WHERE task_id=? ORDER BY seq DESC LIMIT 1').get(row.id);
      result.activity = entry ? { ...entry, current: entry.revision === row.revision, source: 'reported' } : null;
    }
    if (include.has('outcome')) {
      const entry = this.db.prepare('SELECT id,task_id,revision,assignee,author,summary,refs,at,run_id FROM outcomes WHERE task_id=? ORDER BY seq DESC LIMIT 1').get(row.id);
      if (entry) {
        const { refs, ...fields } = entry;
        result.outcome = {
          ...fields, references: JSON.parse(refs), current: entry.revision === row.revision,
          source: entry.run_id ? 'automation' : 'reported',
        };
      } else result.outcome = null;
    }
    if (include.has('retro')) result.retro = this.latestRetro(row, true);
    if (include.has('definition')) {
      const entry = this.db.prepare('SELECT revision,author,at FROM definitions WHERE task_id=? AND revision=?').get(row.id, row.revision);
      result.definition = {
        ...entry, source: 'reported', current: true, description: row.description,
        references: JSON.parse(row.refs), metadata: JSON.parse(row.metadata),
      };
    }
    if (include.has('automation')) result.automation = row.kind === 'automation'
      ? this.automation.project(this.automation.run(row.id, { includeLog: false }), true) : null;
    if (include.has('cancellation')) result.cancellation = row.cancellation ? JSON.parse(row.cancellation) : null;
    const size = JSON.stringify(result).length;
    if (size > LIMITS.selection) {
      const { activity, outcome, retro, definition, automation, cancellation, ...context } = result;
      const groups = { context, activity, outcome, retro, definition, automation, cancellation };
      fail('RESULT_TOO_LARGE', 'Selected content exceeds 48000 serialized JSON characters; narrow include or use existing definition/execution and paginated history/log views', 413, {
        task_id: row.id, include: input.include, max_characters: LIMITS.selection, serialized_characters: size,
        group_characters: Object.fromEntries(Object.entries(groups)
          .filter(([, value]) => value !== undefined).map(([key, value]) => [key, JSON.stringify(value).length])),
      });
    }
    return result;
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
    const input = parseInternal('task_read', rawInput);
    const actor = input.actor;
    // Role is derived from Task facts relative to the reading session, never from memory.
    const withRole = item => actor && item?.orchestrator !== undefined ? { ...item, actor_role: this.actorRole(item, actor) } : item;
    if (input.include) return withRole(this.transaction(() => this.selected(input), { readOnly: true }));
    if (input.view === 'operation') return this.operation(input.request_id);
    if (input.view === 'list') {
      const { orchestrator, assignee, parent_task_id: parent, query, retro } = input;
      const status = input.status ?? (retro ? 'all' : 'unfinished');
      const scope = hash({ view: 'list', orchestrator: orchestrator ?? null, assignee: assignee ?? null, parent: parent?.toLowerCase() ?? null, query: query ?? null, status, ...(retro ? { retro } : {}) });
      const clauses = ['seq < ?'], values = [this.cursor(input, scope)];
      if (orchestrator) { clauses.push('orchestrator=?'); values.push(orchestrator); }
      if (parent) { clauses.push('parent_task_id=?'); values.push(parent.toLowerCase()); }
      if (assignee) { clauses.push('assignee=?'); values.push(assignee); }
      if (status === 'unfinished') clauses.push("status NOT IN ('done','cancelled')");
      else if (status !== 'all') { clauses.push('status=?'); values.push(status); }
      if (query) { clauses.push('instr(lower(title), lower(?)) > 0'); values.push(query); }
      if (retro) {
        const latest = "(SELECT o.id FROM outcomes o WHERE o.task_id=tasks.id AND o.retro_recorded=1 ORDER BY o.seq DESC LIMIT 1)";
        const handled = `(SELECT h.status FROM retro_handlings h WHERE h.outcome_id=${latest} ORDER BY h.seq DESC LIMIT 1)`;
        clauses.push(retro === 'watching' ? `${handled}='watching'`
          : `kind='agent' AND EXISTS (SELECT 1 FROM outcomes o WHERE o.id=${latest} AND o.retro IS NOT NULL) AND ${handled} IS NULL`);
      }
      const limit = input.limit ?? 20;
      const rows = this.db.prepare(`SELECT * FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY seq DESC LIMIT ?`).all(...values, limit + 1);
      return this.page(rows, limit, scope, row => withRole(this.overview(row, false)));
    }
    const row = this.row(input.task_id);
    if (input.view === 'automation_log') return this.automation.log(input);
    if (['subscriptions', 'dependency_notices', 'child_notices'].includes(input.view)) {
      const scope = hash({ view: input.view, task_id: row.id });
      const limit = input.limit ?? 5;
      const rows = this.db.prepare(`SELECT * FROM ${notificationTable(input.view)} WHERE task_id=? AND seq < ? ORDER BY seq DESC LIMIT ?`)
        .all(row.id, this.cursor(input, scope), limit + 1);
      return this.page(rows, limit, scope, entry => ({ subscriptions: this.subscription, dependency_notices: this.notice, child_notices: this.childNotice })[input.view].call(this, entry), { task_id: row.id });
    }
    if (input.view === 'overview') return withRole(this.overview(row));
    if (input.view === 'execution' || input.view === 'definition') return withRole(this.task(row.id));
    if (input.view === 'changelog' && input.revision !== undefined) {
      const entry = this.db.prepare('SELECT revision,description,reason,author,at FROM definitions WHERE task_id=? AND revision=?').get(row.id, input.revision);
      if (!entry) fail('REVISION_NOT_FOUND', 'Definition revision does not exist', 404);
      return { task_id: row.id, ...entry, source: 'reported' };
    }
    if (input.view === 'retro_handlings') {
      const scope = hash({ view: input.view, task_id: row.id });
      const limit = input.limit ?? 5;
      const rows = this.db.prepare('SELECT * FROM retro_handlings WHERE task_id=? AND seq < ? ORDER BY seq DESC LIMIT ?')
        .all(row.id, this.cursor(input, scope), limit + 1);
      return this.page(rows, limit, scope, entry => ({ ...this.handlingEntry(entry), outcome_id: entry.outcome_id }), { task_id: row.id });
    }
    const table = { changelog: 'definitions', activity: 'activities', outcomes: 'outcomes' }[input.view];
    const scope = hash({ view: input.view, task_id: row.id });
    const limit = input.limit ?? 5;
    const rows = this.db.prepare(`SELECT * FROM ${table} WHERE task_id=? AND seq < ? ORDER BY seq DESC LIMIT ?`)
      .all(row.id, this.cursor(input, scope), limit + 1);
    return this.page(rows, limit, scope, entry => {
      const { seq, description, refs, retro, retro_recorded, ...fields } = entry;
      return {
        ...fields, source: fields.run_id ? 'automation' : 'reported',
        ...(input.view === 'outcomes' ? { current: entry.revision === row.revision, retro: this.retro(row, entry) } : {}),
        ...(refs ? { references: JSON.parse(refs) } : {}),
        ...(description ? { description_available: true, description_length: description.length } : {}),
      };
    }, { task_id: row.id });
  }
  definitionCheck({ task_id, actor } = {}) {
    try {
      const rows = this.db.prepare("SELECT id,assignee,status,revision,acknowledged_revision FROM tasks WHERE id=? OR (assignee=? AND status NOT IN ('done','cancelled'))")
        .all(task_id ?? null, actor ?? null);
      if (task_id && !rows.some(row => row.id === task_id)) fail('TASK_NOT_FOUND', `Task ${task_id} does not exist`, 404);
      if (!rows.length) return { status: 'not_applicable', tasks: [] };
      return {
        status: 'checked',
        tasks: rows.map(row => {
          const needs_ack = Boolean(row.assignee) && !terminal(row.status) && row.acknowledged_revision !== row.revision;
          return {
            task_id: row.id, revision: row.revision, acknowledged_revision: row.acknowledged_revision, needs_ack,
            ...(needs_ack ? { message: row.acknowledged_revision === null
              ? "Awaiting the assignee's acknowledgement of the current Task description"
              : "Task description has changed; awaiting the assignee's acknowledgement of the current revision" } : {}),
          };
        }),
      };
    } catch (error) {
      return { status: 'unavailable', error: { code: error.code || 'DEFINITION_CHECK_FAILED', message: error.message } };
    }
  }
}
