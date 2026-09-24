import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TaskStore } from '../src/task-board/store.js';
import { TaskService } from '../src/task-board/service.js';
import { LIMITS } from '../src/task-board/contracts.js';

function fixture(t) {
  const root = join(process.cwd(), '.task-board-tests', randomUUID());
  mkdirSync(root, { recursive: true });
  let store = new TaskStore(root);
  const sent = [];
  const busy = new Set();
  const inspected = [];
  const host = {
    sessionExists: async () => true,
    send: async (session, text) => { sent.push({ session, text }); return { ok: true }; },
    inspect: async session => { inspected.push(session); return { ready: true, idle: !busy.has(session), node: true }; },
  };
  let service = new TaskService(store, host, { report: () => {} });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const as = (actor, name, input) => f.service.execute(name, { actor: actor, request_id: randomUUID(), ...input });
  const context = id => ({ task_id: id, write_context: f.store.task(id).write_context, revision: f.store.task(id).revision });
  const f = {
    root, sent, busy, inspected, as, context,
    get store() { return store; }, get service() { return service; },
    restart() {
      service.close();
      store = new TaskStore(root);
      service = new TaskService(store, host, { report: () => {} });
    },
    cards: session => sent.filter(entry => entry.session === session && !entry.text.includes('event=assigned')).map(entry => entry.text),
    childNotices: id => store.read({ view: 'child_notices', task_id: id }).items,
    create: (orchestrator, fields = {}) => as(orchestrator, 'task_create', { title: `Task by ${orchestrator}`, description: 'Synthetic requirements', ...fields }),
    assign: (orchestrator, id, assignee) => as(orchestrator, 'task_assign', { ...context(id), assignee }),
    async start(orchestrator, assignee, fields) {
      const created = await f.create(orchestrator, fields);
      assert.equal(created.error, null, JSON.stringify(created.error));
      const id = created.result.task_id;
      assert.equal((await as(orchestrator, 'task_assign', { ...context(id), assignee })).error, null);
      assert.equal((await as(assignee, 'task_ack', context(id))).error, null);
      return id;
    },
    report: (assignee, id, fields) => as(assignee, 'task_report', { ...context(id), ...fields }),
  };
  return f;
}

test('Tasks created by an Orchestrator executing its own Agent Task record it as parent, up to the level cap', async t => {
  const f = fixture(t);
  assert.equal(LIMITS.delegationDepth, 3);
  const root = await f.start('user-orchestrator', 'lead');
  assert.equal(f.store.task(root).parent_task_id, null);
  assert.equal(f.store.task(root).depth, 1);

  const child = await f.start('lead', 'worker');
  assert.equal(f.store.task(child).parent_task_id, root);
  assert.equal(f.store.task(child).depth, 2);
  assert.equal(f.store.task(child).orchestrator, 'lead', 'Child notices keep going to the direct parent Assignee as Orchestrator');

  const grandchild = await f.start('worker', 'specialist');
  assert.equal(f.store.task(grandchild).parent_task_id, child);
  assert.equal(f.store.task(grandchild).depth, 3);

  const rejected = await f.create('specialist');
  assert.equal(rejected.error.code, 'DELEGATION_DEPTH_EXCEEDED');
  assert.match(rejected.error.message, /limited to 3 levels/);
  assert.equal(f.store.read({ view: 'list', orchestrator: 'specialist', status: 'all' }).items.length, 0, 'A rejected child is not saved');

  const children = f.store.read({ view: 'list', parent_task_id: root.toUpperCase(), status: 'all' }).items;
  assert.deepEqual(children.map(task => task.task_id), [child]);
  assert.equal(children[0].depth, 2);
  const overview = f.store.read({ view: 'overview', task_id: grandchild, include: ['context'] });
  assert.equal(overview.parent_task_id, child);
  assert.equal(overview.depth, 3);
});

test('Orchestrators without an unfinished Agent assignment create top-level Tasks', async t => {
  const f = fixture(t);
  const earlier = await f.start('user-orchestrator', 'lead');
  const done = await f.report('lead', earlier, { status: 'done', outcome: { summary: 'Delivered' }, retro: null });
  assert.equal(done.error, null);
  const after = await f.create('lead');
  assert.equal(after.error, null);
  assert.equal(f.store.task(after.result.task_id).parent_task_id, null);
  assert.equal(f.store.task(after.result.task_id).depth, 1);

  const unassigned = await f.create('user-orchestrator');
  const other = await f.create('someone-else');
  assert.equal(f.store.task(unassigned.result.task_id).parent_task_id, null);
  assert.equal(f.store.task(other.result.task_id).parent_task_id, null);
});

test('a blocked parent still owns its children, and lineage survives the parent finishing', async t => {
  const f = fixture(t);
  const root = await f.start('user-orchestrator', 'lead');
  assert.equal((await f.report('lead', root, { status: 'blocked', activity: { text: 'Waiting for children' } })).error, null);
  const child = await f.create('lead');
  assert.equal(f.store.task(child.result.task_id).parent_task_id, root);
  assert.equal((await f.report('lead', root, { status: 'done', outcome: { summary: 'Integrated' }, retro: null })).error, null);
  assert.equal(f.store.task(child.result.task_id).parent_task_id, root);
});

test('schema keeps existing top-level Tasks without inventing lineage', t => {
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
  assert.equal(f.store.task(own.result.task_id).assignee, null);
  assert.equal(f.sent.length, 0, 'A rejected assignment sends nothing');

  const root = await f.start('user-orchestrator', 'lead');
  const child = await f.start('lead', 'worker');
  const grandchild = await f.create('worker');
  const id = grandchild.result.task_id;
  assert.equal(f.store.task(id).parent_task_id, child);
  for (const ancestor of ['lead', 'user-orchestrator']) {
    const rejected = await f.assign('worker', id, ancestor);
    assert.equal(rejected.error.code, 'DELEGATION_CYCLE', ancestor);
    assert.equal(f.store.task(id).assignee, null);
  }
  assert.equal((await f.assign('worker', id, 'worker')).error.code, 'SELF_ASSIGNMENT');
  assert.equal((await f.assign('worker', id, 'specialist')).error, null);
  assert.equal(f.store.task(root).assignee, 'lead');
});

test('role-confusion rejections are not masked by a busy target and save no receipt', async t => {
  const f = fixture(t);
  // A root node assigning to itself is always busy running that very call.
  f.busy.add('solo');
  const own = await f.create('solo');
  const self = await f.assign('solo', own.result.task_id, 'solo');
  assert.equal(self.error.code, 'SELF_ASSIGNMENT');
  assert.deepEqual(f.inspected, [], 'Rejected before inspecting the target');

  await f.start('user-orchestrator', 'lead');
  const child = await f.create('lead');
  f.busy.add('user-orchestrator');
  f.inspected.length = 0;
  const cycle = await f.assign('lead', child.result.task_id, 'user-orchestrator');
  assert.equal(cycle.error.code, 'DELEGATION_CYCLE');
  assert.deepEqual(f.inspected, []);
  assert.equal(f.store.task(child.result.task_id).assignee, null);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM operations WHERE tool='task_assign' AND json_extract(input,'$.assignee') IN ('solo','user-orchestrator')").get().n, 0,
    'Like TASK_NOT_READY, these rejections reserve no operation');
});

test('an executing node creates Subtasks as itself while other actors create their own roots', async t => {
  const f = fixture(t);
  await f.start('user-orchestrator', 'lead');
  const forOther = await f.as('lead', 'task_create', { title: 'Handoff', description: 'Synthetic' });
  assert.equal(forOther.error, null);
  assert.equal(f.store.task(forOther.result.task_id).orchestrator, 'lead');
  assert.notEqual(f.store.task(forOther.result.task_id).parent_task_id, null);
  const forLead = await f.as('someone-else', 'task_create', { title: 'Injected', description: 'Synthetic' });
  assert.equal(forLead.error, null);
  assert.equal(f.store.task(forLead.result.task_id).orchestrator, 'someone-else');
  assert.equal(f.store.task(forLead.result.task_id).parent_task_id, null);
  assert.equal(f.store.read({ view: 'list', orchestrator: 'someone-else', status: 'all' }).items.length, 1);
  assert.equal(f.store.read({ view: 'list', orchestrator: 'lead', status: 'all' }).items.length, 1);
  const idle = await f.as('user-orchestrator', 'task_create', { title: 'Root handoff', description: 'Synthetic' });
  assert.equal(idle.error, null, 'Actors without an unfinished assignment create their own roots');
});

test('reads given an actor report its per-Task role from Task facts', async t => {
  const f = fixture(t);
  const root = await f.start('user-orchestrator', 'lead');
  const child = await f.start('lead', 'worker');
  const role = (actor, id) => f.store.read({ view: 'overview', task_id: id, actor: actor }).actor_role;
  assert.equal(role('lead', root), 'assignee');
  assert.equal(role('lead', child), 'orchestrator');
  assert.equal(role('user-orchestrator', root), 'orchestrator');
  assert.equal(role('stranger', child), 'none');
  assert.equal(f.store.read({ view: 'execution', task_id: child, actor: 'worker' }).actor_role, 'assignee');
  assert.equal(f.store.read({ view: 'overview', task_id: child, include: ['context'], actor: 'lead' }).actor_role, 'orchestrator');
  const items = f.store.read({ view: 'list', assignee: 'lead', status: 'all', actor: 'lead' }).items;
  assert.deepEqual(items.map(item => item.actor_role), ['assignee']);
  assert.equal(Object.hasOwn(f.store.read({ view: 'overview', task_id: root }), 'actor_role'), false);
});

test('child done, blocked and cancelled transitions notify the parent Assignee once each', async t => {
  const f = fixture(t);
  const root = await f.start('user-orchestrator', 'lead');
  const child = await f.start('lead', 'worker');
  const blocked = await f.report('worker', child, { status: 'blocked', activity: { text: 'Need a decision' } });
  assert.equal(blocked.error, null);
  assert.equal(blocked.result.notice_ids.length, 1);
  assert.deepEqual(f.cards('lead'), [`[Subtask blocked](task:${child}?event=child_blocked)`]);
  assert.equal((await f.report('worker', child, { status: 'blocked', activity: { text: 'Still waiting' } })).result.notice_ids, undefined,
    'Staying blocked is not a new transition');
  assert.equal((await f.report('worker', child, { status: 'in_progress' })).error, null);
  assert.equal((await f.report('worker', child, { status: 'blocked' })).result.notice_ids.length, 1, 'Each real transition notifies again');
  const done = await f.report('worker', child, { status: 'done', outcome: { summary: 'Child delivered' }, retro: null });
  assert.equal(done.error, null);
  assert.deepEqual(f.cards('lead'), [
    `[Subtask blocked](task:${child}?event=child_blocked)`,
    `[Subtask blocked](task:${child}?event=child_blocked)`,
    `[Subtask done](task:${child}?event=child_done)`,
  ]);
  assert.equal(f.cards('user-orchestrator').length, 0, 'Only the direct Orchestrator is notified');
  const notices = f.childNotices(child);
  assert.deepEqual(notices.map(notice => notice.kind), ['child_done', 'child_blocked', 'child_blocked'], 'Newest first, like subscriptions');
  assert.ok(notices.every(notice => notice.orchestrator === 'lead' && notice.parent_task_id === root && notice.notification.status === 'accepted'));

  const other = await f.start('lead', 'helper');
  assert.equal((await f.as('lead', 'task_cancel', { task_id: other, write_context: f.store.task(other).write_context, reason: 'Not needed' })).error, null);
  assert.equal(f.cards('lead').at(-1), `[Subtask cancelled](task:${other}?event=child_cancelled)`);
  assert.equal(f.childNotices(other).length, 1);
  assert.equal(f.cards('user-orchestrator').length, 0, 'Top-level Tasks never produce child notices');
});

test('blocked_by between sibling Subtasks gates dispatch alongside child notices', async t => {
  const f = fixture(t);
  const root = await f.start('user-orchestrator', 'lead');
  const first = await f.start('lead', 'worker');
  const second = await f.create('lead', { blocked_by: [first] });
  assert.equal(second.error, null, JSON.stringify(second.error));
  const id = second.result.task_id;
  assert.equal(f.store.task(id).parent_task_id, root);
  assert.equal(f.store.task(id).ready, false);
  assert.equal((await f.assign('lead', id, 'helper')).error.code, 'TASK_NOT_READY');
  const onParent = await f.create('lead', { blocked_by: [root] });
  assert.equal(onParent.error.code, 'BLOCKER_ANCESTOR', 'A Subtask cannot be blocked by an ancestor');
  const editAncestor = await f.as('lead', 'task_edit', { ...f.context(id), reason: 'Try ancestor blocker', blocked_by: [root] });
  assert.equal(editAncestor.error.code, 'BLOCKER_ANCESTOR');

  assert.equal((await f.report('worker', first, { status: 'done', outcome: { summary: 'First part' }, retro: null })).error, null);
  assert.deepEqual(f.cards('lead').sort(), [
    `[Subtask done](task:${first}?event=child_done)`,
    `[Subtask ready](task:${id}?event=ready)`,
  ], 'The finished child and the now-ready sibling each yield one card to the parent Assignee');
  assert.equal(f.cards('user-orchestrator').length, 0);
  assert.equal((await f.assign('lead', id, 'helper')).error, null);
  assert.equal(f.store.task(id).assignee, 'helper');
});

test('child notices yield to a same-transition subscription and stop once the parent is finished', async t => {
  const f = fixture(t);
  const root = await f.start('user-orchestrator', 'lead');
  const child = await f.start('lead', 'worker');
  const subscribed = await f.as('lead', 'task_subscribe', { task_id: child, write_context: f.store.task(child).write_context, statuses: ['done'] });
  assert.equal(subscribed.error, null, JSON.stringify(subscribed.error));
  const done = await f.report('worker', child, { status: 'done', outcome: { summary: 'Delivered' }, retro: null });
  assert.equal(done.result.subscription_ids.length, 1);
  assert.equal(done.result.notice_ids, undefined);
  assert.deepEqual(f.cards('lead'), [`[Subscribed Task status changed](task:${child}?event=status_changed)`]);
  assert.equal(f.childNotices(child).length, 0);

  const late = await f.start('lead', 'helper');
  assert.equal((await f.report('lead', root, { status: 'done', outcome: { summary: 'Integrated' }, retro: null })).error, null);
  const before = f.sent.length;
  assert.equal((await f.report('helper', late, { status: 'done', outcome: { summary: 'Late' }, retro: null })).error, null);
  assert.equal(f.sent.length, before, 'A finished parent receives no child notice');
  assert.equal(f.childNotices(late).length, 0);
});

test('third-party Subtask subscriptions do not suppress child notices to the parent Assignee', async t => {
  const f = fixture(t);
  await f.start('user-orchestrator', 'lead');
  const doneChild = await f.start('lead', 'worker');
  const subscribed = await f.as('observer', 'task_subscribe', {
    task_id: doneChild, write_context: f.store.task(doneChild).write_context, statuses: ['done'],
  });
  assert.equal(subscribed.error, null, JSON.stringify(subscribed.error));
  const done = await f.report('worker', doneChild, { status: 'done', outcome: { summary: 'Delivered' }, retro: null });
  assert.equal(done.error, null, JSON.stringify(done.error));
  assert.deepEqual(done.result.subscription_ids, [subscribed.result.subscription.subscription_id]);
  assert.equal(done.result.notice_ids.length, 1);
  assert.deepEqual(f.cards('lead'), [`[Subtask done](task:${doneChild}?event=child_done)`]);
  assert.deepEqual(f.cards('observer'), [`[Subscribed Task status changed](task:${doneChild}?event=status_changed)`]);
  assert.equal(f.childNotices(doneChild).length, 1);

  const blockedChild = await f.start('lead', 'helper');
  const assigneeSub = await f.as('helper', 'task_subscribe', {
    task_id: blockedChild, write_context: f.store.task(blockedChild).write_context, statuses: ['blocked'],
  });
  assert.equal(assigneeSub.error, null, JSON.stringify(assigneeSub.error));
  const blocked = await f.report('helper', blockedChild, { status: 'blocked', activity: { text: 'Need input' } });
  assert.equal(blocked.error, null, JSON.stringify(blocked.error));
  assert.deepEqual(blocked.result.subscription_ids, [assigneeSub.result.subscription.subscription_id]);
  assert.equal(blocked.result.notice_ids.length, 1);
  assert.equal(f.cards('lead').at(-1), `[Subtask blocked](task:${blockedChild}?event=child_blocked)`);
  assert.deepEqual(f.cards('helper'), [`[Subscribed Task status changed](task:${blockedChild}?event=status_changed)`]);
  assert.equal(f.childNotices(blockedChild).length, 1);
});

test('a pending child notice survives restart and is recovered exactly once', async t => {
  const f = fixture(t);
  await f.start('user-orchestrator', 'lead');
  const child = await f.start('lead', 'worker');
  // Record the transition without the service so the notice stays pending, like a crash before delivery.
  f.store.executeLocal('task_report', { actor: 'worker', request_id: randomUUID(), ...f.context(child), status: 'done', outcome: { summary: 'Done' }, retro: null });
  assert.equal(f.childNotices(child)[0].notification.status, 'pending');
  f.restart();
  await f.service.recoverNotifications();
  await f.service.recoverNotifications();
  assert.deepEqual(f.cards('lead'), [`[Subtask done](task:${child}?event=child_done)`]);
  assert.equal(f.childNotices(child)[0].notification.status, 'accepted');
});
