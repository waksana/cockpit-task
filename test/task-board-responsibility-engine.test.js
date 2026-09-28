import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { TaskStore } from '../src/task-board/store.js';
import { deliverNotification } from '../src/task-board/notifications.js';

function fixture(t) {
  const directory = resolve(`test/.responsibility-${randomUUID()}`);
  mkdirSync(directory);
  const store = new TaskStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const context = id => {
    const row = store.task(id);
    return { task_id: id, revision: row.revision, write_context: row.write_context };
  };
  const call = (name, actor, input = {}) => {
    const { revision, ...fields } = input;
    return store.executeLocal(name, {
      request_id: randomUUID(), actor, ...fields,
      ...(!['task_cancel', 'task_subscribe'].includes(name) && revision !== undefined ? { revision } : {}),
    });
  };
  const create = (actor = 'user', input = {}) => call('task_create', actor, {
    title: 'Bounded responsibility', description: 'Deliver only the authorized result', ...input,
  }).task_id;
  const root = (actor, mode = 'orchestrate') => {
    const id = create();
    call('task_claim', actor, context(id));
    call('task_ack', actor, context(id));
    call('task_start', actor, { ...context(id), work_mode: mode });
    return id;
  };
  const assign = (id, actor, assignee) => {
    const input = { ...context(id), actor, assignee, request_id: randomUUID() };
    store.reserveOperation('task_assign', input);
    return store.bindAssignment(input);
  };
  const child = (actor, assignee, mode = 'execute') => {
    const id = create(actor);
    assign(id, actor, assignee);
    call('task_ack', assignee, context(id));
    call('task_start', assignee, { ...context(id), work_mode: mode });
    return id;
  };
  const finish = (id, actor) => call('task_report', actor, {
    ...context(id), status: 'done', outcome: { summary: 'Delivered the bounded result' }, retro: null,
  });
  return { store, context, call, create, root, child, assign, finish };
}

test('root claim is ordinary binding, creator is historical, and start/convert are explicit atomic boundaries', t => {
  const f = fixture(t), id = f.create('registrar');
  assert.throws(() => f.call('task_edit', 'registrar', { ...f.context(id), title: 'Hijack', reason: 'Created it' }), { code: 'PARENT_ASSIGNEE_OR_ASSIGNEE_REQUIRED' });
  f.call('task_claim', 'worker', f.context(id));
  const claimed = f.store.task(id);
  assert.equal(claimed.created_by, 'registrar');
  assert.equal(claimed.actor_role, undefined);
  assert.equal(claimed.parent_assignee, null);
  assert.equal(claimed.work_mode, 'undecided');
  assert.equal(claimed.acknowledged_revision, null);
  assert.equal(Object.hasOwn(claimed, 'orchestrator'), false);
  assert.throws(() => f.call('task_start', 'worker', { ...f.context(id), work_mode: 'execute' }), { code: 'ACK_REQUIRED' });
  f.call('task_ack', 'worker', f.context(id));
  assert.throws(() => f.finish(id, 'worker'), { code: 'START_REQUIRED' });
  f.call('task_start', 'worker', { ...f.context(id), work_mode: 'execute' });
  assert.throws(() => f.create('worker'), { code: 'PARENT_NOT_ORCHESTRATING' });
  const before = f.context(id);
  const convert = { ...before, reason: 'Separate a narrower result', completed: 'Existing research retained', remaining: 'Implement the selected result', request_id: 'convert-once' };
  const result = f.call('task_convert', 'worker', convert);
  assert.deepEqual(f.call('task_convert', 'worker', convert), result);
  assert.throws(() => f.call('task_convert', 'worker', { ...f.context(id), reason: 'Again', completed: 'Done', remaining: 'Rest' }), { code: 'WORK_MODE_CONFLICT' });
  assert.equal(f.store.task(id).work_mode, 'orchestrate');
  assert.notEqual(f.context(id).write_context, before.write_context);
  const history = f.store.read({ view: 'responsibility_events', task_id: id, actor: 'worker' });
  assert.equal(history.items[0].details.completed, 'Existing research retained');
  const child = f.create('worker');
  assert.equal(f.store.task(child).parent_task_id, id);
  assert.equal(f.store.task(child).parent_assignee, 'worker');
});

test('child creation requires the current parent ACK even though create has no revision parameter', t => {
  const f = fixture(t), parent = f.root('parent');
  f.call('task_edit', 'user', {
    ...f.context(parent), description: 'Updated authorized parent agreement', reason: 'User changed the agreed result',
  });
  assert.throws(() => f.create('parent'), { code: 'ACK_REQUIRED' });
  assert.throws(() => f.create('user', { parent_task_id: parent }), { code: 'ACK_REQUIRED' });
  assert.equal(f.store.task(parent).children.total, 0);
  f.call('task_ack', 'parent', f.context(parent));
  const child = f.create('parent');
  assert.equal(f.store.task(child).parent_task_id, parent);
  assert.equal(f.store.task(parent).children.total, 1);
});

test('assignment checks active parent responsibility before reserving any external operation', t => {
  const f = fixture(t), parent = f.root('parent'), child = f.create('parent');
  const reserve = request_id => ({
    ...f.context(child), actor: 'parent', assignee: 'worker', request_id,
  });
  f.call('task_edit', 'user', {
    ...f.context(parent), description: 'Updated coordination agreement', reason: 'Explicit authorized scope update',
  });
  assert.throws(() => f.store.reserveOperation('task_assign', reserve('unacknowledged-parent')), { code: 'ACK_REQUIRED' });
  assert.throws(() => f.store.operation({ actor: 'parent', request_id: 'unacknowledged-parent' }), { code: 'OPERATION_NOT_FOUND' });
  f.call('task_ack', 'parent', f.context(parent));
  f.call('task_cancel', 'user', { ...f.context(parent), reason: 'User abandons the parent goal' });
  assert.throws(() => f.store.assertAssignable(f.store.row(child), 'worker'), { code: 'CANCELLATION_REQUESTED' });
  assert.throws(() => f.store.reserveOperation('task_assign', reserve('cancelled-parent')), { code: 'CANCELLATION_REQUESTED' });
  assert.throws(() => f.store.operation({ actor: 'parent', request_id: 'cancelled-parent' }), { code: 'OPERATION_NOT_FOUND' });
  assert.equal(f.store.task(child).assignee, null);
});

test('cancellation records intent, blocks abandoned work, and finalizes only after children close', t => {
  const f = fixture(t), parent = f.root('parent'), child = f.child('parent', 'child');
  assert.throws(() => f.finish(parent, 'parent'), { code: 'CHILDREN_NOT_TERMINAL' });
  const intent = f.call('task_cancel', 'user', { ...f.context(parent), reason: 'User cancelled this goal' });
  assert.equal(f.store.task(parent).status, 'in_progress');
  assert.equal(f.store.task(child).status, 'in_progress');
  assert.equal(f.store.assigneeNotice(f.store.db.prepare('SELECT * FROM assignee_notices WHERE id=?').get(intent.notice_ids[0])).kind, 'cancellation_requested');
  assert.throws(() => f.create('parent'), { code: 'CANCELLATION_REQUESTED' });
  assert.throws(() => f.call('task_convert', 'child', {
    ...f.context(child), reason: 'Continue abandoned work', completed: 'Existing research', remaining: 'New decomposition',
  }), { code: 'CANCELLATION_REQUESTED' });
  assert.throws(() => f.call('task_cancel_finalize', 'parent', { ...f.context(parent), summary: 'Not yet' }), { code: 'CHILDREN_NOT_TERMINAL' });
  assert.throws(() => f.call('task_cancel_finalize', 'user', { ...f.context(parent), summary: 'Cannot bypass responsible session' }), { code: 'ASSIGNEE_REQUIRED' });
  f.call('task_report', 'parent', { ...f.context(parent), activity: { text: 'Arranging cleanup' } });
  f.call('task_cancel', 'parent', { ...f.context(child), reason: 'Arrange residual handling' });
  f.call('task_edit', 'child', { ...f.context(child), reason: 'Cleanup constraint', blocked_by: [{ condition: 'Original success cannot occur' }] });
  f.call('task_cancel_finalize', 'child', { ...f.context(child), summary: 'Effects reviewed and stopped; success not claimed' });
  f.call('task_cancel_finalize', 'parent', { ...f.context(parent), summary: 'Child closed and residual handling recorded' });
  assert.equal(f.store.task(parent).status, 'cancelled');
  assert.equal(f.store.task(parent).children.nonterminal, 0);
  assert.equal(f.store.read({ view: 'execution', task_id: parent }).cancellation.summary, 'Child closed and residual handling recorded');
});

test('parent cancellation and blockers permit existing child completion, but own cancellation forbids done', t => {
  const f = fixture(t), parent = f.root('parent');
  const completedChild = f.child('parent', 'completed-child'), cancelledChild = f.child('parent', 'cancelled-child');
  f.call('task_edit', 'parent', {
    ...f.context(parent), reason: 'Parent delivery condition remains unmet', blocked_by: [{ condition: 'Overall goal needs another authorization' }],
  });
  f.call('task_cancel', 'user', { ...f.context(parent), reason: 'User abandoned the overall goal' });
  f.finish(completedChild, 'completed-child');
  assert.equal(f.store.task(completedChild).status, 'done');
  assert.equal(f.store.task(parent).status, 'in_progress');
  f.call('task_cancel', 'parent', { ...f.context(cancelledChild), reason: 'Stop this unfinished child result' });
  assert.throws(() => f.finish(cancelledChild, 'cancelled-child'), { code: 'CANCELLATION_REQUESTED' });
  f.call('task_cancel_finalize', 'cancelled-child', { ...f.context(cancelledChild), summary: 'Remaining child work stopped' });
  f.call('task_cancel_finalize', 'parent', { ...f.context(parent), summary: 'Delivered child retained; remaining work stopped' });
  assert.equal(f.store.task(parent).status, 'cancelled');
  assert.equal(f.store.task(parent).ready, false);
});

test('a root assignee resolves an exact condition with durable evidence, never by deleting or replacing it', t => {
  const f = fixture(t), id = f.root('worker', 'execute');
  f.call('task_edit', 'worker', { ...f.context(id), reason: 'Need a user decision', blocked_by: [{ condition: 'User selects a supported delivery target' }] });
  const task = f.store.task(id), dependency_id = task.blocked_by[0].dependency_id;
  assert.equal(task.ready, false);
  assert.throws(() => f.call('task_edit', 'worker', { ...f.context(id), reason: 'Pretend satisfied', blocked_by: [] }), { code: 'CONDITION_RESOLUTION_REQUIRED' });
  const resolved = f.call('task_resolve_condition', 'worker', {
    ...f.context(id), dependency_id, evidence: 'User selected the staging target in the current conversation',
    references: [{ label: 'Decision', target: 'decision:staging' }],
  });
  assert.equal(resolved.ready, true);
  const history = f.store.read({ view: 'dependencies', task_id: id }).items[0];
  assert.equal(history.resolution, 'evidence');
  assert.match(history.evidence, /User selected/);
  assert.deepEqual(history.references, [{ label: 'Decision', target: 'decision:staging' }]);
  assert.throws(() => f.call('task_resolve_condition', 'worker', {
    ...f.context(id), dependency_id, evidence: 'Cannot resolve twice',
  }), { code: 'CONDITION_NOT_ACTIVE' });
  f.finish(id, 'worker');
});

test('a blocked unbound root may be claimed for clarification, but start waits for evidence', t => {
  const f = fixture(t), id = f.create('registrar', { blocked_by: [{ condition: 'User selects the delivery target' }] });
  f.call('task_claim', 'worker', f.context(id));
  f.call('task_ack', 'worker', f.context(id));
  assert.throws(() => f.call('task_start', 'worker', { ...f.context(id), work_mode: 'execute' }), { code: 'TASK_NOT_READY' });
  assert.equal(f.store.task(id).status, 'todo');
  assert.equal(f.store.task(id).work_mode, 'undecided');
  f.call('task_resolve_condition', 'worker', {
    ...f.context(id), dependency_id: f.store.task(id).blocked_by[0].dependency_id, evidence: 'User selected the staging target',
  });
  f.call('task_start', 'worker', { ...f.context(id), work_mode: 'execute' });
  assert.equal(f.store.task(id).status, 'in_progress');
});

test('attachment preserves deep subtree identity and updates authority, contexts, filters, and bounded ancestors', t => {
  const f = fixture(t), original = f.root('original');
  const branch = f.child('original', 'branch', 'orchestrate');
  const leaf = f.child('branch', 'leaf', 'orchestrate');
  const deepest = f.child('leaf', 'deepest');
  const parent = f.root('broader');
  const contexts = [original, branch, leaf, deepest].map(id => f.context(id).write_context);
  const originalVersion = f.store.read({ view: 'overview', task_id: original }).data_version;
  f.call('task_attach', 'broader', {
    ...f.context(original), parent_task_id: parent, parent_write_context: f.context(parent).write_context,
    reason: 'Authorized larger responsibility; original scope is unchanged',
  });
  assert.equal(f.store.task(original).parent_assignee, 'broader');
  assert.equal(f.store.task(original).assignee, 'original');
  assert.equal(f.store.task(deepest).depth, 5);
  assert.notEqual(f.store.read({ view: 'overview', task_id: original }).data_version, originalVersion);
  for (const [index, id] of [original, branch, leaf, deepest].entries()) assert.notEqual(f.context(id).write_context, contexts[index]);
  const first = f.store.read({ view: 'ancestors', task_id: deepest, limit: 2, actor: 'deepest' });
  assert.deepEqual(first.items.map(item => item.id), [leaf, branch]);
  const second = f.store.read({ view: 'ancestors', task_id: deepest, limit: 2, cursor: first.next_cursor });
  assert.deepEqual(second.items.map(item => item.id), [original, parent]);
  assert.equal(second.next_cursor, null);
  assert.deepEqual(f.store.read({ view: 'list', parent_assignee: 'broader' }).items.map(item => item.id), [original]);
  assert.deepEqual(f.store.read({ view: 'list', root: true, work_mode: 'orchestrate' }).items.map(item => item.id), [parent]);
  assert.throws(() => f.call('task_attach', 'deepest', {
    ...f.context(parent), parent_task_id: deepest, parent_write_context: f.context(deepest).write_context, reason: 'Cycle',
  }), { code: 'PARENT_NOT_ORCHESTRATING' });
});

test('attachment rejects descendant dependency deadlocks atomically and structural cycles at any depth', t => {
  const f = fixture(t), root = f.root('root'), child = f.child('root', 'child', 'orchestrate'), higher = f.root('higher');
  f.call('task_edit', 'child', { ...f.context(child), reason: 'Dependency', blocked_by: [{ task_id: higher }] });
  const before = f.context(root);
  assert.throws(() => f.call('task_attach', 'higher', {
    ...before, parent_task_id: higher, parent_write_context: f.context(higher).write_context, reason: 'Would deadlock',
  }), { code: 'BLOCKER_ANCESTOR' });
  assert.equal(f.store.task(root).parent_task_id, null);
  assert.equal(f.context(root).write_context, before.write_context);
  f.call('task_edit', 'root', { ...f.context(child), reason: 'Remove the planned dependency', blocked_by: [] });
  assert.throws(() => f.call('task_attach', 'child', {
    ...f.context(root), parent_task_id: child, parent_write_context: f.context(child).write_context, reason: 'Cycle',
  }), { code: 'TREE_CYCLE' });
});

test('parent prerequisites cannot strand an unstarted descendant behind parent readiness', t => {
  const f = fixture(t), root = f.root('parent'), child = f.child('parent', 'child', 'orchestrate');
  const grandchild = f.create('child'), before = f.context(root);
  assert.throws(() => f.call('task_edit', 'parent', {
    ...before, reason: 'Wait for nested delivery', blocked_by: [{ task_id: grandchild }],
  }), { code: 'BLOCKER_DESCENDANT' });
  assert.equal(f.context(root).write_context, before.write_context);
  assert.equal(f.store.task(root).ready, true);
  f.assign(grandchild, 'child', 'grandchild');
  f.call('task_ack', 'grandchild', f.context(grandchild));
  f.call('task_start', 'grandchild', { ...f.context(grandchild), work_mode: 'execute' });
  f.finish(grandchild, 'grandchild');
  f.finish(child, 'child');
  f.call('task_edit', 'parent', {
    ...f.context(root), reason: 'Record the already-completed prerequisite', blocked_by: [{ task_id: grandchild }],
  });
  assert.equal(f.store.task(root).ready, true);
  f.finish(root, 'parent');
});

test('notice delivery revalidates snapshot recipients after awaited host inspection and never reroutes', async t => {
  const f = fixture(t), root = f.root('parent'), child = f.child('parent', 'child');
  const result = f.finish(child, 'child'), notice = result.notice_ids[0], sent = [];
  const snapshot = f.store.notificationChannel(notice).read();
  assert.equal(snapshot.recipient, 'parent');
  const delivered = await deliverNotification({
    store: f.store, id: notice, stopped: () => false,
    host: {
      sessionExists: async () => {
        f.finish(root, 'parent');
        return true;
      },
      send: async (...args) => { sent.push(args); return { ok: true }; },
    },
  });
  assert.equal(delivered.notification.status, 'not_sent');
  assert.equal(delivered.notification.error.code, 'NOTIFICATION_RELATION_CHANGED');
  assert.deepEqual(sent, []);
});

test('parent terminal blocks child reopen while a legitimate parent reopening preserves work mode', t => {
  const f = fixture(t), parent = f.root('parent'), child = f.child('parent', 'child');
  f.finish(child, 'child');
  f.finish(parent, 'parent');
  assert.throws(() => f.call('task_reopen', 'child', { ...f.context(child), description: 'Authorized rework', reason: 'Need another result' }), { code: 'PARENT_NOT_ORCHESTRATING' });
  f.call('task_reopen', 'parent', { ...f.context(parent), description: 'Authorized coordination rework', reason: 'Restore responsibility first' });
  assert.equal(f.store.task(parent).work_mode, 'orchestrate');
  f.call('task_reopen', 'child', { ...f.context(child), description: 'Authorized rework', reason: 'Parent restored' });
  assert.equal(f.store.task(child).work_mode, 'execute');
});

test('attachment may retain a cancelled historical child without treating its final intent as active', t => {
  const f = fixture(t), root = f.root('root'), child = f.child('root', 'child'), parent = f.root('parent');
  f.call('task_cancel', 'child', { ...f.context(child), reason: 'User cancelled the narrower goal' });
  f.call('task_cancel_finalize', 'child', { ...f.context(child), summary: 'Residual handling complete' });
  f.call('task_attach', 'parent', {
    ...f.context(root), parent_task_id: parent, parent_write_context: f.context(parent).write_context,
    reason: 'Authorized larger responsibility',
  });
  assert.equal(f.store.task(child).status, 'cancelled');
  assert.equal(f.store.task(child).depth, 3);
  assert.equal(f.store.task(root).children.nonterminal, 0);
});

test('condition resolution cannot remove Task-ID dependencies and parent cancellation never resolves a blocker', t => {
  const f = fixture(t), root = f.root('root'), blocker = f.child('root', 'blocker'), dependent = f.create('root', { blocked_by: [blocker] });
  const dependency = f.store.read({ view: 'dependencies', task_id: dependent }).items[0];
  assert.throws(() => f.call('task_resolve_condition', 'root', {
    ...f.context(dependent), dependency_id: dependency.dependency_id, evidence: 'This is not a condition',
  }), { code: 'CONDITION_NOT_ACTIVE' });
  f.call('task_cancel', 'root', { ...f.context(blocker), reason: 'User abandons this execution' });
  f.call('task_cancel_finalize', 'blocker', { ...f.context(blocker), summary: 'Stopped without successful delivery' });
  assert.equal(f.store.task(dependent).ready, false);
  assert.equal(f.store.task(dependent).blocked_by[0].status, 'cancelled');
  assert.equal(f.store.task(root).children.nonterminal, 1);
});

test('new cancellation does not consume subscriptions until final status and Web recipient selection is explicit', t => {
  const f = fixture(t), id = f.root('worker', 'execute');
  assert.throws(() => f.call('task_subscribe', 'user', { ...f.context(id), statuses: ['cancelled'] }), { code: 'SUBSCRIBER_REQUIRED' });
  const subscription = f.call('task_subscribe', 'user', {
    ...f.context(id), subscriber: 'observer', statuses: ['cancelled'],
  }).subscription;
  f.call('task_cancel', 'user', { ...f.context(id), reason: 'Stop authorized work' });
  assert.equal(f.store.getSubscription(subscription.subscription_id).state, 'waiting');
  f.call('task_cancel_finalize', 'worker', { ...f.context(id), summary: 'Stopped and reviewed residual state' });
  assert.equal(f.store.getSubscription(subscription.subscription_id).state, 'triggered');
  assert.equal(f.store.getSubscription(subscription.subscription_id).subscriber, 'observer');
});

test('queued automation retains service-managed mode and cannot launch under blocked or cancelling ancestors', t => {
  const f = fixture(t), parent = f.root('parent');
  f.call('task_script_register', 'user', {
    script_id: 'existing-test', title: 'Existing test source', description: 'Registered for store-only state tests; never launched',
    executable: process.execPath, script_path: resolve('test/task-board-reference.test.js'), argv: [], parameters: [],
  });
  const id = f.create('parent', { automation: { script_id: 'existing-test', parameters: {} } });
  assert.equal(f.store.task(id).work_mode, null);
  assert.equal(f.store.task(id).assignee, null);
  assert.throws(() => f.call('task_ack', 'parent', f.context(id)), { code: 'AUTOMATION_MANAGED' });
  f.call('task_automation_start', 'parent', f.context(id));
  f.call('task_edit', 'parent', { ...f.context(parent), reason: 'Pause pending decision', blocked_by: [{ condition: 'User selects the environment' }] });
  assert.equal(f.store.automation.next(), null);
  f.call('task_resolve_condition', 'parent', {
    ...f.context(parent), dependency_id: f.store.task(parent).blocked_by[0].dependency_id, evidence: 'User chose staging',
  });
  assert.equal(f.store.automation.next().task_id, id);
  f.call('task_cancel', 'user', { ...f.context(parent), reason: 'User withdrew the overall goal' });
  assert.equal(f.store.automation.next(), null);
  f.call('task_cancel', 'parent', { ...f.context(id), reason: 'Stop the queued child before launch' });
  assert.equal(f.store.task(id).status, 'cancelled');
  assert.equal(f.store.automation.run(id).pid, null);
  f.call('task_cancel_finalize', 'parent', { ...f.context(parent), summary: 'No automation launched and all children closed' });
});

test('root automation has no hidden manager or Agent lifecycle and failed attempts remain distinct from done', t => {
  const f = fixture(t);
  f.call('task_script_register', 'user', {
    script_id: 'existing-test', title: 'Existing test source', description: 'Registered but never launched',
    executable: process.execPath, script_path: resolve('test/task-board-reference.test.js'), argv: [], parameters: [],
  });
  const id = f.create('registrar', { automation: { script_id: 'existing-test', parameters: {} } });
  assert.throws(() => f.call('task_automation_start', 'registrar', f.context(id)), { code: 'PARENT_ASSIGNEE_REQUIRED' });
  f.call('task_automation_start', 'user', f.context(id));
  const claimed = f.store.automation.claim(id);
  assert.ok(claimed);
  f.store.automation.finish(id, { state: 'failed', exit_code: 1, error: 'Synthetic service result; no process was launched' });
  assert.equal(f.store.task(id).status, 'done');
  assert.equal(f.store.task(id).work_mode, null);
  assert.equal(f.store.task(id).acknowledged_revision, null);
  assert.equal(f.store.automation.run(id).state, 'failed');
});

test('escaped responsibility payloads remain fully readable within bounded event history', t => {
  const f = fixture(t), id = f.root('worker', 'execute'), escaped = '\u0001'.repeat(2400);
  const latest = () => f.store.read({ view: 'responsibility_events', task_id: id, limit: 1 }).items[0];
  f.call('task_convert', 'worker', {
    ...f.context(id), reason: 'Decompose the remaining result', completed: escaped, remaining: 'One narrower responsibility',
  });
  assert.equal(latest().details.completed, escaped);
  f.call('task_edit', 'worker', {
    ...f.context(id), reason: 'Record a condition', blocked_by: [{ condition: 'Evidence is available' }],
  });
  f.call('task_resolve_condition', 'worker', {
    ...f.context(id), dependency_id: f.store.task(id).blocked_by[0].dependency_id, evidence: escaped,
    references: [{ label: 'Decision', target: 'decision:retained' }],
  });
  assert.equal(latest().details.evidence, escaped);
  assert.deepEqual(latest().details.references, [{ label: 'Decision', target: 'decision:retained' }]);
  f.call('task_cancel', 'worker', { ...f.context(id), reason: 'User abandoned the goal' });
  f.call('task_cancel_finalize', 'worker', { ...f.context(id), summary: escaped });
  assert.equal(latest().details.summary, escaped);
});
