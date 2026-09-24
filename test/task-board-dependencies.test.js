import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TaskStore } from '../src/task-board/store.js';
import { TaskService } from '../src/task-board/service.js';
import { LIMITS, parseInput } from '../src/task-board/contracts.js';

function fixture(t, overrides = {}) {
  const root = join(process.cwd(), '.task-board-tests', randomUUID());
  mkdirSync(root, { recursive: true });
  let store = new TaskStore(root);
  const sent = [], inspected = [], errors = [];
  const host = {
    sessionExists: async () => true,
    send: async (session, text) => { sent.push({ session, text }); return { ok: true }; },
    inspect: async id => { inspected.push(id); return { ready: true, idle: true, node: true }; },
    ...overrides,
  };
  let service = new TaskService(store, host, { report: error => errors.push(error) });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const call = (name, input) => service.execute(name, { actor: 'orchestrator', request_id: randomUUID(), ...input });
  const context = id => ({ task_id: id, write_context: store.task(id).write_context });
  const f = {
    root, sent, inspected, errors, call, context,
    get store() { return store; }, get service() { return service; },
    async create(fields = {}) {
      const result = await call('task_create', { title: 'Synthetic', description: 'Synthetic requirements', ...fields });
      assert.equal(result.error, null, JSON.stringify(result.error));
      return result.result;
    },
    edit: (id, fields) => call('task_edit', { ...context(id), revision: store.task(id).revision, reason: 'Adjust dependencies', ...fields }),
    assign: (id, assignee = `assignee-${randomUUID()}`, fields = {}) => call('task_assign', { ...context(id), revision: store.task(id).revision, assignee, ...fields }),
    cancel: id => call('task_cancel', { ...context(id), reason: 'Not needed' }),
    async done(id) {
      const assignee = `assignee-${randomUUID()}`;
      assert.equal((await f.assign(id, assignee)).error, null);
      const revision = store.task(id).revision;
      const as = { actor: assignee, request_id: randomUUID(), ...context(id), revision };
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
  const base = { request_id: 'r', title: 't', description: 'd' };
  const blockers = Array.from({ length: LIMITS.blockers }, () => randomUUID());
  assert.deepEqual(parseInput('task_create', { ...base, blocked_by: blockers }).blocked_by, blockers);
  for (const blocked_by of [[...blockers, randomUUID()], [blockers[0], blockers[0]], [blockers[0], blockers[0].toUpperCase()], ['not-a-uuid']]) {
    assert.throws(() => parseInput('task_create', { ...base, blocked_by }), error => error.code === 'INVALID_INPUT');
  }
  const edit = { request_id: 'r', task_id: randomUUID(), write_context: 'c', revision: 1, reason: 'x' };
  assert.deepEqual(parseInput('task_edit', { ...edit, blocked_by: [] }).blocked_by, []);
});

test('create and edit validate blockers: existence, cross-orchestrator, not cancelled, no self or cycle', async t => {
  const f = fixture(t);
  const a = await f.create(), b = await f.create({ blocked_by: [a.task_id] });
  assert.deepEqual(ids(b), [a.task_id]);
  assert.equal(b.ready, false);
  assert.equal(f.store.task(b.task_id).status, 'todo');
  assert.equal(f.store.task(b.task_id).assignee, null);
  const expectError = async (promise, code) => assert.equal((await promise).error?.code, code);
  await expectError(f.call('task_create', { title: 'x', description: 'x', blocked_by: [randomUUID()] }), 'BLOCKER_NOT_FOUND');
  const cross = await f.service.execute('task_create', { actor: 'other', request_id: randomUUID(), title: 'cross', description: 'x', blocked_by: [a.task_id] });
  assert.equal(cross.error, null);
  assert.equal(f.store.task(cross.result.task_id).orchestrator, 'other');
  await expectError(f.edit(a.task_id, { blocked_by: [a.task_id] }), 'DEPENDENCY_SELF');
  await expectError(f.edit(a.task_id, { blocked_by: [b.task_id] }), 'DEPENDENCY_CYCLE');
  const c = await f.create({ blocked_by: [b.task_id] });
  await expectError(f.edit(a.task_id, { blocked_by: [c.task_id] }), 'DEPENDENCY_CYCLE');
  assert.deepEqual(ids(f.store.task(a.task_id)), [], 'a rejected edit leaves no partial edges');
  const gone = await f.create();
  await f.cancel(gone.task_id);
  await expectError(f.call('task_create', { title: 'x', description: 'x', blocked_by: [gone.task_id] }), 'BLOCKER_CANCELLED');
  // A rejected create leaves no Task behind.
  assert.equal(f.store.read({ view: 'list', orchestrator: 'orchestrator', status: 'all' }).items.length, 4);
  // Upper-case IDs normalize to the stored Task.
  const upper = await f.create({ blocked_by: [a.task_id.toUpperCase()] });
  assert.deepEqual(ids(upper), [a.task_id]);
});

test('edit replaces the set, bumps only the materials context and may update an assigned Task', async t => {
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
  assert.equal((await f.assign(d.task_id, 'assignee')).error, null);
  const assignedEdit = await f.edit(d.task_id, { blocked_by: [a.task_id] });
  assert.equal(assignedEdit.error, null);
  assert.deepEqual(ids(assignedEdit.result), [a.task_id]);
  assert.equal(f.store.read({ view: 'assignee_notices', task_id: d.task_id }).items.length, 1);
});

test('assigning a not-ready Task is rejected before reservation or Assignee inspection', async t => {
  const f = fixture(t);
  const a = await f.create(), d = await f.create({ blocked_by: [a.task_id] });
  const request_id = randomUUID();
  const rejected = await f.assign(d.task_id, 'assignee-x', { request_id });
  assert.equal(rejected.error.code, 'TASK_NOT_READY');
  assert.match(rejected.error.message, new RegExp(a.task_id));
  assert.deepEqual(f.inspected, []);
  assert.deepEqual(f.sent, []);
  assert.throws(() => f.store.operation(request_id), error => error.code === 'OPERATION_NOT_FOUND');
  assert.equal(f.store.task(d.task_id).assignee, null);
  // The transactional bind is the authoritative gate even without the service precheck.
  const input = { actor: 'orchestrator', request_id: randomUUID(), task_id: d.task_id, write_context: f.store.task(d.task_id).write_context, revision: 1, assignee: 'assignee-y' };
  f.store.reserveOperation('task_assign', input);
  assert.throws(() => f.store.bindAssignment(input), error => error.code === 'TASK_NOT_READY');
  await f.done(a.task_id);
  assert.equal((await f.assign(d.task_id, 'assignee-x', { request_id })).error, null);
  assert.equal(f.store.task(d.task_id).assignee, 'assignee-x');
});

test('only the last blocker becoming done sends one idempotent ready notice to the dependent Orchestrator', async t => {
  const f = fixture(t);
  const a = await f.create(), b = await f.create();
  const d = await f.create({ blocked_by: [a.task_id, b.task_id] });
  const unrelated = await f.create({ blocked_by: [a.task_id, b.task_id] });
  await f.cancel(unrelated.task_id);
  const first = await f.done(a.task_id);
  assert.equal(first.result.result.notice_ids, undefined);
  assert.equal(f.sent.filter(entry => entry.session === 'orchestrator').length, 0);
  assert.equal(f.store.task(d.task_id).ready, false);
  const last = await f.done(b.task_id);
  assert.equal(last.result.notification_error, null);
  assert.equal(last.result.result.notice_ids.length, 1);
  assert.equal(last.result.notifications[0].notification.status, 'accepted');
  const orchestratorCards = () => f.sent.filter(entry => entry.session === 'orchestrator');
  assert.deepEqual(orchestratorCards(), [{ session: 'orchestrator', text: `[Subtask ready](task:${d.task_id}?event=ready)` }]);
  const [notice] = f.notices(d.task_id);
  assert.equal(notice.kind, 'ready');
  assert.equal(notice.orchestrator, 'orchestrator');
  assert.equal(notice.blocker_id, b.task_id);
  assert.equal(notice.event.blocker_status, 'done');
  assert.equal(notice.event.request_id, last.input.request_id);
  const replay = await f.service.execute('task_report', last.input);
  assert.deepEqual(replay.result, last.result.result);
  assert.equal(orchestratorCards().length, 1, 'receipt replay never resends');
  f.restart();
  await f.service.recoverNotifications();
  assert.equal(orchestratorCards().length, 1, 'restart never resends a delivered notice');
  const task = f.store.task(d.task_id);
  assert.equal(task.status, 'todo');
  assert.equal(task.assignee, null, 'ready never assigns or dispatches');
  assert.equal(task.ready, true);
  assert.deepEqual(f.notices(unrelated.task_id), [], 'finished dependents are not notified');
});

test('cross-orchestrator blockers are accepted and ready notices go to the dependent orchestrator', async t => {
  const f = fixture(t);
  const blocker = (await f.service.execute('task_create', {
    actor: 'blocker-orchestrator', request_id: randomUUID(), title: 'Blocker', description: 'Other tree',
  })).result;
  const dependent = (await f.service.execute('task_create', {
    actor: 'dependent-orchestrator', request_id: randomUUID(), title: 'Dependent', description: 'Wait cross-tree',
    blocked_by: [blocker.task_id],
  })).result;
  assert.equal(f.store.task(dependent.task_id).orchestrator, 'dependent-orchestrator');
  assert.deepEqual(dependent.blocked_by, [{ task_id: blocker.task_id, status: 'todo' }]);
  f.sent.length = 0;
  const assignee = `assignee-${randomUUID()}`;
  const assign = await f.service.execute('task_assign', {
    actor: 'blocker-orchestrator', request_id: randomUUID(), ...f.context(blocker.task_id),
    revision: f.store.task(blocker.task_id).revision, assignee,
  });
  assert.equal(assign.error, null, JSON.stringify(assign.error));
  assert.equal((await f.service.execute('task_ack', {
    actor: assignee, request_id: randomUUID(), ...f.context(blocker.task_id),
    revision: f.store.task(blocker.task_id).revision,
  })).error, null);
  assert.equal((await f.service.execute('task_report', {
    actor: assignee, request_id: randomUUID(), ...f.context(blocker.task_id),
    revision: f.store.task(blocker.task_id).revision,
    status: 'done', outcome: { summary: 'Delivered' }, retro: null,
  })).error, null);
  assert.deepEqual(f.sent.filter(entry => entry.session === 'dependent-orchestrator'), [
    { session: 'dependent-orchestrator', text: `[Subtask ready](task:${dependent.task_id}?event=ready)` },
  ]);
});

test('a cancelled blocker notifies the Orchestrator once and keeps the dependent not ready until edited', async t => {
  const f = fixture(t);
  const a = await f.create(), b = await f.create();
  const d = await f.create({ blocked_by: [a.task_id, b.task_id] });
  const cancelled = await f.cancel(a.task_id);
  assert.equal(cancelled.error, null);
  assert.equal(cancelled.result.notice_ids.length, 1);
  assert.deepEqual(f.sent, [{ session: 'orchestrator', text: `[Subtask blocker cancelled](task:${d.task_id}?event=blocker_cancelled)` }]);
  assert.equal((await f.cancel(a.task_id)).result.status, 'unchanged');
  await f.done(b.task_id);
  assert.equal(f.sent.filter(entry => entry.session === 'orchestrator').length, 1, 'no ready notice while a blocker is cancelled');
  const overview = f.store.read({ view: 'overview', task_id: d.task_id });
  assert.equal(overview.ready, false);
  assert.deepEqual(overview.blocked_by, [{ task_id: a.task_id, status: 'cancelled' }, { task_id: b.task_id, status: 'done' }]);
  assert.equal((await f.assign(d.task_id)).error.code, 'TASK_NOT_READY');
  await f.edit(d.task_id, { blocked_by: [b.task_id] });
  assert.equal(f.store.task(d.task_id).ready, true);
  assert.equal((await f.assign(d.task_id)).error, null);
});

test('assigned dependents receive update notices for blocker edits, readiness and cancellation', async t => {
  const f = fixture(t);
  const blocker = await f.create();
  const dependent = await f.create();
  assert.equal((await f.assign(dependent.task_id, 'dependent-worker')).error, null);
  assert.equal((await f.service.execute('task_ack', {
    actor: 'dependent-worker', request_id: randomUUID(), ...f.context(dependent.task_id),
    revision: f.store.task(dependent.task_id).revision,
  })).error, null);
  assert.equal((await f.service.execute('task_report', {
    actor: 'dependent-worker', request_id: randomUUID(), ...f.context(dependent.task_id),
    revision: f.store.task(dependent.task_id).revision, status: 'in_progress',
  })).error, null);
  f.sent.length = 0;

  const edited = await f.edit(dependent.task_id, { blocked_by: [blocker.task_id] });
  assert.equal(edited.error, null, JSON.stringify(edited.error));
  assert.equal(edited.result.notice_ids.length, 1);
  assert.deepEqual(f.sent.map(entry => entry.session), ['dependent-worker']);
  assert.match(f.sent[0].text, new RegExp(`^\\[Task updated\\]\\(task:${dependent.task_id}\\?event=updated\\)\\n`));

  f.sent.length = 0;
  const done = await f.done(blocker.task_id);
  assert.equal(done.result.result.notice_ids.length, 1);
  const readyUpdates = f.sent.filter(entry => entry.text.startsWith('[Task updated]'));
  assert.deepEqual(readyUpdates.map(entry => entry.session), ['dependent-worker']);
  assert.equal(f.sent.some(entry => entry.text.startsWith('[Subtask ready]')), false);
  assert.equal(f.store.read({ view: 'dependency_notices', task_id: dependent.task_id }).items.length, 0);

  const cancelledBlocker = await f.create();
  const dependent2 = await f.create();
  assert.equal((await f.assign(dependent2.task_id, 'dependent-worker-2')).error, null);
  f.sent.length = 0;
  assert.equal((await f.edit(dependent2.task_id, { blocked_by: [cancelledBlocker.task_id] })).error, null);
  f.sent.length = 0;
  const cancelled = await f.cancel(cancelledBlocker.task_id);
  assert.equal(cancelled.error, null, JSON.stringify(cancelled.error));
  const cancelUpdates = f.sent.filter(entry => entry.text.startsWith('[Task updated]'));
  assert.deepEqual(cancelUpdates.map(entry => entry.session), ['dependent-worker-2']);
  assert.match(cancelUpdates[0].text, new RegExp(`^\\[Task updated\\]\\(task:${dependent2.task_id}\\?event=updated\\)\\n`));
  assert.equal(f.sent.some(entry => entry.text.startsWith('[Subtask blocker cancelled]')), false);
});

test('list, overview, execution and selected context project blockers and readiness compactly', async t => {
  const f = fixture(t);
  const a = await f.create(), d = await f.create({ blocked_by: [a.task_id] });
  const expected = { blocked_by: [{ task_id: a.task_id, status: 'todo' }], ready: false };
  const pick = value => ({ blocked_by: value.blocked_by, ready: value.ready });
  assert.deepEqual(pick(f.store.read({ view: 'overview', task_id: d.task_id })), expected);
  assert.deepEqual(pick(f.store.read({ view: 'execution', task_id: d.task_id })), expected);
  assert.deepEqual(pick(f.store.read({ view: 'overview', task_id: d.task_id, include: ['context'] })), expected);
  const listed = f.store.read({ view: 'list', orchestrator: 'orchestrator' }).items.find(item => item.id === d.task_id);
  assert.deepEqual(pick(listed), expected);
  assert.deepEqual(pick(f.store.read({ view: 'overview', task_id: a.task_id })), { blocked_by: [], ready: true });
});

test('a pending notice survives restart and is recovered exactly once', async t => {
  let fail = true;
  const f = fixture(t, { sessionExists: async () => { if (fail) throw new Error('host down'); return true; } });
  const a = await f.create(), d = await f.create({ blocked_by: [a.task_id] });
  // Record the transition without the service so the notice stays pending, like a crash before delivery.
  const assignee = 'assignee-direct';
  const input = { actor: 'orchestrator', request_id: randomUUID(), task_id: a.task_id, write_context: f.store.task(a.task_id).write_context, revision: 1, assignee };
  f.store.reserveOperation('task_assign', input);
  f.store.bindAssignment(input);
  const as = { actor: assignee, task_id: a.task_id, revision: 1 };
  f.store.executeLocal('task_ack', { ...as, request_id: randomUUID(), write_context: f.store.task(a.task_id).write_context });
  f.store.executeLocal('task_report', { ...as, request_id: randomUUID(), write_context: f.store.task(a.task_id).write_context, status: 'done', outcome: { summary: 'Done' }, retro: null });
  assert.equal(f.notices(d.task_id)[0].notification.status, 'pending');
  fail = false;
  f.restart();
  await f.service.recoverNotifications();
  await f.service.recoverNotifications();
  assert.deepEqual(f.sent, [{ session: 'orchestrator', text: `[Subtask ready](task:${d.task_id}?event=ready)` }]);
  assert.equal(f.notices(d.task_id)[0].notification.status, 'accepted');
});

test('schema keeps existing Tasks without changing dependency facts', t => {
  const root = join(process.cwd(), '.task-board-tests', randomUUID());
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let store = new TaskStore(root);
  const task = store.executeLocal('task_create', { actor: 'orchestrator', request_id: 'legacy', title: 'Legacy', description: 'Existing' });
  const receipts = store.db.prepare('SELECT * FROM operations').all();
  store.close();
  store = new TaskStore(root);
  try {
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 9);
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(store.db.prepare('SELECT * FROM operations').all(), receipts);
    const migrated = store.task(task.task_id);
    assert.deepEqual(migrated.blocked_by, []);
    assert.equal(migrated.ready, true);
    const dependent = store.executeLocal('task_create', { actor: 'orchestrator', request_id: 'new', title: 'New', description: 'After', blocked_by: [task.task_id] });
    assert.deepEqual(dependent.blocked_by, [{ task_id: task.task_id, status: 'todo' }]);
  } finally { store.close(); }
});
