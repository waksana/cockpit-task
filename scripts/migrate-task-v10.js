import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspectLifecycleMigration, TaskStore } from '../src/task-board/store.js';

function value(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${flag} requires a value`);
  return process.argv[index + 1];
}

const dataRoot = resolve(value('--data-root'));
const apply = process.argv.includes('--apply');
const preflight = process.argv.includes('--preflight');
if (apply && preflight) throw new Error('Choose --preflight or --apply, not both');
const plan = apply || preflight ? JSON.parse(readFileSync(resolve(value('--plan')), 'utf8')) : undefined;
const inventory = inspectLifecycleMigration(dataRoot, { plan });

if (!apply) {
  process.stdout.write(`${JSON.stringify(preflight
    ? { status: 'ready', schema: inventory.schema, target_schema: 10, source_fingerprint: inventory.source_fingerprint }
    : inventory, null, 2)}\n`);
} else {
  const store = new TaskStore(dataRoot, { migrationPlan: plan });
  try {
    process.stdout.write(`${JSON.stringify({
      status: 'migrated', schema: store.db.prepare('PRAGMA user_version').get().user_version,
      items: store.db.prepare('SELECT * FROM migration_v10_items ORDER BY seq').all(),
    }, null, 2)}\n`);
  } finally {
    store.close();
  }
}
