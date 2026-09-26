export const v10OperationColumns = [
  'request_id', 'tool', 'fingerprint', 'input', 'status', 'result', 'error',
  'created_at', 'updated_at', 'binding_context', 'resumed_by', 'invocation',
];

// Synthetic fixtures only: reproduce the exact v10 receipt schema, not just its version number.
export function restoreV10Operations(db) {
  db.exec(`
    ALTER TABLE operations RENAME TO operations_fixture;
    CREATE TABLE operations (
      request_id TEXT PRIMARY KEY, tool TEXT NOT NULL, fingerprint TEXT NOT NULL,
      input TEXT NOT NULL, status TEXT NOT NULL, result TEXT, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, binding_context TEXT,
      resumed_by TEXT, invocation TEXT
    );
    INSERT INTO operations(rowid,${v10OperationColumns.join(',')})
      SELECT rowid,${v10OperationColumns.join(',')} FROM operations_fixture;
    DROP TABLE operations_fixture;
  `);
}
