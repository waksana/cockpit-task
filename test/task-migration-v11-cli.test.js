import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../src/task-board/store.js';
import { restoreV10Operations, v10OperationColumns } from './helpers/operations-v10.js';

const cli = fileURLToPath(new URL('../scripts/migrate-task-v11.js', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'task-v11-cli-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new TaskStore(root);
  store.executeLocal('task_create', {
    actor: 'synthetic-actor', request_id: 'create', title: 'Keep this Task', description: 'Preserve all fields',
  });
  store.close();
  const path = join(root, 'task-board.sqlite');
  const db = new DatabaseSync(path);
  restoreV10Operations(db);
  db.exec("PRAGMA user_version=10; UPDATE operations SET status='pending',resumed_by='consumed'");
  db.prepare(`INSERT INTO operations(${v10OperationColumns.join(',')}) VALUES(${v10OperationColumns.map(() => '?').join(',')})`)
    .run('legacy', 'task_create', 'unchanged', '{}', 'pending', null, null, 'before', 'before', null, null, null);
  db.close();
  return { root, path };
}
function run(root, action) {
  return spawnSync(process.execPath, [cli, '--data-root', root, action], { encoding: 'utf8' });
}
function read(path, query) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare(query).all(); } finally { db.close(); }
}

test('preflight leaves source bytes unchanged; apply preserves receipts and all other tables', t => {
  const f = fixture(t);
  const bytes = readFileSync(f.path);
  const old = read(f.path, `SELECT ${v10OperationColumns.join(',')} FROM operations ORDER BY rowid`);
  const tables = read(f.path, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('operations','sqlite_sequence')");
  const rows = tables.map(({ name }) => [name, read(f.path, `SELECT * FROM "${name}"`)]);
  const preflight = run(f.root, '--preflight');
  assert.equal(preflight.status, 0, preflight.stderr);
  assert.deepEqual(JSON.parse(preflight.stdout), {
    status: 'ready', schema: 10, target_schema: 11, operations: 2, legacy_operations: 1,
  });
  assert.deepEqual(readFileSync(f.path), bytes);
  const apply = run(f.root, '--apply');
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(JSON.parse(apply.stdout).schema, 11);
  assert.deepEqual(read(f.path, `SELECT ${v10OperationColumns.join(',')} FROM operations ORDER BY seq`), old);
  for (const [name, before] of rows) assert.deepEqual(read(f.path, `SELECT * FROM "${name}"`), before, name);
  assert.deepEqual(read(f.path, 'SELECT actor FROM operations ORDER BY seq').map(row => row.actor), ['synthetic-actor', null]);
  const again = run(f.root, '--apply');
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /requires schema v10/);
});

test('preflight includes committed WAL records without changing source schema or records', t => {
  const f = fixture(t);
  const db = new DatabaseSync(f.path);
  try {
    db.exec("PRAGMA journal_mode=WAL; UPDATE tasks SET title='Committed WAL data'");
    const before = db.prepare('SELECT * FROM tasks').all();
    const result = run(f.root, '--preflight');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 10);
    assert.deepEqual(db.prepare('SELECT * FROM tasks').all(), before);
  } finally { db.close(); }
});

test('invalid schema, missing database and unknown flags fail without migration', t => {
  const f = fixture(t);
  const db = new DatabaseSync(f.path);
  db.exec('PRAGMA user_version=9');
  db.close();
  for (const action of ['--preflight', '--apply', '--unknown']) {
    const result = run(f.root, action);
    assert.notEqual(result.status, 0);
  }
  assert.equal(read(f.path, 'PRAGMA user_version')[0].user_version, 9);
  assert.notEqual(run(join(f.root, 'missing'), '--apply').status, 0);
});

test('migration failure rolls back schema and all original receipts', t => {
  const f = fixture(t);
  const db = new DatabaseSync(f.path);
  db.exec('CREATE TABLE operations_v10 (reserved TEXT)');
  db.close();
  const before = read(f.path, 'SELECT * FROM operations');
  const result = run(f.root, '--apply');
  assert.notEqual(result.status, 0);
  assert.equal(read(f.path, 'PRAGMA user_version')[0].user_version, 10);
  assert.deepEqual(read(f.path, 'SELECT * FROM operations'), before);
});
