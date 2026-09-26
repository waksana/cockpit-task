import { INVOCATION_META_KEY, invocationFromMeta, TaskError } from './contracts.js';

const validActor = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;

export function operationActor(input) {
  if (!validActor(input?.actor)) {
    throw new TaskError('INVOCATION_REQUIRED', 'Operation receipts require the trusted calling session or the internal Web user', 400);
  }
  return input.actor;
}

function storedScope(row) {
  let input;
  let invocation;
  try {
    input = JSON.parse(row.input);
    invocation = row.invocation === null ? null : JSON.parse(row.invocation);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { actor: null, reason: 'Invalid stored input or invocation JSON' };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { actor: null, reason: 'Stored input is not an object' };
  }
  if (Object.hasOwn(input, 'actor_session_id') || Object.hasOwn(input, 'invocation')) {
    return { actor: null, reason: 'Legacy caller fields are not trusted invocation identity' };
  }
  // v9+ stores the service-derived actor, including the internal Web user. The v9
  // migration never promoted the earlier, caller-supplied actor_session_id to actor.
  if (!validActor(input.actor)) {
    return { actor: null, reason: 'No valid service-derived actor was recorded' };
  }
  if (row.invocation !== null) {
    const trusted = invocationFromMeta({ [INVOCATION_META_KEY]: invocation });
    if (!trusted || trusted.sessionId !== input.actor) {
      return { actor: null, reason: 'Stored invocation does not match the service-derived actor' };
    }
  }
  return { actor: input.actor, reason: null };
}

export function migrateOperationScopes(db) {
  db.exec(`
    ALTER TABLE operations RENAME TO operations_v10;
    CREATE TABLE operations (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT, request_id TEXT NOT NULL,
      tool TEXT NOT NULL, fingerprint TEXT NOT NULL, input TEXT NOT NULL,
      status TEXT NOT NULL, result TEXT, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      binding_context TEXT, resumed_by TEXT, invocation TEXT, legacy_reason TEXT,
      UNIQUE(actor,request_id),
      CHECK((actor IS NOT NULL AND legacy_reason IS NULL)
        OR (actor IS NULL AND legacy_reason IS NOT NULL))
    );
    CREATE UNIQUE INDEX operations_legacy_request ON operations(request_id) WHERE actor IS NULL;
  `);
  const insert = db.prepare(`INSERT INTO operations(
    seq,actor,request_id,tool,fingerprint,input,status,result,error,
    created_at,updated_at,binding_context,resumed_by,invocation,legacy_reason
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of db.prepare('SELECT rowid AS migration_seq,* FROM operations_v10 ORDER BY rowid').iterate()) {
    const { actor, reason } = storedScope(row);
    // Preserve every original field, including fingerprints, uncertainty and consumed
    // recovery markers. Unattributable IDs stay reserved globally, not newly executable.
    insert.run(
      row.migration_seq, actor, row.request_id, row.tool, row.fingerprint, row.input,
      row.status, row.result, row.error, row.created_at, row.updated_at,
      row.binding_context, row.resumed_by, row.invocation, reason,
    );
  }
  db.exec('DROP TABLE operations_v10;');
}
