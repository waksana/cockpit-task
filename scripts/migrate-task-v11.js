import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { migrateOperationScopes } from '../src/task-board/operation-scopes.js';

const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== '--data-root' || !args[1]
  || !['--preflight', '--apply'].includes(args[2])) {
  throw new Error('Usage: migrate-task-v11.js --data-root <existing-directory> --preflight|--apply');
}
const source = join(resolve(args[1]), 'task-board.sqlite');
const stat = await lstat(source);
if (!stat.isFile() || stat.nlink !== 1) throw new Error('Expected an existing, unlinked Task database');

function check(db) {
  if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok'
    || db.prepare('PRAGMA foreign_key_check').get()) {
    throw new Error('Task database integrity check failed');
  }
}

function migrate(db) {
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  try {
    if (db.prepare('PRAGMA user_version').get().user_version !== 10) {
      throw new Error('Explicit receipt migration requires schema v10; no replay or older-schema migration is allowed');
    }
    check(db);
    const before = db.prepare('SELECT count(*) AS count FROM operations').get().count;
    migrateOperationScopes(db);
    const after = db.prepare('SELECT count(*) AS count FROM operations').get().count;
    if (before !== after) throw new Error('Receipt migration changed the operation count');
    db.exec('PRAGMA user_version=11');
    check(db);
    const legacy = db.prepare('SELECT count(*) AS count FROM operations WHERE actor IS NULL').get().count;
    db.exec('COMMIT');
    return { operations: after, legacy_operations: legacy };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

if (args[2] === '--preflight') {
  // Exercise the exact migration on a WAL-consistent copy, never the source.
  const temporary = await mkdtemp(join(tmpdir(), 'cockpit-task-v11-'));
  try {
    const copy = join(temporary, 'task-board.sqlite');
    const input = new DatabaseSync(source, { readOnly: true });
    try { await backup(input, copy); } finally { input.close(); }
    const db = new DatabaseSync(copy);
    let result;
    try { result = migrate(db); } finally { db.close(); }
    process.stdout.write(`${JSON.stringify({ status: 'ready', schema: 10, target_schema: 11, ...result })}\n`);
  } finally {
    await rm(temporary, { recursive: true });
  }
} else {
  const db = new DatabaseSync(source);
  let result;
  try { result = migrate(db); } finally { db.close(); }
  process.stdout.write(`${JSON.stringify({ status: 'migrated', schema: 11, ...result })}\n`);
}
