import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../src/task-board/store.js';
import { inspectLifecycleMigration, validateLifecyclePlan } from '../src/task-board/lifecycle-migration.js';

const args = process.argv.slice(2);
const usage = 'Usage: migrate-task-v10.js --data-root <existing-directory> [--inventory | --plan <reviewed.json> --preflight|--apply]';
const options = new Map();
const valueFlags = new Set(['--data-root', '--plan']);
const actionFlags = new Set(['--inventory', '--preflight', '--apply']);
for (let index = 0; index < args.length; index++) {
  const flag = args[index];
  if ((!valueFlags.has(flag) && !actionFlags.has(flag)) || options.has(flag)) throw new Error(usage);
  if (valueFlags.has(flag)) {
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(usage);
    options.set(flag, value);
  } else {
    options.set(flag, true);
  }
}
const apply = options.has('--apply'), preflight = options.has('--preflight');
const reviewed = apply || preflight;
if (!options.has('--data-root') || [...actionFlags].filter(flag => options.has(flag)).length > 1
  || options.has('--plan') !== reviewed) throw new Error(usage);
const dataRoot = resolve(options.get('--data-root')), file = join(dataRoot, 'task-board.sqlite');
const stat = lstatSync(file);
if (!stat.isFile() || stat.nlink !== 1) throw new Error('Expected an existing regular, unlinked Task database');
const plan = reviewed ? JSON.parse(readFileSync(resolve(options.get('--plan')), 'utf8')) : undefined;
const inventory = inspectLifecycleMigration(dataRoot, { plan });

function checkSource(db) {
  const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name);
  const operationColumns = db.prepare('PRAGMA table_info(operations)').all().map(row => row.name);
  if (!taskColumns.includes('orchestrator') || taskColumns.includes('created_by')
    || taskColumns.includes('work_mode') || operationColumns.includes('actor')
    || db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok'
    || db.prepare('PRAGMA foreign_key_check').get()) {
    throw new Error('Expected intact schema-v9 lifecycle data, not a relabeled later responsibility schema');
  }
}

if (!apply) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { checkSource(db); } finally { db.close(); }
  const result = preflight
    ? { status: 'ready', schema: inventory.schema, target_schema: 10, source_fingerprint: inventory.source_fingerprint }
    : inventory;
  process.stdout.write(`${JSON.stringify({ ...result, final_schema: 10 }, null, 2)}\n`);
} else {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    validateLifecyclePlan(db, plan);
    checkSource(db);
    // Reuse only the historical 9 -> 10 transformation. Constructing TaskStore
    // here would cross the separately reviewed receipt/responsibility boundaries.
    const historical = { db, row: id => db.prepare('SELECT * FROM tasks WHERE id=?').get(id) };
    TaskStore.prototype.migrateLifecycle.call(historical, plan.tasks);
    db.exec('PRAGMA user_version=10');
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok'
      || db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Migrated lifecycle integrity check failed');
    const items = db.prepare('SELECT * FROM migration_v10_items ORDER BY seq').all();
    db.exec('COMMIT');
    process.stdout.write(`${JSON.stringify({
      status: 'migrated', schema: 10, items,
    }, null, 2)}\n`);
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}
