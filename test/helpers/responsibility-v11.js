// Synthetic fixture construction only; never a supported data downgrade.
export function restoreV11Schema(db) {
  db.exec(`
    DROP TABLE migration_v12_items;
    DROP TABLE migration_v12_audit;
    DROP TABLE responsibility_events;
    ALTER TABLE tasks DROP COLUMN cancellation_request;
    ALTER TABLE tasks DROP COLUMN legacy;
    ALTER TABLE tasks DROP COLUMN work_mode;
    ALTER TABLE tasks RENAME COLUMN created_by TO orchestrator;
    ALTER TABLE child_notices RENAME COLUMN recipient TO orchestrator;
    ALTER TABLE dependency_notices RENAME COLUMN recipient TO orchestrator;
    DROP TABLE task_dependencies;
    CREATE TABLE task_dependencies (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL CHECK(kind IN ('task','condition')),
      blocker_id TEXT REFERENCES tasks(id), condition TEXT, author TEXT NOT NULL, at TEXT NOT NULL,
      resolved_at TEXT, resolved_by TEXT, resolution TEXT CHECK(resolution IN ('done','removed')),
      blocker_lifecycle INTEGER,
      CHECK((kind='task' AND blocker_id IS NOT NULL AND condition IS NULL AND task_id<>blocker_id)
        OR (kind='condition' AND blocker_id IS NULL AND condition IS NOT NULL)),
      CHECK((resolved_at IS NULL AND resolved_by IS NULL AND resolution IS NULL)
        OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolution IS NOT NULL))
    );
    CREATE INDEX task_dependencies_task ON task_dependencies(task_id,seq);
    CREATE INDEX task_dependencies_blocker ON task_dependencies(blocker_id) WHERE blocker_id IS NOT NULL AND resolved_at IS NULL;
    CREATE UNIQUE INDEX task_dependencies_active_task ON task_dependencies(task_id,blocker_id) WHERE kind='task' AND resolved_at IS NULL;
    CREATE UNIQUE INDEX task_dependencies_active_condition ON task_dependencies(task_id,condition) WHERE kind='condition' AND resolved_at IS NULL;
    DROP TABLE assignee_notices;
    CREATE TABLE assignee_notices (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL, assignee TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('updated','cancelled')),
      event TEXT NOT NULL, created_at TEXT NOT NULL,
      delivery_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(delivery_status IN ('pending','unknown','accepted','queued','not_sent')),
      attempted_at TEXT, completed_at TEXT, delivery_error TEXT
    );
    CREATE INDEX assignee_notices_task ON assignee_notices(task_id,seq);
    CREATE INDEX assignee_notices_pending ON assignee_notices(seq) WHERE delivery_status='pending';
    PRAGMA user_version=11;
  `);
}
