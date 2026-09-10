import { Store, readCredential, hash, fail } from './store.js';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { backup, DatabaseSync } from 'node:sqlite';
import { stageManifest, loadManifest, planImport, applyImport } from './migration.js';
import { cutoverLedger } from './cutover.js';

const data = process.env.WORK_DATA_DIR ?? join(homedir(), '.local/state/work-commander');
const [command, ...args] = process.argv.slice(2);
// A backup must not run schema migrations before capturing the pre-upgrade DB.
const store = command === 'backup' ? null : new Store(data);
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
    const source = new DatabaseSync(join(data, 'work.db'), { readOnly: true });
    try { await backup(source, path); } finally { source.close(); }
    console.log(JSON.stringify({ backup: path, includes: 'tasks, goal versions, events, operations, credential hashes; also archive credentials directory separately' }));
  } else if (command === 'migration-stage') {
    console.log(JSON.stringify(stageManifest(data, args[0])));
  } else if (command === 'migration-cutover') {
    fail(args[2] !== '--confirm', 'CONFIRM_REQUIRED', 'Ledger cutover requires explicit approval');
    console.log(JSON.stringify(cutoverLedger(store, loadManifest(data, args[0]), args[1])));
  } else if (command === 'migration-preview' || command === 'migration-apply') {
    const [manifestId, manager, planHash, confirm] = args;
    fail(!/^[a-zA-Z0-9_-]{1,120}$/.test(manager ?? ''), 'MANAGER_REQUIRED', 'Explicit management caller session required');
    const manifest = loadManifest(data, manifestId);
    if (command === 'migration-preview') console.log(JSON.stringify(planImport(store, manifest, manager)));
    else {
      fail(confirm !== '--confirm', 'CONFIRM_REQUIRED', 'Explicit record migration approval required; no execution authorization is inferred');
      console.log(JSON.stringify(store.tx(() => applyImport(store, manifest, manager, planHash))));
    }
  } else {
    throw new Error('Usage: admin issue caller SESSION_ID | issue viewer | revoke CREDENTIAL_FILE | backup NEW_FILE | migration-stage MANIFEST.json | migration-preview MANIFEST_ID MANAGER | migration-apply MANIFEST_ID MANAGER PLAN_HASH --confirm');
  }
} finally { store?.close(); }
