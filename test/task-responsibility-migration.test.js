import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../src/task-board/store.js';
import {
  applyResponsibilityMigration, initializeResponsibilitySchema, inspectResponsibilityMigration,
  responsibilityFingerprint, responsibilityInventory, validateResponsibilityPlan,
} from '../src/task-board/responsibility-migration.js';
import { restoreV11Schema } from './helpers/responsibility-v11.js';
import { restoreV10Operations } from './helpers/operations-v10.js';

const project = resolve(import.meta.dirname, '..');
const cli = resolve(project, 'scripts/migrate-task-v12.js');
const at = '2026-09-27T00:00:00.000Z';
function fixture(t) {
  const directory = resolve(project, 'dist', `responsibility-migration-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const store = new TaskStore(directory);
  store.close();
  const db = new DatabaseSync(resolve(directory, 'task-board.sqlite'));
  t.after(() => { if (db.isOpen) db.close(); rmSync(directory, { recursive: true, force: true }); });
  restoreV11Schema(db);
  db.exec('PRAGMA foreign_keys=ON');
  return { directory, db };
}
function task(db, { id = randomUUID(), status = 'todo', kind = 'agent', parent = null, depth = 1, assignee = null } = {}) {
  db.prepare(`INSERT INTO tasks(
    id,title,description,orchestrator,assignee,status,kind,parent_task_id,depth,refs,metadata,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, 'Synthetic responsibility', 'Preserve this exact scope', 'historical-creator', assignee,
    status, kind, parent, depth, '[{"label":"historical","target":"local:evidence"}]', '{"keep":true}', at, at,
  );
  db.prepare('INSERT INTO definitions(task_id,revision,description,reason,author,at) VALUES(?,1,?,?,?,?)')
    .run(id, 'Preserve this exact scope', 'Original reason', 'historical-author', at);
  return id;
}
function plan(db, modes = {}) {
  const inventory = responsibilityInventory(db);
  return {
    schema: 11, target_schema: 12, source_fingerprint: inventory.source_fingerprint,
    reviewer: 'synthetic-reviewer', source: 'User-authorized synthetic review',
    tasks: Object.fromEntries(inventory.tasks.map(row => [row.id, {
      revision: row.revision,
      work_mode: Object.hasOwn(modes, row.id) ? modes[row.id] : row.kind === 'automation' ? null
        : row.status === 'todo' ? 'undecided' : row.status === 'in_progress' ? 'execute' : null,
      evidence: 'Explicit synthetic review of the agreement; not inferred from native activity or absent children',
    }])),
  };
}
function readAll(db, table) {
  return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all().map(row => ({ ...row }));
}
function cliRun(directory, ...args) {
  return spawnSync(process.execPath, [cli, '--data-root', directory, ...args], { encoding: 'utf8' });
}
function refuses(db, reviewed, message) {
  const before = responsibilityFingerprint(db);
  assert.throws(() => applyResponsibilityMigration(db, reviewed), message ?? { code: 'MIGRATION_REVIEW_REQUIRED' });
  assert.equal(responsibilityFingerprint(db), before, 'Rejected migration must preserve every logical source byte');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11);
}

test('ordinary loading refuses even empty schema11; fresh bootstrap is schema12 and cannot convert records', t => {
  const { directory, db } = fixture(t);
  const before = responsibilityFingerprint(db);
  assert.throws(() => new TaskStore(directory), { code: 'MIGRATION_REVIEW_REQUIRED' });
  assert.equal(responsibilityFingerprint(db), before);
  task(db);
  assert.throws(() => initializeResponsibilitySchema(db), { code: 'MIGRATION_REVIEW_REQUIRED' });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11);
});

test('TaskStore integrates only an explicit reviewed schema11 migration and retains legacy history', t => {
  const { directory, db } = fixture(t);
  const id = task(db, { status: 'done', assignee: 'old-session' });
  const reviewed = plan(db);
  const store = new TaskStore(directory, { migrationPlan: reviewed });
  try {
    const migrated = store.task(id);
    assert.equal(migrated.work_mode, null);
    assert.equal(migrated.legacy, true);
    assert.equal(migrated.status, 'done');
    assert.equal(migrated.created_by, 'historical-creator');
    assert.equal(migrated.assignee, 'old-session');
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 12);
    assert.equal(readAll(store.db, 'responsibility_events').length, 1);
  } finally { store.close(); }
});

test('explicit review preserves creator, binding, ACK, assignment eligibility, outcomes, receipt JSON and notices', t => {
  const { db } = fixture(t);
  const parent = task(db, { status: 'in_progress', assignee: 'parent-session' });
  const active = task(db, { status: 'in_progress', parent, depth: 2, assignee: 'child-session' });
  const legacy = task(db, { status: 'done', assignee: 'legacy-session' });
  const cancelled = task(db, { status: 'cancelled' });
  db.prepare('UPDATE tasks SET cancellation=? WHERE id=?').run('{"reason":"historical cancellation"}', cancelled);
  db.prepare('UPDATE tasks SET acknowledged_revision=1 WHERE id=?').run(active);
  db.prepare('INSERT INTO acknowledgements VALUES(?,1,?,?,?)').run(active, 'child-session', 'child-session', at);
  db.prepare('INSERT INTO task_assignments(task_id,assignee,author,at) VALUES(?,?,?,?)')
    .run(active, 'child-session', 'parent-session', at);
  db.prepare('INSERT INTO activities(id,task_id,revision,assignee,author,text,at) VALUES(?,?,1,?,?,?,?)')
    .run(randomUUID(), active, 'child-session', 'child-session', 'Historical activity', at);
  const outcome = randomUUID();
  db.prepare('INSERT INTO outcomes(id,task_id,revision,assignee,author,summary,refs,at,retro_recorded) VALUES(?,?,1,?,?,?,?,?,1)')
    .run(outcome, legacy, 'legacy-session', 'legacy-session', 'Historical done; no known mode or start', '[]', at);
  const receipt = '{ "operation": { "orchestrator": "historical-creator", "message": "unknown" } }';
  for (const actor of ['original-actor', null]) {
    db.prepare(`INSERT INTO operations(actor,request_id,tool,fingerprint,input,status,result,created_at,updated_at,resumed_by,legacy_reason)
      VALUES(?,?,?,?,?,'final',?,?,?,?,?)`).run(
      actor, actor ? 'known-receipt' : 'legacy-receipt', 'task_assign', 'original-fingerprint',
      '{"actor":"original-actor","orchestrator":"historical-creator"}', receipt, at, at, 'consumed',
      actor ? null : 'Cannot establish historical scope',
    );
  }
  const event = '{ "orchestrator" : "historical-creator", "actor":"old-actor", "kind":"updated" }';
  db.prepare(`INSERT INTO assignee_notices(id,task_id,revision,assignee,kind,event,created_at,delivery_status,attempted_at)
    VALUES(?,?,1,?,'updated',?,?,'unknown',?)`).run(randomUUID(), active, 'child-session', event, at, at);
  db.prepare(`INSERT INTO child_notices(id,task_id,parent_task_id,child_lifecycle,orchestrator,status,event,created_at,delivery_status)
    VALUES(?,?,?,1,?,'done',?,?,'accepted')`).run(randomUUID(), active, parent, 'old-recipient-snapshot', event, at);
  db.prepare(`INSERT INTO dependency_notices(id,task_id,orchestrator,kind,event,created_at,delivery_status)
    VALUES(?, ?, ?, 'ready', ?, ?, 'queued')`).run(randomUUID(), active, 'old-dependency-recipient', event, at);
  const preserved = ['definitions', 'acknowledgements', 'task_assignments', 'activities', 'outcomes',
    'operations', 'assignee_notices', 'subscriptions', 'automation_runs', 'retro_handlings'];
  const old = Object.fromEntries(preserved.map(table => [table, readAll(db, table)]));
  const tasks = readAll(db, 'tasks');
  const reviewed = plan(db, { [parent]: 'orchestrate' });
  assert.equal(applyResponsibilityMigration(db, reviewed).schema, 12);
  for (const table of preserved) assert.deepEqual(readAll(db, table), old[table], table);
  for (const row of tasks) {
    const { orchestrator, lifecycle, editable, ...rest } = row;
    const migrated = readAll(db, 'tasks').find(item => item.id === row.id);
    const { created_by, work_mode, legacy: legacyFlag, cancellation_request, ...remaining } = migrated;
    assert.equal(created_by, orchestrator);
    assert.deepEqual(remaining, { ...rest, lifecycle: lifecycle + 1, editable: editable + 1 });
    assert.equal(cancellation_request, null);
    if (row.id === legacy) { assert.equal(work_mode, null); assert.equal(legacyFlag, 1); }
  }
  assert.equal(readAll(db, 'child_notices')[0].recipient, 'old-recipient-snapshot');
  assert.equal(readAll(db, 'child_notices')[0].event, event);
  assert.equal(readAll(db, 'dependency_notices')[0].recipient, 'old-dependency-recipient');
  assert.equal(readAll(db, 'dependency_notices')[0].event, event);
  assert.equal(readAll(db, 'migration_v12_items').length, tasks.length);
  assert.equal(readAll(db, 'migration_v12_audit')[0].source_fingerprint, reviewed.source_fingerprint);
  assert.deepEqual(JSON.parse(readAll(db, 'migration_v12_audit')[0].plan), reviewed);
  assert.ok(readAll(db, 'responsibility_events').every(row => row.kind === 'migrated'));
  assert.equal(readAll(db, 'task_assignments').some(row => row.task_id === legacy), false);
});

test('automation remains unbound and mode-free with terminal barrier and uncertainty unchanged', t => {
  const { db } = fixture(t);
  const id = task(db, { kind: 'automation', status: 'done' });
  db.prepare(`INSERT INTO automation_runs(run_id,task_id,script_id,script,parameters,state,finished_at,process_group,barrier,cancel_requested,error)
    VALUES(?,?,'fixture','{}','{}','interrupted',?,7654321,1,1,?)`)
    .run(randomUUID(), id, at, 'Process exit remains unconfirmed');
  const before = readAll(db, 'automation_runs');
  applyResponsibilityMigration(db, plan(db));
  assert.deepEqual(readAll(db, 'automation_runs'), before);
  const row = db.prepare('SELECT assignee,acknowledged_revision,work_mode,legacy FROM tasks WHERE id=?').get(id);
  assert.deepEqual({ ...row }, { assignee: null, acknowledged_revision: null, work_mode: null, legacy: 0 });
});

for (const [status, state] of [['todo', 'succeeded'], ['in_progress', 'created'], ['done', 'created'], ['cancelled', 'succeeded']]) {
  test(`migration rejects contradictory automation facts ${status}/${state} without rewriting history`, t => {
    const { db } = fixture(t);
    const id = task(db, { kind: 'automation', status });
    db.prepare("INSERT INTO automation_runs(run_id,task_id,script_id,script,parameters,state) VALUES(?,?,'fixture','{}','{}',?)")
      .run(randomUUID(), id, state);
    refuses(db, plan(db));
  });
}

for (const [status, state] of [['todo', 'created'], ['done', 'succeeded'], ['done', 'failed'], ['done', 'interrupted'], ['cancelled', 'cancelled']]) {
  test(`migration preserves valid automation facts ${status}/${state}`, t => {
    const { db } = fixture(t);
    const id = task(db, { kind: 'automation', status });
    db.prepare("INSERT INTO automation_runs(run_id,task_id,script_id,script,parameters,state,barrier) VALUES(?,?,'fixture','{}','{}',?,?)")
      .run(randomUUID(), id, state, Number(['interrupted', 'cancelled'].includes(state)));
    const before = readAll(db, 'automation_runs');
    applyResponsibilityMigration(db, plan(db));
    assert.deepEqual(readAll(db, 'automation_runs'), before);
  });
}

for (const readiness of [false, true]) {
  test(`migration rejects mixed ${readiness ? 'ancestor readiness' : 'child completion'} wait cycles`, t => {
    const { db } = fixture(t);
    const p = task(db, { status: 'in_progress', assignee: 'p' });
    const c = task(db, { status: readiness ? 'todo' : 'in_progress', parent: p, depth: 2, assignee: 'c' });
    const q = task(db, { status: 'in_progress', assignee: 'q' });
    const modes = { [p]: 'orchestrate', [q]: 'orchestrate' };
    const add = (id, blocker) => db.prepare(`INSERT INTO task_dependencies(id,task_id,kind,blocker_id,author,at)
      VALUES(?,?,'task',?,'reviewed-author',?)`).run(randomUUID(), id, blocker, at);
    if (readiness) {
      const d = task(db, { status: 'todo', parent: q, depth: 2, assignee: 'd' });
      add(p, d); add(q, c);
    } else {
      add(c, q); add(q, p);
    }
    refuses(db, plan(db, modes));
  });
}

test('dependency resolution history and rebuilt-table sequence high-water marks survive exactly', t => {
  const { db } = fixture(t);
  const id = task(db);
  const dependency = randomUUID();
  db.prepare(`INSERT INTO task_dependencies(id,task_id,kind,condition,author,at,resolved_at,resolved_by,resolution)
    VALUES(?,?,'condition','Historical condition','author',?,?,'reviewer','removed')`).run(dependency, id, at, at);
  db.prepare("UPDATE sqlite_sequence SET seq=1000 WHERE name='task_dependencies'").run();
  db.prepare(`INSERT INTO assignee_notices(id,task_id,revision,assignee,kind,event,created_at,delivery_status)
    VALUES(?,?,1,'old-assignee','cancelled','{}',?,'not_sent')`).run(randomUUID(), id, at);
  db.prepare("UPDATE sqlite_sequence SET seq=2000 WHERE name='assignee_notices'").run();
  const before = readAll(db, 'task_dependencies');
  const sequenceTypes = () => db.prepare(`SELECT name,typeof(seq) AS type FROM sqlite_sequence
    WHERE name IN ('task_dependencies','assignee_notices') ORDER BY name`).all();
  assert.ok(sequenceTypes().every(row => row.type === 'integer'));
  applyResponsibilityMigration(db, plan(db));
  assert.ok(sequenceTypes().every(row => row.type === 'integer'));
  assert.deepEqual(readAll(db, 'task_dependencies').map(({ evidence, refs, ...row }) => {
    assert.equal(evidence, null); assert.equal(refs, null); return row;
  }), before);
  assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='task_dependencies'").get().seq, 1000);
  assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='assignee_notices'").get().seq, 2000);
  db.prepare(`INSERT INTO task_dependencies(id,task_id,kind,condition,author,at,resolved_at,resolved_by,resolution,evidence,refs)
    VALUES(?,?,'condition','New satisfied condition','author',?,?,'reviewer','evidence','Recorded user answer','[]')`)
    .run(randomUUID(), id, at, at);
  assert.equal(readAll(db, 'task_dependencies').at(-1).seq, 1001);
});

for (const highWater of [100n, 9007199254740993n, 9223372036854775806n]) {
  test(`CLI migration preserves integer high-water ${highWater} and never reuses deleted IDs`, t => {
    const { directory, db } = fixture(t);
    const id = task(db);
    const inserts = [
      ['task_dependencies', db.prepare(`INSERT INTO task_dependencies(seq,id,task_id,kind,condition,author,at)
        VALUES(?,?,?,'condition',?,'author',?)`)],
      ['assignee_notices', db.prepare(`INSERT INTO assignee_notices(seq,id,task_id,revision,assignee,kind,event,created_at,delivery_status)
        VALUES(?,?,?,1,?,'updated','{}',?,'not_sent')`)],
    ];
    const sequences = db.prepare(`SELECT name,seq,typeof(seq) AS type FROM sqlite_sequence
      WHERE name IN ('task_dependencies','assignee_notices') ORDER BY name`);
    sequences.setReadBigInts(true);
    for (const [table, insert] of inserts) {
      insert.setReadBigInts(true);
      insert.run(1n, randomUUID(), id, 'Retained synthetic row', at);
      insert.run(highWater, randomUUID(), id, 'Deleted synthetic row', at);
      db.prepare(`DELETE FROM ${table} WHERE seq=?`).run(highWater);
    }
    const before = sequences.all();
    assert.equal(before.length, 2);
    assert.ok(before.every(row => row.seq === highWater && row.type === 'integer'));
    const inventory = cliRun(directory, '--inventory');
    assert.equal(inventory.status, 0, inventory.stderr);
    const reviewed = plan(db);
    assert.equal(JSON.parse(inventory.stdout).source_fingerprint, reviewed.source_fingerprint);
    const planFile = resolve(directory, 'reviewed.json');
    writeFileSync(planFile, JSON.stringify(reviewed));
    const preflight = cliRun(directory, '--plan', planFile, '--preflight');
    assert.equal(preflight.status, 0, preflight.stderr);
    assert.deepEqual(sequences.all(), before);
    const apply = cliRun(directory, '--plan', planFile, '--apply');
    assert.equal(apply.status, 0, apply.stderr);
    assert.deepEqual(sequences.all(), before);
    for (const [table, insert] of inserts) {
      assert.equal(insert.run(null, randomUUID(), id, 'New synthetic row', at).lastInsertRowid, highWater + 1n);
      const rows = db.prepare(`SELECT seq FROM ${table} ORDER BY seq`);
      rows.setReadBigInts(true);
      assert.deepEqual(rows.all().map(row => row.seq), [1n, highWater + 1n]);
    }
    assert.ok(sequences.all().every(row => row.type === 'integer'));
  });
}

test('safe-integer source fingerprints match the original number-based algorithm', t => {
  const { db } = fixture(t);
  task(db);
  db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('task_dependencies',?)").run(9007199254740991n);
  const canonicalNumber = value => {
    if (Array.isArray(value)) return `[${value.map(canonicalNumber).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalNumber(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  };
  const hash = createHash('sha256');
  hash.update(String(db.prepare('PRAGMA user_version').get().user_version));
  const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
  hash.update(canonicalNumber(schema));
  for (const { name } of schema.filter(row => row.type === 'table')) {
    hash.update(canonicalNumber(name));
    for (const row of db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).iterate()) {
      hash.update(canonicalNumber(row));
      hash.update('\n');
    }
  }
  assert.equal(responsibilityFingerprint(db), hash.digest('hex'));
});

test('source fingerprint distinguishes adjacent 64-bit sequence integers', t => {
  const { db } = fixture(t);
  const update = db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('task_dependencies',?)");
  update.run(9007199254740992n);
  const before = responsibilityFingerprint(db);
  db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='task_dependencies'").run(9007199254740993n);
  assert.notEqual(responsibilityFingerprint(db), before);
});

test('public inventory refuses out-of-range retained row IDs without rounding or mutation', t => {
  const { directory, db } = fixture(t);
  const id = task(db);
  db.prepare('UPDATE tasks SET seq=? WHERE id=?').run(9007199254740993n, id);
  const before = responsibilityFingerprint(db);
  assert.throws(() => responsibilityInventory(db), { code: 'ERR_OUT_OF_RANGE' });
  const inventory = cliRun(directory, '--inventory');
  assert.notEqual(inventory.status, 0);
  assert.match(inventory.stderr, /too large|safe integer|out of range/i);
  assert.equal(responsibilityFingerprint(db), before);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11);
});

test('review may explicitly retain orchestrate without children and unknown historical terminal start stays unknown', t => {
  const { db } = fixture(t);
  const id = task(db, { status: 'in_progress', assignee: 'orchestrating-session' });
  const historical = task(db, { status: 'done', assignee: 'historical-session' });
  const reviewed = plan(db, { [id]: 'orchestrate', [historical]: 'execute' });
  applyResponsibilityMigration(db, reviewed);
  assert.equal(db.prepare('SELECT work_mode FROM tasks WHERE id=?').get(id).work_mode, 'orchestrate');
  assert.equal(readAll(db, 'responsibility_events').some(event => event.kind === 'started'), false);
  const event = readAll(db, 'responsibility_events').find(row => row.task_id === historical);
  assert.equal(JSON.parse(event.details).historical_start, 'not_inferred');
});

test('every Task needs an exact known decision, including terminal/automation, without guessing mode', t => {
  const { db } = fixture(t);
  const id = task(db, { status: 'in_progress', assignee: 'explicit-session' });
  const historical = task(db, { status: 'done' });
  const reviewed = plan(db);
  for (const mutate of [
    value => { delete value.tasks[historical]; },
    value => { value.tasks.unknown = { revision: 1, work_mode: 'execute', evidence: 'x' }; },
    value => { value.tasks[id].work_mode = 'auto'; },
    value => { value.tasks[id].work_mode = null; },
    value => { value.tasks[id].revision = 2; },
    value => { value.tasks[id].evidence = ''; },
    value => { value.tasks[id].assignee = 'replacement'; },
    value => { value.force = true; },
    value => { value.tasks[historical].work_mode = 'undecided'; },
    value => { value.source_fingerprint = '0'.repeat(64); },
  ]) {
    const invalid = structuredClone(reviewed);
    mutate(invalid);
    refuses(db, invalid);
  }
  validateResponsibilityPlan(db, reviewed);
});

for (const invalid of ['orphan', 'cycle', 'depth', 'terminal-parent', 'unbound-parent', 'execute-parent', 'same-assignee', 'ancestor-blocker', 'descendant-blocker']) {
  test(`invalid ${invalid} structure fails closed without repair`, t => {
    const { db } = fixture(t);
    const parent = task(db, { status: 'in_progress', assignee: 'parent-session' });
    const child = task(db, { status: 'in_progress', parent, depth: 2, assignee: 'child-session' });
    const modes = { [parent]: 'orchestrate' };
    if (invalid === 'orphan') {
      db.exec('PRAGMA foreign_keys=OFF');
      db.prepare('UPDATE tasks SET parent_task_id=? WHERE id=?').run(randomUUID(), child);
    }
    if (invalid === 'cycle') db.prepare('UPDATE tasks SET parent_task_id=? WHERE id=?').run(child, parent);
    if (invalid === 'depth') db.prepare('UPDATE tasks SET depth=3 WHERE id=?').run(child);
    if (invalid === 'terminal-parent') db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(parent);
    if (invalid === 'unbound-parent') db.prepare('UPDATE tasks SET assignee=NULL WHERE id=?').run(parent);
    if (invalid === 'execute-parent') modes[parent] = 'execute';
    if (invalid === 'same-assignee') {
      db.exec('DROP INDEX assignee_occupancy');
      db.prepare('UPDATE tasks SET assignee=? WHERE id=?').run('parent-session', child);
    }
    if (invalid.endsWith('blocker')) {
      db.prepare("INSERT INTO task_dependencies(id,task_id,kind,blocker_id,author,at) VALUES(?,?,'task',?,?,?)")
        .run(randomUUID(), invalid === 'ancestor-blocker' ? child : parent,
          invalid === 'ancestor-blocker' ? parent : child, 'author', at);
    }
    if (invalid === 'orphan') {
      const before = responsibilityFingerprint(db);
      assert.throws(() => responsibilityInventory(db), { code: 'MIGRATION_REVIEW_REQUIRED' });
      assert.equal(responsibilityFingerprint(db), before);
    } else refuses(db, plan(db, modes));
  });
}

for (const effect of ['receipt', 'notification', 'automation']) {
  test(`in-flight ${effect} blocks migration without dropping its uncertainty`, t => {
    const { db } = fixture(t);
    const id = task(db, { kind: effect === 'automation' ? 'automation' : 'agent' });
    if (effect === 'receipt') {
      db.prepare(`INSERT INTO operations(actor,request_id,tool,fingerprint,input,status,result,created_at,updated_at)
        VALUES('actor','pending','task_assign','fingerprint','{}','pending','{"message":"unknown"}',?,?)`).run(at, at);
    }
    if (effect === 'notification') {
      db.prepare(`INSERT INTO assignee_notices(id,task_id,revision,assignee,kind,event,created_at)
        VALUES(?,?,1,'assignee','updated','{}',?)`).run(randomUUID(), id, at);
    }
    if (effect === 'automation') {
      db.prepare(`INSERT INTO automation_runs(run_id,task_id,script_id,script,parameters,state,barrier)
        VALUES(?,?,'fixture','{}','{}','running',1)`).run(randomUUID(), id);
    }
    assert.equal(responsibilityInventory(db).in_flight.length, 1);
    refuses(db, plan(db));
  });
}

test('schema/history/receipt/WAL drift invalidates a reviewed snapshot', t => {
  const { db } = fixture(t);
  task(db);
  for (const statement of [
    "UPDATE tasks SET title='Changed committed Task'",
    "UPDATE definitions SET reason='Changed historical reason'",
    "CREATE TABLE unexpected_reviewed_data(value TEXT)",
  ]) {
    const reviewed = plan(db);
    db.exec(statement);
    refuses(db, reviewed);
  }
});

test('CLI inventory and preflight preserve source bytes, apply is explicit and replay is refused', t => {
  const { directory, db } = fixture(t);
  task(db);
  const reviewed = plan(db);
  const planPath = resolve(directory, 'reviewed.json');
  writeFileSync(planPath, JSON.stringify(reviewed));
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const file = resolve(directory, 'task-board.sqlite');
  const bytes = readFileSync(file);
  const inventory = cliRun(directory, '--inventory');
  assert.equal(inventory.status, 0, inventory.stderr);
  assert.equal(JSON.parse(inventory.stdout).source_fingerprint, reviewed.source_fingerprint);
  const preflight = cliRun(directory, '--plan', planPath, '--preflight');
  assert.equal(preflight.status, 0, preflight.stderr);
  assert.equal(JSON.parse(preflight.stdout).applies_changes, false);
  assert.deepEqual(readFileSync(file), bytes);
  const migrated = cliRun(directory, '--plan', planPath, '--apply');
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.equal(JSON.parse(migrated.stdout).schema, 12);
  assert.notEqual(cliRun(directory, '--plan', planPath, '--apply').status, 0);
  assert.notEqual(cliRun(directory, '--apply').status, 0);
  assert.notEqual(cliRun(directory, '--unknown').status, 0);
  assert.notEqual(cliRun(resolve(directory, 'missing'), '--inventory').status, 0);
});

test('content-addressed inventory includes committed WAL changes and apply rejects stale plans', t => {
  const { directory, db } = fixture(t);
  const id = task(db);
  const reviewed = plan(db);
  db.exec('PRAGMA journal_mode=WAL');
  db.prepare("UPDATE tasks SET title='WAL-only title' WHERE id=?").run(id);
  const inventory = inspectResponsibilityMigration(directory);
  assert.equal(inventory.tasks[0].title, 'WAL-only title');
  assert.notEqual(inventory.source_fingerprint, reviewed.source_fingerprint);
  refuses(db, reviewed);
});

test('unknown trigger effects and nested migration failure roll back every schema and data change', t => {
  const { db } = fixture(t);
  task(db);
  db.exec("CREATE TRIGGER unknown_effect AFTER UPDATE ON tasks BEGIN UPDATE tasks SET title='rewritten'; END");
  assert.throws(() => responsibilityInventory(db), /Unknown trigger/);
  db.exec('DROP TRIGGER unknown_effect');
  const reviewed = plan(db);
  db.exec('CREATE TABLE assignee_notices_v11(reserved TEXT)');
  reviewed.source_fingerprint = responsibilityFingerprint(db);
  db.exec('BEGIN IMMEDIATE');
  refuses(db, reviewed, /already another table/);
  assert.equal(db.isTransaction, true);
  db.exec('ROLLBACK');
});

test('unrecognized rebuilt-table data and indexes fail closed rather than silently losing history', t => {
  const { db } = fixture(t);
  task(db);
  db.exec('ALTER TABLE task_dependencies ADD COLUMN unknown_history TEXT');
  assert.throws(() => responsibilityInventory(db), /cannot discard/);
  db.exec('ALTER TABLE task_dependencies DROP COLUMN unknown_history; CREATE INDEX unknown_history_index ON task_dependencies(author)');
  assert.throws(() => responsibilityInventory(db), /would be lost/);
});

test('explicit historical CLI stages stop at 10 then 11 and never choose responsibility modes', t => {
  const { directory, db } = fixture(t);
  const id = task(db, { assignee: 'historical-session' });
  restoreV10Operations(db);
  db.exec(`
    DROP TRIGGER tasks_status_insert;
    DROP TRIGGER tasks_status_update;
    DROP TABLE migration_v10_items;
    DROP TABLE migration_v10_subscriptions;
    DROP TABLE task_dependencies;
    CREATE TABLE task_dependencies (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
      blocker_id TEXT NOT NULL REFERENCES tasks(id), author TEXT NOT NULL, at TEXT NOT NULL,
      UNIQUE(task_id,blocker_id), CHECK(task_id<>blocker_id)
    );
    CREATE INDEX task_dependencies_blocker ON task_dependencies(blocker_id);
    DROP TABLE dependency_notices;
    CREATE TABLE dependency_notices (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL REFERENCES tasks(id), blocker_id TEXT NOT NULL REFERENCES tasks(id),
      blocker_lifecycle INTEGER NOT NULL, orchestrator TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('ready','blocker_cancelled')),
      event TEXT NOT NULL, created_at TEXT NOT NULL,
      delivery_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(delivery_status IN ('pending','unknown','accepted','queued','not_sent')),
      attempted_at TEXT, completed_at TEXT, delivery_error TEXT,
      UNIQUE(task_id,kind,blocker_id,blocker_lifecycle)
    );
    CREATE INDEX dependency_notices_task ON dependency_notices(task_id,seq);
    CREATE INDEX dependency_notices_pending ON dependency_notices(seq) WHERE delivery_status='pending';
    UPDATE tasks SET status='blocked';
    PRAGMA user_version=9;
  `);
  const legacyCli = resolve(project, 'scripts/migrate-task-v10.js');
  const legacyRun = (...args) => spawnSync(process.execPath, [legacyCli, '--data-root', directory, ...args], { encoding: 'utf8' });
  const inventoryResult = legacyRun();
  assert.equal(inventoryResult.status, 0, inventoryResult.stderr);
  const inventory = JSON.parse(inventoryResult.stdout);
  assert.equal(inventory.final_schema, 10);
  const oldPlan = {
    schema: 9, target_schema: 10, source_fingerprint: inventory.source_fingerprint,
    tasks: { [id]: { revision: 1, action: 'condition', source: 'Reviewed historical block',
      condition: 'A recorded authorization is still required' } },
  };
  const oldPlanPath = resolve(directory, 'reviewed-v10.json');
  writeFileSync(oldPlanPath, JSON.stringify(oldPlan));
  const oldPreflight = legacyRun('--plan', oldPlanPath, '--preflight');
  assert.equal(oldPreflight.status, 0, oldPreflight.stderr);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9);
  const oldApply = legacyRun('--plan', oldPlanPath, '--apply');
  assert.equal(oldApply.status, 0, oldApply.stderr);
  assert.equal(JSON.parse(oldApply.stdout).schema, 10);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 10);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status, 'in_progress');
  assert.ok(!db.prepare('PRAGMA table_info(tasks)').all().some(row => row.name === 'work_mode'));
  assert.ok(!db.prepare('PRAGMA table_info(operations)').all().some(row => row.name === 'actor'));
  const receiptApply = spawnSync(process.execPath, [resolve(project, 'scripts/migrate-task-v11.js'),
    '--data-root', directory, '--apply'], { encoding: 'utf8' });
  assert.equal(receiptApply.status, 0, receiptApply.stderr);
  assert.equal(JSON.parse(receiptApply.stdout).schema, 11);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11);
  assert.ok(!db.prepare('PRAGMA table_info(tasks)').all().some(row => row.name === 'work_mode'));
  assert.throws(() => new TaskStore(directory), { code: 'MIGRATION_REVIEW_REQUIRED' });
  const reviewed = plan(db, { [id]: 'execute' });
  applyResponsibilityMigration(db, reviewed);
  assert.equal(db.prepare('SELECT work_mode FROM tasks WHERE id=?').get(id).work_mode, 'execute');
  assert.equal(db.prepare("SELECT condition FROM task_dependencies WHERE task_id=? AND resolved_at IS NULL").get(id).condition,
    'A recorded authorization is still required');
});
