import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/task-board/store.js';
import { TaskService } from '../src/task-board/service.js';

function fixture(t, inspect = async () => ({ ready: true, node: true, idle: false })) {
  const directory = mkdtempSync(join(tmpdir(), 'task-root-claim-'));
  const store = new TaskStore(directory);
  const inspections = [], sends = [];
  const service = new TaskService(store, {
    inspect: async session => { inspections.push(session); return inspect(session); },
    sessionExists: async () => true,
    send: async (...args) => { sends.push(args); return { ok: true }; },
  });
  t.after(() => { service.close(); rmSync(directory, { recursive: true, force: true }); });
  let sequence = 0;
  const call = (name, input, actor) => service.execute(name, {
    request_id: `claim-test-${++sequence}`, ...input,
  }, { invocation: { sessionId: actor, runtimeSessionId: actor, subagent: false }, external: true });
  const context = task_id => {
    const task = store.task(task_id);
    return { task_id, revision: task.revision, write_context: task.write_context };
  };
  const root = async (actor = 'registrar') => {
    const result = await call('task_create', { title: 'Root responsibility', description: 'A bounded authorized result' }, actor);
    assert.equal(result.error, null);
    return result.result.task_id;
  };
  return { store, service, inspections, sends, call, context, root };
}

test('a busy calling Node can claim an ordinary root without self-dispatch or creator authority', async t => {
  const f = fixture(t);
  const id = await f.root();
  const unauthorized = await f.call('task_edit', { ...f.context(id), title: 'Attempted control', reason: 'Creator is not a manager' }, 'registrar');
  assert.ok(unauthorized.error, 'Registration must not grant ongoing management rights');
  const input = { ...f.context(id), request_id: 'stable-claim' };
  const claimed = await f.call('task_claim', input, 'responsible');
  assert.equal(claimed.error, null);
  const task = f.store.task(id);
  assert.equal(task.created_by, 'registrar');
  assert.equal(task.assignee, 'responsible');
  assert.equal(task.parent_task_id, null);
  assert.equal(task.parent_assignee, null);
  assert.equal(task.status, 'todo');
  assert.equal(task.work_mode, 'undecided');
  assert.equal(task.acknowledged_revision, null);
  assert.equal(Object.hasOwn(task, 'orchestrator'), false);
  assert.deepEqual(f.inspections, ['responsible']);
  assert.deepEqual(f.sends, []);
  const replay = await f.call('task_claim', input, 'responsible');
  assert.equal(replay.error, null);
  assert.deepEqual(replay.result, claimed.result);
  assert.deepEqual(f.inspections, ['responsible'], 'A finalized claim does not inspect or bind again');
  assert.equal((await f.call('task_ack', f.context(id), 'responsible')).error, null);
  assert.equal((await f.call('task_start', { ...f.context(id), work_mode: 'execute' }, 'responsible')).error, null);
  assert.equal(f.store.task(id).work_mode, 'execute');
  assert.deepEqual(f.sends, [], 'Starting does not dispatch to oneself or alter native mode');
});

test('claim fails closed on missing Node capability without binding or sending', async t => {
  const f = fixture(t, async () => ({ ready: true, node: false, idle: true }));
  const id = await f.root();
  const result = await f.call('task_claim', f.context(id), 'not-a-node');
  assert.equal(result.error?.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(f.store.task(id).assignee, null);
  assert.deepEqual(f.sends, []);
});

test('claim rechecks the root after awaited readiness so concurrent claims cannot overwrite a binding', async t => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture(t, async actor => {
    if (actor === 'slow') { entered(); await blocked; }
    return { ready: true, node: true, idle: false };
  });
  const id = await f.root();
  const input = f.context(id);
  const slow = f.call('task_claim', input, 'slow');
  await waiting;
  const fast = await f.call('task_claim', input, 'fast');
  assert.equal(fast.error, null);
  release();
  const loser = await slow;
  assert.ok(loser.error);
  assert.equal(f.store.task(id).assignee, 'fast');
  assert.deepEqual(f.sends, []);
});

test('claim cannot occupy two roots and host metadata cannot be overridden by tool fields', async t => {
  const f = fixture(t);
  const first = await f.root(), second = await f.root();
  assert.equal((await f.call('task_claim', f.context(first), 'responsible')).error, null);
  assert.ok((await f.call('task_claim', f.context(second), 'responsible')).error);
  assert.equal(f.store.task(second).assignee, null);
  const forged = await f.call('task_claim', { ...f.context(second), actor: 'responsible' }, 'intruder');
  assert.equal(forged.error?.code, 'INVALID_INPUT');
  assert.equal(f.store.task(second).assignee, null);
});

test('claim does not bind a session while another operation is preparing its resources', async t => {
  const f = fixture(t);
  const id = await f.root();
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const preparation = f.service.withSessionOperation('responsible', async () => { entered(); await held; });
  await waiting;
  const blocked = await f.call('task_claim', f.context(id), 'responsible');
  assert.equal(blocked.error?.code, 'SESSION_OPERATION_IN_PROGRESS');
  assert.equal(f.store.task(id).assignee, null);
  assert.deepEqual(f.inspections, []);
  release();
  await preparation;
  assert.equal((await f.call('task_claim', f.context(id), 'responsible')).error, null);
});

test('claim rechecks cancellation after a host observation', async t => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const f = fixture(t, async () => {
    entered();
    await held;
    return { ready: true, node: true, idle: false };
  });
  const id = await f.root();
  const pending = f.call('task_claim', f.context(id), 'responsible');
  await waiting;
  const request = await f.service.execute('task_cancel', {
    request_id: 'valid-cancel-during-claim', task_id: id,
    write_context: f.context(id).write_context, reason: 'User abandoned the result',
  }, { actor: 'user', external: true });
  assert.equal(request.error, null);
  release();
  const result = await pending;
  assert.ok(result.error);
  assert.equal(f.store.task(id).assignee, null);
  assert.equal(f.store.task(id).status, 'todo');
  assert.ok(f.store.task(id).cancellation_request);
  assert.deepEqual(f.sends, []);
});

test('reopen preserves session preparation exclusivity while binding receipts remain replayable', async t => {
  const f = fixture(t);
  const id = await f.root();
  const claim = { ...f.context(id), request_id: 'claim-before-completion' };
  const claimed = await f.call('task_claim', claim, 'responsible');
  assert.equal(claimed.error, null);
  assert.equal((await f.call('task_ack', f.context(id), 'responsible')).error, null);
  assert.equal((await f.call('task_start', { ...f.context(id), work_mode: 'execute' }, 'responsible')).error, null);
  assert.equal((await f.call('task_report', {
    ...f.context(id), status: 'done', outcome: { summary: 'Initial responsibility delivered' }, retro: null,
  }, 'responsible')).error, null);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const preparation = f.service.withSessionOperation('responsible', () => held);
  const input = { ...f.context(id), description: 'Authorized rework', reason: 'User requested another revision' };
  const blocked = await f.call('task_reopen', input, 'responsible');
  assert.equal(blocked.error?.code, 'SESSION_OPERATION_IN_PROGRESS');
  assert.equal(f.store.task(id).status, 'done');
  const replay = await f.call('task_claim', claim, 'responsible');
  assert.equal(replay.error, null);
  assert.deepEqual(replay.result, claimed.result);
  assert.deepEqual(f.inspections, ['responsible']);
  release();
  await preparation;
  assert.equal((await f.call('task_reopen', input, 'responsible')).error, null);
  assert.equal(f.store.task(id).status, 'in_progress');
});
