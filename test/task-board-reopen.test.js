import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore, TaskError } from '../src/task-board/store.js';
import { TaskService } from '../src/task-board/service.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'task-reopen-'));
  let store = new TaskStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const input = (task, fields = {}) => ({
    actor: 'assignee', request_id: randomUUID(),
    task_id: task.task_id, revision: task.revision, write_context: task.write_context, ...fields,
  });
  const create = () => store.executeLocal('task_create', {
    actor: 'orchestrator', request_id: randomUUID(),
    title: 'Rework', description: 'Full agreement',
    references: [{ label: 'Previous PR', target: 'https://example.test/pr/1' }],
  });
  const assign = task => {
    const request = input(task, { actor: 'orchestrator', assignee: 'assignee' });
    store.reserveOperation('task_assign', request);
    return store.bindAssignment(request);
  };
  const done = task => {
    store.executeLocal('task_ack', input(task));
    return store.executeLocal('task_report', input(task, {
      status: 'done', outcome: { summary: 'Prior delivery', references: [{ label: 'PR', target: 'https://example.test/pr/1' }] },
      retro: 'Observed improvement',
    }));
  };
  const reopenInput = (task, fields = {}) => input(task, { description: 'Full agreement', reason: 'User requested rework', ...fields });
  return {
    root, get store() { return store; }, input, create, assign, done, reopenInput,
    reopen: (task, fields) => store.executeLocal('task_reopen', reopenInput(task, fields)),
    restart() { store.close(); store = new TaskStore(root); },
  };
}

function rejects(work, code) {
  assert.throws(work, error => error.code === code);
}

test('self-reopen atomically creates and ACKs a new revision even with identical text, preserving completion facts', t => {
  const f = fixture(t), assigned = f.assign(f.create());
  const completed = f.done(assigned);
  const before = f.store.task(assigned.task_id);
  const oldOutcome = f.store.read({ view: 'outcomes', task_id: assigned.task_id }).items[0];
  const oldAck = f.store.db.prepare('SELECT * FROM acknowledgements WHERE task_id=?').get(assigned.task_id);
  const request = f.reopenInput(completed);
  const reopened = f.store.executeLocal('task_reopen', request);
  assert.equal(reopened.task_status, 'in_progress');
  assert.equal(reopened.revision, 2);
  assert.equal(reopened.acknowledged_revision, 2);
  assert.notEqual(reopened.write_context, completed.write_context);
  const after = f.store.task(assigned.task_id);
  for (const key of ['id', 'orchestrator', 'assignee', 'title', 'references', 'metadata', 'created_at', 'description']) {
    assert.deepEqual(after[key], before[key], key);
  }
  assert.equal(after.retro.current, false);
  assert.equal(after.retro.text, 'Observed improvement');
  const revision = f.store.read({ view: 'changelog', task_id: assigned.task_id, revision: 2 });
  assert.equal(revision.reason, 'User requested rework');
  assert.equal(revision.author, 'assignee');
  assert.equal(revision.description, before.description);
  assert.ok(revision.at);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM acknowledgements WHERE task_id=? AND revision=1').get(assigned.task_id), oldAck);
  assert.equal(f.store.read({ view: 'activity', task_id: assigned.task_id }).items.length, 0);
  const historical = f.store.read({ view: 'outcomes', task_id: assigned.task_id }).items[0];
  assert.deepEqual(historical, { ...oldOutcome, current: false, retro: { ...oldOutcome.retro, current: false } });
  for (const input of [
    { view: 'overview', task_id: assigned.task_id },
    { view: 'overview', task_id: assigned.task_id, include: ['outcome', 'retro'] },
  ]) {
    const read = f.store.read(input);
    assert.equal(read.outcome.current, false);
    assert.equal(read.retro.current, false);
  }
  assert.equal(f.store.read({ view: 'list' }).items[0].outcome.current, false);
  f.restart();
  assert.deepEqual(f.store.executeLocal('task_reopen', request), reopened);
  assert.equal(f.store.read({ view: 'changelog', task_id: assigned.task_id }).items.length, 2);
  rejects(() => f.store.executeLocal('task_reopen', { ...request, reason: 'Different' }), 'REQUEST_ID_CONFLICT');
  rejects(() => f.store.executeLocal('task_report', f.input(completed, { status: 'done', outcome: { summary: 'Old' }, retro: null })), 'TASK_STATE_CONFLICT');
  rejects(() => f.store.executeLocal('task_report', f.input(reopened, { revision: 1, status: 'done', outcome: { summary: 'Old' }, retro: null })), 'DESCRIPTION_UPDATED');
  for (const fields of [{ status: 'done', retro: null }, { status: 'done', outcome: { summary: 'New' } }]) {
    rejects(() => f.store.executeLocal('task_report', f.input(reopened, fields)), 'INVALID_INPUT');
  }
  const completedAgain = f.store.executeLocal('task_report', f.input(reopened, {
    status: 'done', outcome: { summary: 'New delivery' }, retro: null,
  }));
  assert.equal(completedAgain.task_status.value, 'done');
  assert.equal(f.store.task(assigned.task_id).retro.current, true);
  const history = f.store.read({ view: 'outcomes', task_id: assigned.task_id }).items;
  assert.equal(history.length, 2);
  assert.equal(history[0].revision, 2);
  assert.equal(history[0].retro.text, null);
  assert.equal(history[1].retro.text, 'Observed improvement');
  assert.equal(f.reopen(completedAgain).revision, 3, 'Repeated contiguous rework remains eligible');
});

test('reopen rejects mismatched/missing actor, state, stale revision and editable/lifecycle contexts', t => {
  const f = fixture(t), assigned = f.assign(f.create());
  rejects(() => f.reopen(assigned), 'TASK_STATE_CONFLICT');
  const completed = f.done(assigned);
  const g = fixture(t);
  assert.equal(g.reopen(g.done(g.assign(g.create())), { actor: 'orchestrator' }).revision, 2);
  rejects(() => f.reopen(completed, { actor: 'someone-else' }), 'ORCHESTRATOR_OR_ASSIGNEE_REQUIRED');
  rejects(() => f.reopen(completed, { actor: undefined }), 'ORCHESTRATOR_OR_ASSIGNEE_REQUIRED');
  rejects(() => f.reopen(completed, { revision: 2 }), 'DESCRIPTION_UPDATED');
  rejects(() => f.reopen(completed, { write_context: assigned.write_context }), 'TASK_STATE_CONFLICT');
  const edited = f.store.executeLocal('task_edit', f.input(completed, { reason: 'Rename', title: 'Changed' }));
  rejects(() => f.reopen(completed), 'EDIT_CONFLICT');
  const updated = f.store.executeLocal('task_edit', f.input(edited, { reason: 'Clarify', description: 'Revised while done' }));
  assert.equal(updated.acknowledged_revision, 1);
  rejects(() => f.reopen(edited), 'DESCRIPTION_UPDATED');
  const reopened = f.reopen(updated);
  assert.equal(reopened.revision, 3);
  assert.equal(reopened.acknowledged_revision, 3);
  const cancelled = f.store.executeLocal('task_cancel', {
    actor: 'orchestrator', request_id: randomUUID(), task_id: reopened.task_id,
    write_context: reopened.write_context, reason: 'Stop',
  });
  rejects(() => f.reopen(cancelled), 'TASK_STATE_CONFLICT');
});

test('automation and unassigned done records cannot reopen or gain an Assignee', t => {
  const f = fixture(t), task = f.create();
  f.store.db.prepare("UPDATE tasks SET status='done',kind='automation' WHERE id=?").run(task.task_id);
  rejects(() => f.reopen(task, { actor: 'orchestrator' }), 'AUTOMATION_MANAGED');
  f.store.db.prepare("UPDATE tasks SET kind='agent' WHERE id=?").run(task.task_id);
  rejects(() => f.reopen(task, { actor: 'orchestrator' }), 'REOPEN_NOT_ELIGIBLE');
  assert.equal(f.store.task(task.task_id).assignee, null);
});

test('actual assignment order, not creation/update timestamps or request reservation order, governs eligibility', t => {
  const f = fixture(t);
  const laterTask = f.create();
  const priorTask = f.create();
  const laterRequest = f.input(laterTask, { actor: 'orchestrator', assignee: 'assignee' });
  f.store.reserveOperation('task_assign', laterRequest);
  const priorDone = f.done(f.assign(priorTask));
  const laterAssigned = f.store.bindAssignment(laterRequest);
  rejects(() => f.reopen(priorDone), 'ASSIGNEE_OCCUPIED');
  const laterDone = f.done(laterAssigned);
  const touched = f.store.executeLocal('task_edit', f.input(priorDone, { reason: 'New timestamp', title: 'Touched last' }));
  rejects(() => f.reopen(touched), 'REOPEN_NOT_ELIGIBLE');
  assert.equal(f.reopen(laterDone).task_status, 'in_progress');
});

test('later cancelled assignments still disqualify after restart', t => {
  const f = fixture(t), completed = f.done(f.assign(f.create()));
  const later = f.assign(f.create());
  f.store.executeLocal('task_cancel', {
    task_id: later.task_id, write_context: later.write_context, actor: 'orchestrator',
    request_id: randomUUID(), reason: 'Later work cancelled',
  });
  f.restart();
  rejects(() => f.reopen(completed), 'REOPEN_NOT_ELIGIBLE');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM task_assignments').get().n, 2);
});

test('assignment history preserves reopen eligibility after restart', t => {
  const f = fixture(t), prior = f.done(f.assign(f.create()));
  const history = f.store.read({ view: 'outcomes', task_id: prior.task_id });
  f.restart();
  assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version, 10);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM task_assignments').get().n, 1);
  assert.deepEqual(f.store.read({ view: 'outcomes', task_id: prior.task_id }), history);
  assert.equal(f.reopen(prior).task_status, 'in_progress');
});

test('ended subscriptions and delivery facts never resurrect; newly explicit subscriptions work once', t => {
  const f = fixture(t), assigned = f.assign(f.create());
  const subscribe = task => {
    const { revision, ...input } = f.input(task, { actor: 'orchestrator', statuses: ['done'] });
    return f.store.executeLocal('task_subscribe', input).subscription;
  };
  const first = subscribe(assigned);
  const completed = f.done(assigned);
  const prior = f.store.getSubscription(first.subscription_id);
  assert.equal(prior.state, 'triggered');
  const reopened = f.reopen(completed);
  assert.deepEqual(f.store.getSubscription(first.subscription_id), prior);
  const second = subscribe(reopened);
  const again = f.done(reopened);
  assert.deepEqual(again.subscription_ids, [second.subscription_id]);
  assert.deepEqual(f.store.getSubscription(first.subscription_id), prior);
  assert.equal(f.store.getSubscription(second.subscription_id).event.from_status, 'in_progress');
});

test('expired and explicitly cancelled waits remain ended across reopening and subsequent completion', t => {
  const f = fixture(t), assigned = f.assign(f.create());
  const subscription = statuses => {
    const { revision, ...input } = f.input(assigned, { actor: 'orchestrator', statuses });
    return f.store.executeLocal('task_subscribe', input).subscription;
  };
  const cancelled = subscription(['done']);
  f.store.executeLocal('task_unsubscribe', {
    actor: 'orchestrator', request_id: randomUUID(), task_id: assigned.task_id,
    subscription_id: cancelled.subscription_id,
  });
  const expired = subscription(['cancelled']);
  const completed = f.done(assigned);
  const histories = [cancelled, expired].map(entry => f.store.getSubscription(entry.subscription_id));
  assert.deepEqual(histories.map(entry => entry.state), ['cancelled', 'expired']);
  const reopened = f.reopen(completed);
  assert.equal(f.done(reopened).subscription_ids, undefined);
  assert.deepEqual([cancelled, expired].map(entry => f.store.getSubscription(entry.subscription_id)), histories);
});

test('reopen combined definition bounds and cancellation do not partially mutate a new revision', async t => {
  const f = fixture(t), completed = f.done(f.assign(f.create()));
  rejects(() => f.reopen(completed, { description: '\u0001'.repeat(24000) }), 'INVALID_INPUT');
  assert.equal(f.store.task(completed.task_id).revision, 1);
  const controller = new AbortController();
  const service = new TaskService(f.store, { inspect: async () => {
    controller.abort();
    return { ready: true, node: true };
  } });
  const request = f.reopenInput(completed);
  const rejected = await service.execute('task_reopen', request, { signal: controller.signal });
  assert.equal(rejected.error.code, 'REQUEST_CANCELLED');
  assert.equal(f.store.task(completed.task_id).status, 'done');
  assert.equal(f.store.task(completed.task_id).revision, 1);
  assert.equal((await service.execute('task_reopen', request)).error.code, 'REQUEST_CANCELLED');
});

test('failed ACK persistence rolls back reopen status, revision, definition and context together', t => {
  const f = fixture(t), completed = f.done(f.assign(f.create()));
  const before = f.store.task(completed.task_id);
  const recordAck = f.store.recordAck;
  f.store.recordAck = () => { throw new TaskError('ACK_STORAGE_TEST', 'Synthetic failure'); };
  const request = f.reopenInput(completed);
  rejects(() => f.store.executeLocal('task_reopen', request), 'ACK_STORAGE_TEST');
  f.store.recordAck = recordAck;
  assert.deepEqual(f.store.task(completed.task_id), before);
  assert.equal(f.store.read({ view: 'changelog', task_id: completed.task_id }).items.length, 1);
  rejects(() => f.store.executeLocal('task_reopen', request), 'ACK_STORAGE_TEST');
  assert.equal(f.reopen(completed).revision, 2);
});

test('store transactions serialize competing connections for reopen and assignment in both orders', t => {
  const f = fixture(t);
  const other = new TaskStore(f.root);
  t.after(() => other.close());
  const completed = f.done(f.assign(f.create())), next = f.create();
  const assignment = f.input(next, { assignee: 'assignee', actor: 'orchestrator' });
  other.reserveOperation('task_assign', assignment);
  const reopened = f.reopen(completed);
  rejects(() => other.bindAssignment(assignment), 'ASSIGNEE_OCCUPIED');
  const doneAgain = f.done(reopened);
  other.bindAssignment(assignment);
  rejects(() => f.reopen(doneAgain), 'ASSIGNEE_OCCUPIED');
  assert.equal(other.db.prepare("SELECT count(*) AS n FROM tasks WHERE assignee='assignee' AND status NOT IN ('done','cancelled')").get().n, 1);
});

test('service checks ready original Assignee but permits its running turn; replay skips host and invalidates reads', async t => {
  const f = fixture(t), completed = f.done(f.assign(f.create()));
  let inspections = 0, invalidations = 0;
  const service = new TaskService(f.store, {
    inspect: async id => { assert.equal(id, 'assignee'); inspections++; return { ready: true, node: true, idle: false }; },
    send: () => assert.fail('Reopen must not send a prompt'),
  }, { invalidate: () => invalidations++ });
  const request = f.reopenInput(completed);
  const reopened = await service.execute('task_reopen', request);
  assert.equal(reopened.error, null);
  assert.equal(reopened.definition_check.tasks[0].needs_ack, false);
  assert.equal(reopened.result.task_status, 'in_progress');
  assert.equal(invalidations, 1);
  assert.deepEqual((await service.execute('task_reopen', request)).result, reopened.result);
  assert.equal(inspections, 1);
  const again = f.done(reopened.result);
  service.host.inspect = async () => ({ ready: true, assignee: false, idle: true });
  const rejectedInput = f.reopenInput(again);
  assert.equal((await service.execute('task_reopen', rejectedInput)).error.code, 'CAPABILITY_UNAVAILABLE');
  service.host.inspect = () => assert.fail('Rejected receipt replay must not re-inspect');
  assert.equal((await service.execute('task_reopen', rejectedInput)).error.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(f.store.task(completed.task_id).status, 'done');
});

test('service rejects wrong attribution before host observation and unavailable readiness without mutation', async t => {
  const f = fixture(t), completed = f.done(f.assign(f.create()));
  const service = new TaskService(f.store, { inspect: () => assert.fail('Mismatched actor must not inspect another session') });
  assert.equal((await service.execute('task_reopen', f.reopenInput(completed, { actor: 'someone-else' }))).error.code, 'ORCHESTRATOR_OR_ASSIGNEE_REQUIRED');
  service.host.inspect = async () => ({ ready: false, node: true, idle: true });
  assert.equal((await service.execute('task_reopen', f.reopenInput(completed))).error.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(f.store.task(completed.task_id).revision, 1);
  assert.equal(f.store.task(completed.task_id).status, 'done');
});

test('completion receipt replay after reopen preserves the old notice without another send', async t => {
  const f = fixture(t), assigned = f.assign(f.create());
  const { revision, ...subscriptionInput } = f.input(assigned, { statuses: ['done'], actor: 'orchestrator' });
  f.store.executeLocal('task_subscribe', subscriptionInput);
  f.store.executeLocal('task_ack', f.input(assigned));
  let sends = 0;
  const service = new TaskService(f.store, {
    inspect: async () => ({ ready: true, node: true, idle: false }),
    sessionExists: async () => true,
    send: async () => { sends++; return { ok: true }; },
  });
  const completion = f.input(assigned, { status: 'done', outcome: { summary: 'Delivered' }, retro: null });
  const done = await service.execute('task_report', completion);
  assert.equal(sends, 1);
  const reopened = await service.execute('task_reopen', f.reopenInput(done.result));
  assert.equal(reopened.error, null);
  assert.equal(sends, 1);
  const replay = await service.execute('task_report', completion);
  assert.equal(replay.error, null);
  assert.equal(replay.result.revision, 1, 'Receipt is the historical operation result');
  assert.equal(replay.definition_check.tasks[0].revision, 2, 'Definition check remains live');
  assert.equal(f.store.task(assigned.task_id).status, 'in_progress');
  assert.equal(sends, 1);
  const completedAgain = await service.execute('task_report', f.input(reopened.result, {
    status: 'done', outcome: { summary: 'Rework delivered' }, retro: null,
  }));
  assert.equal(completedAgain.error, null);
  assert.equal(sends, 1);
});

test('assignment during asynchronous readiness check rejects reopen without an extra revision or ACK', async t => {
  const f = fixture(t), completed = f.done(f.assign(f.create())), next = f.create();
  let release;
  const service = new TaskService(f.store, {
    inspect: () => new Promise(resolve => { release = resolve; }),
  });
  const request = f.reopenInput(completed);
  const pending = service.execute('task_reopen', request);
  assert.equal(typeof release, 'function');
  f.done(f.assign(next));
  release({ ready: true, node: true, idle: false });
  const rejected = await pending;
  assert.equal(rejected.error.code, 'REOPEN_NOT_ELIGIBLE');
  assert.equal(f.store.task(completed.task_id).revision, 1);
  assert.equal(f.store.task(completed.task_id).status, 'done');
  assert.deepEqual((await service.execute('task_reopen', request)).error, rejected.error);
});

test('competing reopen requests and lost mutation response never duplicate a transition', async t => {
  const f = fixture(t), completed = f.done(f.assign(f.create()));
  const releases = [];
  const service = new TaskService(f.store, {
    inspect: () => new Promise(resolve => releases.push(resolve)),
  });
  const request = f.reopenInput(completed);
  const first = service.execute('task_reopen', request);
  const second = service.execute('task_reopen', f.reopenInput(completed));
  releases[0]({ ready: true, node: true });
  releases[1]({ ready: true, node: true });
  const [saved, rejected] = await Promise.all([first, second]);
  assert.equal(saved.error, null);
  assert.equal(rejected.error.code, 'TASK_STATE_CONFLICT');
  assert.equal(f.store.task(completed.task_id).revision, 2);
  const completedAgain = f.done(saved.result);
  const uncertainRequest = f.reopenInput(completedAgain);
  service.host.inspect = async () => ({ ready: true, node: true });
  const execute = f.store.executeLocal.bind(f.store);
  f.store.executeLocal = (...args) => { execute(...args); throw new Error('Response lost after commit'); };
  assert.equal((await service.execute('task_reopen', uncertainRequest)).error.code, 'OPERATION_UNCONFIRMED');
  f.store.executeLocal = execute;
  assert.equal((await service.execute('task_reopen', uncertainRequest)).result.revision, 3);
  assert.equal(f.store.read({ view: 'changelog', task_id: completed.task_id }).items.length, 3);
});
