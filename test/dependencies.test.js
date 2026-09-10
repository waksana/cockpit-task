import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, readCredential } from '../src/store.js';
import { Work } from '../src/work.js';
import { createApp } from '../src/server.js';

const goal = { objective: 'Fixture goal', scope: 'Isolated state', acceptance: 'Fixture artifact', authorization: 'Fixture only' };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'wc-dependencies-'));
  const store = new Store(directory);
  let sequence = 0;
  const cockpit = {
    calls: [],
    async call(name) {
      this.calls.push(name);
      return name === 'session/new' ? { sessionId: `owner-${++sequence}` } : { ok: true, status: 'connected' };
    },
    async meta() { this.calls.push('session/get'); return { loaded: true, status: 'idle', currentModelId: 'gpt-6-astra' }; },
  };
  const work = new Work(store, cockpit), caller = store.authenticate(store.issue('caller', 'caller'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  const key = () => `fixture-key-${++sequence}`;
  const execute = (name, input, principal = caller) => work.execute(principal, name, { idempotencyKey: key(), ...input });
  const create = async title => (await execute('work_record', { action: 'create', title })).task.taskId;
  const dispatch = async taskId => (await execute('work_dispatch', {
    selection: 'new', taskId, recordRevision: store.task(taskId).record_revision, cwd: directory, goal,
  })).task;
  const owner = taskId => store.authenticate(readCredential(store.task(taskId).credential_path));
  const report = (taskId, kind) => execute('work_report', { taskId, goalVersion: store.task(taskId).version, kind, summary: kind }, owner(taskId));
  const deliver = (taskId, outcome = 'delivered') => execute('work_deliver', {
    taskId, goalVersion: store.task(taskId).version, outcome, summary: outcome, artifacts: ['/fixture/result'],
  }, owner(taskId));
  const edit = (taskId, prerequisiteId, extra = {}, principal = caller) => execute('work_dependency', {
    action: 'add', taskId, prerequisiteId, recordRevision: store.task(taskId).record_revision, ...extra,
  }, principal);
  const read = (taskId, extra = {}, principal = caller) => work.execute(principal, 'work_read', {
    taskId, view: 'dependencies', ...extra,
  });
  return { store, work, cockpit, caller, directory, execute, create, dispatch, owner, report, deliver, edit, read };
}

test('two historical cases preserve decision and delivered states, acceptance, and operation identity', async t => {
  const f = fixture(t), prerequisite = await f.create('Engineering handoff');
  const ci = await f.create('CI route decision'), retired = await f.create('Retired collaboration skill');
  for (const id of [prerequisite, ci, retired]) { await f.dispatch(id); await f.report(id, 'accepted'); }
  await f.deliver(prerequisite); await f.report(ci, 'needs_decision'); await f.deliver(retired);
  const calls = f.cockpit.calls.length;
  const snapshot = id => {
    const row = f.store.task(id);
    return [row.status, row.summary, row.artifacts, row.owner, row.caller, row.version, row.accepted_version, row.active_op];
  };
  for (const id of [ci, retired]) {
    const before = snapshot(id), result = await f.edit(id, prerequisite, { prerequisiteGoalVersion: 1, note: 'Engineering prerequisite only' });
    assert.equal(result.task.conditions.ready, true);
    assert.equal(result.task.conditions.satisfied, 1);
    assert.deepEqual(snapshot(id), before);
    assert.equal(result.nativeCalls, 0);
    assert.equal(result.notification, 'not_sent');
  }
  assert.equal(f.cockpit.calls.length, calls);
  assert.equal(f.store.get('SELECT COUNT(*) n FROM dependencies').n, 2);
  assert.equal((await f.read(ci)).items[0].reason, 'delivered');
});

test('self edges, duplicates, transitive cycles, missing references, stale revisions and idempotency', async t => {
  const f = fixture(t), a = await f.create('A'), b = await f.create('B'), c = await f.create('C');
  await assert.rejects(f.edit(a, a), { code: 'SELF_DEPENDENCY' });
  await assert.rejects(f.edit(a, 'missing'), { code: 'NOT_FOUND' });
  const options = { recordRevision: 1, idempotencyKey: 'stable-dependency-key' };
  const added = await f.edit(a, b, options);
  await f.edit(b, c);
  assert.deepEqual(await f.edit(a, b, options), added);
  await assert.rejects(f.edit(a, b, { ...options, note: 'different' }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(f.edit(a, b), { code: 'DEPENDENCY_EXISTS' });
  await assert.rejects(f.edit(b, a), { code: 'DEPENDENCY_CYCLE' });
  await assert.rejects(f.edit(c, a), { code: 'DEPENDENCY_CYCLE' });
  await assert.rejects(f.edit(a, c, { recordRevision: 1 }), { code: 'STALE_RECORD' });
  const removed = await f.edit(a, b, { action: 'remove' });
  assert.equal(removed.task.conditions.total, 0);
  await assert.rejects(f.edit(a, b, { action: 'remove' }), { code: 'DEPENDENCY_NOT_FOUND' });
  await f.edit(c, a);
  assert.deepEqual(f.store.all('PRAGMA foreign_key_check'), []);
  assert.equal(f.cockpit.calls.length, 0);
  const events = await f.work.execute(f.caller, 'work_read', { taskId: a, view: 'events' });
  assert.equal(events.items.filter(e => e.kind === 'dependency_added').length, 1);
  assert.match(events.items.find(e => e.kind === 'dependency_removed').summary, new RegExp(b));
});

test('concurrent graph edits serialize cycle and revision checks, including separate database connections', async t => {
  const f = fixture(t), a = await f.create('A'), b = await f.create('B'), c = await f.create('C');
  const second = new Store(f.directory), work = new Work(second, f.cockpit);
  t.after(() => second.close());
  const results = await Promise.allSettled([
    f.edit(a, b, { recordRevision: 1 }),
    work.execute(f.caller, 'work_dependency', { action: 'add', taskId: a, prerequisiteId: c, recordRevision: 1, idempotencyKey: 'competing-write' }),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'STALE_RECORD');
  const cycleResults = await Promise.allSettled([
    f.edit(b, c),
    work.execute(f.caller, 'work_dependency', { action: 'add', taskId: c, prerequisiteId: a, recordRevision: 1, idempotencyKey: 'competing-cycle' }),
  ]);
  assert.equal(cycleResults.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(cycleResults.find(r => r.status === 'rejected').reason.code, 'DEPENDENCY_CYCLE');
});

test('only bound current formal delivered satisfies; amendment, failure, cancellation and legacy do not', async t => {
  const f = fixture(t), dependent = await f.create('Dependent'), p = await f.create('Prerequisite');
  await f.edit(dependent, p);
  assert.equal((await f.read(dependent)).items[0].reason, 'no_bound_goal');
  await f.dispatch(p); await f.report(p, 'accepted'); await f.deliver(p);
  assert.equal((await f.read(dependent)).conditions.ready, false, 'unbound edges never follow later authorization');
  await f.edit(dependent, p, { action: 'remove' }); await f.edit(dependent, p, { prerequisiteGoalVersion: 1 });
  assert.equal((await f.read(dependent)).conditions.ready, true);
  await f.execute('work_amend', { taskId: p, goalVersion: 1, goal, reason: 'Explicit next goal' });
  assert.equal((await f.read(dependent)).items[0].reason, 'goal_changed');
  await f.edit(dependent, p, { action: 'remove' });
  await assert.rejects(f.edit(dependent, p, { prerequisiteGoalVersion: 1 }), { code: 'STALE_GOAL' });
  await f.edit(dependent, p);
  assert.equal((await f.read(dependent)).items[0].prerequisiteGoalVersion, 2);
  assert.equal((await f.read(dependent)).items[0].state, 'waiting');
  await f.report(p, 'accepted'); await f.deliver(p);
  assert.equal((await f.read(dependent)).conditions.ready, true);
  for (const outcome of ['failed', 'cancelled']) {
    const id = await f.create(outcome); await f.dispatch(id); await f.report(id, 'accepted'); await f.deliver(id, outcome);
    await f.edit(dependent, id);
    assert.equal((await f.read(dependent)).items[0].state, 'waiting');
  }
  const legacy = await f.create('Legacy done observation');
  f.store.run("UPDATE tasks SET status='legacy' WHERE id=?", legacy);
  f.store.run(`INSERT INTO legacy_records(task_id,observed_at,observed_state,summary,notes)
    VALUES(?,'historical','done','Historical receipt','Fixture')`, legacy);
  await f.edit(dependent, legacy);
  assert.equal((await f.read(dependent)).items[0].state, 'needs_confirmation');
  assert.equal(f.store.get("SELECT COUNT(*) n FROM events WHERE task_id=? AND kind IN ('accepted','delivered')", legacy).n, 0);
});

test('same-caller endpoint permissions and read-only viewer/owner boundaries hold across every read surface', async t => {
  const f = fixture(t), a = await f.create('A'), p = await f.create('Private prerequisite title');
  await f.dispatch(a); await f.edit(a, p);
  const stranger = f.store.authenticate(f.store.issue('caller', 'stranger'));
  const foreign = (await f.execute('work_record', { action: 'create', title: 'Secret foreign work' }, stranger)).task.taskId;
  const viewerToken = f.store.issue('viewer'), viewer = f.store.authenticate(viewerToken);
  await assert.rejects(f.edit(a, foreign), { code: 'WRONG_OWNER' });
  await assert.rejects(f.edit(foreign, p), { code: 'WRONG_OWNER' });
  await assert.rejects(f.edit(a, p, { action: 'remove' }, stranger), { code: 'WRONG_OWNER' });
  for (const principal of [viewer, f.owner(a)]) {
    await assert.rejects(f.edit(a, foreign, {}, principal), { code: 'FORBIDDEN' });
    await assert.rejects(f.edit(a, p, { action: 'remove' }, principal), { code: 'FORBIDDEN' });
  }
  await assert.rejects(f.read(a, {}, stranger), { code: 'FORBIDDEN' });
  await assert.rejects(f.read(p, {}, f.owner(a)), { code: 'FORBIDDEN' });
  assert.equal((await f.read(a, {}, f.owner(a))).items[0].title, undefined);
  assert.equal((await f.read(a, {}, viewer)).items[0].title, 'Private prerequisite title');
  for (const view of ['summary', 'board', 'events', 'detail', 'dependencies']) {
    const args = ['summary', 'board'].includes(view) ? { view, includeClosed: true } : { view, taskId: a };
    assert.equal(JSON.stringify(await f.work.execute(f.caller, 'work_read', args)).includes(foreign), false);
  }
  const { app } = createApp({ store: f.store, cockpit: f.cockpit, port: 18811 });
  t.after(() => app.close());
  const login = await app.inject({ method: 'POST', url: '/api/login', headers: { host: '127.0.0.1:18811' }, payload: { token: viewerToken } });
  const cookie = login.headers['set-cookie'].split(';')[0];
  const denied = await app.inject({ method: 'POST', url: '/api/tools/work_dependency',
    headers: { host: '127.0.0.1:18811', cookie }, payload: { action: 'remove', taskId: a, prerequisiteId: p, recordRevision: 2, idempotencyKey: 'viewer-write-attempt' } });
  assert.equal(denied.statusCode, 401);
  const bearerDenied = await app.inject({ method: 'POST', url: '/api/tools/work_dependency',
    headers: { host: '127.0.0.1:18811', authorization: `Bearer ${viewerToken}` }, payload: { action: 'remove', taskId: a, prerequisiteId: p, recordRevision: 2, idempotencyKey: 'viewer-bearer-write' } });
  assert.equal(bearerDenied.statusCode, 403);
});

test('pagination and readiness remain factual without transitive propagation or dispatch blocking', async t => {
  const f = fixture(t), a = await f.create('A'), b = await f.create('B'), c = await f.create('C');
  await f.dispatch(b); await f.report(b, 'accepted'); await f.deliver(b);
  await f.edit(b, c); await f.edit(a, b);
  assert.equal((await f.read(a)).conditions.ready, true, 'does not recursively gate on prerequisites of prerequisites');
  await f.edit(a, c);
  const page = await f.read(a, { limit: 1 });
  assert.ok(page.nextBefore); assert.equal(page.conditions.total, 2);
  assert.notEqual((await f.read(a, { limit: 1, before: page.nextBefore })).items[0].prerequisiteId, page.items[0].prerequisiteId);
  await f.dispatch(a); await f.report(a, 'accepted');
  await f.execute('work_dispatch', { selection: 'continue', taskId: a, goalVersion: 1, message: 'Explicit instruction despite recorded conditions' });
  assert.equal(f.store.task(a).status, 'active');
  assert.equal((await f.read(a)).conditions.ready, false);
  const revision = f.store.task(a).record_revision;
  await f.report(a, 'progress');
  assert.equal(f.store.task(a).record_revision, revision);
  assert.equal((await f.read(a)).conditions.ready, false);
});

test('v2 migration is additive, preserves every existing row, persists edges and removals across reopen', async t => {
  const f = fixture(t), a = await f.create('A'), p = await f.create('P');
  await f.dispatch(a); await f.report(a, 'accepted');
  f.store.run("UPDATE operations SET status='running',inflight=1,step='prompt' WHERE task_id=?", a);
  f.store.db.exec('DROP TABLE dependencies; PRAGMA user_version=2');
  const tables = ['tasks', 'versions', 'credentials', 'operations', 'session_locks', 'mutations', 'events', 'legacy_records', 'legacy_sources', 'import_snapshots'];
  const snapshots = Object.fromEntries(tables.map(table => [table, f.store.all(`SELECT * FROM ${table}`)]));
  let upgraded = new Store(f.directory);
  assert.equal(upgraded.get('PRAGMA user_version').user_version, 3);
  for (const table of tables) assert.deepEqual(upgraded.all(`SELECT * FROM ${table}`), snapshots[table]);
  const work = new Work(upgraded, f.cockpit);
  const args = { action: 'add', taskId: a, prerequisiteId: p, recordRevision: f.store.task(a).record_revision, idempotencyKey: 'upgrade-dependency' };
  const added = await work.execute(f.caller, 'work_dependency', args);
  assert.equal(upgraded.task(a).status, 'active');
  assert.equal(upgraded.get('SELECT status FROM operations WHERE task_id=?', a).status, 'running');
  upgraded.close(); upgraded = new Store(f.directory);
  const restarted = new Work(upgraded, f.cockpit);
  upgraded.recoverInterrupted();
  assert.equal(upgraded.get('SELECT status FROM operations WHERE task_id=?', a).status, 'unknown');
  assert.deepEqual(await restarted.execute(f.caller, 'work_dependency', args), added);
  assert.equal((await restarted.execute(f.caller, 'work_read', { taskId: a, view: 'dependencies' })).items.length, 1);
  await restarted.execute(f.caller, 'work_dependency', { ...args, action: 'remove', recordRevision: added.task.recordRevision, idempotencyKey: 'upgrade-remove-edge' });
  upgraded.close(); upgraded = new Store(f.directory);
  assert.equal(upgraded.get('SELECT COUNT(*) n FROM dependencies').n, 0);
  assert.deepEqual(upgraded.all('PRAGMA foreign_key_check'), []);
  upgraded.close();
});
