import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inspectLifecycleMigration, TaskStore } from '../src/task-board/store.js';
import { TaskService } from '../src/task-board/service.js';
import { LIMITS, parseInput } from '../src/task-board/contracts.js';
import { restoreV10Operations } from './helpers/operations-v10.js';
import { serviceOrchestratingRoot, startExecution } from './helpers/responsibility-fixtures.js';
import { restoreV11Schema } from './helpers/responsibility-v11.js';
import { responsibilityFingerprint } from '../src/task-board/responsibility-migration.js';

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
      await serviceOrchestratingRoot(service, store, fields.actor ?? 'orchestrator');
      const result = await call('task_create', { title: 'Synthetic', description: 'Synthetic requirements', ...fields });
      assert.equal(result.error, null, JSON.stringify(result.error));
      return result.result;
    },
    edit: (id, fields) => call('task_edit', { ...context(id), revision: store.task(id).revision, reason: 'Adjust dependencies', ...fields }),
    assign: (id, assignee = `assignee-${randomUUID()}`, fields = {}) => call('task_assign', { ...context(id), revision: store.task(id).revision, assignee, ...fields }),
    async cancel(id, actor = 'orchestrator') {
      if (store.task(id).status === 'cancelled') return call('task_cancel', { actor, ...context(id), reason: 'Not needed' });
      const requested = await call('task_cancel', { actor, ...context(id), reason: 'Not needed' });
      assert.equal(requested.error, null, JSON.stringify(requested.error));
      return call('task_cancel_finalize', {
        actor: store.task(id).assignee ?? 'user', ...context(id), revision: store.task(id).revision,
        summary: 'Cancelled before further work; no resources remain.',
      });
    },
    async done(id) {
      const assignee = `assignee-${randomUUID()}`;
      assert.equal((await f.assign(id, assignee)).error, null);
      const revision = store.task(id).revision;
      const as = { actor: assignee, request_id: randomUUID(), ...context(id), revision };
      assert.equal((await service.execute('task_ack', as)).error, null);
      assert.equal((await service.execute('task_start', { ...as, request_id: randomUUID(), work_mode: 'execute' })).error, null);
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
  assert.equal(f.store.task(cross.result.task_id).created_by, 'other');
  await expectError(f.edit(a.task_id, { blocked_by: [a.task_id] }), 'DEPENDENCY_SELF');
  await expectError(f.edit(a.task_id, { blocked_by: [b.task_id] }), 'DEPENDENCY_CYCLE');
  const c = await f.create({ blocked_by: [b.task_id] });
  await expectError(f.edit(a.task_id, { blocked_by: [c.task_id] }), 'DEPENDENCY_CYCLE');
  assert.deepEqual(ids(f.store.task(a.task_id)), [], 'a rejected edit leaves no partial edges');
  const gone = await f.create();
  await f.cancel(gone.task_id);
  await expectError(f.call('task_create', { title: 'x', description: 'x', blocked_by: [gone.task_id] }), 'BLOCKER_CANCELLED');
  // A rejected create leaves no Task behind.
  assert.equal(f.store.read({ view: 'list', parent_assignee: 'orchestrator', status: 'all' }).items.length, 4);
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
  f.inspected.length = 0;
  const request_id = randomUUID();
  const rejected = await f.assign(d.task_id, 'assignee-x', { request_id });
  assert.equal(rejected.error.code, 'TASK_NOT_READY');
  assert.match(rejected.error.message, new RegExp(a.task_id));
  assert.deepEqual(f.inspected, []);
  assert.deepEqual(f.sent, []);
  assert.throws(() => f.store.operation({ actor: 'orchestrator', request_id }), error => error.code === 'OPERATION_NOT_FOUND');
  assert.equal(f.store.task(d.task_id).assignee, null);
  const input = { actor: 'orchestrator', request_id: randomUUID(), task_id: d.task_id, write_context: f.store.task(d.task_id).write_context, revision: 1, assignee: 'assignee-y' };
  assert.throws(() => f.store.reserveOperation('task_assign', input), error => error.code === 'TASK_NOT_READY');
  assert.throws(() => f.store.operation(input), error => error.code === 'OPERATION_NOT_FOUND');
  // A prerequisite introduced after reservation must still block the authoritative bind transaction.
  const lateBlocked = await f.create();
  const pending = { ...input, request_id: randomUUID(), ...f.context(lateBlocked.task_id) };
  f.store.reserveOperation('task_assign', pending);
  assert.equal((await f.edit(lateBlocked.task_id, { blocked_by: [a.task_id] })).error, null);
  assert.throws(() => f.store.bindAssignment(pending), error => error.code === 'TASK_NOT_READY');
  assert.equal(f.store.task(lateBlocked.task_id).assignee, null);
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
  assert.equal(first.result.result.notice_ids.length, 1, 'The child completion is distinct from dependency readiness');
  assert.deepEqual(f.sent.filter(entry => entry.session === 'orchestrator').map(entry => entry.text), [
    `[Subtask cancelled](task:${unrelated.task_id}?event=child_cancelled)`,
    `[Subtask done](task:${a.task_id}?event=child_done)`,
  ]);
  assert.equal(f.store.task(d.task_id).ready, false);
  const last = await f.done(b.task_id);
  assert.equal(last.result.notification_error, null);
  assert.equal(last.result.result.notice_ids.length, 2);
  assert.equal(last.result.notifications[0].notification.status, 'accepted');
  const orchestratorCards = () => f.sent.filter(entry => entry.session === 'orchestrator');
  assert.deepEqual(orchestratorCards().map(entry => entry.text).sort(), [
    `[Subtask cancelled](task:${unrelated.task_id}?event=child_cancelled)`,
    `[Subtask done](task:${a.task_id}?event=child_done)`,
    `[Subtask done](task:${b.task_id}?event=child_done)`,
    `[Subtask ready](task:${d.task_id}?event=ready)`,
  ].sort());
  const [notice] = f.notices(d.task_id);
  assert.equal(notice.kind, 'ready');
  assert.equal(notice.recipient, 'orchestrator');
  assert.equal(notice.blocker_id, b.task_id);
  assert.equal(notice.event.blocker_status, 'done');
  assert.equal(notice.event.request_id, last.input.request_id);
  const replay = await f.service.execute('task_report', last.input);
  assert.deepEqual(replay.result, last.result.result);
  assert.equal(orchestratorCards().length, 4, 'receipt replay never resends');
  f.restart();
  await f.service.recoverNotifications();
  assert.equal(orchestratorCards().length, 4, 'restart never resends a delivered notice');
  const task = f.store.task(d.task_id);
  assert.equal(task.status, 'todo');
  assert.equal(task.assignee, null, 'ready never assigns or dispatches');
  assert.equal(task.ready, true);
  assert.deepEqual(f.notices(unrelated.task_id), [], 'finished dependents are not notified');
});

test('cross-orchestrator blockers are accepted and ready notices go to the dependent orchestrator', async t => {
  const f = fixture(t);
  await serviceOrchestratingRoot(f.service, f.store, 'blocker-orchestrator');
  await serviceOrchestratingRoot(f.service, f.store, 'dependent-orchestrator');
  const blocker = (await f.service.execute('task_create', {
    actor: 'blocker-orchestrator', request_id: randomUUID(), title: 'Blocker', description: 'Other tree',
  })).result;
  const dependent = (await f.service.execute('task_create', {
    actor: 'dependent-orchestrator', request_id: randomUUID(), title: 'Dependent', description: 'Wait cross-tree',
    blocked_by: [blocker.task_id],
  })).result;
  assert.equal(f.store.task(dependent.task_id).parent_assignee, 'dependent-orchestrator');
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
  startExecution(f.store, blocker, assignee);
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
  const cancelled = await f.cancel(a.task_id, 'user');
  assert.equal(cancelled.error, null);
  assert.equal(cancelled.result.notice_ids.length, 2);
  assert.deepEqual(f.sent.map(entry => entry.text).sort(), [
    `[Subtask blocker cancelled](task:${d.task_id}?event=blocker_cancelled)`,
    `[Subtask cancelled](task:${a.task_id}?event=child_cancelled)`,
  ].sort());
  assert.equal((await f.cancel(a.task_id)).result.status, 'unchanged');
  await f.done(b.task_id);
  assert.equal(f.sent.filter(entry => entry.session === 'orchestrator').length, 3, 'Only sibling completion is added, not readiness');
  assert.equal(f.sent.some(entry => entry.text.includes('?event=ready')), false);
  const overview = f.store.read({ view: 'overview', task_id: d.task_id });
  assert.equal(overview.ready, false);
  assert.deepEqual(overview.blocked_by, [{ task_id: a.task_id, status: 'cancelled' }]);
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
  assert.equal((await f.service.execute('task_start', {
    actor: 'dependent-worker', request_id: randomUUID(), ...f.context(dependent.task_id),
    revision: f.store.task(dependent.task_id).revision, work_mode: 'execute',
  })).error, null);
  f.sent.length = 0;

  const edited = await f.edit(dependent.task_id, { blocked_by: [blocker.task_id] });
  assert.equal(edited.error, null, JSON.stringify(edited.error));
  assert.equal(edited.result.notice_ids.length, 1);
  assert.deepEqual(f.sent.map(entry => entry.session), ['dependent-worker']);
  assert.equal(f.sent[0].text, `[Task updated](task:${dependent.task_id}?event=updated)`);

  f.sent.length = 0;
  const done = await f.done(blocker.task_id);
  assert.equal(done.result.result.notice_ids.length, 2);
  const readyUpdates = f.sent.filter(entry => entry.text.startsWith('[Task updated]'));
  assert.deepEqual(readyUpdates.map(entry => entry.session), ['dependent-worker']);
  assert.equal(readyUpdates[0].text, `[Task updated](task:${dependent.task_id}?event=updated)`);
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
  assert.equal(cancelUpdates[0].text, `[Task updated](task:${dependent2.task_id}?event=updated)`);
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
  const listed = f.store.read({ view: 'list', parent_assignee: 'orchestrator' }).items.find(item => item.id === d.task_id);
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
  startExecution(f.store, a, assignee);
  f.store.executeLocal('task_report', { ...as, request_id: randomUUID(), write_context: f.store.task(a.task_id).write_context, status: 'done', outcome: { summary: 'Done' }, retro: null });
  assert.equal(f.notices(d.task_id)[0].notification.status, 'pending');
  fail = false;
  f.restart();
  await f.service.recoverNotifications();
  await f.service.recoverNotifications();
  assert.deepEqual(f.sent.map(entry => entry.text).sort(), [
    `[Subtask ready](task:${d.task_id}?event=ready)`,
    `[Subtask done](task:${a.task_id}?event=child_done)`,
  ].sort());
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
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 12);
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(store.db.prepare('SELECT * FROM operations').all(), receipts);
    const migrated = store.task(task.task_id);
    assert.deepEqual(migrated.blocked_by, []);
    assert.equal(migrated.ready, true);
    const dependent = store.executeLocal('task_create', { actor: 'orchestrator', request_id: 'new', title: 'New', description: 'After', blocked_by: [task.task_id] });
    assert.deepEqual(dependent.blocked_by, [{ task_id: task.task_id, status: 'todo' }]);
  } finally { store.close(); }
});

test('pause stays in_progress; a later condition escalates once and atomically becomes a Task blocker', async t => {
  const f = fixture(t);
  const dependent = await f.create();
  assert.equal((await f.assign(dependent.task_id, 'worker')).error, null);
  assert.equal((await f.service.execute('task_ack', {
    actor: 'worker', request_id: randomUUID(), ...f.context(dependent.task_id), revision: 1,
  })).error, null);
  startExecution(f.store, dependent, 'worker');
  assert.equal((await f.service.execute('task_report', {
    actor: 'worker', request_id: randomUUID(), ...f.context(dependent.task_id), revision: 1,
    status: 'in_progress', activity: { text: 'User asked to pause; waiting without changing lifecycle or inventing a blocker.' },
  })).error, null);
  assert.equal(f.store.task(dependent.task_id).status, 'in_progress');
  assert.deepEqual(f.sent.filter(entry => entry.session === 'orchestrator'), []);

  const condition = 'A reproducible Safari capture is required; satisfied when the user supplies one matching the reported path.';
  const added = await f.service.execute('task_edit', {
    actor: 'worker', request_id: randomUUID(), ...f.context(dependent.task_id), revision: 1,
    reason: 'Record the newly discovered prerequisite', blocked_by: [{ condition }],
  });
  assert.equal(added.error, null, JSON.stringify(added.error));
  assert.deepEqual(f.sent.filter(entry => entry.session === 'orchestrator').map(entry => entry.text),
    [`[Task blocked](task:${dependent.task_id}?event=blocked)`]);
  const premature = await f.service.execute('task_report', {
    actor: 'worker', request_id: randomUUID(), ...f.context(dependent.task_id), revision: 1,
    status: 'done', outcome: { summary: 'Must not bypass prerequisite' }, retro: null,
  });
  assert.equal(premature.error.code, 'TASK_NOT_READY');
  assert.equal(f.store.read({ view: 'outcomes', task_id: dependent.task_id }).items.length, 0);
  f.sent.length = 0;
  const agreement = 'User authorization: do not resume implementation until I say continue. Latest requirements are recorded here.';
  const revised = await f.edit(dependent.task_id, { description: agreement });
  assert.equal(revised.error, null);
  assert.deepEqual(f.sent, [], 'ordinary blocked-period updates stay silent');

  const blocker = await f.create();
  const replaced = await f.edit(dependent.task_id, { blocked_by: [{ task_id: blocker.task_id }] });
  assert.equal(replaced.error, null);
  assert.equal(replaced.result.ready, false);
  assert.deepEqual(replaced.result.blocked_by, [{ task_id: blocker.task_id, status: 'todo' }]);
  assert.deepEqual(f.sent, [], 'atomic replacement never exposes or announces a false ready state');
  const history = f.store.read({ view: 'dependencies', task_id: dependent.task_id, limit: 10 }).items;
  assert.equal(history.find(entry => entry.condition === condition).resolution, 'removed');

  await f.done(blocker.task_id);
  assert.deepEqual(f.sent.filter(entry => entry.session === 'worker').map(entry => entry.text),
    [`[Task updated](task:${dependent.task_id}?event=updated)`]);
  assert.equal(f.store.task(dependent.task_id).description, agreement);
  assert.equal(f.store.task(dependent.task_id).ready, true);
  assert.equal(f.store.task(dependent.task_id).acknowledged_revision, 1, 'ready does not ACK or override user authorization');
  assert.equal((await f.service.execute('task_ack', {
    actor: 'worker', request_id: randomUUID(), ...f.context(dependent.task_id), revision: 2,
  })).error, null);
  assert.equal(f.store.task(dependent.task_id).status, 'in_progress');
});

test('resolved dependency rounds survive reopen and only an explicit new round blocks the affected Task', async t => {
  const f = fixture(t);
  const blocker = await f.create();
  const b = await f.create({ blocked_by: [{ task_id: blocker.task_id }] });
  const c = await f.create({ blocked_by: [{ task_id: blocker.task_id }] });
  const first = await f.done(blocker.task_id);
  const blockerAssignee = first.input.actor;
  assert.equal(f.store.task(b.task_id).ready, true);
  assert.equal(f.store.task(c.task_id).ready, true);
  f.restart();
  assert.equal(f.store.task(b.task_id).ready, true);
  assert.equal(f.store.task(c.task_id).ready, true);
  const firstCardCount = f.sent.length;

  const reopened = await f.call('task_reopen', {
    ...f.context(blocker.task_id), revision: 1,
    description: 'Explicitly authorized rework', reason: 'The original result needs correction',
  });
  assert.equal(reopened.error, null, JSON.stringify(reopened.error));
  assert.equal(f.store.task(blocker.task_id).status, 'in_progress');
  assert.equal(f.store.task(b.task_id).ready, true);
  assert.equal(f.store.task(c.task_id).ready, true);
  assert.equal(f.sent.length, firstCardCount + 1, 'reopen only notifies its own assignee');

  assert.equal((await f.assign(b.task_id, 'b-worker')).error, null);
  assert.equal((await f.service.execute('task_ack', {
    actor: 'b-worker', request_id: randomUUID(), ...f.context(b.task_id), revision: 1,
  })).error, null);
  const condition = 'The reopened prerequisite must deliver the corrected result.';
  assert.equal((await f.service.execute('task_edit', {
    actor: 'b-worker', request_id: randomUUID(), ...f.context(b.task_id), revision: 1,
    reason: 'Record discovered gap', blocked_by: [{ condition }],
  })).error, null);
  f.sent.length = 0;
  assert.equal((await f.edit(b.task_id, { blocked_by: [{ task_id: blocker.task_id }] })).error, null);
  assert.equal(f.store.task(b.task_id).ready, false);
  assert.equal(f.store.task(c.task_id).ready, true);

  assert.equal((await f.service.execute('task_ack', {
    actor: blockerAssignee, request_id: randomUUID(), ...f.context(blocker.task_id), revision: 2,
  })).error, null);
  const second = await f.service.execute('task_report', {
    actor: blockerAssignee, request_id: randomUUID(), ...f.context(blocker.task_id), revision: 2,
    status: 'done', outcome: { summary: 'Corrected result delivered' }, retro: null,
  });
  assert.equal(second.error, null, JSON.stringify(second.error));
  assert.deepEqual(f.sent.filter(entry => entry.session === 'b-worker').map(entry => entry.text),
    [`[Task updated](task:${b.task_id}?event=updated)`]);
  assert.equal(f.sent.some(entry => entry.text.includes(c.task_id)), false);
  const bRounds = f.store.read({ view: 'dependencies', task_id: b.task_id, limit: 10 }).items
    .filter(entry => entry.blocker_id === blocker.task_id);
  assert.equal(bRounds.length, 2);
  assert.equal(bRounds.every(entry => entry.resolution === 'done'), true);
});

test('mixed prerequisites, condition authority, silent partial resolution and cancelled replanning', async t => {
  const f = fixture(t);
  const dependent = await f.create();
  await f.assign(dependent.task_id, 'worker');
  const blocker = await f.create();
  const condition = { condition: 'The customer must supply the missing input file.' };
  f.sent.length = 0;
  assert.equal((await f.edit(dependent.task_id, { blocked_by: [condition, blocker.task_id] })).error, null);
  assert.equal(f.sent.filter(item => item.session === 'worker').length, 1);
  f.sent.length = 0;
  assert.equal((await f.edit(dependent.task_id, { actor: 'worker', blocked_by: [blocker.task_id] })).error.code,
    'CONDITION_RESOLUTION_REQUIRED');
  assert.equal((await f.edit(dependent.task_id, { description: 'Updated complete blocked agreement.' })).error, null);
  await f.done(blocker.task_id);
  assert.equal(f.sent.filter(item => item.session === 'worker').length, 0);
  const [remainingCondition] = f.store.task(dependent.task_id).blocked_by;
  assert.equal(remainingCondition.condition, condition.condition);
  assert.match(remainingCondition.dependency_id, /^[0-9a-f-]{36}$/);
  assert.equal((await f.edit(dependent.task_id, { blocked_by: [] })).error, null);
  assert.equal(f.sent.filter(item => item.session === 'worker').length, 1);
  const cancelledBlocker = await f.create();
  await f.edit(dependent.task_id, { blocked_by: [cancelledBlocker.task_id] });
  f.sent.length = 0;
  await f.cancel(cancelledBlocker.task_id);
  assert.equal(f.store.task(dependent.task_id).ready, false);
  assert.equal(f.sent.filter(item => item.session === 'worker').length, 1);
  f.restart();
  assert.equal(f.store.task(dependent.task_id).ready, false);
});

test('dependency transitions do not remind their own actor and unknown escalation is not resent', async t => {
  const f = fixture(t, {
    send: async (session, text) => {
      f.sent.push({ session, text });
      if (text.startsWith('[Task blocked]')) throw new Error('Acceptance unknown');
      return { ok: true };
    },
  });
  const dependent = await f.create();
  await f.assign(dependent.task_id, 'worker');
  f.sent.length = 0;
  const request = {
    actor: 'worker', request_id: randomUUID(), ...f.context(dependent.task_id), revision: 1,
    reason: 'Missing external data', blocked_by: [{ condition: 'Need the complete source data.' }],
  };
  const result = await f.service.execute('task_edit', request);
  assert.equal(result.error, null);
  assert.equal(result.notifications[0].notification.status, 'unknown');
  await f.service.execute('task_edit', request);
  f.restart();
  await f.service.recoverNotifications();
  assert.equal(f.sent.length, 1, 'unknown never retries');
  assert.equal(f.sent[0].session, 'orchestrator');
  const blocker = await f.create();
  const waiting = await f.create({ blocked_by: [blocker.task_id] });
  f.sent.length = 0;
  await f.cancel(blocker.task_id);
  assert.deepEqual(f.sent.map(entry => entry.text).sort(), [
    `[Subtask blocker cancelled](task:${waiting.task_id}?event=blocker_cancelled)`,
    `[Subtask cancelled](task:${blocker.task_id}?event=child_cancelled)`,
  ].sort(), 'The Web user finalizes an unbound cancellation; its parent receives both distinct transitions');
  assert.equal(f.store.task(waiting.task_id).ready, false);
});

test('legacy lifecycle review migrates every decision branch only to schema10 and cannot bypass responsibility review', t => {
  const root = join(process.cwd(), '.task-board-tests', randomUUID());
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let store = new TaskStore(root);
  const create = (request_id, title, blocked_by) => store.executeLocal('task_create', {
    actor: 'orchestrator', request_id, title, description: `${title} definition`, ...(blocked_by ? { blocked_by } : {}),
  });
  const doneBlocker = create('migration-done-blocker', 'Done blocker');
  store.db.prepare("UPDATE tasks SET status='done',lifecycle=lifecycle+1 WHERE id=?").run(doneBlocker.task_id);
  const withDependency = create('migration-with-dependency', 'Blocked with dependency', [{ task_id: doneBlocker.task_id }]);
  const condition = create('migration-condition', 'Blocked needing condition');
  const paused = create('migration-paused', 'User pause only');
  const review = create('migration-review', 'Legacy review');
  const automation = create('migration-automation', 'Failed automation');
  const consumer = create('migration-consumer', 'Automation consumer', [automation.task_id]);
  const dependencies = store.db.prepare('SELECT * FROM task_dependencies').all();
  store.close();

  const db = new DatabaseSync(join(root, 'task-board.sqlite'));
  restoreV11Schema(db);
  for (const { evidence, refs, ...entry } of dependencies) {
    const columns = Object.keys(entry);
    db.prepare(`INSERT INTO task_dependencies(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
      .run(...Object.values(entry));
  }
  const at = new Date().toISOString();
  db.exec('DROP TRIGGER tasks_status_insert; DROP TRIGGER tasks_status_update; DROP TABLE migration_v10_items; DROP TABLE migration_v10_subscriptions;');
  db.prepare("UPDATE tasks SET status='blocked' WHERE id IN (?,?,?,?)")
    .run(withDependency.task_id, condition.task_id, paused.task_id, automation.task_id);
  db.prepare("UPDATE tasks SET status='in_review' WHERE id=?").run(review.task_id);
  db.prepare("UPDATE tasks SET kind='automation',assignee=NULL,acknowledged_revision=NULL WHERE id=?").run(automation.task_id);
  db.prepare(`INSERT INTO automation_runs(
    run_id,task_id,script_id,script,parameters,state,revision,finished_at,exit_code,error,barrier
  ) VALUES(?,?,?,?,?,'failed',1,?,7,'Synthetic failure',1)`).run(
    randomUUID(), automation.task_id, 'legacy-script',
    JSON.stringify({ script_id: 'legacy-script' }), '{}', at,
  );
  db.prepare(`INSERT INTO outcomes(
    id,task_id,revision,assignee,author,summary,refs,at,run_id,retro,retro_recorded
  ) VALUES(?,?,?,?,?,?,?,?,?,NULL,0)`).run(
    randomUUID(), automation.task_id, 1, null, 'automation:legacy', 'Automation failed with exit code 7.', '[]', at, 'legacy-run',
  );
  db.prepare(`INSERT INTO subscriptions(
    id,task_id,subscriber,author,statuses,state,created_at
  ) VALUES(?,?,?,?,?,'waiting',?)`).run(randomUUID(), condition.task_id, 'observer', 'observer', '["blocked"]', at);
  db.prepare(`INSERT INTO subscriptions(
    id,task_id,subscriber,author,statuses,state,created_at
  ) VALUES(?,?,?,?,?,'waiting',?)`).run(randomUUID(), paused.task_id, 'observer', 'observer', '["blocked","done"]', at);
  restoreV10Operations(db);
  db.exec('PRAGMA user_version=9;');
  db.close();

  const inventory = inspectLifecycleMigration(root);
  assert.equal(inventory.schema, 9);
  assert.deepEqual(inventory.tasks.map(item => item.task_id),
    [withDependency.task_id, condition.task_id, paused.task_id, review.task_id, automation.task_id]);
  assert.equal(inventory.tasks.find(item => item.task_id === withDependency.task_id).dependencies.length, 1);
  assert.equal(inventory.tasks.find(item => item.task_id === automation.task_id).automation.barrier, 1);
  assert.throws(() => new TaskStore(root), error =>
    error.code === 'MIGRATION_REVIEW_REQUIRED');
  const unchanged = new DatabaseSync(join(root, 'task-board.sqlite'), { readOnly: true });
  assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 9);
  assert.equal(unchanged.prepare("SELECT count(*) AS count FROM tasks WHERE status IN ('blocked','in_review')").get().count, 5);
  unchanged.close();
  assert.equal(inspectLifecycleMigration(root).source_fingerprint, inventory.source_fingerprint,
    'rejected initialization rolls back schema, indexes and data, not just user_version');

  const tasks = {
    [withDependency.task_id]: { revision: 1, action: 'preserve_dependencies', source: 'Existing task_dependencies row.' },
    [condition.task_id]: {
      revision: 1, action: 'condition', source: 'Latest activity and definition require a user decision.',
      condition: 'The user must provide the missing decision before implementation resumes.',
    },
    [paused.task_id]: { revision: 1, action: 'paused', source: 'Definition records a user pause and no unmet prerequisite.' },
    [review.task_id]: { revision: 1, action: 'resume', source: 'Legacy in_review maps directly to in_progress.' },
    [automation.task_id]: { revision: 1, action: 'automation_finished', source: 'Run state failed with exit code 7 and retained barrier.' },
  };
  const plan = { schema: 9, target_schema: 10, source_fingerprint: inventory.source_fingerprint, tasks };
  const planFile = join(root, 'plan.json');
  writeFileSync(planFile, JSON.stringify(plan));
  const before = readFileSync(join(root, 'task-board.sqlite'));
  const cli = (...args) => execFileSync(process.execPath, ['scripts/migrate-task-v10.js', '--data-root', root, ...args], { encoding: 'utf8' });
  const preflight = JSON.parse(cli('--plan', planFile, '--preflight'));
  assert.equal(preflight.status, 'ready');
  assert.equal(preflight.target_schema, 10);
  assert.equal(preflight.final_schema, 10);
  assert.deepEqual(readFileSync(join(root, 'task-board.sqlite')), before, 'preflight is read-only');
  const drift = new DatabaseSync(join(root, 'task-board.sqlite'));
  drift.prepare('UPDATE tasks SET editable=editable+1 WHERE id=?').run(condition.task_id);
  drift.close();
  assert.throws(() => new TaskStore(root, { migrationPlan: plan }), error => error.code === 'MIGRATION_REVIEW_REQUIRED');
  assert.throws(() => inspectLifecycleMigration(root, { plan }), error => error.code === 'MIGRATION_REVIEW_REQUIRED');
  plan.source_fingerprint = inspectLifecycleMigration(root).source_fingerprint;
  writeFileSync(planFile, JSON.stringify(plan));
  assert.equal(inspectLifecycleMigration(root, { plan }).tasks.length, 5);
  for (const [id, invalid] of [
    [withDependency.task_id, { ...tasks[withDependency.task_id], action: 'paused' }],
    [condition.task_id, { ...tasks[condition.task_id], condition: '' }],
    [paused.task_id, { ...tasks[paused.task_id], source: '' }],
    [review.task_id, { ...tasks[review.task_id], revision: 2 }],
    [automation.task_id, { ...tasks[automation.task_id], action: 'resume' }],
  ]) {
    assert.throws(() => inspectLifecycleMigration(root, { plan: { ...plan, tasks: { ...tasks, [id]: invalid } } }),
      error => error.code === 'MIGRATION_REVIEW_REQUIRED');
  }
  const preserved = new DatabaseSync(join(root, 'task-board.sqlite'));
  try {
    const receipts = preserved.prepare('SELECT * FROM operations ORDER BY request_id').all();
    const applied = JSON.parse(cli('--plan', planFile, '--apply'));
    assert.equal(applied.status, 'migrated');
    assert.equal(applied.schema, 10, 'Lifecycle review does not select responsibility modes or upgrade receipts');
    assert.equal(preserved.prepare('PRAGMA user_version').get().user_version, 10);
    assert.deepEqual(preserved.prepare('SELECT * FROM operations ORDER BY request_id').all(), receipts);
    assert.deepEqual(preserved.prepare("SELECT status FROM tasks WHERE id IN (?,?,?) ORDER BY seq").all(withDependency.task_id, condition.task_id, paused.task_id).map(row => row.status), ['in_progress', 'in_progress', 'in_progress']);
    assert.equal(preserved.prepare('SELECT status FROM tasks WHERE id=?').get(review.task_id).status, 'in_progress');
    assert.equal(preserved.prepare('SELECT status FROM tasks WHERE id=?').get(automation.task_id).status, 'done');
    assert.deepEqual({ ...preserved.prepare('SELECT state,barrier,exit_code FROM automation_runs WHERE task_id=?').get(automation.task_id) },
      { state: 'failed', barrier: 1, exit_code: 7 });
    assert.equal(preserved.prepare('SELECT blocker_id FROM task_dependencies WHERE task_id=?').get(consumer.task_id).blocker_id, automation.task_id);
    assert.equal(preserved.prepare('SELECT resolution FROM task_dependencies WHERE task_id=?').get(consumer.task_id).resolution, 'done');
    assert.equal(preserved.prepare('SELECT resolution FROM task_dependencies WHERE task_id=?').get(withDependency.task_id).resolution, 'done');
    assert.equal(preserved.prepare('SELECT condition FROM task_dependencies WHERE task_id=? AND resolved_at IS NULL').get(condition.task_id).condition,
      'The user must provide the missing decision before implementation resumes.');
    assert.equal(preserved.prepare('SELECT count(*) AS n FROM task_dependencies WHERE task_id=? AND resolved_at IS NULL').get(paused.task_id).n, 0);
    assert.match(preserved.prepare('SELECT summary FROM outcomes WHERE task_id=? ORDER BY seq DESC LIMIT 1').get(automation.task_id).summary, /Exit code: 7/);
    const subscriptions = preserved.prepare('SELECT statuses,state FROM subscriptions ORDER BY seq').all();
    assert.deepEqual(subscriptions.map(row => [JSON.parse(row.statuses), row.state]), [[[], 'expired'], [['done'], 'waiting']]);
    assert.deepEqual(preserved.prepare('SELECT prior_statuses FROM migration_v10_subscriptions').all().map(row => row.prior_statuses).sort(),
      ['["blocked"]', '["blocked","done"]'].sort());
    assert.equal(preserved.prepare('SELECT count(*) AS n FROM migration_v10_subscriptions').get().n, 2);
    assert.equal(preserved.prepare('SELECT count(*) AS n FROM migration_v10_items').get().n, 5);
    const fingerprint = responsibilityFingerprint(preserved);
    assert.throws(() => new TaskStore(root), error => error.code === 'MIGRATION_REVIEW_REQUIRED');
    assert.equal(responsibilityFingerprint(preserved), fingerprint, 'Subsequent startup cannot silently cross the responsibility boundary');
    assert.equal(preserved.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(preserved.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { preserved.close(); }
});

test('v9 startup requires a reviewed plan even without legacy statuses', t => {
  const f = fixture(t);
  const task = f.store.executeLocal('task_create', {
    actor: 'orchestrator', request_id: randomUUID(), title: 'Current state', description: 'Keep intact',
  });
  f.service.close();
  const db = new DatabaseSync(join(f.root, 'task-board.sqlite'));
  t.after(() => { if (db.isOpen) db.close(); });
  restoreV11Schema(db);
  restoreV10Operations(db);
  db.exec(`DROP TRIGGER tasks_status_insert; DROP TRIGGER tasks_status_update;
    DROP TABLE migration_v10_items; DROP TABLE migration_v10_subscriptions; PRAGMA user_version=9`);
  const inventory = inspectLifecycleMigration(f.root);
  assert.deepEqual(inventory.tasks, []);
  assert.throws(() => new TaskStore(f.root), error => error.code === 'MIGRATION_REVIEW_REQUIRED');
  assert.equal(inspectLifecycleMigration(f.root).source_fingerprint, inventory.source_fingerprint);
  const plan = {
    schema: 9, target_schema: 10, source_fingerprint: inventory.source_fingerprint, tasks: {},
  };
  assert.deepEqual(inspectLifecycleMigration(f.root, { plan }).tasks, []);
  assert.throws(() => new TaskStore(f.root, { migrationPlan: plan }), error => error.code === 'MIGRATION_REVIEW_REQUIRED');
  assert.equal(db.prepare('SELECT description FROM tasks WHERE id=?').get(task.task_id).description, 'Keep intact');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9);
  assert.equal(inspectLifecycleMigration(f.root).source_fingerprint, inventory.source_fingerprint);
  db.close();
});

test('list pagination bounds condition previews without truncating execution requirements', async t => {
  const f = fixture(t);
  const older = await f.create();
  const blocked_by = Array.from({ length: 20 }, (_, index) => ({ condition: `${index}${'\u0001'.repeat(1998)}` }));
  const large = await f.create({ blocked_by });
  const page = f.store.read({ view: 'list', parent_assignee: 'orchestrator', limit: 1 });
  assert.equal(page.items[0].task_id, large.task_id);
  assert.ok(page.items[0].blocked_by.every(entry => entry.condition.length === 80 && entry.truncated));
  assert.ok(JSON.stringify(page).length < LIMITS.page);
  const next = f.store.read({ view: 'list', parent_assignee: 'orchestrator', limit: 1, cursor: page.next_cursor });
  assert.equal(next.items[0].task_id, older.task_id);
  assert.equal(next.next_cursor, null, 'The root setup fixture must not add an unexpected pagination remainder');
  const requirements = f.store.read({ view: 'execution', task_id: large.task_id }).blocked_by;
  assert.deepEqual(requirements.map(({ condition }) => ({ condition })), blocked_by);
  assert.equal(new Set(requirements.map(entry => entry.dependency_id)).size, blocked_by.length);
});
