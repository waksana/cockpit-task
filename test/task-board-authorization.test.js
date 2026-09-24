import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskStore } from '../src/task-board/store.js';
import { TaskService } from '../src/task-board/service.js';

function fixture(t) {
  const root = join(process.cwd(), '.task-board-tests', randomUUID());
  mkdirSync(root, { recursive: true });
  const store = new TaskStore(root);
  const sent = [], inspected = [];
  const service = new TaskService(store, {
    sessionExists: async () => true,
    inspect: async id => { inspected.push(id); return { ready: true, idle: true, node: true }; },
    send: async (session, text, options = {}) => { sent.push({ session, text, mode: options.mode ?? 'enqueue' }); return { ok: true }; },
  });
  let scriptCount = 0;
  t.after(async () => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const as = (actor, name, input, options = {}) => service.execute(name, { actor, request_id: randomUUID(), ...input }, options);
  const context = id => ({ task_id: id, write_context: store.task(id).write_context, revision: store.task(id).revision });
  async function create(actor = 'orchestrator', fields = {}) {
    const created = await as(actor, 'task_create', { title: 'Auth target', description: 'Requirements', ...fields });
    assert.equal(created.error, null, JSON.stringify(created.error));
    return created.result;
  }
  async function assign(task, actor = 'orchestrator', assignee = 'assignee') {
    const assigned = await as(actor, 'task_assign', { ...context(task.task_id), assignee });
    assert.equal(assigned.error, null, JSON.stringify(assigned.error));
    return store.task(task.task_id);
  }
  async function ack(task, actor = 'assignee') {
    const result = await as(actor, 'task_ack', context(task.task_id));
    assert.equal(result.error, null, JSON.stringify(result.error));
    return result.result;
  }
  async function done(task, actor = 'assignee', retro = null) {
    await ack(task, actor);
    const result = await as(actor, 'task_report', { ...context(task.task_id), status: 'done', outcome: { summary: 'Delivered' }, retro });
    assert.equal(result.error, null, JSON.stringify(result.error));
    return result.result;
  }
  async function automationTask() {
    const script_id = `auth-script-${++scriptCount}`;
    const script = join(root, `${script_id}.mjs`);
    writeFileSync(script, 'process.exit(0);\n');
    assert.equal((await as('orchestrator', 'task_script_register', {
      script_id, title: 'Auth script', description: 'Synthetic script',
      executable: process.execPath, script_path: script, argv: [], parameters: [],
    })).error, null);
    return create('orchestrator', { automation: { script_id, parameters: {} } });
  }
  return { root, store, service, sent, inspected, as, context, create, assign, ack, done, automationTask };
}

test('relationship permissions allow the right actor and reject third parties without saving effects', async t => {
  const f = fixture(t);

  const assignTarget = await f.create();
  assert.equal((await f.as('third', 'task_assign', { ...f.context(assignTarget.task_id), assignee: 'worker' })).error.code, 'ORCHESTRATOR_REQUIRED');
  assert.equal(f.store.task(assignTarget.task_id).assignee, null);
  assert.equal((await f.as('user', 'task_assign', { ...f.context(assignTarget.task_id), assignee: 'worker' })).error, null, 'Web user counts as orchestrator');

  const ackTarget = await f.assign(await f.create(), 'orchestrator', 'ack-assignee');
  assert.equal((await f.as('third', 'task_ack', f.context(ackTarget.task_id))).error.code, 'ASSIGNEE_REQUIRED');
  assert.equal(f.store.task(ackTarget.task_id).acknowledged_revision, null);
  await f.ack(ackTarget, 'ack-assignee');
  assert.equal(f.store.task(ackTarget.task_id).acknowledged_revision, 1);

  const reportTarget = await f.assign(await f.create(), 'orchestrator', 'report-assignee');
  await f.ack(reportTarget, 'report-assignee');
  assert.equal((await f.as('third', 'task_report', { ...f.context(reportTarget.task_id), activity: { text: 'nope' } })).error.code, 'ASSIGNEE_REQUIRED');
  assert.equal(f.store.read({ view: 'activity', task_id: reportTarget.task_id }).items.length, 0);
  assert.equal((await f.as('report-assignee', 'task_report', { ...f.context(reportTarget.task_id), activity: { text: 'allowed' } })).error, null);

  const editTarget = await f.assign(await f.create(), 'orchestrator', 'edit-assignee');
  assert.equal((await f.as('third', 'task_edit', { ...f.context(editTarget.task_id), reason: 'bad', title: 'Bad' })).error.code, 'ORCHESTRATOR_OR_ASSIGNEE_REQUIRED');
  assert.equal(f.store.task(editTarget.task_id).title, 'Auth target');
  assert.equal((await f.as('orchestrator', 'task_edit', { ...f.context(editTarget.task_id), reason: 'ok', title: 'By orchestrator' })).error, null);
  assert.equal((await f.as('edit-assignee', 'task_edit', { ...f.context(editTarget.task_id), reason: 'ok', title: 'By assignee' })).error, null);

  const cancelTarget = await f.assign(await f.create(), 'orchestrator', 'cancel-assignee');
  assert.equal((await f.as('third', 'task_cancel', { task_id: cancelTarget.task_id, write_context: f.store.task(cancelTarget.task_id).write_context, reason: 'bad' })).error.code, 'ORCHESTRATOR_OR_ASSIGNEE_REQUIRED');
  assert.equal(f.store.task(cancelTarget.task_id).status, 'todo');
  assert.equal((await f.as('cancel-assignee', 'task_cancel', { task_id: cancelTarget.task_id, write_context: f.store.task(cancelTarget.task_id).write_context, reason: 'ok' })).error, null);

  const reopenTarget = await f.done(await f.assign(await f.create()));
  assert.equal((await f.as('third', 'task_reopen', { ...f.context(reopenTarget.task_id), description: 'Rework', reason: 'bad' })).error.code, 'ORCHESTRATOR_OR_ASSIGNEE_REQUIRED');
  assert.equal(f.store.task(reopenTarget.task_id).status, 'done');
  assert.equal((await f.as('orchestrator', 'task_reopen', { ...f.context(reopenTarget.task_id), description: 'Rework', reason: 'ok' })).error, null);

  const autoStart = await f.automationTask();
  assert.equal((await f.as('third', 'task_automation_start', f.context(autoStart.task_id))).error.code, 'ORCHESTRATOR_REQUIRED');
  assert.equal(f.store.task(autoStart.task_id).automation.state, 'created');
  const autoReconcile = await f.automationTask();
  f.store.automation.claim(autoReconcile.task_id);
  assert.equal((await f.as('third', 'task_automation_reconcile', {
    task_id: autoReconcile.task_id, write_context: f.store.task(autoReconcile.task_id).write_context, reason: 'bad',
  })).error.code, 'ORCHESTRATOR_REQUIRED');
});

test('unrestricted operations accept non-orchestrators and user subscriptions target the orchestrator', async t => {
  const f = fixture(t);
  const task = await f.create();
  assert.equal((await f.service.execute('task_read', { view: 'overview', task_id: task.task_id }, { actor: 'third' })).error, null);
  assert.equal((await f.service.execute('task_script_read', {}, { actor: 'third' })).error, null);
  const subscribed = await f.as('third', 'task_subscribe', {
    task_id: task.task_id, write_context: f.store.task(task.task_id).write_context, statuses: ['cancelled'],
  });
  assert.equal(subscribed.error, null);
  assert.equal(subscribed.result.subscription.subscriber, 'third');
  const web = await f.as('user', 'task_subscribe', {
    task_id: task.task_id, write_context: f.store.task(task.task_id).write_context, statuses: ['done'],
  });
  assert.equal(web.error, null);
  assert.equal(web.result.subscription.subscriber, 'orchestrator');

  const retroTask = await f.done(await f.assign(await f.create(), 'orchestrator', 'retro-assignee'), 'retro-assignee', 'Finding to handle');
  const outcomeId = f.store.read({ view: 'outcomes', task_id: retroTask.task_id }).items[0].id;
  const handled = await f.as('third', 'task_retro_handle', { task_id: retroTask.task_id, outcome_id: outcomeId, status: 'fixed', note: 'Handled by observer' });
  assert.equal(handled.error, null);
  assert.equal(handled.result.handling.author, 'third');
});

test('subagent invocations act as their containing session for assignee-only operations', async t => {
  const f = fixture(t);
  const task = await f.assign(await f.create());
  const input = { task_id: task.task_id, write_context: f.store.task(task.task_id).write_context, revision: 1 };
  const allowed = await f.service.execute('task_ack', { request_id: 'ack-subagent', ...input }, {
    external: true,
    invocation: { sessionId: 'assignee', runtimeSessionId: 'assignee-worker', subagent: true },
  });
  assert.equal(allowed.error, null, JSON.stringify(allowed.error));
  assert.equal(f.store.task(task.task_id).acknowledged_revision, 1);
  const rejected = await f.service.execute('task_report', { request_id: 'report-subagent', ...input, activity: { text: 'wrong container' } }, {
    external: true,
    invocation: { sessionId: 'other-session', runtimeSessionId: 'other-worker', subagent: true },
  });
  assert.equal(rejected.error.code, 'ASSIGNEE_REQUIRED');
  assert.equal(f.store.read({ view: 'activity', task_id: task.task_id }).items.length, 0);
});
