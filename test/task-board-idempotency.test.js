import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../src/task-board/store.js';
import { TaskService } from '../src/task-board/service.js';
import { restoreV10Operations, v10OperationColumns } from './helpers/operations-v10.js';

function fixture(t, host = {}) {
  const root = mkdtempSync(join(tmpdir(), 'task-idempotency-'));
  const errors = [];
  let store = new TaskStore(root);
  let service = new TaskService(store, host, { report: error => errors.push(error) });
  t.after(() => {
    service.close();
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  return {
    root, host,
    get store() { return store; },
    get service() { return service; },
    call(actor, name, input, invocation = {}) {
      return service.execute(name, input, {
        external: true, invocation: { sessionId: actor, runtimeSessionId: actor, subagent: false, ...invocation },
      });
    },
    restart() {
      service.close();
      store = new TaskStore(root);
      service = new TaskService(store, host, { report: error => errors.push(error) });
    },
  };
}

const createInput = request_id => ({ request_id, title: 'Synthetic Task', description: 'Scoped durable effects' });
const context = task => ({ task_id: task.task_id, revision: task.revision, write_context: task.write_context });
const receipts = db => db.prepare(`SELECT rowid AS insertion_seq,${v10OperationColumns.join(',')} FROM operations ORDER BY rowid`).all();

function v10Fixture(f, seed = () => {}) {
  f.service.close();
  const db = new DatabaseSync(join(f.root, 'task-board.sqlite'));
  try {
    restoreV10Operations(db);
    seed(db);
    db.exec('PRAGMA user_version=10');
    return receipts(db);
  } finally { db.close(); }
}

test('local receipts and failures are scoped to the actor across connections and restarts', async t => {
  const f = fixture(t);
  const input = createInput('request-1');
  const first = await f.call('first', 'task_create', input);
  const second = await f.call('second', 'task_create', input);
  assert.equal(first.error, null);
  assert.equal(second.error, null);
  assert.notEqual(first.result.task_id, second.result.task_id);
  const other = new TaskStore(f.root);
  try {
    assert.deepEqual(other.executeLocal('task_create', { ...input, actor: 'first' }), first.result);
    assert.deepEqual(other.executeLocal('task_create', { ...input, actor: 'second' }), second.result);
    assert.throws(() => other.executeLocal('task_create', { ...input, actor: 'first', title: 'Changed' }),
      error => error.code === 'REQUEST_ID_CONFLICT');
    assert.throws(() => other.operation({ request_id: input.request_id }), error => error.code === 'INVOCATION_REQUIRED');
    assert.throws(() => other.operation({ actor: 'third', request_id: input.request_id }),
      error => error.code === 'OPERATION_NOT_FOUND');
  } finally { other.close(); }
  const edit = { ...context(first.result), request_id: 'edit', reason: 'Update title', title: 'Updated' };
  assert.equal((await f.call('second', 'task_edit', edit)).error.code, 'ORCHESTRATOR_OR_ASSIGNEE_REQUIRED');
  assert.equal((await f.call('first', 'task_edit', edit)).error, null);
  f.restart();
  for (const [actor, expected] of [['first', first], ['second', second]]) {
    assert.deepEqual((await f.call(actor, 'task_create', input)).result, expected.result);
    const read = await f.call(actor, 'task_read', { view: 'operation', request_id: input.request_id });
    assert.equal(read.result.actor, actor);
    assert.deepEqual(read.result.result, expected.result);
  }
  assert.equal((await f.call('second', 'task_edit', edit)).error.code, 'ORCHESTRATOR_OR_ASSIGNEE_REQUIRED');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 2);
});

test('overlapping external calls with the same ID save and replay only their own caller receipt', async t => {
  const pending = new Map();
  const f = fixture(t, {
    create: cwd => new Promise(resolve => pending.set(cwd, resolve)),
    inspect: async () => ({ ready: true, idle: true, node: true }),
  });
  const firstInput = { request_id: 'create-session', cwd: '/first' };
  const secondInput = { request_id: 'create-session', cwd: '/second' };
  const first = f.call('first', 'task_session_create', firstInput);
  const second = f.call('second', 'task_session_create', secondInput);
  assert.equal(pending.size, 2);
  const replay = await f.call('first', 'task_session_create', firstInput, {
    runtimeSessionId: 'first-subagent', subagent: true,
  });
  assert.equal(replay.error.code, 'OPERATION_UNCONFIRMED');
  assert.equal(pending.size, 2, 'An in-flight replay must not call the host again');
  pending.get('/second')({ sessionId: 'second-created' });
  const secondResult = await second;
  assert.equal(secondResult.result.operation.session_id, 'second-created');
  assert.equal(f.store.operation({ actor: 'first', request_id: firstInput.request_id }).status, 'pending');
  pending.get('/first')({ sessionId: 'first-created' });
  const firstResult = await first;
  assert.equal(firstResult.result.operation.session_id, 'first-created');
  f.restart();
  f.host.create = () => assert.fail('Finalized creation must not repeat');
  for (const [actor, input, result] of [['first', firstInput, firstResult], ['second', secondInput, secondResult]]) {
    assert.deepEqual((await f.call(actor, 'task_session_create', input)).result, result.result);
    assert.throws(() => f.store.saveOperation({ actor, request_id: input.request_id }, { result: { changed: true } }),
      error => error.code === 'OPERATION_FINALIZED');
  }
});

test('preparation uncertainty and completion do not overwrite a same-ID receipt in another session', async t => {
  const prepared = [];
  const f = fixture(t, {
    preparationSupported: true,
    inspect: async () => ({ ready: true, idle: true, node: true }),
    prepare: async sessionId => {
      prepared.push(sessionId);
      if (sessionId === 'uncertain-target') throw new Error('Synthetic lost preparation response');
      return { sessionId, ok: true, skills: [], mcpServers: [], tools: 'unchanged' };
    },
  });
  const input = { request_id: 'prepare', session_id: 'uncertain-target' };
  const unknown = await f.call('first', 'task_session_prepare', input);
  const secondInput = { ...input, session_id: 'ready-target' };
  const known = await f.call('second', 'task_session_prepare', secondInput);
  assert.equal(unknown.result.operation.preparation, 'unknown');
  assert.equal(known.result.operation.preparation, 'prepared');
  f.restart();
  assert.deepEqual((await f.call('first', 'task_session_prepare', input)).result, unknown.result);
  assert.deepEqual((await f.call('second', 'task_session_prepare', secondInput)).result, known.result);
  assert.deepEqual(prepared, ['uncertain-target', 'ready-target']);
});

test('assignment binding and one-time resume are scoped, including authorized Web callers', async t => {
  const sent = [];
  const f = fixture(t, {
    inspect: async () => ({ ready: true, idle: true, node: true }),
    send: async sessionId => { sent.push(sessionId); return { ok: true }; },
  });
  const originals = [];
  for (const actor of ['first', 'second']) {
    const task = f.store.executeLocal('task_create', { actor, ...createInput(`task-${actor}`) });
    const input = { actor, request_id: 'assign', ...context(task), assignee: `${actor}-worker` };
    f.store.reserveOperation('task_assign', input);
    const bound = f.store.bindAssignment(input);
    f.store.saveOperation(input, { result: { operation: {
      assignment: 'applied', message: 'not_sent', status: 'partially_applied',
    } } });
    originals.push({ actor, input, bound });
  }
  const webAttempt = await f.service.execute('task_assign', {
    request_id: 'web-resume', ...context(originals[0].bound),
    assignee: 'first-worker', resume_request_id: 'assign',
  }, { actor: 'user', external: true });
  assert.equal(webAttempt.error.code, 'UNSAFE_DISPATCH_RECOVERY',
    'Web authority on the Task does not provide another caller receipt namespace');
  assert.deepEqual(sent, []);
  for (const { actor, input, bound } of originals) {
    const resumed = await f.call(actor, 'task_assign', {
      request_id: 'resume', ...context(bound), assignee: input.assignee, resume_request_id: input.request_id,
    });
    assert.equal(resumed.error, null);
    assert.equal(resumed.result.operation.message, 'accepted');
    assert.equal(f.store.db.prepare('SELECT resumed_by FROM operations WHERE actor=? AND request_id=?')
      .get(actor, 'assign').resumed_by, 'resume');
  }
  assert.deepEqual(sent, ['first-worker', 'second-worker']);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM task_assignments').get().n, 2);
  const consumed = await f.call('first', 'task_assign', {
    request_id: 'resume-again', ...context(originals[0].bound),
    assignee: 'first-worker', resume_request_id: 'assign',
  });
  assert.equal(consumed.error.code, 'UNSAFE_DISPATCH_RECOVERY');
  assert.deepEqual(sent, ['first-worker', 'second-worker']);
});

test('script registration, automation start and reconcile share the local scoped receipt contract', t => {
  const f = fixture(t);
  const script = join(f.root, 'synthetic.mjs');
  writeFileSync(script, 'process.exit(0);\n');
  for (const actor of ['first', 'second']) {
    const registration = {
      actor, request_id: 'register', script_id: actor, title: 'Synthetic script', description: 'Never launched',
      executable: process.execPath, script_path: script, argv: [], parameters: [],
    };
    const registered = f.store.executeLocal('task_script_register', registration);
    assert.deepEqual(f.store.executeLocal('task_script_register', registration), registered);
    const task = f.store.executeLocal('task_create', {
      actor, ...createInput('automation'), automation: { script_id: actor, parameters: {} },
    });
    const input = { actor, request_id: 'start', ...context(task) };
    const started = f.store.executeLocal('task_automation_start', input);
    assert.deepEqual(f.store.executeLocal('task_automation_start', input), started);
    const run = f.store.automation.claim(task.task_id);
    assert.ok(run);
    f.store.automation.finish(task.task_id, { state: 'interrupted', barrier: true, error: 'Synthetic no-launch handshake' });
    const current = f.store.task(task.task_id);
    const reconcile = {
      actor, request_id: 'reconcile', task_id: task.task_id,
      write_context: current.write_context, reason: 'Synthetic process was never launched',
    };
    const reconciled = f.store.executeLocal('task_automation_reconcile', reconcile);
    assert.deepEqual(f.store.executeLocal('task_automation_reconcile', reconcile), reconciled);
    assert.equal(f.store.automation.run(task.task_id).barrier, 0);
    assert.equal(f.store.automation.run(task.task_id).pid, null);
  }
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM scripts').get().n, 2);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM automation_runs').get().n, 2);
});

test('v10 migration preserves raw receipts, caller attribution and pending or unknown effects without host replay', async t => {
  const calls = [];
  const f = fixture(t, {
    create: async cwd => { calls.push(cwd); return { sessionId: 'independent-session' }; },
    inspect: async () => ({ ready: true, idle: true, node: true }),
  });
  const invocation = { sessionId: 'main', runtimeSessionId: 'child', subagent: true, agentName: 'worker' };
  const createdInput = { ...createInput('known-create'), actor: 'main', invocation };
  const created = f.store.executeLocal('task_create', createdInput);
  const webInput = { ...createInput('web-create'), actor: 'user' };
  const web = f.store.executeLocal('task_create', webInput);
  const pendingInput = { actor: 'main', invocation, request_id: 'pending-create', cwd: '/pending' };
  f.store.reserveOperation('task_session_create', pendingInput);
  f.store.saveOperation(pendingInput, {
    result: { operation: { status: 'running', creation: 'unknown', session_id: null } },
  });
  const unknownInput = { actor: 'main', invocation, request_id: 'unknown-create', cwd: '/unknown' };
  f.store.reserveOperation('task_session_create', unknownInput);
  f.store.saveOperation(unknownInput, {
    result: { operation: { status: 'unconfirmed', creation: 'unknown', session_id: null } },
    error: { code: 'OPERATION_UNCONFIRMED', message: 'Historical lost response' },
  });
  const before = v10Fixture(f);
  f.restart();
  assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version, 11);
  assert.deepEqual(receipts(f.store.db), before, 'No original receipt field or insertion order changes');
  assert.deepEqual(f.store.executeLocal('task_create', createdInput), created);
  assert.deepEqual(f.store.executeLocal('task_create', webInput), web);
  assert.deepEqual(f.store.operation(createdInput).invocation, invocation);
  for (const input of [pendingInput, unknownInput]) {
    const { actor, invocation: ignored, ...fields } = input;
    const replay = await f.call(actor, 'task_session_create', fields, { runtimeSessionId: 'another-child', subagent: true });
    assert.equal(replay.error.code, 'OPERATION_UNCONFIRMED');
    assert.equal(replay.result.operation.creation, 'unknown');
    assert.equal(f.store.operation(input).status, input === pendingInput ? 'pending' : 'final');
    assert.equal((await f.call(actor, 'task_session_create', { ...fields, cwd: '/changed' })).error.code, 'REQUEST_ID_CONFLICT');
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(receipts(f.store.db), before, 'Reads and replays do not rewrite history');
  const independent = await f.call('independent', 'task_session_create', { request_id: 'pending-create', cwd: '/new-work' });
  assert.equal(independent.error, null);
  assert.deepEqual(calls, ['/new-work']);
  assert.equal(f.store.operation(pendingInput).status, 'pending');
  f.restart();
  assert.equal(f.store.operation(unknownInput).result.operation.creation, 'unknown');
  assert.equal(f.store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('unattributable v10 receipts remain intact and block querying, reuse and resume for every caller', async t => {
  const sent = [];
  const f = fixture(t, {
    create: () => assert.fail('Quarantined request IDs cannot create sessions'),
    inspect: async () => ({ ready: true, idle: true, node: true }),
    send: async id => { sent.push(id); return { ok: true }; },
  });
  const task = f.store.executeLocal('task_create', { actor: 'main', ...createInput('task') });
  const assignment = { actor: 'main', request_id: 'old-assignment', ...context(task), assignee: 'worker' };
  f.store.reserveOperation('task_assign', assignment);
  const bound = f.store.bindAssignment(assignment);
  f.store.saveOperation(assignment, { result: { operation: {
    assignment: 'applied', message: 'not_sent', status: 'partially_applied',
  } } });
  const legacyInputs = [
    ['missing', JSON.stringify({ request_id: 'missing', cwd: '/old' }), null],
    ['retired', JSON.stringify({ actor_session_id: 'main', request_id: 'retired', cwd: '/old' }), null],
    ['contradictory', JSON.stringify({ actor: 'main', request_id: 'contradictory' }), JSON.stringify({ sessionId: 'different' })],
    ['invalid-input', '{not JSON', null],
    ['invalid-invocation', JSON.stringify({ actor: 'main' }), '{not JSON'],
    ['invalid-meta', JSON.stringify({ actor: 'main' }), JSON.stringify({ runtimeSessionId: 'main', subagent: false })],
    ['blank-actor', JSON.stringify({ actor: ' ' }), null],
    ['unpaired-meta', JSON.stringify({ cwd: '/old' }), JSON.stringify({ sessionId: 'main' })],
  ];
  const before = v10Fixture(f, db => {
    const at = '2026-09-20T00:00:00.000Z';
    const insert = db.prepare(`INSERT INTO operations(${v10OperationColumns.join(',')}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const [requestId, input, invocation] of legacyInputs) {
      insert.run(requestId, 'task_session_create', 'unchanged-legacy-fingerprint', input, 'pending',
        '{"operation":{"creation":"unknown","status":"unconfirmed"}}',
        '{"code":"OPERATION_UNCONFIRMED","message":"Historical uncertainty"}',
        at, at, 'historical-binding', 'already-consumed', invocation);
    }
    db.prepare('UPDATE operations SET input=? WHERE request_id=?')
      .run(JSON.stringify({ ...assignment, actor: undefined, actor_session_id: 'main' }), assignment.request_id);
  });
  f.restart();
  assert.deepEqual(receipts(f.store.db), before);
  for (const actor of ['main', 'other', 'user']) {
    for (const [request_id] of legacyInputs) {
      const read = await f.call(actor, 'task_read', { view: 'operation', request_id });
      assert.equal(read.error.code, 'LEGACY_OPERATION_UNSCOPED');
      assert.equal(read.result.legacy_operation.request_id, request_id);
      assert.equal(read.result.legacy_operation.status, 'pending');
      assert.ok(read.result.legacy_operation.legacy_reason);
      const replay = await f.call(actor, 'task_session_create', { request_id, cwd: '/old' });
      assert.equal(replay.error.code, 'LEGACY_OPERATION_UNSCOPED');
      const local = await f.call(actor, 'task_create', createInput(request_id));
      assert.equal(local.error.code, 'LEGACY_OPERATION_UNSCOPED');
    }
  }
  assert.deepEqual(receipts(f.store.db), before, 'Rejected requests do not replace or finalize quarantined rows');
  const resume = await f.call('main', 'task_assign', {
    request_id: 'resume-quarantined', ...context(bound), assignee: 'worker', resume_request_id: assignment.request_id,
  });
  assert.equal(resume.error.code, 'LEGACY_OPERATION_UNSCOPED');
  assert.deepEqual(sent, []);
  assert.equal(f.store.db.prepare('SELECT actor FROM operations WHERE request_id=?').get(assignment.request_id).actor, null);
  assert.equal((await f.call('other', 'task_create', createInput('unrelated-new-id'))).error, null);
  f.restart();
  assert.equal((await f.call('other', 'task_create', createInput('missing'))).error.code, 'LEGACY_OPERATION_UNSCOPED');
});

test('v10 consumed recovery markers survive and known-unsent assignments resume only in the original namespace', async t => {
  const sent = [];
  const f = fixture(t, {
    inspect: async () => ({ ready: true, idle: true, node: true }),
    send: async id => { sent.push(id); return { ok: true }; },
  });
  const tasks = [];
  for (const request_id of ['resumable', 'consumed']) {
    const task = f.store.executeLocal('task_create', { actor: 'main', ...createInput(`${request_id}-task`) });
    const input = { actor: 'main', request_id, ...context(task), assignee: `${request_id}-worker` };
    f.store.reserveOperation('task_assign', input);
    const bound = f.store.bindAssignment(input);
    f.store.saveOperation(input, { result: { operation: {
      assignment: 'applied', message: 'not_sent', status: 'partially_applied',
    } } });
    tasks.push({ input, bound });
  }
  v10Fixture(f, db => db.prepare("UPDATE operations SET resumed_by='historical-other-caller-resume' WHERE request_id='consumed'").run());
  f.restart();
  for (const { input, bound } of tasks) {
    const resumeInput = {
      request_id: `resume-${input.request_id}`, ...context(bound), assignee: input.assignee, resume_request_id: input.request_id,
    };
    const web = await f.service.execute('task_assign', resumeInput, { actor: 'user', external: true });
    assert.equal(web.error.code, 'UNSAFE_DISPATCH_RECOVERY');
    const resumed = await f.call('main', 'task_assign', resumeInput);
    if (input.request_id === 'resumable') assert.equal(resumed.result.operation.message, 'accepted');
    else assert.equal(resumed.error.code, 'UNSAFE_DISPATCH_RECOVERY');
  }
  assert.deepEqual(sent, ['resumable-worker']);
  assert.equal(f.store.db.prepare("SELECT resumed_by FROM operations WHERE actor='main' AND request_id='consumed'")
    .get().resumed_by, 'historical-other-caller-resume');
});

test('a failed v10-to-v11 migration rolls back the entire schema and every receipt', t => {
  const f = fixture(t);
  f.store.executeLocal('task_create', { actor: 'main', ...createInput('atomic') });
  const before = v10Fixture(f);
  const exec = DatabaseSync.prototype.exec;
  const mock = t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    if (sql === 'DROP TABLE operations_v10;') throw new Error('Synthetic migration failure after copying receipts');
    return exec.call(this, sql);
  });
  assert.throws(() => new TaskStore(f.root), /Synthetic migration failure/);
  mock.mock.restore();
  const db = new DatabaseSync(join(f.root, 'task-board.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 10);
    assert.deepEqual(receipts(db), before);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='operations_v10'").get(), undefined);
    assert.equal(db.prepare('PRAGMA table_info(operations)').all().some(column => column.name === 'actor'), false);
  } finally { db.close(); }
  f.restart();
  assert.deepEqual(receipts(f.store.db), before);
});
