import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../src/task-board/store.js';
import { TaskService } from '../src/task-board/service.js';
import { LIMITS } from '../src/task-board/contracts.js';

function fixture(t) {
  const root = join(process.cwd(), '.task-board-tests', randomUUID());
  mkdirSync(root, { recursive: true });
  let store = new TaskStore(root);
  const sent = [];
  const host = {
    ownerExists: async () => true,
    send: async (session, text) => { sent.push({ session, text }); return { ok: true }; },
    inspect: async () => ({ ready: true, idle: true, executor: true }),
  };
  let service = new TaskService(store, host, { report: () => {} });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const as = (actor, name, input) => f.service.execute(name, { actor_session_id: actor, request_id: randomUUID(), ...input });
  const context = id => ({ task_id: id, write_context: f.store.task(id).write_context, revision: f.store.task(id).revision });
  const f = {
    root, sent, as, context,
    get store() { return store; }, get service() { return service; },
    restart() {
      service.close();
      store = new TaskStore(root);
      service = new TaskService(store, host, { report: () => {} });
    },
    cards: session => sent.filter(entry => entry.session === session && entry.text.startsWith('[As Owner:')).map(entry => entry.text),
    childNotices: id => store.read({ view: 'child_notices', task_id: id }).items,
    create: (owner, fields = {}) => as(owner, 'task_create', { owner, title: `Task by ${owner}`, description: 'Synthetic requirements', ...fields }),
    assign: (owner, id, executor) => as(owner, 'task_assign', { ...context(id), executor }),
    async start(owner, executor, fields) {
      const created = await f.create(owner, fields);
      assert.equal(created.error, null, JSON.stringify(created.error));
      const id = created.result.task_id;
      assert.equal((await as(owner, 'task_assign', { ...context(id), executor })).error, null);
      assert.equal((await as(executor, 'task_ack', context(id))).error, null);
      return id;
    },
    report: (executor, id, fields) => as(executor, 'task_report', { ...context(id), ...fields }),
  };
  return f;
}

test('Tasks created by an Owner executing its own Agent Task record it as parent, up to the level cap', async t => {
  const f = fixture(t);
  assert.equal(LIMITS.delegationDepth, 3);
  const root = await f.start('user-owner', 'lead');
  assert.equal(f.store.task(root).parent_task_id, null);
  assert.equal(f.store.task(root).depth, 1);

  const child = await f.start('lead', 'worker');
  assert.equal(f.store.task(child).parent_task_id, root);
  assert.equal(f.store.task(child).depth, 2);
  assert.equal(f.store.task(child).owner, 'lead', 'Child notices keep going to the direct parent Executor as Owner');

  const grandchild = await f.start('worker', 'specialist');
  assert.equal(f.store.task(grandchild).parent_task_id, child);
  assert.equal(f.store.task(grandchild).depth, 3);

  const rejected = await f.create('specialist');
  assert.equal(rejected.error.code, 'DELEGATION_DEPTH_EXCEEDED');
  assert.match(rejected.error.message, /limited to 3 levels/);
  assert.equal(f.store.read({ view: 'list', owner: 'specialist', status: 'all' }).items.length, 0, 'A rejected child is not saved');

  const children = f.store.read({ view: 'list', parent_task_id: root.toUpperCase(), status: 'all' }).items;
  assert.deepEqual(children.map(task => task.task_id), [child]);
  assert.equal(children[0].depth, 2);
  const overview = f.store.read({ view: 'overview', task_id: grandchild, include: ['context'] });
  assert.equal(overview.parent_task_id, child);
  assert.equal(overview.depth, 3);
});

test('Owners without an unfinished Agent assignment create top-level Tasks', async t => {
  const f = fixture(t);
  const earlier = await f.start('user-owner', 'lead');
  const done = await f.report('lead', earlier, { status: 'done', outcome: { summary: 'Delivered' }, retro: null });
  assert.equal(done.error, null);
  const after = await f.create('lead');
  assert.equal(after.error, null);
  assert.equal(f.store.task(after.result.task_id).parent_task_id, null);
  assert.equal(f.store.task(after.result.task_id).depth, 1);

  const unassigned = await f.create('user-owner');
  const other = await f.create('someone-else');
  assert.equal(f.store.task(unassigned.result.task_id).parent_task_id, null);
  assert.equal(f.store.task(other.result.task_id).parent_task_id, null);
});

test('a blocked parent still owns its children, and lineage survives the parent finishing', async t => {
  const f = fixture(t);
  const root = await f.start('user-owner', 'lead');
  assert.equal((await f.report('lead', root, { status: 'blocked', activity: { text: 'Waiting for children' } })).error, null);
  const child = await f.create('lead');
  assert.equal(f.store.task(child.result.task_id).parent_task_id, root);
  assert.equal((await f.report('lead', root, { status: 'done', outcome: { summary: 'Integrated' }, retro: null })).error, null);
  assert.equal(f.store.task(child.result.task_id).parent_task_id, root);
});

test('schema v6 databases migrate forward to v7 as top-level Tasks without inventing lineage', t => {
  const root = join(process.cwd(), '.task-board-tests', randomUUID());
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let store = new TaskStore(root);
  const task = store.executeLocal('task_create', { actor_session_id: 'owner', request_id: 'legacy', owner: 'owner', title: 'Legacy', description: 'Existing' });
  const receipts = store.db.prepare('SELECT * FROM operations').all();
  store.db.exec('DROP TABLE child_notices; DROP INDEX tasks_parent; ALTER TABLE tasks DROP COLUMN parent_task_id; ALTER TABLE tasks DROP COLUMN depth; PRAGMA user_version=6');
  store.close();
  const legacy = new DatabaseSync(join(root, 'task-board.sqlite'));
  assert.equal(legacy.prepare('PRAGMA user_version').get().user_version, 6);
  legacy.close();
  store = new TaskStore(root);
  try {
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 7);
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.deepEqual(store.db.prepare('SELECT * FROM operations').all(), receipts);
    const migrated = store.task(task.task_id);
    assert.equal(migrated.parent_task_id, null);
    assert.equal(migrated.depth, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM child_notices").get().n, 0, 'v7 creates the child notice table');
  } finally { store.close(); }
});

test('assignment rejects self-assignment and delegation cycles without binding', async t => {
  const f = fixture(t);
  const own = await f.create('solo');
  const self = await f.assign('solo', own.result.task_id, 'solo');
  assert.equal(self.error.code, 'SELF_ASSIGNMENT');
  assert.equal(f.store.task(own.result.task_id).executor, null);
  assert.equal(f.sent.length, 0, 'A rejected assignment sends nothing');

  const root = await f.start('user-owner', 'lead');
  const child = await f.start('lead', 'worker');
  const grandchild = await f.create('worker');
  const id = grandchild.result.task_id;
  assert.equal(f.store.task(id).parent_task_id, child);
  for (const ancestor of ['lead', 'user-owner']) {
    const rejected = await f.assign('worker', id, ancestor);
    assert.equal(rejected.error.code, 'DELEGATION_CYCLE', ancestor);
    assert.equal(f.store.task(id).executor, null);
  }
  assert.equal((await f.assign('worker', id, 'worker')).error.code, 'SELF_ASSIGNMENT');
  assert.equal((await f.assign('worker', id, 'specialist')).error, null);
  assert.equal(f.store.task(root).executor, 'lead');
});

test('an executing node creates Tasks only as their Owner, and nobody creates Tasks for it', async t => {
  const f = fixture(t);
  await f.start('user-owner', 'lead');
  const forOther = await f.as('lead', 'task_create', { owner: 'someone-else', title: 'Handoff', description: 'Synthetic' });
  assert.equal(forOther.error.code, 'DELEGATION_OWNER_MISMATCH');
  const forLead = await f.as('someone-else', 'task_create', { owner: 'lead', title: 'Injected', description: 'Synthetic' });
  assert.equal(forLead.error.code, 'DELEGATION_OWNER_MISMATCH');
  assert.equal(f.store.read({ view: 'list', owner: 'someone-else', status: 'all' }).items.length, 0);
  assert.equal(f.store.read({ view: 'list', owner: 'lead', status: 'all' }).items.length, 0);
  const idle = await f.as('user-owner', 'task_create', { owner: 'another-root', title: 'Root handoff', description: 'Synthetic' });
  assert.equal(idle.error, null, 'Nodes without an unfinished assignment keep creating for other Owners');
});

test('reads given an actor report its per-Task role from Task facts', async t => {
  const f = fixture(t);
  const root = await f.start('user-owner', 'lead');
  const child = await f.start('lead', 'worker');
  const role = (actor, id) => f.store.read({ view: 'overview', task_id: id, actor_session_id: actor }).actor_role;
  assert.equal(role('lead', root), 'executor');
  assert.equal(role('lead', child), 'owner');
  assert.equal(role('user-owner', root), 'owner');
  assert.equal(role('stranger', child), 'none');
  assert.equal(f.store.read({ view: 'execution', task_id: child, actor_session_id: 'worker' }).actor_role, 'executor');
  assert.equal(f.store.read({ view: 'overview', task_id: child, include: ['context'], actor_session_id: 'lead' }).actor_role, 'owner');
  const items = f.store.read({ view: 'list', executor: 'lead', status: 'all', actor_session_id: 'lead' }).items;
  assert.deepEqual(items.map(item => item.actor_role), ['executor']);
  assert.equal(Object.hasOwn(f.store.read({ view: 'overview', task_id: root }), 'actor_role'), false);
});

test('child done, blocked and cancelled transitions notify the parent Executor once each', async t => {
  const f = fixture(t);
  const root = await f.start('user-owner', 'lead');
  const child = await f.start('lead', 'worker');
  const blocked = await f.report('worker', child, { status: 'blocked', activity: { text: 'Need a decision' } });
  assert.equal(blocked.error, null);
  assert.equal(blocked.result.notice_ids.length, 1);
  assert.deepEqual(f.cards('lead'), [`[As Owner: child Task blocked](task:${child}?event=child_blocked)`]);
  assert.equal((await f.report('worker', child, { status: 'blocked', activity: { text: 'Still waiting' } })).result.notice_ids, undefined,
    'Staying blocked is not a new transition');
  assert.equal((await f.report('worker', child, { status: 'in_progress' })).error, null);
  assert.equal((await f.report('worker', child, { status: 'blocked' })).result.notice_ids.length, 1, 'Each real transition notifies again');
  const done = await f.report('worker', child, { status: 'done', outcome: { summary: 'Child delivered' }, retro: null });
  assert.equal(done.error, null);
  assert.deepEqual(f.cards('lead'), [
    `[As Owner: child Task blocked](task:${child}?event=child_blocked)`,
    `[As Owner: child Task blocked](task:${child}?event=child_blocked)`,
    `[As Owner: child Task done](task:${child}?event=child_done)`,
  ]);
  assert.equal(f.cards('user-owner').length, 0, 'Only the direct Owner is notified');
  const notices = f.childNotices(child);
  assert.deepEqual(notices.map(notice => notice.kind), ['child_done', 'child_blocked', 'child_blocked'], 'Newest first, like subscriptions');
  assert.ok(notices.every(notice => notice.owner === 'lead' && notice.parent_task_id === root && notice.notification.status === 'accepted'));

  const other = await f.start('lead', 'helper');
  assert.equal((await f.as('lead', 'task_cancel', { task_id: other, write_context: f.store.task(other).write_context, reason: 'Not needed' })).error, null);
  assert.equal(f.cards('lead').at(-1), `[As Owner: child Task cancelled](task:${other}?event=child_cancelled)`);
  assert.equal(f.childNotices(other).length, 1);
  assert.equal(f.cards('user-owner').length, 0, 'Top-level Tasks never produce child notices');
});

test('child notices yield to a same-transition subscription and stop once the parent is finished', async t => {
  const f = fixture(t);
  const root = await f.start('user-owner', 'lead');
  const child = await f.start('lead', 'worker');
  const subscribed = await f.as('lead', 'task_subscribe', { task_id: child, write_context: f.store.task(child).write_context, statuses: ['done'] });
  assert.equal(subscribed.error, null, JSON.stringify(subscribed.error));
  const done = await f.report('worker', child, { status: 'done', outcome: { summary: 'Delivered' }, retro: null });
  assert.equal(done.result.subscription_ids.length, 1);
  assert.equal(done.result.notice_ids, undefined);
  assert.deepEqual(f.cards('lead'), [`[As Owner: Task status updated](task:${child}?event=status_changed)`]);
  assert.equal(f.childNotices(child).length, 0);

  const late = await f.start('lead', 'helper');
  assert.equal((await f.report('lead', root, { status: 'done', outcome: { summary: 'Integrated' }, retro: null })).error, null);
  const before = f.sent.length;
  assert.equal((await f.report('helper', late, { status: 'done', outcome: { summary: 'Late' }, retro: null })).error, null);
  assert.equal(f.sent.length, before, 'A finished parent receives no child notice');
  assert.equal(f.childNotices(late).length, 0);
});

test('a pending child notice survives restart and is recovered exactly once', async t => {
  const f = fixture(t);
  await f.start('user-owner', 'lead');
  const child = await f.start('lead', 'worker');
  // Record the transition without the service so the notice stays pending, like a crash before delivery.
  f.store.executeLocal('task_report', { actor_session_id: 'worker', request_id: randomUUID(), ...f.context(child), status: 'done', outcome: { summary: 'Done' }, retro: null });
  assert.equal(f.childNotices(child)[0].notification.status, 'pending');
  f.restart();
  await f.service.recoverNotifications();
  await f.service.recoverNotifications();
  assert.deepEqual(f.cards('lead'), [`[As Owner: child Task done](task:${child}?event=child_done)`]);
  assert.equal(f.childNotices(child)[0].notification.status, 'accepted');
});
