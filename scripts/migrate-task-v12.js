import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  applyResponsibilityMigration, inspectResponsibilityMigration, responsibilityDatabasePath,
} from '../src/task-board/responsibility-migration.js';

const usage = 'Usage: migrate-task-v12.js --data-root <existing-directory> --inventory | --data-root <existing-directory> --plan <reviewed.json> --preflight|--apply';
const args = process.argv.slice(2);
const inventoryOnly = args.length === 3 && args[2] === '--inventory';
const reviewed = args.length === 5 && args[2] === '--plan' && args[3] && ['--preflight', '--apply'].includes(args[4]);
if (args[0] !== '--data-root' || !args[1] || (!inventoryOnly && !reviewed)) throw new Error(usage);
const directory = resolve(args[1]);
const plan = reviewed ? JSON.parse(readFileSync(resolve(args[3]), 'utf8')) : undefined;

if (inventoryOnly) {
  process.stdout.write(`${JSON.stringify(inspectResponsibilityMigration(directory), null, 2)}\n`);
} else if (args[4] === '--preflight') {
  const inventory = inspectResponsibilityMigration(directory, { plan });
  process.stdout.write(`${JSON.stringify({
    status: 'ready', schema: inventory.schema, target_schema: inventory.target_schema,
    source_fingerprint: inventory.source_fingerprint, tasks: inventory.tasks.length,
    applies_changes: false,
  })}\n`);
} else {
  const db = new DatabaseSync(responsibilityDatabasePath(directory));
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');
    process.stdout.write(`${JSON.stringify(applyResponsibilityMigration(db, plan))}\n`);
  } finally {
    db.close();
  }
}
