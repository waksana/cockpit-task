import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { LIMITS, TaskError } from './contracts.js';

const reject = (message, result = null) => {
  throw new TaskError('MIGRATION_REVIEW_REQUIRED', message, 409, result);
};
const quote = value => `"${value.replaceAll('"', '""')}"`;

// Hash the logical snapshot, including history and receipts, rather than a SQLite file
// whose latest committed pages may still be in WAL.
function fingerprint(db) {
  const hash = createHash('sha256');
  const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
  hash.update(JSON.stringify(schema));
  for (const { name } of schema.filter(entry => entry.type === 'table')) {
    hash.update(name);
    for (const row of db.prepare(`SELECT * FROM ${quote(name)} ORDER BY rowid`).iterate()) {
      hash.update(JSON.stringify(row));
      hash.update('\n');
    }
  }
  return hash.digest('hex');
}

export function lifecycleInventory(db) {
  const schema = db.prepare('PRAGMA user_version').get().user_version;
  if (schema !== 9) reject('Lifecycle inventory requires schema v9; do not use a plan from another schema');
  const tasks = db.prepare("SELECT * FROM tasks WHERE status IN ('blocked','in_review') ORDER BY seq").all().map(row => ({
    task_id: row.id, title: row.title, revision: row.revision, lifecycle: row.lifecycle, editable: row.editable,
    status: row.status, kind: row.kind, description: row.description,
    dependencies: db.prepare(`SELECT d.*,t.status AS blocker_status FROM task_dependencies d
      JOIN tasks t ON t.id=d.blocker_id WHERE d.task_id=? ORDER BY d.seq`).all(row.id),
    definitions: db.prepare('SELECT * FROM definitions WHERE task_id=? ORDER BY seq').all(row.id),
    activities: db.prepare('SELECT * FROM activities WHERE task_id=? ORDER BY seq').all(row.id),
    outcomes: db.prepare('SELECT * FROM outcomes WHERE task_id=? ORDER BY seq').all(row.id),
    automation: row.kind === 'automation'
      ? db.prepare('SELECT * FROM automation_runs WHERE task_id=?').get(row.id) ?? null : null,
  }));
  return { schema, target_schema: 10, source_fingerprint: fingerprint(db), tasks };
}

export function validateLifecyclePlan(db, plan, inventory = lifecycleInventory(db)) {
  if (!plan || plan.schema !== 9 || plan.target_schema !== 10
    || plan.source_fingerprint !== inventory.source_fingerprint
    || !plan.tasks || typeof plan.tasks !== 'object' || Array.isArray(plan.tasks)) {
    reject('A reviewed schema v9 -> v10 plan must match the complete current source fingerprint; inventory again after any drift');
  }
  const entries = plan.tasks;
  if (Object.keys(entries).length !== inventory.tasks.length
    || Object.keys(entries).some(id => !inventory.tasks.some(task => task.task_id === id))) {
    reject('The plan must contain exactly every legacy blocked/in_review Task, without missing or extra entries');
  }
  const terminalRuns = ['succeeded', 'failed', 'interrupted', 'cancelled'];
  for (const item of inventory.tasks) {
    const entry = entries[item.task_id];
    const expected = item.kind === 'automation' ? ['automation_finished']
      : item.status === 'in_review' ? ['resume']
        : item.dependencies.length ? ['preserve_dependencies'] : ['condition', 'paused'];
    if (!entry || entry.revision !== item.revision || !expected.includes(entry.action)
      || typeof entry.source !== 'string' || !entry.source.trim() || entry.source.length > 4000) {
      reject(`Task ${item.task_id} needs its exact revision, evidence source and one action: ${expected.join(', ')}`);
    }
    if (entry.action === 'condition'
      && (typeof entry.condition !== 'string' || !entry.condition.trim() || entry.condition.length > LIMITS.blockerCondition)) {
      reject(`Task ${item.task_id} needs a concrete, bounded unmet condition`);
    }
    if (entry.action === 'automation_finished'
      && (!item.automation || !terminalRuns.includes(item.automation.state) || !item.automation.finished_at)) {
      reject(`Automation ${item.task_id} has no confirmed finished run; migration cannot finish or rerun it`);
    }
  }
  return entries;
}

export function inspectLifecycleMigration(directory, { plan } = {}) {
  const db = new DatabaseSync(join(directory, 'task-board.sqlite'), { readOnly: true });
  try {
    db.exec('BEGIN');
    const inventory = lifecycleInventory(db);
    if (plan !== undefined) validateLifecyclePlan(db, plan, inventory);
    db.exec('COMMIT');
    return inventory;
  } finally {
    db.close();
  }
}
