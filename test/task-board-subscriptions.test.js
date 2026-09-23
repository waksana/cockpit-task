import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../src/task-board/store.js';
import { TaskService } from '../src/task-board/service.js';
import { parseInput } from '../src/task-board/contracts.js';
import { activate } from '../src/task-board/module.js';

function fixture(t, overrides = {}) {
  const root = join(process.cwd(), '.task-board-tests', randomUUID());
  mkdirSync(root, { recursive: true });
  let store = new TaskStore(root);
  const sent = [], reads = [], errors = [];
  const host = {
    ownerExists: async owner => { reads.push(owner); return true; },
    send: async (owner, text) => { sent.push({ owner, text }); return { ok: true }; },
    ...overrides,
  };
  let service = new TaskService(store, host, { report: error => errors.push(error) });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const create = owner => store.executeLocal('task_create', {
    actor_session_id: 'creating-actor', request_id: randomUUID(), owner: owner ?? 'task-owner',
    title: 'Synthetic subscription', description: 'Synthetic requirements',
  });
  const request = (task, fields) => ({
    actor_session_id: 'different-actor', request_id: randomUUID(),
    task_id: task.task_id, write_context: store.task(task.task_id).write_context, ...fields,
  });
  const subscribe = (task, statuses = ['done'], extra = {}) => store.executeLocal('task_subscribe', request(task, { statuses, ...extra }));
  const reportRequest = (task, fields) => request(task, { revision: store.task(task.task_id).revision, ...fields });
  const executable = () => {
    const task = create();
    const input = request(task, { revision: 1, executor: 'executor' });
    store.reserveOperation('task_assign', input);
    store.bindAssignment(input);
    store.executeLocal('task_ack', reportRequest(task, {}));
    return task;
  };
  return {
    root, host, sent, reads, errors, create, request, reportRequest, subscribe, executable,
    get store() { return store; }, get service() { return service; },
    subscriptions: task => store.read({ view: 'subscriptions', task_id: task.task_id }).items,
    restart() { service.close(); store = new TaskStore(root); service = new TaskService(store, host, { report: error => errors.push(error) }); },
  };
}
const code = expected => error => error.code === expected;

test('subscription schemas are bounded and never accept recipient, owner or rule selectors', () => {
  const input = { actor_session_id: 'actor', request_id: 'id', task_id: randomUUID(), write_context: 'context', statuses: ['done'] };
  assert.deepEqual(parseInput('task_subscribe', input), input);
  for (const patch of [
    { statuses: [] }, { statuses: ['done', 'done'] }, { statuses: ['unknown'] },
    { recipient: 'other' }, { owner: 'other' }, { fields: ['status'] }, { rule: {} }, { revision: 1 },
  ]) assert.throws(() => parseInput('task_subscribe', { ...input, ...patch }), code('INVALID_INPUT'));
  assert.throws(() => parseInput('task_unsubscribe', {
    actor_session_id: 'actor', request_id: 'id', task_id: input.task_id, subscription_id: randomUUID(), write_context: 'extra',
  }), code('INVALID_INPUT'));
});

test('already-matching registration rejects inside the transaction without subscribing or notifying', async t => {
  const f = fixture(t), task = f.create();
  const request = f.request(task, { statuses: ['todo', 'done'] });
  const original = f.store.subscribe;
  f.store.subscribe = function (input) {
    assert.equal(this.db.isTransaction, true);
    return original.call(this, input);
  };
  const result = await f.service.execute('task_subscribe', request);
  assert.equal(result.error.code, 'ALREADY_IN_TARGET_STATUS');
  assert.equal(result.result, null);
  assert.deepEqual(f.subscriptions(task), []);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.reads, []);
  f.restart();
  assert.deepEqual(await f.service.execute('task_subscribe', request), result);
});

test('one waiting subscription per derived Owner, durable receipt replay and cancellation', t => {
  const f = fixture(t), task = f.create();
  const input = f.request(task, { statuses: ['in_review', 'done'] });
  const first = f.store.executeLocal('task_subscribe', input);
  const subscription = first.subscription;
  assert.equal(subscription.owner, 'task-owner');
  assert.equal(subscription.actor_session_id, 'different-actor');
  assert.equal(subscription.state, 'waiting');
  assert.equal(subscription.event, null);
  assert.equal(subscription.notification.status, 'not_requested');
  assert.deepEqual(f.store.executeLocal('task_subscribe', input), first);
  assert.throws(() => f.subscribe(task), code('SUBSCRIPTION_EXISTS'));
  assert.throws(() => f.store.executeLocal('task_subscribe', { ...input, statuses: ['blocked'] }), code('REQUEST_ID_CONFLICT'));
  f.restart();
  assert.equal(f.subscriptions(task)[0].state, 'waiting');
  const cancel = { actor_session_id: 'other-actor', request_id: randomUUID(), task_id: task.task_id, subscription_id: subscription.subscription_id };
  const cancelled = f.store.executeLocal('task_unsubscribe', cancel);
  assert.equal(cancelled.subscription.state, 'cancelled');
  assert.equal(cancelled.subscription.ended_by, 'other-actor');
  assert.deepEqual(f.store.executeLocal('task_unsubscribe', cancel), cancelled);
  assert.equal(f.store.executeLocal('task_unsubscribe', { ...cancel, request_id: randomUUID() }).status, 'unchanged');
  assert.equal(f.subscribe(task).subscription.state, 'waiting');
  assert.throws(() => f.store.executeLocal('task_unsubscribe', { ...cancel, request_id: randomUUID(), task_id: f.create('other').task_id }), code('SUBSCRIPTION_NOT_FOUND'));
});

test('actual transitions consume once, address only stored Owner, and retain event snapshot after fast changes', async t => {
  const f = fixture(t), task = f.executable();
  const subscription = f.subscribe(task, ['in_progress', 'blocked']).subscription;
  const input = f.reportRequest(task, { status: 'in_progress' });
  const first = await f.service.execute('task_report', input);
  assert.equal(first.error, null);
  assert.equal(first.notification_error, null);
  assert.deepEqual(first.result.subscription_ids, [subscription.subscription_id]);
  assert.equal(first.notifications[0].notification.status, 'accepted');
  assert.deepEqual(f.sent, [{ owner: 'task-owner', text: `[Task status updated](task:${task.task_id}?event=status_changed)` }]);
  assert.deepEqual(f.reads, ['task-owner']);
  assert.deepEqual((await f.service.execute('task_report', input)).result, first.result);
  await f.service.execute('task_report', f.reportRequest(task, { status: 'blocked' }));
  await f.service.execute('task_report', f.reportRequest(task, { status: 'in_progress' }));
  assert.equal(f.sent.length, 1);
  const recorded = f.subscriptions(task)[0];
  assert.equal(recorded.state, 'triggered');
  assert.equal(recorded.event.from_status, 'todo');
  assert.equal(recorded.event.status, 'in_progress');
  assert.equal(recorded.event.request_id, input.request_id);
  assert.equal(recorded.event.actor_session_id, 'different-actor');
  assert.equal(recorded.event.at, recorded.ended_at);
  assert.equal(f.store.operation(input.request_id).result.subscription_ids[0], subscription.subscription_id);
});

test('same-status, activity, definitions and stale status reports do not fire or contact the host', async t => {
  const f = fixture(t), task = f.executable();
  await f.service.execute('task_report', f.reportRequest(task, { status: 'in_progress' }));
  f.subscribe(task, ['blocked']);
  await f.service.execute('task_report', f.reportRequest(task, { status: 'in_progress', activity: { text: 'Same status' } }));
  await f.service.execute('task_edit', f.reportRequest(task, { reason: 'clarify', description: 'Second definition' }));
  const stale = await f.service.execute('task_report', f.reportRequest(task, {
    revision: 1, status: 'blocked', activity: { text: 'Acknowledged old work' },
  }));
  assert.equal(stale.error.code, 'DESCRIPTION_UPDATED');
  assert.equal(stale.result.activity.status, 'saved');
  assert.equal(f.store.task(task.task_id).status, 'in_progress');
  assert.equal(f.subscriptions(task)[0].state, 'waiting');
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.reads, []);
  const staleContext = f.reportRequest(task, { revision: 2, status: 'blocked' });
  await f.service.execute('task_ack', f.reportRequest(task, {}));
  await f.service.execute('task_report', f.reportRequest(task, { status: 'in_review' }));
  assert.equal((await f.service.execute('task_report', staleContext)).error.code, 'TASK_STATE_CONFLICT');
  assert.deepEqual(f.sent, []);
});

test('cancellation triggers only subscribed Tasks; unmatched terminal targets expire and reject registration', async t => {
  const f = fixture(t);
  const task = f.create();
  f.subscribe(task, ['cancelled']);
  const result = await f.service.execute('task_cancel', f.request(task, { reason: 'stop' }));
  assert.equal(result.result.task_status, 'cancelled');
  assert.equal(result.notifications[0].event.status, 'cancelled');
  assert.equal(f.subscriptions(task)[0].notification.status, 'accepted');
  assert.throws(() => f.subscribe(task, ['cancelled']), code('ALREADY_IN_TARGET_STATUS'));
  assert.throws(() => f.subscribe(task, ['done']), code('TASK_STATE_CONFLICT'));
  const unmatched = f.executable();
  f.subscribe(unmatched, ['blocked']);
  await f.service.execute('task_report', f.reportRequest(unmatched, { status: 'done', outcome: { summary: 'Complete' }, retro: null }));
  assert.equal(f.subscriptions(unmatched)[0].state, 'expired');
  const ordinary = f.create();
  await f.service.execute('task_cancel', f.request(ordinary, { reason: 'ordinary' }));
  assert.equal(f.sent.length, 1);
  assert.equal(f.reads.length, 1);
});

test('unsubscription races serialize: cancelling wins before transition or fails after consumption', async t => {
  const f = fixture(t), task = f.create();
  const sub = f.subscribe(task, ['cancelled']).subscription;
  const cancel = { actor_session_id: 'actor', request_id: randomUUID(), task_id: task.task_id, subscription_id: sub.subscription_id };
  await f.service.execute('task_unsubscribe', cancel);
  await f.service.execute('task_cancel', f.request(task, { reason: 'done waiting' }));
  assert.equal(f.sent.length, 0);
  const next = f.create();
  const triggered = f.subscribe(next, ['cancelled']).subscription;
  f.store.executeLocal('task_cancel', f.request(next, { reason: 'transition wins' }));
  assert.throws(() => f.store.executeLocal('task_unsubscribe', { ...cancel, request_id: randomUUID(), task_id: next.task_id, subscription_id: triggered.subscription_id }), code('SUBSCRIPTION_NOT_WAITING'));
  await f.service.recoverNotifications();
  assert.equal(f.sent.length, 1);
});

test('queued, rejected and unknown host results remain inspectable across restart without resending', async t => {
  for (const [send, status, error] of [
    [async () => ({ ok: true, queued: true }), 'queued', null],
    [async () => ({ ok: false, error: { message: 'Rejected without confirmed acceptance' } }), 'unknown', 'NOTIFICATION_UNCONFIRMED'],
    [async () => ({ queued: true }), 'unknown', 'NOTIFICATION_UNCONFIRMED'],
    [async () => { throw new Error('Response lost'); }, 'unknown', 'NOTIFICATION_UNCONFIRMED'],
  ]) {
    let attempts = 0;
    const f = fixture(t, { send: async (...args) => { attempts++; return send(...args); } }), task = f.create();
    f.subscribe(task, ['cancelled']);
    const input = f.request(task, { reason: 'stop' });
    const result = await f.service.execute('task_cancel', input);
    assert.equal(result.error, null, 'delivery failures do not erase saved Task effects');
    assert.equal(result.result.task_status, 'cancelled');
    assert.equal(result.notification_error?.code ?? null, error);
    assert.equal(result.notifications[0].notification.status, status);
    f.restart();
    await f.service.recoverNotifications();
    const replay = await f.service.execute('task_cancel', input);
    assert.deepEqual(replay, result);
    assert.equal(f.subscriptions(task)[0].notification.status, status);
    assert.equal(attempts, 1);
  }
});

test('missing Owner or failed passive lookup is explicitly known unsent; no session is created', async t => {
  for (const ownerExists of [async () => false, async () => { throw new Error('read failed'); }]) {
    const f = fixture(t, { ownerExists }), task = f.create();
    f.subscribe(task, ['cancelled']);
    const result = await f.service.execute('task_cancel', f.request(task, { reason: 'stop' }));
    assert.equal(result.result.task_status, 'cancelled');
    assert.equal(result.notifications[0].notification.status, 'not_sent');
    assert.ok(result.notification_error);
    assert.deepEqual(f.sent, []);
    f.restart();
    await f.service.recoverNotifications();
    assert.deepEqual(f.sent, []);
  }
});

test('crash gaps: pending is recovered, claimed uncertainty is never resent, event commit rolls back atomically', async t => {
  const f = fixture(t), pending = f.create(), claimed = f.create();
  const p = f.subscribe(pending, ['cancelled']).subscription;
  const c = f.subscribe(claimed, ['cancelled']).subscription;
  f.store.executeLocal('task_cancel', f.request(pending, { reason: 'pending gap' }));
  f.store.executeLocal('task_cancel', f.request(claimed, { reason: 'claimed gap' }));
  assert.equal(f.store.claimNotification(c.subscription_id).notification.status, 'unknown');
  f.restart();
  await f.service.recoverNotifications();
  assert.equal(f.store.getSubscription(p.subscription_id).notification.status, 'accepted');
  assert.equal(f.store.getSubscription(c.subscription_id).notification.status, 'unknown');
  assert.equal(f.sent.length, 1);
  const rollback = f.create();
  f.subscribe(rollback, ['cancelled']);
  f.store.db.exec(`CREATE TRIGGER fail_subscription BEFORE UPDATE ON subscriptions
    WHEN NEW.state='triggered' BEGIN SELECT RAISE(ABORT,'synthetic commit failure'); END`);
  const result = await f.service.execute('task_cancel', f.request(rollback, { reason: 'rollback' }));
  assert.equal(result.error.code, 'OPERATION_UNCONFIRMED');
  assert.equal(f.store.task(rollback.task_id).status, 'todo');
  assert.equal(f.subscriptions(rollback)[0].state, 'waiting');
  assert.equal(f.sent.length, 1);
});

test('concurrent requests and independent stores claim one external attempt before send', async t => {
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { finish = resolve; });
  let attempts = 0;
  const f = fixture(t, { send: async () => { attempts++; entered(); return waiting; } });
  const task = f.create();
  const sub = f.subscribe(task, ['cancelled']).subscription;
  const input = f.request(task, { reason: 'stop' });
  const first = f.service.execute('task_cancel', input);
  await started;
  const secondStore = new TaskStore(f.root);
  const second = new TaskService(secondStore, f.host);
  try {
    assert.equal(secondStore.getSubscription(sub.subscription_id).notification.status, 'unknown');
    assert.equal(secondStore.claimNotification(sub.subscription_id), null);
    const replay = await second.execute('task_cancel', input);
    assert.equal(replay.notifications[0].notification.status, 'unknown');
    await second.recoverNotifications();
    finish({ ok: true });
    assert.equal((await first).notifications[0].notification.status, 'accepted');
    assert.equal(attempts, 1);
  } finally { finish({ ok: true }); await first; second.close(); }
});

test('competing status reports fire once and an armed subscription survives restart', async t => {
  const f = fixture(t), task = f.executable();
  f.subscribe(task, ['in_progress']);
  f.restart();
  const first = f.reportRequest(task, { status: 'in_progress' });
  const competing = f.reportRequest(task, { status: 'in_progress' });
  const results = await Promise.all([
    f.service.execute('task_report', first), f.service.execute('task_report', competing),
  ]);
  assert.equal(results[0].error, null);
  assert.equal(results[1].error.code, 'TASK_STATE_CONFLICT');
  assert.equal(f.sent.length, 1);
  assert.equal(f.subscriptions(task)[0].event.request_id, first.request_id);
});

test('close drains in-flight delivery and preserves successful receipt while rejecting new requests', async t => {
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { finish = resolve; });
  const f = fixture(t, { send: async () => { entered(); return waiting; } });
  const task = f.create();
  const sub = f.subscribe(task, ['cancelled']).subscription;
  f.store.executeLocal('task_cancel', f.request(task, { reason: 'pending recovery' }));
  const recovery = f.service.recoverNotifications();
  await started;
  f.service.close();
  assert.equal((await f.service.execute('task_read', { view: 'list' })).error.code, 'MODULE_CLOSING');
  finish({ ok: true, queued: true });
  await recovery;
  assert.equal(f.service.closed, true);
  const reopened = new TaskStore(f.root);
  try { assert.equal(reopened.getSubscription(sub.subscription_id).notification.status, 'queued'); }
  finally { reopened.close(); }
});

test('storage failure after host acceptance remains unknown durably and cannot resend', async t => {
  const f = fixture(t), task = f.create();
  f.subscribe(task, ['cancelled']);
  f.store.finishNotification = () => { throw new Error('Synthetic disk failure'); };
  const input = f.request(task, { reason: 'stop' });
  const first = await f.service.execute('task_cancel', input);
  assert.equal(first.result.task_status, 'cancelled');
  assert.equal(first.notification_error.code, 'NOTIFICATION_STORAGE_UNCONFIRMED');
  assert.equal(f.sent.length, 1);
  f.restart();
  assert.equal(f.subscriptions(task)[0].notification.status, 'unknown');
  await f.service.recoverNotifications();
  await f.service.execute('task_cancel', input);
  assert.equal(f.sent.length, 1);
});

test('schema 1 upgrade preserves Task rows and receipts while fencing old binaries with version 6', t => {
  const f = fixture(t), task = f.executable();
  const before = f.store.task(task.task_id);
  const receipts = f.store.db.prepare('SELECT * FROM operations ORDER BY request_id').all();
  f.service.close();
  const old = new DatabaseSync(join(f.root, 'task-board.sqlite'));
  old.exec(`
    DROP TABLE subscriptions; DROP TABLE automation_runs; DROP TABLE scripts;
    ALTER TABLE tasks DROP COLUMN kind; ALTER TABLE outcomes DROP COLUMN run_id;
    PRAGMA user_version=1;
  `);
  old.close();
  const upgraded = new TaskStore(f.root);
  try {
    assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version, 6);
    assert.deepEqual(upgraded.task(task.task_id), before);
    assert.deepEqual(upgraded.db.prepare('SELECT * FROM operations ORDER BY request_id').all(), receipts);
    assert.deepEqual(upgraded.read({ view: 'subscriptions', task_id: task.task_id }).items, []);
  } finally { upgraded.close(); }
});

test('subscription histories are bounded and scoped, including after terminal transitions', t => {
  const f = fixture(t), task = f.create();
  for (let i = 0; i < 13; i++) {
    const subscription = f.subscribe(task).subscription;
    f.store.executeLocal('task_unsubscribe', {
      actor_session_id: 'actor', request_id: randomUUID(), task_id: task.task_id, subscription_id: subscription.subscription_id,
    });
  }
  f.store.executeLocal('task_cancel', f.request(task, { reason: 'stop' }));
  const page = f.store.read({ view: 'subscriptions', task_id: task.task_id, limit: 10 });
  assert.equal(page.items.length, 10);
  assert.ok(JSON.stringify(page).length < 24000);
  assert.equal(f.store.read({ view: 'subscriptions', task_id: task.task_id, limit: 10, cursor: page.next_cursor }).items.length, 3);
  assert.throws(() => f.store.read({ view: 'subscriptions', task_id: f.create().task_id, cursor: page.next_cursor }), code('INVALID_CURSOR'));
  assert.throws(() => f.store.read({ view: 'activity', task_id: task.task_id, cursor: page.next_cursor }), code('INVALID_CURSOR'));
});

test('service-ready hook recovers without inbound traffic; activation and ordinary reads do not initiate recovery', async t => {
  const f = fixture(t), task = f.create();
  f.subscribe(task, ['cancelled']);
  f.store.executeLocal('task_cancel', f.request(task, { reason: 'crash gap' }));
  f.service.close();
  const calls = [];
  const module = activate({
    apiVersion: 1, serviceReadyVersion: 1, moduleId: 'cockpit-task', dataRoot: f.root, signal: new AbortController().signal,
    invalidate() {}, report: error => f.errors.push(error),
    host: { async call(name, body) {
      calls.push({ name, body });
      if (name === 'session/get') return { meta: { sessionId: body.sessionId, loaded: true, status: 'running' } };
      if (name === 'prompt') return { ok: true, queued: true };
      assert.fail(`Unexpected ${name}`);
    } },
  });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [], 'Activation cannot inspect or send before the service-ready hook');
    assert.equal(module.controlEvents, undefined);
    const read = await module.routes.find(route => route.path === '/read').handler({
      signal: new AbortController().signal, body: { view: 'subscriptions', task_id: task.task_id },
    });
    assert.equal(read.body.result.items[0].notification.status, 'pending');
    assert.deepEqual(calls, [], 'Read handlers never replace service-ready recovery');
    await Promise.all([module.onReady(), module.onReady()]);
    assert.deepEqual(calls.map(call => call.name), ['session/get', 'prompt']);
    assert.deepEqual(calls.at(-1).body, {
      sessionId: 'task-owner', text: `[Task status updated](task:${task.task_id}?event=status_changed)`, mode: 'enqueue',
    });
    await module.onReady();
    assert.equal(calls.length, 2);
    assert.deepEqual(f.errors, []);
  } finally { module.dispose(); }
});

test('service-ready recovery honors host shutdown or module disposal during Owner lookup', async t => {
  for (const shutdown of ['host', 'dispose']) {
    const f = fixture(t), task = f.create();
    f.subscribe(task, ['cancelled']);
    f.store.executeLocal('task_cancel', f.request(task, { reason: 'pending gap' }));
    f.service.close();
    const controller = new AbortController();
    let finishLookup;
    const lookup = new Promise(resolve => { finishLookup = resolve; });
    const calls = [];
    const module = activate({
      apiVersion: 1, serviceReadyVersion: 1, moduleId: 'cockpit-task', dataRoot: f.root, signal: controller.signal,
      invalidate() {}, report: error => f.errors.push(error),
      host: { async call(name) {
        calls.push(name);
        assert.equal(name, 'session/get', 'Shutdown must prevent notification sends');
        return lookup;
      } },
    });
    try {
      const recovery = module.onReady();
      assert.deepEqual(calls, ['session/get']);
      if (shutdown === 'host') controller.abort();
      else module.dispose();
      finishLookup({ meta: { sessionId: 'task-owner', loaded: true, status: 'idle' } });
      await recovery;
      await module.onReady();
      assert.deepEqual(calls, ['session/get']);
      const reopened = new TaskStore(f.root);
      try { assert.equal(reopened.read({ view: 'subscriptions', task_id: task.task_id }).items[0].notification.status, 'pending'); }
      finally { reopened.close(); }
      assert.deepEqual(f.errors, []);
    } finally { finishLookup({ meta: null }); module.dispose(); }
  }
});

test('pending recovery drains bounded batches and stops at its captured high-water mark', async t => {
  const f = fixture(t);
  for (let i = 0; i < 23; i++) {
    const task = f.create();
    f.subscribe(task, ['cancelled']);
    f.store.executeLocal('task_cancel', f.request(task, { reason: 'pending' }));
  }
  const sizes = [];
  const original = f.store.pendingNotifications.bind(f.store);
  f.store.pendingNotifications = (...args) => {
    const batch = original(...args);
    sizes.push(batch.length);
    return batch;
  };
  let later;
  f.host.send = async (owner, text) => {
    f.sent.push({ owner, text });
    if (!later) {
      later = f.create();
      f.subscribe(later, ['cancelled']);
      f.store.executeLocal('task_cancel', f.request(later, { reason: 'after high-water mark' }));
    }
    return { ok: true };
  };
  await f.service.recoverNotifications();
  assert.deepEqual(sizes, [20, 3, 0]);
  assert.equal(f.sent.length, 23);
  assert.equal(f.subscriptions(later)[0].notification.status, 'pending');
  await f.service.recoverNotifications();
  assert.equal(f.sent.length, 24);
});

test('abort during passive Owner lookup preserves pending known-unsent evidence for explicit replay', async t => {
  const controller = new AbortController();
  const f = fixture(t, { ownerExists: async () => { controller.abort(); return true; } });
  const task = f.create();
  f.subscribe(task, ['cancelled']);
  const input = f.request(task, { reason: 'saved before abort' });
  const first = await f.service.execute('task_cancel', input, { signal: controller.signal });
  assert.equal(first.error, null);
  assert.equal(first.result.task_status, 'cancelled');
  assert.equal(first.notification_error.code, 'NOTIFICATION_PENDING');
  assert.equal(first.notifications[0].notification.status, 'pending');
  assert.deepEqual(f.sent, []);
  f.host.ownerExists = async () => true;
  const replay = await f.service.execute('task_cancel', input);
  assert.deepEqual(replay.result, first.result);
  assert.equal(replay.notifications[0].notification.status, 'accepted');
  assert.equal(f.sent.length, 1);
});

test('failure to persist uncertainty prevents crossing the send boundary', async t => {
  const f = fixture(t), task = f.create();
  f.subscribe(task, ['cancelled']);
  f.store.claimNotification = () => { throw new Error('Synthetic disk failure before claim'); };
  const result = await f.service.execute('task_cancel', f.request(task, { reason: 'saved status' }));
  assert.equal(result.result.task_status, 'cancelled');
  assert.equal(result.notification_error.code, 'NOTIFICATION_STORAGE_UNCONFIRMED');
  assert.equal(f.subscriptions(task)[0].notification.status, 'pending');
  assert.deepEqual(f.sent, []);
  f.restart();
  await f.service.recoverNotifications();
  assert.equal(f.sent.length, 1);
});

test('HTTP exposes notification failure separately from persisted cancellation and never requires Owner idle', async t => {
  const f = fixture(t), task = f.create();
  f.subscribe(task, ['cancelled']);
  f.service.close();
  const calls = [];
  const controller = new AbortController();
  const module = activate({
    apiVersion: 1, serviceReadyVersion: 1, moduleId: 'cockpit-task', dataRoot: f.root, signal: controller.signal,
    invalidate() {}, report: error => f.errors.push(error),
    host: { async call(name, body) {
      calls.push({ name, body });
      if (name === 'session/get') return { meta: { sessionId: body.sessionId, loaded: true, status: 'running' } };
      if (name === 'prompt') throw new Error('Synthetic acceptance response lost');
      assert.fail(`Unexpected host call ${name}`);
    } },
  });
  try {
    const response = await module.routes.find(route => route.path === '/tools/:name').handler({
      params: { name: 'task_cancel' }, signal: controller.signal,
      body: { actor_session_id: 'actor', request_id: randomUUID(), task_id: task.task_id, write_context: task.write_context, reason: 'stop' },
    });
    assert.equal(response.status, 502);
    assert.equal(response.body.error, null);
    assert.equal(response.body.result.task_status, 'cancelled');
    assert.equal(response.body.notification_error.code, 'NOTIFICATION_UNCONFIRMED');
    assert.equal(response.body.notifications[0].notification.status, 'unknown');
    assert.deepEqual(calls.map(call => call.name), ['session/get', 'prompt']);
    assert.deepEqual(calls[1].body, {
      sessionId: 'task-owner', text: `[Task status updated](task:${task.task_id}?event=status_changed)`, mode: 'enqueue',
    });
  } finally { module.dispose(); }
});
