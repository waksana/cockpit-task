import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/task-board/store.js';
import { TaskService } from '../src/task-board/service.js';
import { parseInput } from '../src/task-board/contracts.js';
import { createHostAdapter } from '../src/task-board/host.js';

const prepared = (sessionId = 'executor', patch = {}) => ({
  sessionId, ok: true, skills: [], mcpServers: [], tools: 'unchanged', ...patch,
});

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'task-preparation-'));
  const calls = [];
  const store = new TaskStore(directory);
  const host = {
    preparationSupported: true,
    create: async () => { calls.push('create'); return { sessionId: 'executor' }; },
    inspect: async () => { calls.push('inspect'); return { ready: true, idle: true, executor: true }; },
    prepare: async (id, input) => { calls.push({ id, skills: input.skills, mcp_servers: input.mcp_servers }); return prepared(id); },
    send: async () => { calls.push('send'); return { ok: true, queued: false }; },
    ...overrides,
  };
  const service = new TaskService(store, host, { report: error => assert.fail(error.stack) });
  let sequence = 0;
  const write = (name, input) => service.execute(name, {
    actor_session_id: 'owner', request_id: `preparation-${++sequence}`, ...input,
  });
  t.after(() => { service.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, service, host, calls, write, directory };
}

test('create and existing preparation share explicit resources without Task binding or messages', async t => {
  const f = fixture(t);
  const selections = { skills: ['synthetic-work'], mcp_servers: [{ name: 'synthetic-tools', tools: ['read'] }] };
  for (const [name, target] of [
    ['task_session_create', { cwd: '/synthetic' }],
    ['task_session_prepare', { session_id: 'executor' }],
  ]) {
    const result = await f.write(name, { ...target, ...selections });
    assert.equal(result.error, null);
    assert.equal(result.result.operation.preparation, 'prepared');
    assert.equal(result.result.operation.capability, 'ready');
    assert.equal(result.result.operation.session_id, 'executor');
    assert.deepEqual(result.result.operation.resources, prepared());
  }
  assert.equal(f.calls.filter(call => call === 'create').length, 1);
  assert.equal(f.calls.filter(call => call === 'send').length, 0);
  assert.deepEqual(f.calls.filter(call => typeof call === 'object'), [
    { id: 'executor', ...selections }, { id: 'executor', ...selections },
  ]);
  assert.deepEqual(f.store.read({ view: 'list', executor: 'executor' }).items, []);
});

test('old host rejects explicit preparation before creation but retains omitted-resource creation', async t => {
  const f = fixture(t, { preparationSupported: false });
  for (const [name, input] of [
    ['task_session_create', { cwd: '/synthetic', skills: [] }],
    ['task_session_prepare', { session_id: 'executor' }],
  ]) {
    const result = await f.write(name, input);
    assert.equal(result.error.code, 'PREPARATION_UNSUPPORTED');
    assert.equal(result.result.operation.status, 'rejected');
    assert.deepEqual(f.calls, []);
  }
  const legacy = await f.write('task_session_create', { cwd: '/synthetic' });
  assert.equal(legacy.error, null);
  assert.equal(Object.hasOwn(legacy.result.operation, 'preparation'), false);
  assert.deepEqual(f.calls, ['create', 'inspect']);
});

test('preparation rejects busy, unloaded and unapplied roles without native mutation', async t => {
  const f = fixture(t);
  for (const state of [
    { ready: true, idle: false, executor: true },
    { ready: false, idle: false, executor: false },
    { ready: false, idle: true, executor: false },
  ]) {
    f.host.inspect = async () => state;
    const result = await f.write('task_session_prepare', { session_id: 'executor' });
    assert.equal(result.error.code, state.idle ? 'EXECUTOR_ROLE_REQUIRED' : 'EXECUTOR_NOT_READY');
    assert.equal(result.result.operation.preparation, 'not_prepared');
    assert.deepEqual(f.calls, []);
  }
});

test('unfinished Task excludes preparation even when idle; completed Executor can be prepared', async t => {
  const f = fixture(t);
  const created = await f.write('task_create', { owner: 'owner', title: 'Synthetic', description: 'Complete one result' });
  const taskId = created.result.task_id;
  await f.write('task_assign', { task_id: taskId, revision: 1, executor: 'executor', write_context: created.result.write_context });
  const before = f.calls.length;
  const rejected = await f.write('task_session_prepare', { session_id: 'executor' });
  assert.equal(rejected.error.code, 'EXECUTOR_OCCUPIED');
  assert.equal(f.calls.length, before, 'Reject responsibility conflict before host observation or mutation');
  const context = f.store.task(taskId).write_context;
  await f.write('task_ack', { task_id: taskId, revision: 1, write_context: context, actor_session_id: 'executor' });
  await f.write('task_report', {
    task_id: taskId, revision: 1, write_context: context, actor_session_id: 'executor',
    status: 'done', outcome: { summary: 'Synthetic complete result' }, retro: null,
  });
  assert.equal((await f.write('task_session_prepare', { session_id: 'executor' })).error, null);
});

test('native partial effects and creation ID survive readiness failures and replay', async t => {
  const native = prepared('executor', {
    ok: false, skills: [{ name: 'synthetic-work', effect: 'enabled', enabled: true }],
    mcpServers: [{ name: 'synthetic-tools', effect: 'unconfirmed', enabled: null, status: null, tools: null }],
    tools: 'not_attempted', error: 'Native connector result unknown',
  });
  const f = fixture(t, { prepare: async () => native });
  const input = { actor_session_id: 'owner', request_id: 'partial-create', cwd: '/synthetic', skills: ['synthetic-work'] };
  const first = await f.service.execute('task_session_create', input);
  assert.equal(first.error.code, 'RESOURCE_PREPARATION_FAILED');
  assert.equal(first.result.operation.status, 'unconfirmed');
  assert.equal(first.result.operation.creation, 'created');
  assert.equal(first.result.operation.session_id, 'executor');
  assert.deepEqual(first.result.operation.resources, native);
  f.host.create = f.host.prepare = f.host.inspect = () => assert.fail('Replay cannot repeat host work');
  assert.deepEqual((await f.service.execute('task_session_create', input)).result, first.result);
  assert.deepEqual(f.store.operation(input.request_id).result, first.result);
});

test('lost preparation result remains durable unknown with no retry after restart', async t => {
  const f = fixture(t, { prepare: async () => { throw new Error('Lost native response'); } });
  const input = { actor_session_id: 'owner', request_id: 'unknown-prepare', session_id: 'executor' };
  const first = await f.service.execute('task_session_prepare', input);
  assert.equal(first.result.operation.preparation, 'unknown');
  assert.equal(first.result.operation.status, 'unconfirmed');
  f.service.close();
  const restarted = new TaskService(new TaskStore(f.directory), {
    prepare: () => assert.fail('Unknown preparation cannot repeat after restart'),
  });
  try {
    assert.deepEqual((await restarted.execute('task_session_prepare', input)).result, first.result);
    const changed = await restarted.execute('task_session_prepare', { ...input, skills: [] });
    assert.equal(changed.error.code, 'REQUEST_ID_CONFLICT');
  } finally { restarted.close(); }
});

test('initial null metadata can be prepared; native success still needs final Executor readiness', async t => {
  const f = fixture(t);
  for (const after of [{ ready: false, idle: true }, { ready: true, idle: false }, { ready: true, idle: true }]) {
    let inspections = 0;
    f.host.inspect = async () => ++inspections === 1
      ? { ready: false, idle: true, executor: true, details: { reasons: ['Native metadata uninitialized'] } }
      : { ...after, executor: true };
    const outcome = await f.write('task_session_prepare', { session_id: 'executor' });
    assert.equal(outcome.result.operation.preparation, 'prepared');
    assert.equal(outcome.result.operation.status, after.ready && after.idle ? 'applied' : 'partially_applied');
    assert.equal(outcome.error?.code ?? null, !after.ready ? 'CAPABILITY_UNAVAILABLE' : !after.idle ? 'EXECUTOR_NOT_READY' : null);
  }
});

test('cancellation before resource mutation preserves a newly created ID', async t => {
  const controller = new AbortController();
  const f = fixture(t, {
    inspect: async () => { controller.abort(); return { ready: false, executor: true, idle: true }; },
  });
  const result = await f.service.execute('task_session_create', {
    actor_session_id: 'owner', request_id: 'cancel-created', cwd: '/synthetic', skills: [],
  }, { signal: controller.signal });
  assert.equal(result.error.code, 'REQUEST_CANCELLED');
  assert.equal(result.result.operation.creation, 'created');
  assert.equal(result.result.operation.session_id, 'executor');
  assert.equal(result.result.operation.status, 'partially_applied');
  assert.deepEqual(f.calls, ['create']);
});

test('cancellation after creation or an admitted preparation stops the next observation, not known effects', async t => {
  for (const phase of ['creation', 'preparation']) {
    await t.test(phase, async t => {
      const controller = new AbortController();
      let inspections = 0;
      const f = fixture(t, {
        create: async () => {
          if (phase === 'creation') controller.abort();
          return { sessionId: 'executor' };
        },
        inspect: async () => { inspections++; return { ready: true, idle: true, executor: true }; },
        prepare: async () => { controller.abort(); return prepared(); },
      });
      const result = await f.service.execute('task_session_create', {
        actor_session_id: 'owner', request_id: `cancel-${phase}`, cwd: '/synthetic', skills: [],
      }, { signal: controller.signal });
      assert.equal(result.error.code, 'REQUEST_CANCELLED');
      assert.equal(result.result.operation.creation, 'created');
      assert.equal(result.result.operation.status, 'partially_applied');
      assert.equal(result.result.operation.preparation, phase === 'creation' ? 'not_prepared' : 'prepared');
      assert.equal(inspections, phase === 'creation' ? 0 : 1);
      if (phase === 'preparation') assert.deepEqual(result.result.operation.resources, prepared());
    });
  }
});

test('preparation and assignment reject concurrent same-target work without duplicate effects', async t => {
  const f = fixture(t);
  const created = await f.write('task_create', { owner: 'owner', title: 'Concurrent', description: 'Complete one result' });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  let release;
  f.host.prepare = async () => { started(); return new Promise(resolve => { release = resolve; }); };
  const pending = f.write('task_session_prepare', { session_id: 'executor' });
  await entered;
  const competing = await f.write('task_session_prepare', { session_id: 'executor' });
  assert.equal(competing.error.code, 'EXECUTOR_OPERATION_IN_PROGRESS');
  const assignment = await f.write('task_assign', {
    task_id: created.result.task_id, revision: 1, executor: 'executor', write_context: created.result.write_context,
  });
  assert.equal(assignment.error.code, 'EXECUTOR_OPERATION_IN_PROGRESS');
  assert.equal(assignment.result.operation.assignment, 'not_applied');
  assert.equal(f.store.task(created.result.task_id).executor, null);
  release(prepared());
  assert.equal((await pending).error, null);
  f.host.prepare = async () => prepared();
  assert.equal((await f.write('task_session_prepare', { session_id: 'executor' })).result.operation.status, 'applied');
});

test('resource inputs reject unknown fields and duplicate selections without expanding authority', () => {
  const input = { actor_session_id: 'owner', request_id: 'schema', session_id: 'executor' };
  for (const patch of [
    { skills: ['same', 'same'] }, { skills: [' '] },
    { mcp_servers: [{ name: 'same' }, { name: 'same' }] },
    { mcp_servers: [{ name: 'tools', tools: ['read', 'read'] }] },
    { mcp_servers: [{ name: 'tools', tools: ['*'] }] },
    { mcp_servers: [{ name: 'tools', url: 'https://unapproved.invalid' }] },
    { task_id: 'not-a-preparation-mode' }, { model: 'unselected' }, { roles: [] },
  ]) assert.throws(() => parseInput('task_session_prepare', { ...input, ...patch }), { code: 'INVALID_INPUT' });
});

test('an admitted assignment excludes preparation even before the Task is bound', async t => {
  const f = fixture(t);
  const created = await f.write('task_create', { owner: 'owner', title: 'Reserved assignment', description: 'One result' });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  let reads = 0;
  f.host.inspect = async () => {
    if (++reads === 1) {
      entered();
      await new Promise(resolve => { release = resolve; });
    }
    return { ready: true, idle: true, executor: true };
  };
  const pending = f.write('task_assign', {
    task_id: created.result.task_id, revision: 1, executor: 'executor', write_context: created.result.write_context,
  });
  await started;
  const result = await f.write('task_session_prepare', { session_id: 'executor' });
  assert.equal(result.error.code, 'EXECUTOR_OPERATION_IN_PROGRESS');
  assert.equal(f.store.task(created.result.task_id).executor, null);
  assert.deepEqual(f.calls, []);
  release();
  assert.equal((await pending).result.operation.message, 'accepted');
});

test('unknown host receipts are not accepted as successful preparation', async t => {
  const f = fixture(t);
  for (const receipt of [null, { ok: true }, prepared('other'), prepared('executor', { tools: 'pending' })]) {
    f.host.prepare = async () => receipt;
    const result = await f.write('task_session_prepare', { session_id: 'executor' });
    assert.equal(result.error.code, 'PREPARATION_UNCONFIRMED');
    assert.equal(result.result.operation.preparation, 'unknown');
    assert.equal(result.result.operation.status, 'unconfirmed');
  }
});

test('pending preparation replay retains the target ID without another observation or mutation', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  let inspections = 0;
  const f = fixture(t, {
    inspect: async () => {
      if (++inspections === 1) {
        entered();
        await new Promise(resolve => { release = resolve; });
      }
      return { ready: true, idle: true, executor: true };
    },
  });
  const input = { actor_session_id: 'owner', request_id: 'pending-prepare', session_id: 'executor' };
  const pending = f.service.execute('task_session_prepare', input);
  await started;
  const replay = await f.service.execute('task_session_prepare', input);
  assert.equal(replay.error.code, 'OPERATION_UNCONFIRMED');
  assert.equal(replay.result.operation.session_id, 'executor');
  assert.equal(replay.result.operation.preparation, 'not_prepared');
  assert.equal(inspections, 1);
  assert.deepEqual(f.calls, []);
  release();
  assert.equal((await pending).error, null);
});

test('host adapter exposes preparation capability and maps only selected public resources', async () => {
  const calls = [];
  const host = {
    resourcePreparationVersion: 1,
    call: async (name, body) => {
      calls.push({ name, body });
      if (name === 'session/resources-prepare') return prepared(body.sessionId);
      if (name === 'roles/readiness') return {
        sessionId: 'executor', ready: false, loaded: true, rolesNeedReload: false,
        appliedRoles: [{ moduleId: 'cockpit-task', roleId: 'executor' }], reasons: ['Native metadata uninitialized'],
      };
      if (name === 'session/get') return { meta: {
        sessionId: 'executor', loaded: true, status: 'idle', nativeProcessing: false, activeOperations: 0, queue: [],
      } };
      assert.fail(name);
    },
  };
  const adapter = createHostAdapter(host);
  assert.equal(adapter.preparationSupported, true);
  const observed = await adapter.inspect('executor');
  assert.equal(observed.executor, true);
  assert.equal(observed.ready, false);
  await adapter.prepare('executor', { skills: ['synthetic-work'], mcp_servers: [{ name: 'tools', tools: ['read'] }] });
  assert.deepEqual(calls.at(-1), {
    name: 'session/resources-prepare',
    body: { sessionId: 'executor', skills: ['synthetic-work'], mcpServers: [{ name: 'tools', tools: ['read'] }] },
  });
  assert.equal(createHostAdapter({ call() {} }).preparationSupported, false);
});
