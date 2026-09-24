import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../src/task-board/store.js';
import { TaskService } from '../src/task-board/service.js';
import { LIMITS, parseInput } from '../src/task-board/contracts.js';

function fixture(t, overrides = {}) {
  const root = join(process.cwd(), '.task-board-tests', randomUUID());
  mkdirSync(root, { recursive: true });
  let store = new TaskStore(root);
  const sent = [], inspected = [], errors = [];
  const host = {
    ownerExists: async () => true,
    send: async (session, text) => { sent.push({ session, text }); return { ok: true }; },
    inspect: async id => { inspected.push(id); return { ready: true, idle: true, executor: true }; },
    ...overrides,
  };
  let service = new TaskService(store, host, { report: error => errors.push(error) });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const call = (name, input) => service.execute(name, { actor_session_id: 'owner', request_id: randomUUID(), ...input });
  const context = id => ({ task_id: id, write_context: store.task(id).write_context });
  const f = {
    root, sent, inspected, errors, call,
    get store() { return store; }, get service() { return service; },
    async create(fields = {}) {
      const result = await call('task_create', { owner: 'owner', title: 'Synthetic', description: 'Synthetic requirements', ...fields });
      assert.equal(result.error, null, JSON.stringify(result.error));
      return result.result;
    },
    edit: (id, fields) => call('task_edit', { ...context(id), revision: store.task(id).revision, reason: 'Adjust dependencies', ...fields }),
    assign: (id, executor = `executor-${randomUUID()}`, fields = {}) => call('task_assign', { ...context(id), revision: store.task(id).revision, executor, ...fields }),
    cancel: id => call('task_cancel', { ...context(id), reason: 'Not needed' }),
    async done(id) {
      const executor = `executor-${randomUUID()}`;
      assert.equal((await f.assign(id, executor)).error, null);
      const revision = store.task(id).revision;
      const as = { actor_session_id: executor, request_id: randomUUID(), ...context(id), revision };
      assert.equal((await service.execute('task_ack', as)).error, null);
      const input = { ...as, request_id: randomUUID(), write_context: store.task(id).write_context, status: 'done', outcome: { summary: 'Delivered' }, retro: null };
      const result = await service.execute('task_report', input);
      assert.equal(result.error, null, JSON.stringify(result.error));
      return { result, input };
    },
    notices: id => store.read({ view: 'dependency_notices', task_id: id }).items,
    restart() {
      service.close();
      store = new TaskStore(root);
      service = new TaskService(store, host, { report: error => errors.push(error) });
    },
  };
  return f;
}
const ids = task => task.blocked_by.map(entry => entry.task_id);

test('blocked_by is a bounded unique set on create and edit, never an edit-free patch', () => {
  const base = { actor_session_id: 'a', request_id: 'r', owner: 'o', title: 't', description: 'd' };
  const blockers = Array.from({ length: LIMITS.blockers }, () => randomUUID());
  assert.deepEqual(parseInput('task_create', { ...base, blocked_by: blockers }).blocked_by, blockers);
  for (const blocked_by of [[...blockers, randomUUID()], [blockers[0], blockers[0]], [blockers[0], blockers[0].toUpperCase()], ['not-a-uuid']]) {
    assert.throws(() => parseInput('task_create', { ...base, blocked_by }), error => error.code === 'INVALID_INPUT');
  }
  const edit = { actor_session_id: 'a', request_id: 'r', task_id: randomUUID(), write_context: 'c', revision: 1, reason: 'x' };
  assert.deepEqual(parseInput('task_edit', { ...edit, blocked_by: [] }).blocked_by, []);
});

test('create and edit validate blockers: existence, same Owner, not cancelled, no self or cycle', async t => {
  const f = fixture(t);
  const a = await f.create(), b = await f.create({ blocked_by: [a.task_id] });
  assert.deepEqual(ids(b), [a.task_id]);
  assert.equal(b.ready, false);
  assert.equal(f.store.task(b.task_id).status, 'todo');
  assert.equal(f.store.task(b.task_id).executor, null);
  const expectError = async (promise, code) => assert.equal((await promise).error?.code, code);
  await expectError(f.call('task_create', { owner: 'owner', title: 'x', description: 'x', blocked_by: [randomUUID()] }), 'BLOCKER_NOT_FOUND');
  await expectError(f.call('task_create', { owner: 'someone-else', title: 'x', description: 'x', blocked_by: [a.task_id] }), 'BLOCKER_OWNER_MISMATCH');
  await expectError(f.edit(a.task_id, { blocked_by: [a.task_id] }), 'DEPENDENCY_SELF');
  await expectError(f.edit(a.task_id, { blocked_by: [b.task_id] }), 'DEPENDENCY_CYCLE');
  const c = await f.create({ blocked_by: [b.task_id] });
  await expectError(f.edit(a.task_id, { blocked_by: [c.task_id] }), 'DEPENDENCY_CYCLE');
  assert.deepEqual(ids(f.store.task(a.task_id)), [], 'a rejected edit leaves no partial edges');
  const gone = await f.create();
  await f.cancel(gone.task_id);
  await expectError(f.call('task_create', { owner: 'owner', title: 'x', description: 'x', blocked_by: [gone.task_id] }), 'BLOCKER_CANCELLED');
  // A rejected create leaves no Task behind.
  assert.equal(f.store.read({ view: 'list', owner: 'owner', status: 'all' }).items.length, 4);
  // Upper-case IDs normalize to the stored Task.
  const upper = await f.create({ blocked_by: [a.task_id.toUpperCase()] });
  assert.deepEqual(ids(upper), [a.task_id]);
});

test('edit replaces the set, bumps only the materials context and locks once dispatched', async t => {
  const f = fixture(t);
  const a = await f.create(), b = await f.create(), d = await f.create({ blocked_by: [a.task_id] });
  const before = f.store.task(d.task_id);
  const added = await f.edit(d.task_id, { blocked_by: [a.task_id, b.task_id] });
  assert.equal(added.error, null);
  assert.equal(added.result.blockers_changed, true);
  assert.equal(added.result.metadata_changed, true);
  assert.equal(added.result.description_changed, false);
  assert.deepEqual(ids(added.result), [a.task_id, b.task_id]);
  const after = f.store.task(d.task_id);
  assert.equal(after.revision, before.revision, 'dependencies are not a description revision');
  assert.notEqual(after.write_context, before.write_context);
  const unchanged = await f.edit(d.task_id, { blocked_by: [b.task_id, a.task_id] });
  assert.equal(unchanged.result.status, 'unchanged');
  assert.equal(unchanged.result.blockers_changed, false);
  assert.deepEqual(ids(unchanged.result), [a.task_id, b.task_id]);
  assert.equal(typeof unchanged.result.ready, 'boolean');
  const removed = await f.edit(d.task_id, { blocked_by: [b.task_id] });
  assert.deepEqual(ids(removed.result), [b.task_id]);
  const cleared = await f.edit(d.task_id, { blocked_by: [] });
  assert.deepEqual(cleared.result.blocked_by, []);
  assert.equal(cleared.result.ready, true);
  assert.equal((await f.assign(d.task_id)).error, null);
  assert.equal((await f.edit(d.task_id, { blocked_by: [a.task_id] })).error.code, 'DEPENDENCY_LOCKED');
  assert.equal(f.notices(d.task_id).length, 0, 'Owner edits never send notices');
});

test('assigning a not-ready Task is rejected before reservation or Executor inspection', async t => {
  const f = fixture(t);
  const a = await f.create(), d = await f.create({ blocked_by: [a.task_id] });
  const request_id = randomUUID();
  const rejected = await f.assign(d.task_id, 'executor-x', { request_id });
  assert.equal(rejected.error.code, 'TASK_NOT_READY');
  assert.match(rejected.error.message, new RegExp(a.task_id));
  assert.deepEqual(f.inspected, []);
  assert.deepEqual(f.sent, []);
  assert.throws(() => f.store.operation(request_id), error => error.code === 'OPERATION_NOT_FOUND');
  assert.equal(f.store.task(d.task_id).executor, null);
  // The transactional bind is the authoritative gate even without the service precheck.
  const input = { actor_session_id: 'owner', request_id: randomUUID(), task_id: d.task_id, write_context: f.store.task(d.task_id).write_context, revision: 1, executor: 'executor-y' };
  f.store.reserveOperation('task_assign', input);
  assert.throws(() => f.store.bindAssignment(input), error => error.code === 'TASK_NOT_READY');
  await f.done(a.task_id);
  assert.equal((await f.assign(d.task_id, 'executor-x', { request_id })).error, null);
  assert.equal(f.store.task(d.task_id).executor, 'executor-x');
});

test('only the last blocker becoming done sends one idempotent ready notice to the dependent Owner', async t => {
  const f = fixture(t);
  const a = await f.create(), b = await f.create();
  const d = await f.create({ blocked_by: [a.task_id, b.task_id] });
  const unrelated = await f.create({ blocked_by: [a.task_id, b.task_id] });
  await f.cancel(unrelated.task_id);
  const first = await f.done(a.task_id);
  assert.equal(first.result.result.notice_ids, undefined);
  assert.equal(f.sent.filter(entry => entry.session === 'owner').length, 0);
  assert.equal(f.store.task(d.task_id).ready, false);
  const last = await f.done(b.task_id);
  assert.equal(last.result.notification_error, null);
  assert.equal(last.result.result.notice_ids.length, 1);
  assert.equal(last.result.notifications[0].notification.status, 'accepted');
  const ownerCards = () => f.sent.filter(entry => entry.session === 'owner');
  assert.deepEqual(ownerCards(), [{ session: 'owner', text: `[As Owner: Task ready](task:${d.task_id}?event=ready)` }]);
  const [notice] = f.notices(d.task_id);
  assert.equal(notice.kind, 'ready');
  assert.equal(notice.owner, 'owner');
  assert.equal(notice.blocker_id, b.task_id);
  assert.equal(notice.event.blocker_status, 'done');
  assert.equal(notice.event.request_id, last.input.request_id);
  const replay = await f.service.execute('task_report', last.input);
  assert.deepEqual(replay.result, last.result.result);
  assert.equal(ownerCards().length, 1, 'receipt replay never resends');
  f.restart();
  await f.service.recoverNotifications();
  assert.equal(ownerCards().length, 1, 'restart never resends a delivered notice');
  const task = f.store.task(d.task_id);
  assert.equal(task.status, 'todo');
  assert.equal(task.executor, null, 'ready never assigns or dispatches');
  assert.equal(task.ready, true);
  assert.deepEqual(f.notices(unrelated.task_id), [], 'finished dependents are not notified');
});

test('a cancelled blocker notifies the Owner once and keeps the dependent not ready until edited', async t => {
  const f = fixture(t);
  const a = await f.create(), b = await f.create();
  const d = await f.create({ blocked_by: [a.task_id, b.task_id] });
  const cancelled = await f.cancel(a.task_id);
  assert.equal(cancelled.error, null);
  assert.equal(cancelled.result.notice_ids.length, 1);
  assert.deepEqual(f.sent, [{ session: 'owner', text: `[As Owner: Task blocker cancelled](task:${d.task_id}?event=blocker_cancelled)` }]);
  assert.equal((await f.cancel(a.task_id)).result.status, 'unchanged');
  await f.done(b.task_id);
  assert.equal(f.sent.filter(entry => entry.session === 'owner').length, 1, 'no ready notice while a blocker is cancelled');
  const overview = f.store.read({ view: 'overview', task_id: d.task_id });
  assert.equal(overview.ready, false);
  assert.deepEqual(overview.blocked_by, [{ task_id: a.task_id, status: 'cancelled' }, { task_id: b.task_id, status: 'done' }]);
  assert.equal((await f.assign(d.task_id)).error.code, 'TASK_NOT_READY');
  await f.edit(d.task_id, { blocked_by: [b.task_id] });
  assert.equal(f.store.task(d.task_id).ready, true);
  assert.equal((await f.assign(d.task_id)).error, null);
});

test('list, overview, execution and selected context project blockers and readiness compactly', async t => {
  const f = fixture(t);
  const a = await f.create(), d = await f.create({ blocked_by: [a.task_id] });
  const expected = { blocked_by: [{ task_id: a.task_id, status: 'todo' }], ready: false };
  const pick = value => ({ blocked_by: value.blocked_by, ready: value.ready });
  assert.deepEqual(pick(f.store.read({ view: 'overview', task_id: d.task_id })), expected);
  assert.deepEqual(pick(f.store.read({ view: 'execution', task_id: d.task_id })), expected);
  assert.deepEqual(pick(f.store.read({ view: 'overview', task_id: d.task_id, include: ['context'] })), expected);
  const listed = f.store.read({ view: 'list', owner: 'owner' }).items.find(item => item.id === d.task_id);
  assert.deepEqual(pick(listed), expected);
  assert.deepEqual(pick(f.store.read({ view: 'overview', task_id: a.task_id })), { blocked_by: [], ready: true });
});

test('a pending notice survives restart and is recovered exactly once', async t => {
  let fail = true;
  const f = fixture(t, { ownerExists: async () => { if (fail) throw new Error('host down'); return true; } });
  const a = await f.create(), d = await f.create({ blocked_by: [a.task_id] });
  // Record the transition without the service so the notice stays pending, like a crash before delivery.
  const executor = 'executor-direct';
  const input = { actor_session_id: 'owner', request_id: randomUUID(), task_id: a.task_id, write_context: f.store.task(a.task_id).write_context, revision: 1, executor };
  f.store.reserveOperation('task_assign', input);
  f.store.bindAssignment(input);
  const as = { actor_session_id: executor, task_id: a.task_id, revision: 1 };
  f.store.executeLocal('task_ack', { ...as, request_id: randomUUID(), write_context: f.store.task(a.task_id).write_context });
  f.store.executeLocal('task_report', { ...as, request_id: randomUUID(), write_context: f.store.task(a.task_id).write_context, status: 'done', outcome: { summary: 'Done' }, retro: null });
  assert.equal(f.notices(d.task_id)[0].notification.status, 'pending');
  fail = false;
  f.restart();
  await f.service.recoverNotifications();
  await f.service.recoverNotifications();
  assert.deepEqual(f.sent, [{ session: 'owner', text: `[As Owner: Task ready](task:${d.task_id}?event=ready)` }]);
  assert.equal(f.notices(d.task_id)[0].notification.status, 'accepted');
});

test('schema v5 databases migrate forward to v7 without changing existing Tasks', t => {
  const root = join(process.cwd(), '.task-board-tests', randomUUID());
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let store = new TaskStore(root);
  const task = store.executeLocal('task_create', { actor_session_id: 'owner', request_id: 'legacy', owner: 'owner', title: 'Legacy', description: 'Existing' });
  const receipts = store.db.prepare('SELECT * FROM operations').all();
  store.db.exec('DROP TABLE dependency_notices; DROP TABLE task_dependencies; PRAGMA user_version=5');
  store.close();
  const legacy = new DatabaseSync(join(root, 'task-board.sqlite'));
  assert.equal(legacy.prepare('PRAGMA user_version').get().user_version, 5);
  legacy.close();
  store = new TaskStore(root);
  try {
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 7);
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(store.db.prepare('SELECT * FROM operations').all(), receipts);
    const migrated = store.task(task.task_id);
    assert.deepEqual(migrated.blocked_by, []);
    assert.equal(migrated.ready, true);
    const dependent = store.executeLocal('task_create', { actor_session_id: 'owner', request_id: 'new', owner: 'owner', title: 'New', description: 'After', blocked_by: [task.task_id] });
    assert.deepEqual(dependent.blocked_by, [{ task_id: task.task_id, status: 'todo' }]);
  } finally { store.close(); }
});
