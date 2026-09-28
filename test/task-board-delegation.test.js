import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TaskStore } from '../src/task-board/store.js';
import { TaskService } from '../src/task-board/service.js';

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
    async start(orchestrator, assignee, fields, work_mode) {
      const created = await f.create(orchestrator, fields);
      assert.equal(created.error, null, JSON.stringify(created.error));
      const id = created.result.task_id;
      const assignment = store.task(id).parent_task_id
        ? await as(orchestrator, 'task_assign', { ...context(id), assignee })
        : await as(assignee, 'task_claim', context(id));
      assert.equal(assignment.error, null, JSON.stringify(assignment.error));
      assert.equal((await as(assignee, 'task_ack', context(id))).error, null);
      assert.equal((await as(assignee, 'task_start', {
        ...context(id), work_mode: work_mode ?? (store.task(id).parent_task_id ? 'execute' : 'orchestrate'),
      })).error, null);
      return id;
    },
    report: (assignee, id, fields) => as(assignee, 'task_report', { ...context(id), ...fields }),
  };
  return f;
}

test('Tasks created by active orchestrating assignees preserve recursive lineage beyond three levels', async t => {
  const f = fixture(t);
  const root = await f.start('user-orchestrator', 'lead');
  assert.equal(f.store.task(root).parent_task_id, null);
  assert.equal(f.store.task(root).depth, 1);

  const child = await f.start('lead', 'worker', {}, 'orchestrate');
  assert.equal(f.store.task(child).parent_task_id, root);
  assert.equal(f.store.task(child).depth, 2);
  assert.equal(f.store.task(child).parent_assignee, 'lead', 'Responsibility derives from the direct parent binding');

  const grandchild = await f.start('worker', 'specialist', {}, 'orchestrate');
  assert.equal(f.store.task(grandchild).parent_task_id, child);
  assert.equal(f.store.task(grandchild).depth, 3);

  const fourth = await f.start('specialist', 'fourth-worker', {}, 'execute');
  assert.equal(f.store.task(fourth).depth, 4);
  assert.equal(f.store.task(fourth).parent_task_id, grandchild);
  const rejected = await f.create('fourth-worker');
  assert.equal(rejected.error.code, 'PARENT_NOT_ORCHESTRATING');
  assert.equal(f.store.read({ view: 'list', parent_assignee: 'fourth-worker', status: 'all' }).items.length, 0);

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

test('an in-progress parent still owns its children, and lineage survives the parent finishing', async t => {
  const f = fixture(t);
  const root = await f.start('user-orchestrator', 'lead');
  assert.equal((await f.report('lead', root, { status: 'in_progress', activity: { text: 'Waiting for children' } })).error, null);
  const child = await f.create('lead');
  assert.equal(f.store.task(child.result.task_id).parent_task_id, root);
  assert.equal((await f.report('lead', root, { status: 'done', outcome: { summary: 'Too early' }, retro: null })).error.code, 'CHILDREN_NOT_TERMINAL');
  const id = child.result.task_id;
  assert.equal((await f.assign('lead', id, 'worker')).error, null);
  assert.equal((await f.as('worker', 'task_ack', f.context(id))).error, null);
  assert.equal((await f.as('worker', 'task_start', { ...f.context(id), work_mode: 'execute' })).error, null);
  assert.equal((await f.report('worker', id, { status: 'done', outcome: { summary: 'Child delivered' }, retro: null })).error, null);
  assert.equal(f.store.task(root).children.nonterminal, 0);
  assert.equal(f.store.task(root).work_mode, 'orchestrate', 'Finishing children never silently changes work mode');
  assert.equal((await f.as('lead', 'task_start', { ...f.context(root), work_mode: 'execute' })).error.code, 'TASK_STATE_CONFLICT');
  assert.equal(f.store.task(root).work_mode, 'orchestrate');
  assert.equal((await f.report('lead', root, { status: 'done', outcome: { summary: 'Integrated' }, retro: null })).error, null);
  assert.equal(f.store.task(child.result.task_id).parent_task_id, root);
});

test('parent cancellation waits for children and cleanup finalization ignores abandoned execution prerequisites', async t => {
  const f = fixture(t);
  const root = await f.start('creator', 'lead');
  const child = await f.start('lead', 'worker');
  const completedChild = await f.start('lead', 'finisher');
  const cancel = (actor, id) => f.as(actor, 'task_cancel', {
    task_id: id, write_context: f.store.task(id).write_context, reason: 'User abandoned the original goal',
  });
  const finalize = (actor, id) => f.as(actor, 'task_cancel_finalize', {
    ...f.context(id), summary: 'Stopped; effects reviewed and residual resources cleaned up',
  });
  assert.equal((await f.report('lead', root, { status: 'done', outcome: { summary: 'Premature integration' }, retro: null })).error.code, 'CHILDREN_NOT_TERMINAL');
  assert.equal((await cancel('user', root)).error, null);
  assert.equal(f.store.task(root).status, 'in_progress');
  assert.equal(f.store.task(child).status, 'in_progress', 'Intent does not cascade cancellation or imply child completion');
  assert.equal((await finalize('lead', root)).error.code, 'CHILDREN_NOT_TERMINAL');
  assert.equal((await f.create('lead')).error.code, 'CANCELLATION_REQUESTED');
  assert.equal((await f.report('finisher', completedChild, {
    status: 'done', outcome: { summary: 'Preserve the already completed child result during parent shutdown' }, retro: null,
  })).error, null, 'Parent cancellation permits a truthful child completion without cancelling that child implicitly');
  assert.equal(f.store.task(completedChild).status, 'done');
  assert.equal((await finalize('lead', root)).error.code, 'CHILDREN_NOT_TERMINAL', 'The other child still needs closure');
  assert.equal((await cancel('lead', child)).error, null, 'The cancelling parent can arrange child cleanup');
  assert.equal((await f.report('worker', child, { status: 'done', outcome: { summary: 'Abandoned child goal' }, retro: null })).error.code, 'CANCELLATION_REQUESTED');
  for (const [actor, id] of [['lead', root], ['worker', child]]) {
    assert.equal((await f.as(actor, 'task_edit', {
      ...f.context(id), reason: 'The former success criterion remains unmet',
      blocked_by: [{ condition: 'Original delivery is impossible after cancellation' }],
    })).error, null);
    assert.equal((await f.report(actor, id, { activity: { text: 'Cleanup is proceeding without claiming the abandoned result' } })).error, null);
    assert.equal(f.store.task(id).ready, false);
  }
  assert.equal((await finalize('worker', child)).error, null, 'A cancelling ancestor does not obstruct child cleanup closure');
  assert.equal(f.store.task(child).status, 'cancelled');
  assert.equal(f.store.task(child).ready, false, 'Finalization records disposition, not prerequisite satisfaction');
  assert.equal(f.store.task(root).children.nonterminal, 0);
  assert.equal((await finalize('lead', root)).error, null);
  assert.equal(f.store.task(root).status, 'cancelled');
  assert.equal(f.store.task(root).ready, false);
  assert.equal(f.store.read({ view: 'outcomes', task_id: root }).items.length, 0);
});

test('subtree attachment preserves bindings and recorded work while rejecting new ancestry dependency cycles atomically', async t => {
  const f = fixture(t);
  const original = await f.start('registrar', 'owner');
  const branch = await f.start('owner', 'coordinator', {}, 'orchestrate');
  const leaf = await f.start('coordinator', 'implementer');
  const target = await f.start('other-registrar', 'broader-owner');
  assert.equal((await f.report('implementer', leaf, {
    activity: { text: 'Evidence collected before attachment' }, outcome: { summary: 'Partial result retained across attachment' },
  })).error, null);
  const taskIds = [original, branch, leaf];
  const unchangedFacts = id => {
    const task = f.store.task(id);
    return {
      task_id: task.task_id, created_by: task.created_by, assignee: task.assignee, status: task.status,
      revision: task.revision, acknowledged_revision: task.acknowledged_revision, work_mode: task.work_mode,
      description: task.description, references: task.references, metadata: task.metadata,
      definitions: f.store.read({ view: 'changelog', task_id: id }).items,
      activities: f.store.read({ view: 'activity', task_id: id }).items,
      outcomes: f.store.read({ view: 'outcomes', task_id: id }).items,
    };
  };
  const before = taskIds.map(unchangedFacts);
  const bindings = f.store.db.prepare('SELECT * FROM task_assignments ORDER BY seq').all();
  assert.equal((await f.as('implementer', 'task_edit', {
    ...f.context(leaf), reason: 'Prerequisite currently lies outside this subtree', blocked_by: [target],
  })).error, null);
  const attach = {
    ...f.context(original), parent_task_id: target, parent_write_context: f.context(target).write_context,
    reason: 'Authorized attachment of the existing responsibility, not replacement work',
  };
  const contexts = taskIds.map(id => f.context(id).write_context);
  const rejected = await f.as('broader-owner', 'task_attach', attach);
  assert.equal(rejected.error.code, 'BLOCKER_ANCESTOR');
  assert.equal(f.store.task(original).parent_task_id, null);
  assert.deepEqual(taskIds.map(id => f.context(id).write_context), contexts, 'Failed attachment changes no descendant context');
  assert.deepEqual(taskIds.map(id => f.store.task(id).depth), [1, 2, 3]);
  assert.equal((await f.as('coordinator', 'task_edit', {
    ...f.context(leaf), reason: 'Explicitly replan the external dependency before attachment', blocked_by: [],
  })).error, null);
  assert.equal((await f.as('coordinator', 'task_attach', {
    ...f.context(original), parent_task_id: branch, parent_write_context: f.context(branch).write_context,
    reason: 'A structural cycle must also be rejected',
  })).error.code, 'TREE_CYCLE');
  const priorContexts = taskIds.map(id => f.context(id).write_context);
  assert.equal((await f.as('broader-owner', 'task_attach', {
    ...f.context(original), parent_task_id: target, parent_write_context: f.context(target).write_context,
    reason: 'Attach the now-valid complete subtree',
  })).error, null);
  assert.deepEqual(taskIds.map(unchangedFacts), before);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM task_assignments ORDER BY seq').all(), bindings);
  assert.deepEqual(taskIds.map(id => f.store.task(id).depth), [2, 3, 4]);
  assert.deepEqual(taskIds.map(id => f.store.task(id).parent_task_id), [target, original, branch]);
  assert.equal(f.store.task(original).parent_assignee, 'broader-owner');
  assert.ok(taskIds.every((id, index) => f.context(id).write_context !== priorContexts[index]));
  assert.deepEqual(f.store.read({ view: 'ancestors', task_id: leaf }).items.map(item => item.task_id), [branch, original, target]);
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
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 12);
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
  assert.equal(self.error.code, 'PARENT_ASSIGNEE_REQUIRED', 'Creating a root grants no dispatch authority');
  assert.equal(f.store.task(own.result.task_id).assignee, null);
  assert.equal(f.sent.length, 0, 'A rejected assignment sends nothing');

  const root = await f.start('user-orchestrator', 'lead');
  const child = await f.start('lead', 'worker', {}, 'orchestrate');
  const grandchild = await f.create('worker');
  const id = grandchild.result.task_id;
  assert.equal(f.store.task(id).parent_task_id, child);
  for (const ancestor of ['lead']) {
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
  assert.equal(self.error.code, 'PARENT_ASSIGNEE_REQUIRED');
  assert.deepEqual(f.inspected, [], 'Rejected before inspecting the target');

  await f.start('user-orchestrator', 'lead');
  await f.start('lead', 'worker', {}, 'orchestrate');
  const child = await f.create('worker');
  f.busy.add('lead');
  f.inspected.length = 0;
  const cycle = await f.assign('worker', child.result.task_id, 'lead');
  assert.equal(cycle.error.code, 'DELEGATION_CYCLE');
  assert.deepEqual(f.inspected, []);
  assert.equal(f.store.task(child.result.task_id).assignee, null);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM operations WHERE tool='task_assign' AND json_extract(input,'$.assignee') IN ('solo','lead')").get().n, 0,
    'Like TASK_NOT_READY, these rejections reserve no operation');
});

test('an executing node creates Subtasks as itself while other actors create their own roots', async t => {
  const f = fixture(t);
  await f.start('user-orchestrator', 'lead');
  const forOther = await f.as('lead', 'task_create', { title: 'Handoff', description: 'Synthetic' });
  assert.equal(forOther.error, null);
  assert.equal(f.store.task(forOther.result.task_id).created_by, 'lead');
  assert.notEqual(f.store.task(forOther.result.task_id).parent_task_id, null);
  const forLead = await f.as('someone-else', 'task_create', { title: 'Injected', description: 'Synthetic' });
  assert.equal(forLead.error, null);
  assert.equal(f.store.task(forLead.result.task_id).created_by, 'someone-else');
  assert.equal(f.store.task(forLead.result.task_id).parent_task_id, null);
  assert.equal(f.store.read({ view: 'list', parent_assignee: 'someone-else', status: 'all' }).items.length, 0);
  assert.equal(f.store.read({ view: 'list', parent_assignee: 'lead', status: 'all' }).items.length, 1);
  const idle = await f.as('user-orchestrator', 'task_create', { title: 'Root handoff', description: 'Synthetic' });
  assert.equal(idle.error, null, 'Actors without an unfinished assignment create their own roots');
});

test('reads given an actor report its per-Task role from Task facts', async t => {
  const f = fixture(t);
  const root = await f.start('user-orchestrator', 'lead');
  const child = await f.start('lead', 'worker');
  const role = (actor, id) => f.store.read({ view: 'overview', task_id: id, actor: actor }).actor_role;
  assert.equal(role('lead', root), 'assignee');
  assert.equal(role('lead', child), 'parent_assignee');
  assert.equal(role('user-orchestrator', root), 'none');
  assert.equal(role('stranger', child), 'none');
  assert.equal(f.store.read({ view: 'execution', task_id: child, actor: 'worker' }).actor_role, 'assignee');
  assert.equal(f.store.read({ view: 'overview', task_id: child, include: ['context'], actor: 'lead' }).actor_role, 'parent_assignee');
  const items = f.store.read({ view: 'list', assignee: 'lead', status: 'all', actor: 'lead' }).items;
  assert.deepEqual(items.map(item => item.actor_role), ['assignee']);
  assert.equal(Object.hasOwn(f.store.read({ view: 'overview', task_id: root }), 'actor_role'), false);
});

test('a child condition escalates once while done and cancelled remain lifecycle notices', async t => {
  const f = fixture(t);
  const root = await f.start('user-orchestrator', 'lead');
  const child = await f.start('lead', 'worker');
  const condition = 'The user must choose the target before implementation can continue.';
  const blocked = await f.as('worker', 'task_edit', {
    task_id: child, write_context: f.store.task(child).write_context, revision: 1,
    reason: 'Record an unmet prerequisite', blocked_by: [{ condition }],
  });
  assert.equal(blocked.error, null);
  assert.equal(blocked.result.notice_ids.length, 1);
  assert.deepEqual(f.cards('lead'), [`[Task blocked](task:${child}?event=blocked)`]);
  assert.equal((await f.report('worker', child, { status: 'in_progress', activity: { text: 'Still waiting' } })).result.notice_ids, undefined);
  assert.equal((await f.as('lead', 'task_edit', {
    task_id: child, write_context: f.store.task(child).write_context, revision: 1,
    reason: 'The prerequisite was explicitly resolved', blocked_by: [],
  })).error, null);
  const done = await f.report('worker', child, { status: 'done', outcome: { summary: 'Child delivered' }, retro: null });
  assert.equal(done.error, null);
  assert.deepEqual(f.cards('lead'), [
    `[Task blocked](task:${child}?event=blocked)`,
    `[Subtask done](task:${child}?event=child_done)`,
  ]);
  assert.equal(f.cards('user-orchestrator').length, 0, 'Only the direct Orchestrator is notified');
  const notices = f.childNotices(child);
  assert.deepEqual(notices.map(notice => notice.kind), ['child_done']);
  assert.ok(notices.every(notice => notice.recipient === 'lead' && notice.parent_task_id === root && notice.notification.status === 'accepted'));

  const other = await f.start('lead', 'helper');
  assert.equal((await f.as('helper', 'task_cancel', { task_id: other, write_context: f.store.task(other).write_context, reason: 'Not needed' })).error, null);
  assert.equal(f.childNotices(other).length, 0, 'Cancellation intent is not completion');
  assert.equal((await f.as('helper', 'task_cancel_finalize', { ...f.context(other), summary: 'Stopped and cleaned up' })).error, null);
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
  assert.equal((await f.report('lead', root, { status: 'done', outcome: { summary: 'Integrated' }, retro: null })).error.code, 'CHILDREN_NOT_TERMINAL');
  const before = f.sent.length;
  assert.equal((await f.report('helper', late, { status: 'done', outcome: { summary: 'Late' }, retro: null })).error, null);
  assert.equal(f.sent.length, before + 1, 'The parent remains responsible until its last child finishes');
  assert.equal((await f.report('lead', root, { status: 'done', outcome: { summary: 'Integrated' }, retro: null })).error, null);
  assert.equal(f.childNotices(late).length, 1);
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
