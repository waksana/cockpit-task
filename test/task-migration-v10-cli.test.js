import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../src/task-board/store.js';
import { lifecycleInventory } from '../src/task-board/lifecycle-migration.js';
import { restoreV11Schema } from './helpers/responsibility-v11.js';
import { restoreV10Operations } from './helpers/operations-v10.js';

const project = resolve(import.meta.dirname, '..');
const cli = resolve(project, 'scripts/migrate-task-v10.js');
const at = '2026-09-27T00:00:00.000Z';
function fixture(t) {
  const directory = resolve(project, 'dist', `migration-v10-cli-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new TaskStore(directory);
  store.close();
  const file = resolve(directory, 'task-board.sqlite');
  const db = new DatabaseSync(file);
  const id = randomUUID();
  let reviewed;
  try {
    restoreV11Schema(db);
    restoreV10Operations(db);
    db.exec(`
      DROP TRIGGER tasks_status_insert;
      DROP TRIGGER tasks_status_update;
      DROP TABLE migration_v10_items;
      DROP TABLE migration_v10_subscriptions;
      DROP TABLE task_dependencies;
      CREATE TABLE task_dependencies (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
        blocker_id TEXT NOT NULL REFERENCES tasks(id), author TEXT NOT NULL, at TEXT NOT NULL,
        UNIQUE(task_id,blocker_id), CHECK(task_id<>blocker_id)
      );
      CREATE INDEX task_dependencies_blocker ON task_dependencies(blocker_id);
      DROP TABLE dependency_notices;
      CREATE TABLE dependency_notices (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(id), blocker_id TEXT NOT NULL REFERENCES tasks(id),
        blocker_lifecycle INTEGER NOT NULL, orchestrator TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('ready','blocker_cancelled')),
        event TEXT NOT NULL, created_at TEXT NOT NULL,
        delivery_status TEXT NOT NULL DEFAULT 'pending'
          CHECK(delivery_status IN ('pending','unknown','accepted','queued','not_sent')),
        attempted_at TEXT, completed_at TEXT, delivery_error TEXT,
        UNIQUE(task_id,kind,blocker_id,blocker_lifecycle)
      );
      CREATE INDEX dependency_notices_task ON dependency_notices(task_id,seq);
      CREATE INDEX dependency_notices_pending ON dependency_notices(seq) WHERE delivery_status='pending';
      PRAGMA user_version=9;
    `);
    db.prepare(`INSERT INTO tasks(id,title,description,orchestrator,assignee,status,refs,metadata,created_at,updated_at)
      VALUES(?,'Historical Task','Preserved scope','creator','assignee','blocked','[]','{}',?,?)`).run(id, at, at);
    db.prepare(`INSERT INTO definitions(task_id,revision,description,reason,author,at)
      VALUES(?,1,'Preserved scope','Initial definition','creator',?)`).run(id, at);
    db.prepare(`INSERT INTO operations(request_id,tool,fingerprint,input,status,result,created_at,updated_at,resumed_by)
      VALUES('historical-receipt','task_assign','unchanged','{"actor":"creator"}','final',
        '{"message":"unknown","orchestrator":"creator"}',?,?,'consumed')`).run(at, at);
    const inventory = lifecycleInventory(db);
    reviewed = { schema: 9, target_schema: 10, source_fingerprint: inventory.source_fingerprint,
      tasks: { [id]: { revision: 1, action: 'condition', source: 'Reviewed legacy CLI fixture',
        condition: 'Recorded approval still required' } } };
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
  const plan = resolve(directory, 'reviewed.json');
  writeFileSync(plan, JSON.stringify(reviewed));
  return { directory, file, plan, id };
}
const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
function rows(file, sql) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}

for (const order of ['action-first', 'plan-first']) {
  test(`v9 preflight/apply accepts ${order} and preserves the exact schema10 boundary`, t => {
    const f = fixture(t);
    const command = action => ['--data-root', f.directory, ...(order === 'action-first'
      ? [action, '--plan', f.plan] : ['--plan', f.plan, action])];
    const bytes = readFileSync(f.file);
    const receipt = rows(f.file, 'SELECT * FROM operations');
    const definitions = rows(f.file, 'SELECT * FROM definitions');
    const before = rows(f.file, 'SELECT * FROM tasks')[0];
    const preflight = run(command('--preflight'));
    assert.equal(preflight.status, 0, preflight.stderr);
    assert.equal(JSON.parse(preflight.stdout).final_schema, 10);
    assert.deepEqual(readFileSync(f.file), bytes);
    const applied = run(command('--apply'));
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).schema, 10);
    assert.equal(rows(f.file, 'PRAGMA user_version')[0].user_version, 10);
    const after = rows(f.file, 'SELECT * FROM tasks')[0];
    assert.equal(after.status, 'in_progress');
    assert.equal(after.lifecycle, before.lifecycle + 1);
    assert.deepEqual({ ...after, status: before.status, lifecycle: before.lifecycle, updated_at: before.updated_at }, { ...before });
    assert.deepEqual(rows(f.file, 'SELECT * FROM operations'), receipt);
    assert.deepEqual(rows(f.file, 'SELECT * FROM definitions'), definitions);
    assert.equal(rows(f.file, 'SELECT action FROM migration_v10_items')[0].action, 'condition');
    assert.equal(rows(f.file, 'SELECT condition FROM task_dependencies')[0].condition, 'Recorded approval still required');
    assert.ok(!rows(f.file, 'PRAGMA table_info(tasks)').some(row => row.name === 'work_mode'));
    assert.ok(!rows(f.file, 'PRAGMA table_info(operations)').some(row => row.name === 'actor'));
    assert.equal(rows(f.file, 'PRAGMA integrity_check')[0].integrity_check, 'ok');
    assert.deepEqual(rows(f.file, 'PRAGMA foreign_key_check'), []);
  });
}

test('inventory and reviewed options remain independent of data-root position', t => {
  const f = fixture(t), bytes = readFileSync(f.file);
  for (const args of [
    ['--data-root', f.directory],
    ['--inventory', '--data-root', f.directory],
    ['--preflight', '--plan', f.plan, '--data-root', f.directory],
    ['--plan', f.plan, '--data-root', f.directory, '--preflight'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).final_schema, 10);
    assert.deepEqual(readFileSync(f.file), bytes);
  }
});

test('duplicate, missing, unknown and conflicting options refuse without changing the source', t => {
  const f = fixture(t), base = ['--data-root', f.directory], bytes = readFileSync(f.file);
  for (const args of [
    [], ['--data-root'], ['--data-root', '--inventory'], ['--data-root', ''],
    ['--preflight', '--plan', f.plan],
    [...base, '--unknown'], [...base, 'unexpected'],
    [...base, '--data-root', f.directory], [...base, '--inventory', '--inventory'],
    [...base, '--plan', f.plan], [...base, '--preflight'], [...base, '--apply'],
    [...base, '--plan'], [...base, '--preflight', '--plan'],
    [...base, '--preflight', '--plan', '--apply'],
    [...base, '--preflight', '--plan', ''],
    [...base, '--plan', f.plan, '--plan', f.plan, '--preflight'],
    [...base, '--plan', f.plan, '--preflight', '--preflight'],
    [...base, '--plan', f.plan, '--apply', '--apply'],
    [...base, '--plan', f.plan, '--preflight', '--apply'],
    [...base, '--plan', f.plan, '--inventory', '--preflight'],
    [...base, '--plan', f.plan, '--inventory', '--apply'],
  ]) {
    const result = run(args);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.match(result.stderr, /Usage: migrate-task-v10\.js/, JSON.stringify(args));
    assert.deepEqual(readFileSync(f.file), bytes);
  }
});
