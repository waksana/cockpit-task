import { createHash, randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskError } from './contracts.js';

const SOURCE_SCHEMA = 11;
const TARGET_SCHEMA = 12;
const MAX_TASKS = 10000;
const notices = ['subscriptions', 'dependency_notices', 'child_notices', 'assignee_notices'];
const terminal = status => status === 'done' || status === 'cancelled';
const quote = name => `"${name.replaceAll('"', '""')}"`;
const reject = message => { throw new TaskError('MIGRATION_REVIEW_REQUIRED', message, 409); };
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const columns = (db, table) => db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => row.name);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, maximum) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;

function exactKeys(value, expected, label) {
  if (!plain(value) || Object.keys(value).length !== expected.length
    || Object.keys(value).some(key => !expected.includes(key))) {
    reject(`${label} must contain exactly: ${expected.join(', ')}`);
  }
}

function integrity(db) {
  if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok'
    || db.prepare('PRAGMA foreign_key_check').get()) reject('Database integrity or foreign keys are invalid');
}

function sourceSchema(db) {
  if (db.prepare('PRAGMA user_version').get().user_version !== SOURCE_SCHEMA) {
    reject('Explicit responsibility migration requires schema 11; no replay or older-schema conversion is allowed');
  }
  const required = {
    tasks: ['id', 'orchestrator', 'assignee', 'status', 'kind', 'parent_task_id', 'depth', 'revision', 'lifecycle', 'editable'],
    definitions: ['task_id', 'revision', 'description'],
    acknowledgements: ['task_id', 'revision', 'confirmed_for'],
    activities: ['task_id', 'assignee'],
    outcomes: ['task_id', 'assignee', 'run_id', 'retro', 'retro_recorded'],
    task_assignments: ['task_id', 'assignee'],
    operations: ['seq', 'actor', 'request_id', 'fingerprint', 'input', 'result', 'error', 'status', 'legacy_reason'],
    scripts: ['script_id', 'definition'],
    automation_runs: ['task_id', 'state', 'barrier', 'cancel_requested', 'process_group'],
    task_dependencies: ['id', 'task_id', 'kind', 'blocker_id', 'condition', 'resolved_at', 'resolution'],
    dependency_notices: ['id', 'orchestrator', 'event', 'delivery_status'],
    child_notices: ['id', 'orchestrator', 'event', 'delivery_status'],
    assignee_notices: ['id', 'assignee', 'kind', 'event', 'delivery_status'],
    subscriptions: ['id', 'subscriber', 'event', 'delivery_status'],
    retro_handlings: ['id', 'outcome_id'],
    migration_v10_items: ['task_id', 'prior_status', 'action'],
    migration_v10_subscriptions: ['subscription_id', 'prior_statuses'],
  };
  for (const [table, expected] of Object.entries(required)) {
    const actual = columns(db, table);
    if (expected.some(column => !actual.includes(column))) reject(`Unsupported schema-11 structure in ${table}`);
  }
  const rebuilt = {
    task_dependencies: ['seq', 'id', 'task_id', 'kind', 'blocker_id', 'condition', 'author', 'at',
      'resolved_at', 'resolved_by', 'resolution', 'blocker_lifecycle'],
    assignee_notices: ['seq', 'id', 'task_id', 'revision', 'assignee', 'kind', 'event', 'created_at',
      'delivery_status', 'attempted_at', 'completed_at', 'delivery_error'],
  };
  for (const [table, expected] of Object.entries(rebuilt)) {
    if (canonical(columns(db, table)) !== canonical(expected)) {
      reject(`Unknown ${table} columns; the migration cannot discard unrecognized historical fields`);
    }
  }
  const rebuiltIndexes = new Set(['task_dependencies_task', 'task_dependencies_blocker',
    'task_dependencies_active_task', 'task_dependencies_active_condition',
    'assignee_notices_task', 'assignee_notices_pending']);
  for (const { name, type, tbl_name: table } of db.prepare("SELECT name,type,tbl_name FROM sqlite_schema WHERE sql IS NOT NULL").all()) {
    if (type === 'view') reject(`Unsupported view ${name}; dependent schema requires separate review`);
    if (type === 'index' && Object.hasOwn(rebuilt, table) && !rebuiltIndexes.has(name)) {
      reject(`Unknown index ${name} would be lost during migration`);
    }
  }
  if (columns(db, 'tasks').some(column => ['created_by', 'work_mode', 'legacy', 'cancellation_request'].includes(column))
    || columns(db, 'responsibility_events').length || columns(db, 'migration_v12_items').length) {
    reject('Responsibility schema already exists or the source is partially modified');
  }
  const normalize = sql => sql.replace(/\s+/g, '').replaceAll(';', '').toLowerCase();
  const knownTriggers = new Map([
    ['tasks_status_insert', "CREATE TRIGGER tasks_status_insert BEFORE INSERT ON tasks WHEN NEW.status NOT IN ('todo','in_progress','done','cancelled') BEGIN SELECT RAISE(ABORT,'invalid Task lifecycle status'); END"],
    ['tasks_status_update', "CREATE TRIGGER tasks_status_update BEFORE UPDATE OF status ON tasks WHEN NEW.status NOT IN ('todo','in_progress','done','cancelled') BEGIN SELECT RAISE(ABORT,'invalid Task lifecycle status'); END"],
  ]);
  for (const { name, sql } of db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all()) {
    if (!knownTriggers.has(name) || normalize(sql) !== normalize(knownTriggers.get(name))) {
      reject(`Unknown trigger ${name}; migration will not execute unreviewed database effects`);
    }
  }
}

// Hash committed logical content, not database-file pages which may omit the WAL.
export function responsibilityFingerprint(db) {
  const hash = createHash('sha256');
  hash.update(String(db.prepare('PRAGMA user_version').get().user_version));
  const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
  hash.update(canonical(schema));
  for (const { name } of schema.filter(row => row.type === 'table')) {
    hash.update(canonical(name));
    for (const row of db.prepare(`SELECT * FROM ${quote(name)} ORDER BY rowid`).iterate()) {
      hash.update(canonical(row));
      hash.update('\n');
    }
  }
  return hash.digest('hex');
}

function inFlight(db) {
  const effects = [];
  for (const row of db.prepare("SELECT seq,actor,request_id,status FROM operations WHERE status<>'final'").all()) {
    effects.push({ table: 'operations', ...row });
  }
  for (const table of notices) {
    for (const row of db.prepare(`SELECT id,delivery_status FROM ${table} WHERE delivery_status='pending'`).all()) {
      effects.push({ table, ...row });
    }
  }
  for (const row of db.prepare("SELECT task_id,state,barrier FROM automation_runs WHERE state IN ('queued','starting','running')").all()) {
    effects.push({ table: 'automation_runs', ...row });
  }
  return effects;
}

export function responsibilityInventory(db) {
  sourceSchema(db);
  integrity(db);
  const count = db.prepare('SELECT count(*) AS count FROM tasks').get().count;
  if (count > MAX_TASKS) reject(`TREE_RESOURCE_LIMIT: review supports at most ${MAX_TASKS} Tasks`);
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY seq').all().map(row => ({
    ...row,
    definitions: db.prepare('SELECT * FROM definitions WHERE task_id=? ORDER BY seq').all(row.id),
    acknowledgements: db.prepare('SELECT * FROM acknowledgements WHERE task_id=? ORDER BY revision').all(row.id),
    assignments: db.prepare('SELECT * FROM task_assignments WHERE task_id=? ORDER BY seq').all(row.id),
    activities: db.prepare('SELECT * FROM activities WHERE task_id=? ORDER BY seq').all(row.id),
    outcomes: db.prepare('SELECT * FROM outcomes WHERE task_id=? ORDER BY seq').all(row.id),
    dependencies: db.prepare('SELECT * FROM task_dependencies WHERE task_id=? ORDER BY seq').all(row.id),
    automation: db.prepare('SELECT * FROM automation_runs WHERE task_id=?').get(row.id) ?? null,
  }));
  return {
    schema: SOURCE_SCHEMA, target_schema: TARGET_SCHEMA, source_fingerprint: responsibilityFingerprint(db),
    tasks, in_flight: inFlight(db),
    plan_contract: {
      fields: ['schema', 'target_schema', 'source_fingerprint', 'reviewer', 'source', 'tasks'],
      tasks: 'Object keyed by every Task ID, with exactly revision, work_mode, evidence per Task',
      work_mode: 'Agent todo: undecided; in_progress: execute or orchestrate; terminal: null for unknown legacy, otherwise evidence-backed execute/orchestrate (cancelled may be undecided); automation: null',
      evidence: 'Nonempty explicit reviewed evidence (max 4000 characters); neither child absence nor native activity establishes a mode',
      reviewer: 'Named reviewer (max 200 characters)',
      source: 'Review authorization/evidence reference (max 4000 characters)',
    },
  };
}

function validateStructure(inventory, decisions) {
  const tasks = new Map(inventory.tasks.map(row => [row.id, row]));
  const occupied = new Set();
  for (const row of tasks.values()) {
    if (!['agent', 'automation'].includes(row.kind) || !['todo', 'in_progress', 'done', 'cancelled'].includes(row.status)
      || !Number.isSafeInteger(row.depth) || row.depth < 1 || !text(row.orchestrator, 200)
      || !Number.isSafeInteger(row.revision) || row.revision < 1
      || !Number.isSafeInteger(row.lifecycle) || row.lifecycle < 1
      || !Number.isSafeInteger(row.editable) || row.editable < 1
      || !row.definitions.some(item => item.revision === row.revision && item.description === row.description)) {
      reject(`Task ${row.id} has invalid lifecycle, revision, creation history or structure`);
    }
    if (row.assignee !== null && !text(row.assignee, 200)) reject(`Task ${row.id} has an invalid assignee`);
    if (row.kind === 'agent' && row.status === 'in_progress' && !row.assignee) reject(`Active Task ${row.id} is unbound`);
    if (row.kind === 'automation' && (row.assignee !== null || row.acknowledged_revision !== null || !row.automation)) {
      reject(`Automation ${row.id} cannot have Agent binding/ACK and must retain its run record`);
    }
    if (row.kind === 'agent' && row.automation) reject(`Agent ${row.id} has an automation run`);
    if (row.automation && !['created', 'queued', 'starting', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled'].includes(row.automation.state)) {
      reject(`Automation ${row.id} has unknown execution facts`);
    }
    if (row.assignee && !terminal(row.status)) {
      if (occupied.has(row.assignee)) reject(`Session ${row.assignee} holds multiple unfinished Tasks`);
      occupied.add(row.assignee);
    }
    const ancestors = new Set([row.id]);
    let current = row;
    while (current.parent_task_id !== null) {
      const parent = tasks.get(current.parent_task_id);
      if (!parent || ancestors.has(parent.id)) reject(`Task ${row.id} has a missing parent or responsibility cycle`);
      ancestors.add(parent.id);
      if (parent.kind !== 'agent' || !parent.assignee || current.depth !== parent.depth + 1) {
        reject(`Task ${row.id} has an invalid parent binding or depth`);
      }
      if (row.assignee && row.assignee === parent.assignee) reject(`Task ${row.id} shares an ancestor's assignee`);
      if (!terminal(current.status) && parent.status !== 'in_progress') {
        reject(`Unfinished Task ${current.id} lacks an active parent`);
      }
      const mode = decisions[parent.id].work_mode;
      if ((!terminal(parent.status) || mode !== null) && mode !== 'orchestrate') {
        reject(`Parent ${parent.id} requires an explicit orchestrate decision`);
      }
      current = parent;
    }
    if (current.depth !== 1) reject(`Root ${current.id} has a non-root depth`);
    for (const dependency of row.dependencies.filter(item => item.resolved_at === null && item.kind === 'task')) {
      if (!tasks.has(dependency.blocker_id) || ancestors.has(dependency.blocker_id)) {
        reject(`Task ${row.id} has a missing, self or ancestor prerequisite`);
      }
      let blocker = tasks.get(dependency.blocker_id);
      const visited = new Set();
      while (blocker.parent_task_id !== null) {
        if (visited.has(blocker.id)) reject('Responsibility cycle in prerequisite ancestry');
        visited.add(blocker.id);
        if (blocker.parent_task_id === row.id) reject(`Task ${row.id} depends on its descendant`);
        blocker = tasks.get(blocker.parent_task_id);
        if (!blocker) reject('Missing prerequisite ancestor');
      }
    }
  }
  // Check active prerequisite cycles without recursive JS calls.
  const edges = new Map([...tasks].map(([id, row]) => [id,
    row.dependencies.filter(item => item.resolved_at === null && item.kind === 'task').map(item => item.blocker_id)]));
  const visiting = new Set(), complete = new Set();
  for (const id of tasks.keys()) {
    const stack = [[id, false]];
    while (stack.length) {
      const [node, exit] = stack.pop();
      if (exit) { visiting.delete(node); complete.add(node); continue; }
      if (complete.has(node)) continue;
      if (visiting.has(node)) reject('Active prerequisite cycle');
      visiting.add(node);
      stack.push([node, true], ...edges.get(node).map(next => [next, false]));
    }
  }
}

export function validateResponsibilityPlan(db, plan, inventory = responsibilityInventory(db)) {
  exactKeys(plan, ['schema', 'target_schema', 'source_fingerprint', 'reviewer', 'source', 'tasks'], 'Plan');
  if (plan.schema !== SOURCE_SCHEMA || plan.target_schema !== TARGET_SCHEMA
    || plan.source_fingerprint !== inventory.source_fingerprint
    || !text(plan.reviewer, 200) || !text(plan.source, 4000)) {
    reject('Reviewed schema 11 -> 12 plan must match the complete current snapshot and identify its reviewer and source');
  }
  if (!plain(plan.tasks) || Object.keys(plan.tasks).length !== inventory.tasks.length
    || Object.keys(plan.tasks).some(id => !inventory.tasks.some(row => row.id === id))) {
    reject('The plan must cover exactly every Task, including terminal and automation records');
  }
  for (const row of inventory.tasks) {
    const entry = plan.tasks[row.id];
    exactKeys(entry, ['revision', 'work_mode', 'evidence'], `Task ${row.id} decision`);
    const allowed = row.kind === 'automation' ? [null]
      : row.status === 'todo' ? ['undecided']
        : row.status === 'in_progress' ? ['execute', 'orchestrate']
          : row.status === 'cancelled' ? [null, 'undecided', 'execute', 'orchestrate'] : [null, 'execute', 'orchestrate'];
    if (entry.revision !== row.revision || !allowed.includes(entry.work_mode) || !text(entry.evidence, 4000)) {
      reject(`Task ${row.id} needs its exact revision, a permitted explicit work_mode and reviewed evidence`);
    }
  }
  validateStructure(inventory, plan.tasks);
  if (inventory.in_flight.length) reject('In-flight operations, pending notices or active automation require separate resolution before migration');
  return plan.tasks;
}

function installSchema(db) {
  const sequences = new Map(db.prepare("SELECT name,seq FROM sqlite_sequence WHERE name IN ('task_dependencies','assignee_notices')").all()
    .map(row => [row.name, row.seq]));
  db.exec(`
    ALTER TABLE tasks RENAME COLUMN orchestrator TO created_by;
    ALTER TABLE tasks ADD COLUMN work_mode TEXT CHECK(work_mode IN ('undecided','execute','orchestrate'));
    ALTER TABLE tasks ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0 CHECK(legacy IN (0,1));
    ALTER TABLE tasks ADD COLUMN cancellation_request TEXT;
    ALTER TABLE dependency_notices RENAME COLUMN orchestrator TO recipient;
    ALTER TABLE child_notices RENAME COLUMN orchestrator TO recipient;
    DROP INDEX task_dependencies_task;
    DROP INDEX task_dependencies_blocker;
    DROP INDEX task_dependencies_active_task;
    DROP INDEX task_dependencies_active_condition;
    ALTER TABLE task_dependencies RENAME TO task_dependencies_v11;
    CREATE TABLE task_dependencies (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      kind TEXT NOT NULL CHECK(kind IN ('task','condition')),
      blocker_id TEXT REFERENCES tasks(id), condition TEXT,
      author TEXT NOT NULL, at TEXT NOT NULL,
      resolved_at TEXT, resolved_by TEXT,
      resolution TEXT CHECK(resolution IN ('done','removed','evidence')),
      blocker_lifecycle INTEGER, evidence TEXT, refs TEXT,
      CHECK((kind='task' AND blocker_id IS NOT NULL AND condition IS NULL AND task_id<>blocker_id)
        OR (kind='condition' AND blocker_id IS NULL AND condition IS NOT NULL)),
      CHECK((resolved_at IS NULL AND resolved_by IS NULL AND resolution IS NULL)
        OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolution IS NOT NULL)),
      CHECK(resolution IS NOT 'evidence' OR (kind='condition' AND evidence IS NOT NULL AND refs IS NOT NULL))
    );
    INSERT INTO task_dependencies(seq,id,task_id,kind,blocker_id,condition,author,at,resolved_at,resolved_by,resolution,blocker_lifecycle)
      SELECT seq,id,task_id,kind,blocker_id,condition,author,at,resolved_at,resolved_by,resolution,blocker_lifecycle
      FROM task_dependencies_v11;
    DROP TABLE task_dependencies_v11;
    CREATE INDEX task_dependencies_task ON task_dependencies(task_id,seq);
    CREATE INDEX task_dependencies_blocker ON task_dependencies(blocker_id)
      WHERE blocker_id IS NOT NULL AND resolved_at IS NULL;
    CREATE UNIQUE INDEX task_dependencies_active_task ON task_dependencies(task_id,blocker_id)
      WHERE kind='task' AND resolved_at IS NULL;
    CREATE UNIQUE INDEX task_dependencies_active_condition ON task_dependencies(task_id,condition)
      WHERE kind='condition' AND resolved_at IS NULL;
    CREATE TABLE responsibility_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL,
      author TEXT NOT NULL, at TEXT NOT NULL, details TEXT NOT NULL
    );
    CREATE INDEX responsibility_events_task ON responsibility_events(task_id,seq);
    CREATE TABLE migration_v12_items (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
      revision INTEGER NOT NULL, prior_status TEXT NOT NULL, work_mode TEXT, legacy INTEGER NOT NULL,
      evidence TEXT NOT NULL, reviewer TEXT NOT NULL, source TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL, plan_fingerprint TEXT NOT NULL, migrated_at TEXT NOT NULL
    );
    CREATE TABLE migration_v12_audit (
      source_fingerprint TEXT PRIMARY KEY, plan_fingerprint TEXT NOT NULL,
      reviewer TEXT NOT NULL, source TEXT NOT NULL, plan TEXT NOT NULL,
      task_count INTEGER NOT NULL, migrated_at TEXT NOT NULL
    );
    DROP INDEX assignee_notices_task;
    DROP INDEX assignee_notices_pending;
    ALTER TABLE assignee_notices RENAME TO assignee_notices_v11;
    CREATE TABLE assignee_notices (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL, assignee TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('updated','cancelled','cancellation_requested')),
      event TEXT NOT NULL, created_at TEXT NOT NULL,
      delivery_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(delivery_status IN ('pending','unknown','accepted','queued','not_sent')),
      attempted_at TEXT, completed_at TEXT, delivery_error TEXT
    );
    INSERT INTO assignee_notices SELECT * FROM assignee_notices_v11;
    DROP TABLE assignee_notices_v11;
    CREATE INDEX assignee_notices_task ON assignee_notices(task_id,seq);
    CREATE INDEX assignee_notices_pending ON assignee_notices(seq) WHERE delivery_status='pending';
  `);
  for (const [name, seq] of sequences) {
    if (!db.prepare('UPDATE sqlite_sequence SET seq=? WHERE name=?').run(seq, name).changes) {
      db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(name, seq);
    }
  }
}

export function initializeResponsibilitySchema(db) {
  for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    if (db.prepare(`SELECT 1 FROM ${quote(name)} LIMIT 1`).get()) {
      reject('Responsibility bootstrap accepts only empty storage; existing records require explicit review');
    }
  }
  db.exec('SAVEPOINT responsibility_bootstrap');
  try {
    installSchema(db);
    db.exec('RELEASE responsibility_bootstrap');
  } catch (error) {
    db.exec('ROLLBACK TO responsibility_bootstrap; RELEASE responsibility_bootstrap');
    throw error;
  }
}

export function applyResponsibilityMigration(db, plan) {
  // Works inside TaskStore's immediate transaction or as a standalone offline operation.
  const outer = db.isTransaction;
  db.exec(outer ? 'SAVEPOINT responsibility_v12' : 'BEGIN IMMEDIATE');
  try {
    const inventory = responsibilityInventory(db);
    validateResponsibilityPlan(db, plan, inventory);
    const at = new Date().toISOString(), planFingerprint = digest(plan);
    installSchema(db);
    for (const row of inventory.tasks) {
      const entry = plan.tasks[row.id];
      const legacy = Number(row.kind === 'agent' && terminal(row.status) && entry.work_mode === null);
      db.prepare('UPDATE tasks SET work_mode=?,legacy=?,lifecycle=lifecycle+1,editable=editable+1 WHERE id=?')
        .run(entry.work_mode, legacy, row.id);
      db.prepare(`INSERT INTO migration_v12_items(
        task_id,revision,prior_status,work_mode,legacy,evidence,reviewer,source,source_fingerprint,plan_fingerprint,migrated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.revision, row.status, entry.work_mode, legacy,
        entry.evidence, plan.reviewer, plan.source, inventory.source_fingerprint, planFingerprint, at);
      db.prepare('INSERT INTO responsibility_events(id,task_id,kind,author,details,at) VALUES(?,?,?,?,?,?)')
        .run(randomUUID(), row.id, 'migrated', plan.reviewer, JSON.stringify({
          revision: row.revision,
          work_mode: entry.work_mode, legacy: Boolean(legacy), prior_status: row.status,
          evidence: entry.evidence, source_fingerprint: inventory.source_fingerprint,
          plan_fingerprint: planFingerprint, historical_start: 'not_inferred',
        }), at);
    }
    db.prepare('INSERT INTO migration_v12_audit VALUES(?,?,?,?,?,?,?)').run(
      inventory.source_fingerprint, planFingerprint, plan.reviewer, plan.source,
      JSON.stringify(plan), inventory.tasks.length, at,
    );
    db.exec(`PRAGMA user_version=${TARGET_SCHEMA}`);
    integrity(db);
    db.exec(outer ? 'RELEASE responsibility_v12' : 'COMMIT');
    return { status: 'migrated', schema: TARGET_SCHEMA, source_fingerprint: inventory.source_fingerprint,
      plan_fingerprint: planFingerprint, tasks: inventory.tasks.length };
  } catch (error) {
    db.exec(outer ? 'ROLLBACK TO responsibility_v12; RELEASE responsibility_v12' : 'ROLLBACK');
    throw error;
  }
}

export function responsibilityDatabasePath(directory) {
  const file = join(directory, 'task-board.sqlite');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) reject('Expected an existing regular, unlinked Task database, not a symlink');
  return file;
}

export function inspectResponsibilityMigration(directory, { plan } = {}) {
  const db = new DatabaseSync(responsibilityDatabasePath(directory), { readOnly: true });
  try {
    db.exec('BEGIN');
    const inventory = responsibilityInventory(db);
    if (plan !== undefined) validateResponsibilityPlan(db, plan, inventory);
    db.exec('COMMIT');
    return inventory;
  } finally {
    db.close();
  }
}
