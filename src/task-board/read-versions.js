import { createHash, randomUUID } from 'node:crypto';

const tables = [
  'tasks', 'definitions', 'acknowledgements', 'activities', 'outcomes', 'task_assignments',
  'task_dependencies', 'subscriptions', 'dependency_notices', 'child_notices',
  'assignee_notices', 'retro_handlings', 'automation_runs',
];

// Connection-local SQL triggers participate in commits/savepoints without changing the durable schema.
// A new store epoch invalidates old tokens after restart; tokens are equality markers, not ordering.
export class ReadVersions {
  constructor(db) {
    this.db = db;
    this.epoch = randomUUID();
    this.externalVersion = this.observedExternalVersion();
    db.exec(`PRAGMA temp_store=MEMORY;
    CREATE TEMP TABLE task_read_versions (
      task_id TEXT PRIMARY KEY, version INTEGER NOT NULL, dirty INTEGER NOT NULL
    );
    CREATE INDEX temp.task_read_versions_dirty ON task_read_versions(task_id) WHERE dirty=1`);
    const touch = query => `INSERT INTO task_read_versions(task_id,version,dirty)
      SELECT task_id,1,1 FROM (${query}) WHERE task_id IS NOT NULL
      ON CONFLICT(task_id) DO UPDATE SET version=version+1,dirty=1;`;
    for (const table of tables) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        const row = operation === 'DELETE' ? 'OLD' : 'NEW';
        const id = `${row}.${table === 'tasks' ? 'id' : 'task_id'}`;
        const changed = operation === 'UPDATE'
          ? `WHEN ${columns.map(column => `OLD."${column}" IS NOT NEW."${column}"`).join(' OR ')}` : '';
        const query = `SELECT ${id} AS task_id
          UNION SELECT parent_task_id FROM tasks WHERE id=${id}`;
        db.exec(`CREATE TEMP TRIGGER task_read_${table}_${operation}
          AFTER ${operation} ON main.${table} ${changed} BEGIN
          ${touch(query)}
          ${table === 'tasks' && operation === 'DELETE' ? touch('SELECT OLD.parent_task_id AS task_id') : ''}
          END`);
      }
    }
    db.exec(`CREATE TEMP TRIGGER task_read_blocker_status AFTER UPDATE OF status ON main.tasks
      WHEN OLD.status IS NOT NEW.status BEGIN
      ${touch(`SELECT task_id FROM task_dependencies WHERE blocker_id=NEW.id AND resolved_at IS NULL
        UNION SELECT t.parent_task_id FROM tasks t JOIN task_dependencies d ON d.task_id=t.id
          WHERE d.blocker_id=NEW.id AND d.resolved_at IS NULL`)}
      END`);
  }

  observedExternalVersion() {
    return this.db.prepare('PRAGMA main.data_version').get().data_version;
  }

  token(taskId) {
    const externalVersion = this.observedExternalVersion();
    // Other SQLite connections cannot run our TEMP triggers. Conservatively invalidate tokens,
    // rather than claiming exact identities for out-of-band writes.
    if (externalVersion !== this.externalVersion) {
      this.epoch = randomUUID();
      this.externalVersion = externalVersion;
    }
    const version = this.db.prepare('SELECT version FROM task_read_versions WHERE task_id=?').get(taskId)?.version ?? 0;
    return createHash('sha256').update(`${this.epoch}:${taskId}:${version}`).digest('hex');
  }

  pending() {
    return this.db.prepare('SELECT task_id,version FROM task_read_versions WHERE dirty=1 LIMIT 100').all();
  }

  acknowledge({ task_id, version }) {
    this.db.prepare('UPDATE task_read_versions SET dirty=0 WHERE task_id=? AND version=?').run(task_id, version);
  }
}
