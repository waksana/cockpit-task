import { Store, readCredential, hash, fail } from './store.js';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { backup } from 'node:sqlite';

const data = process.env.WORK_DATA_DIR ?? join(homedir(), '.local/state/work-commander');
const [command, ...args] = process.argv.slice(2);
const store = new Store(data);
try {
  if (command === 'issue') {
    const [role, sessionId] = args;
    fail(!['caller', 'viewer'].includes(role), 'INVALID_ROLE', 'issue caller SESSION_ID | issue viewer');
    fail(role === 'caller' && !/^[a-zA-Z0-9_-]{1,120}$/.test(sessionId ?? ''), 'SESSION_REQUIRED', 'Explicit caller session required');
    const token = store.issue(role, sessionId ?? null);
    const path = store.credentialFile(token, `${role}-${crypto.randomUUID()}`);
    console.log(JSON.stringify({ role, sessionId: sessionId ?? null, credential: path }));
  } else if (command === 'revoke') {
    const digest = hash(readCredential(args[0]));
    const result = store.run('UPDATE credentials SET revoked=1 WHERE digest=?', digest);
    fail(!result.changes, 'NOT_FOUND', 'Credential not found');
    console.log('Credential revoked');
  } else if (command === 'backup') {
    const path = resolve(args[0] ?? '');
    fail(!args[0] || existsSync(path), 'INVALID_DESTINATION', 'Supply a new backup filename in a private directory');
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    process.umask(0o077);
    await backup(store.db, path);
    console.log(JSON.stringify({ backup: path, includes: 'tasks, goal versions, events, operations, credential hashes; also archive credentials directory separately' }));
  } else if (command === 'migration-preview') {
    const rows = JSON.parse(readFileSync(args[0], 'utf8'));
    fail(!Array.isArray(rows) || rows.length > 5000, 'INVALID_MANIFEST', 'Expected an explicit task manifest array, max 5000');
    const owners = new Set(), streams = new Set();
    const conflicts = [];
    for (const row of rows) {
      if (!row.workstream || !row.ownerSessionId || !row.callerSessionId || !row.goal || !row.authorization) conflicts.push('Missing binding/goal/authorization');
      if (owners.has(row.ownerSessionId) || streams.has(row.workstream)) conflicts.push(`Duplicate owner/workstream: ${row.workstream}`);
      if (store.get('SELECT id FROM tasks WHERE owner=? OR workstream=?', row.ownerSessionId ?? '', row.workstream ?? '')) conflicts.push(`Already managed: ${row.workstream}`);
      owners.add(row.ownerSessionId); streams.add(row.workstream);
    }
    console.log(JSON.stringify({ records: rows.length, conflicts, imported: 0, dispatched: 0, next: 'User must approve single-ledger cutover; this release intentionally has no bulk import/dispatch command' }));
  } else {
    throw new Error('Usage: admin issue caller SESSION_ID | issue viewer | revoke CREDENTIAL_FILE | backup NEW_FILE | migration-preview MANIFEST.json');
  }
} finally { store.close(); }
