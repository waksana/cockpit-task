import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activate } from '../src/task-board/module.js';
import { createHostAdapter } from '../src/task-board/host.js';
import { TOOL_NAMES } from '../src/task-board/contracts.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'task-board-module-'));
  const controller = new AbortController();
  const calls = [];
  const errors = [];
  let invalidations = 0;
  let meta = {
    sessionId: 'executor', status: 'idle', loaded: true, nativeProcessing: false,
    activeOperations: 0, queue: [], ask: null,
  };
  let capability = { sessionId: 'executor', ready: true, loaded: true, roles: [], reasons: [] };
  const host = {
    async call(name, body) {
      calls.push({ name, body });
      if (name === 'session/new') return { sessionId: 'executor' };
      if (name === 'session/get') return { meta };
      if (name === 'roles/readiness') return capability;
      if (name === 'prompt') return { ok: true, queued: false };
      assert.fail(`Unexpected host intent: ${name}`);
    },
  };
  const context = {
    apiVersion: 1, moduleId: 'task-board', dataRoot: root, host, signal: controller.signal,
    invalidate: () => { invalidations++; }, report: error => errors.push(error),
  };
  let module = activate(context);
  let request = 0;
  return {
    root, calls, errors, context, host,
    set meta(value) { meta = value; },
    get meta() { return meta; },
    set capability(value) { capability = value; },
    get invalidations() { return invalidations; },
    async read(taskId, view = 'execution') {
      return module.routes.find(route => route.path === '/read').handler({
        body: { task_id: taskId, view }, signal: controller.signal,
      });
    },
    async native(taskId) {
      return module.routes.find(route => route.path === '/tasks/:id/native').handler({
        params: { id: taskId }, signal: controller.signal,
      });
    },
    async write(name, input) {
      return module.routes.find(route => route.path === '/tools/:name').handler({
        params: { name }, body: { request_id: `op-${++request}`, actor_session_id: 'owner', ...input },
        signal: controller.signal,
      });
    },
    restart() { module.dispose(); module = activate(context); },
    close() { module.dispose(); rmSync(root, { recursive: true, force: true }); },
  };
}

test('module roles contain exactly the agreed tool subsets and only two role skills', () => {
  const manifest = JSON.parse(readFileSync(new URL('../cockpit.module.json', import.meta.url), 'utf8'));
  const [owner, executor] = manifest.roles;
  assert.deepEqual(owner.mcpServers.task.tools, ['task_read', 'task_create', 'task_session_create', 'task_assign', 'task_edit', 'task_cancel']);
  assert.deepEqual(executor.mcpServers.task.tools, ['task_read', 'task_edit', 'task_ack', 'task_report', 'task_cancel']);
  assert.deepEqual([...new Set([...owner.mcpServers.task.tools, ...executor.mcpServers.task.tools])].sort(), [...TOOL_NAMES].sort());
  assert.deepEqual(manifest.roles.flatMap(role => role.skillDirectories), ['skills/task-owner', 'skills/task-executor']);
});

test('module fails before opening storage when the host bridge is absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-board-no-host-'));
  try {
    assert.throws(() => activate({ apiVersion: 1, moduleId: 'task-board', dataRoot: root }), /requires.*host intents/);
    assert.equal(existsSync(join(root, 'task-board.sqlite')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('module HTTP and host bridge preserve registration, creation, assignment and cold reads', async () => {
  const f = fixture();
  try {
    const created = await f.write('task_create', { owner: 'owner', title: 'Integration', description: 'Complete the whole Task' });
    assert.equal(created.status, 200);
    const id = created.body.result.task_id;
    assert.deepEqual(f.calls, []);
    assert.equal((await f.native(id)).body.error.code, 'NO_EXECUTOR');
    const session = await f.write('task_session_create', { cwd: '/tmp' });
    assert.equal(session.body.result.operation.capability, 'ready');
    assert.deepEqual(f.calls[0], {
      name: 'session/new', body: { cwd: '/tmp', roles: [{ moduleId: 'task-board', roleId: 'executor' }] },
    });
    const execution = (await f.read(id)).body.result;
    const assigned = await f.write('task_assign', { task_id: id, revision: 1, executor: 'executor', write_context: execution.write_context });
    assert.equal(assigned.body.result.operation.message, 'accepted');
    assert.deepEqual(f.calls.filter(call => call.name === 'prompt'), [{
      name: 'prompt', body: { sessionId: 'executor', text: `[Task assigned to you](task:${id}?event=assigned)`, mode: 'enqueue' },
    }]);
    f.meta = { ...f.meta, loaded: false, status: 'unloaded' };
    const before = f.calls.length;
    const native = (await f.native(id)).body;
    assert.equal(native.loaded, false);
    assert.equal(native.available, true);
    assert.equal(native.source, 'native');
    assert.deepEqual(f.calls.slice(before), [{ name: 'session/get', body: { sessionId: 'executor' } }]);
    f.restart();
    assert.equal((await f.read(id)).body.result.executor, 'executor');
    assert.equal(f.invalidations, 3);
    assert.deepEqual(f.errors, []);
    assert.equal(existsSync(join(f.root, 'work.db')), false);
  } finally { f.close(); }
});

test('on-demand capability checks remain separate from native idle evidence and never load a session', async () => {
  const f = fixture();
  try {
    const adapter = createHostAdapter(f.host);
    assert.deepEqual(await adapter.inspect('executor'), {
      ready: true, idle: true, details: { reasons: [], loaded: true, status: 'idle' },
    });
    for (const patch of [
      { nativeProcessing: true }, { nativeProcessing: undefined }, { queue: undefined },
      { queue: [{ id: 'waiting' }] }, { activeOperations: 1 }, { activeOperations: undefined },
      { activeSubagents: 1 }, { ask: { requestId: 'question' } }, { closing: true },
    ]) {
      const original = f.meta;
      f.meta = { ...original, ...patch };
      const inspected = await adapter.inspect('executor');
      assert.equal(inspected.ready, true);
      assert.equal(inspected.idle, false);
      f.meta = original;
    }
    f.capability = { sessionId: 'executor', loaded: true, ready: false, roles: [], reasons: ['Missing role Skill'] };
    const unavailable = await adapter.inspect('executor');
    assert.equal(unavailable.ready, false);
    assert.equal(unavailable.idle, true);
    assert.ok(f.calls.every(call => ['session/get', 'roles/readiness'].includes(call.name)));
  } finally { f.close(); }
});

test('native observations do not collect capabilities and explicit checks do not reuse old readiness', async () => {
  const f = fixture();
  try {
    const adapter = createHostAdapter(f.host);
    await adapter.observe('executor');
    assert.deepEqual(f.calls.map(call => call.name), ['session/get']);
    assert.equal((await adapter.inspect('executor')).ready, true);
    f.capability = { sessionId: 'executor', loaded: true, ready: false, roles: [], reasons: ['MCP disconnected'] };
    assert.equal((await adapter.inspect('executor')).ready, false);
    await adapter.observe('executor');
    assert.deepEqual(f.calls.map(call => call.name), [
      'session/get', 'roles/readiness', 'session/get', 'roles/readiness', 'session/get', 'session/get',
    ]);
  } finally { f.close(); }
});

test('native observation distinguishes a missing session and an unavailable host', async () => {
  const f = fixture();
  try {
    const id = (await f.write('task_create', { owner: 'owner', title: 'Native', description: 'Observe current state' })).body.result.task_id;
    const task = (await f.read(id)).body.result;
    await f.write('task_assign', { task_id: id, executor: 'executor', revision: 1, write_context: task.write_context });
    f.meta = null;
    const missing = (await f.native(id)).body;
    assert.equal(missing.available, false);
    assert.equal(missing.loaded, null);
    assert.equal(missing.error.code, 'SESSION_NOT_FOUND');
    f.host.call = async () => { throw new Error('Synthetic host unavailable'); };
    const unavailable = (await f.native(id)).body;
    assert.equal(unavailable.available, false);
    assert.equal(unavailable.error.code, 'NATIVE_UNAVAILABLE');
    assert.equal(f.errors.length, 1);
    const invalid = await f.native('invalid-id');
    assert.equal(invalid.status, 400);
  } finally { f.close(); }
});
