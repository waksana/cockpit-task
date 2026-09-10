import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync, writeFileSync, readFileSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const uid = () => randomUUID();
export const now = () => Date.now();
export class WorkError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message); this.code = code; this.statusCode = statusCode;
  }
}
export function fail(condition, code, message, statusCode) {
  if (condition) throw new WorkError(code, message, statusCode);
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export class Store {
  constructor(directory) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    this.db = new DatabaseSync(join(this.directory, 'work.db'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    chmodSync(join(this.directory, 'work.db'), 0o600);
    const schema = this.db.prepare('PRAGMA user_version').get().user_version;
    fail(schema > 1, 'SCHEMA_TOO_NEW', 'Database was written by a newer release', 500);
    this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, workstream TEXT NOT NULL UNIQUE, caller TEXT NOT NULL,
        owner TEXT UNIQUE, version INTEGER NOT NULL, accepted_version INTEGER,
        status TEXT NOT NULL, summary TEXT NOT NULL, artifacts TEXT NOT NULL DEFAULT '[]',
        active_op TEXT, credential_path TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        task_id TEXT NOT NULL REFERENCES tasks(id), version INTEGER NOT NULL,
        goal TEXT NOT NULL, reason TEXT NOT NULL, created INTEGER NOT NULL,
        PRIMARY KEY(task_id, version)
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
        version INTEGER NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL,
        artifacts TEXT NOT NULL, created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credentials (
        digest TEXT PRIMARY KEY, role TEXT NOT NULL, session_id TEXT,
        task_id TEXT, revoked INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mutations (
        principal TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL,
        response TEXT NOT NULL, PRIMARY KEY(principal, key)
      );
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), version INTEGER NOT NULL,
        kind TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL, step TEXT,
        inflight INTEGER NOT NULL DEFAULT 0, error TEXT, steps TEXT NOT NULL DEFAULT '{}',
        metrics TEXT NOT NULL DEFAULT '{"calls":0,"responseBytes":0,"byIntent":{}}',
        created INTEGER NOT NULL, updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_locks (
        session_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_task_seq ON events(task_id,seq);
      PRAGMA user_version=1;
      COMMIT;
    `);
  }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  task(id) {
    const task = this.get('SELECT * FROM tasks WHERE id=?', id);
    fail(!task, 'NOT_FOUND', 'Task not found', 404);
    return task;
  }
  event(task, kind, summary, artifacts = []) {
    this.run('INSERT INTO events(task_id,version,kind,summary,artifacts,created) VALUES(?,?,?,?,?,?)',
      task.id, task.version, kind, summary, JSON.stringify(artifacts), now());
  }
  issue(role, sessionId = null, taskId = null) {
    const token = randomBytes(32).toString('base64url');
    this.run('INSERT INTO credentials(digest,role,session_id,task_id,created) VALUES(?,?,?,?,?)',
      hash(token), role, sessionId, taskId, now());
    return token;
  }
  authenticate(token) {
    fail(typeof token !== 'string' || token.length < 30 || token.length > 200, 'UNAUTHORIZED', 'Credential required', 401);
    const row = this.get('SELECT * FROM credentials WHERE digest=? AND revoked=0', hash(token));
    fail(!row, 'UNAUTHORIZED', 'Invalid or revoked credential', 401);
    return row;
  }
  credentialFile(token, name) {
    const directory = join(this.directory, 'credentials');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${name}.json`);
    writeFileSync(path, JSON.stringify({ token }) + '\n', { mode: 0o600, flag: 'wx' });
    return path;
  }
  recoverInterrupted() {
    this.tx(() => {
      this.run(`UPDATE operations SET status=CASE WHEN inflight=1 THEN 'unknown' ELSE 'failed' END,
        error='Service stopped before operation completion; explicit recovery required', updated=? WHERE status='running'`, now());
    });
  }
  close() { this.db.close(); }
}

export function readCredential(path) {
  const info = lstatSync(path);
  fail(!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid(), 'UNSAFE_CREDENTIAL', 'Credential must be an owned regular 0600 file', 403);
  const result = JSON.parse(readFileSync(path, 'utf8'));
  fail(typeof result.token !== 'string', 'INVALID_CREDENTIAL', 'Credential file has no token', 403);
  return result.token;
}
