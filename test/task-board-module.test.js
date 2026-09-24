import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  let capability = { sessionId: 'executor', ready: true, loaded: true, roles: [], reasons: [],
    rolesNeedReload: false, appliedRoles: [{ moduleId: 'cockpit-task', roleId: 'node' }] };
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
    apiVersion: 1, serviceReadyVersion: 1, moduleId: 'cockpit-task', dataRoot: root, host, signal: controller.signal,
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
    async read(taskId, view = 'execution', fields = {}) {
      return module.routes.find(route => route.path === '/read').handler({
        body: { task_id: taskId, view, ...fields }, signal: controller.signal,
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

test('HTTP completion requires explicit valid retro with atomic effects and durable detail reads', async () => {
  const f = fixture();
  try {
    for (const retro of [null, 'A useful automation candidate.']) {
      const create = await f.write('task_create', { title: 'Retro', description: 'Synthetic only', owner: 'owner' });
      const id = create.body.result.task_id;
      let task = (await f.read(id)).body.result;
      await f.write('task_assign', { task_id: id, revision: 1, executor: 'executor', write_context: task.write_context });
      task = (await f.read(id)).body.result;
      const base = { task_id: id, revision: 1, write_context: task.write_context };
      await f.write('task_ack', base);
      const report = { ...base, status: 'done', outcome: { summary: 'Delivered' }, activity: { text: 'Final activity' } };
      for (const value of [undefined, '', ' \n', true, {}, 'r'.repeat(2001)]) {
        const response = await f.write('task_report', { ...report, ...(value === undefined ? {} : { retro: value }) });
        assert.equal(response.status, 400);
        assert.equal(response.body.error.code, 'INVALID_INPUT');
      }
      assert.equal((await f.read(id)).body.result.status, 'todo');
      assert.equal((await f.read(id, 'outcomes')).body.result.items.length, 0);
      assert.equal((await f.read(id, 'activity')).body.result.items.length, 0);
      assert.equal((await f.write('task_report', { ...report, retro })).body.result.retro.status, 'saved');
      f.restart();
      assert.equal((await f.read(id)).body.result.retro.text, retro);
      const outcome = (await f.read(id, 'outcomes')).body.result.items[0];
      assert.equal(outcome.retro.text, retro);
      assert.equal(outcome.summary, 'Delivered');
    }
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('HTTP reopen checks real host readiness while the Executor is running and does not dispatch', async () => {
  const f = fixture();
  try {
    const created = (await f.write('task_create', { owner: 'owner', title: 'Reopen', description: 'Agreement' })).body.result;
    await f.write('task_assign', { task_id: created.task_id, revision: 1, write_context: created.write_context, executor: 'executor' });
    const task = (await f.read(created.task_id)).body.result;
    const base = { task_id: task.id, revision: 1, write_context: task.write_context, actor_session_id: 'executor' };
    await f.write('task_ack', base);
    const completed = (await f.write('task_report', { ...base, status: 'done', outcome: { summary: 'Original result' }, retro: null })).body.result;
    f.meta = { ...f.meta, status: 'running', nativeProcessing: true, activeOperations: 1 };
    const before = f.calls.length, invalidations = f.invalidations;
    const reopened = await f.write('task_reopen', {
      ...base, write_context: completed.write_context, description: 'Revised agreement', reason: 'Explicit user request',
    });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.result.revision, 2);
    assert.equal(reopened.body.result.task_status, 'in_progress');
    assert.equal(reopened.body.definition_check.tasks[0].needs_ack, false);
    assert.deepEqual(f.calls.slice(before).map(call => call.name), ['roles/readiness', 'session/get']);
    assert.equal(f.invalidations, invalidations + 1);
    f.restart();
    const current = (await f.read(task.id)).body.result;
    assert.equal(current.description, 'Revised agreement');
    assert.equal(current.retro.current, false);
    assert.equal((await f.read(task.id, 'outcomes')).body.result.items[0].current, false);
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('HTTP selective reads preserve legacy defaults, errors, revision checks and exact chosen groups', async () => {
  const f = fixture();
  try {
    const create = await f.write('task_create', { title: 'Selective HTTP', description: 'Synthetic only', owner: 'owner' });
    const id = create.body.result.task_id;
    let task = (await f.read(id)).body.result;
    await f.write('task_assign', { task_id: id, revision: 1, executor: 'executor', write_context: task.write_context });
    task = (await f.read(id)).body.result;
    const base = { task_id: id, revision: 1, write_context: task.write_context };
    const fresh = await f.read(id, 'overview', { include: ['activity', 'outcome', 'retro'] });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.result.activity, null);
    assert.equal(fresh.body.result.outcome, null);
    assert.deepEqual(fresh.body.result.retro, { status: 'not_recorded' });
    assert.equal(fresh.body.definition_check.tasks[0].needs_ack, true);
    await f.write('task_ack', base);
    const text = `${'Activity '.repeat(90)}Asked the user directly.`;
    const blocked = await f.write('task_report', { ...base, status: 'blocked', activity: { text } });
    const selected = await f.read(id, 'overview', { include: ['activity', 'outcome'] });
    assert.equal(selected.body.result.status, 'blocked');
    assert.equal(selected.body.result.activity.text, text);
    assert.equal(selected.body.result.outcome, null);
    assert.equal('retro' in selected.body.result, false);
    const legacy = await f.read(id, 'overview');
    assert.equal(legacy.body.result.activity.truncated, true);
    assert.deepEqual(legacy.body.result.outcome, { available: false });
    const done = await f.write('task_report', {
      ...base, write_context: blocked.body.result.write_context, status: 'done',
      outcome: { summary: 'Delivered' }, retro: null,
    });
    assert.equal(done.status, 200);
    const edited = await f.write('task_edit', {
      ...base, write_context: done.body.result.write_context, reason: 'Revised definition after completion',
      description: '\u0001'.repeat(9000),
    });
    assert.equal(edited.status, 200);
    const revised = await f.read(id, 'overview', { include: ['outcome', 'retro'] });
    assert.equal(revised.body.result.revision, 2);
    assert.equal(revised.body.result.outcome.current, false);
    assert.equal(revised.body.result.retro.current, false);
    assert.equal(revised.body.result.retro.text, null);
    assert.equal(revised.body.definition_check.tasks[0].revision, 2);
    const context = await f.read(id, 'overview', { include: ['context'] });
    for (const field of ['description', 'outcome', 'activity', 'retro']) assert.equal(field in context.body.result, false);
    const oversized = await f.read(id, 'overview', { include: ['definition', 'outcome'] });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body.error.code, 'RESULT_TOO_LARGE');
    assert.ok(oversized.body.result.group_characters.definition > 48000);
    assert.equal(oversized.body.definition_check.status, 'checked');
    for (const fields of [{ include: [] }, { include: ['retro', 'retro'] }, { include: ['outcome'], limit: 1 }]) {
      const rejected = await f.read(id, 'overview', fields);
      assert.equal(rejected.status, 400);
      assert.equal(rejected.body.error.code, 'INVALID_INPUT');
    }
    assert.equal((await f.read(id, 'execution', { include: ['context'] })).status, 400);
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('module publishes one Task node role with every tool, the tree Skill and the shared coding Skill', () => {
  const manifest = JSON.parse(readFileSync(new URL('../cockpit.module.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'Task');
  assert.equal(manifest.id, 'cockpit-task');
  assert.deepEqual(manifest.roles.map(({ id, name }) => ({ id, name })), [{ id: 'node', name: 'Task node' }]);
  const [node] = manifest.roles;
  assert.deepEqual(Object.keys(node.mcpServers), ['cockpit-task']);
  assert.deepEqual([...node.mcpServers['cockpit-task'].tools].sort(), [...TOOL_NAMES].sort());
  assert.equal(new Set(node.mcpServers['cockpit-task'].tools).size, TOOL_NAMES.length);
  assert.equal(node.instructions, 'roles/task-node.md');
  assert.deepEqual(node.skillDirectories, ['skills/cockpit-task-tree', 'skills/github-coding']);
});

test('automation HTTP views never fabricate or inspect a native Executor session', async () => {
  const f = fixture();
  try {
    const path = join(f.root, 'automation.mjs');
    writeFileSync(path, 'console.log("synthetic");');
    const registered = await f.write('task_script_register', {
      script_id: 'native-free', title: 'No native session', description: 'Synthetic only',
      executable: process.execPath, script_path: path, parameters: [],
    });
    assert.equal(registered.body.error, null);
    const created = await f.write('task_create', {
      owner: 'owner', title: 'Automated', description: 'Synthetic only',
      automation: { script_id: 'native-free', parameters: {} },
    });
    assert.equal(created.body.error, null);
    const id = created.body.result.task_id;
    const native = await f.native(id);
    assert.equal(native.body.available, false);
    assert.equal(native.body.session_id, null);
    assert.equal(native.body.error.code, 'NO_NATIVE_EXECUTOR');
    assert.equal((await f.read(id)).body.result.automation.state, 'created');
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('old module identity is rejected before opening storage instead of silently aliasing it', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-board-old-id-'));
  try {
    assert.throws(() => activate({
      apiVersion: 1, moduleId: 'task-board', dataRoot: root, host: { call() {} },
    }), /module ID cockpit-task.*explicit offline migration/);
    assert.equal(existsSync(join(root, 'task-board.sqlite')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('module fails before opening storage when the host bridge is absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-board-no-host-'));
  try {
    assert.throws(() => activate({ apiVersion: 1, serviceReadyVersion: 1, moduleId: 'cockpit-task', dataRoot: root }), /requires.*host intents/);
    assert.equal(existsSync(join(root, 'task-board.sqlite')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unsupported service-ready capability rejects before creating or migrating SQLite storage', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-board-no-service-ready-'));
  const file = join(root, 'task-board.sqlite');
  const context = { apiVersion: 1, moduleId: 'cockpit-task', dataRoot: root, host: { call() { assert.fail('No host calls before capability validation'); } } };
  try {
    for (const serviceReadyVersion of [undefined, null, 0, 2, true, '1']) {
      assert.throws(() => activate({ ...context, serviceReadyVersion }), /requires.*service-ready lifecycle v1/);
      assert.equal(existsSync(file), false);
    }
    const prior = new DatabaseSync(file);
    prior.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('preserved'); PRAGMA user_version=1");
    prior.close();
    const bytes = readFileSync(file);
    assert.throws(() => activate(context), /requires.*service-ready lifecycle v1/);
    assert.deepEqual(readFileSync(file), bytes, 'Unsupported activation cannot mutate an existing database');
    const untouched = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(untouched.prepare('PRAGMA user_version').get().user_version, 1);
      assert.equal(untouched.prepare('SELECT value FROM sentinel').get().value, 'preserved');
      assert.equal(untouched.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='subscriptions'").get().count, 0);
    } finally { untouched.close(); }
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
      name: 'session/new', body: { cwd: '/tmp', roles: [{ moduleId: 'cockpit-task', roleId: 'node' }] },
    });
    const execution = (await f.read(id)).body.result;
    const assigned = await f.write('task_assign', { task_id: id, revision: 1, executor: 'executor', write_context: execution.write_context });
    assert.equal(assigned.body.result.operation.message, 'accepted');
    assert.deepEqual(f.calls.filter(call => call.name === 'prompt'), [{
      name: 'prompt', body: { sessionId: 'executor', text: `[As Executor: Task assigned to you](task:${id}?event=assigned)`, mode: 'enqueue' },
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
    const initial = await adapter.inspect('executor');
    assert.equal(initial.ready, true);
    assert.equal(initial.idle, true);
    assert.ok(Number.isFinite(Date.parse(initial.details.observed_at)));
    assert.deepEqual(initial.details, {
      reasons: [], loaded: true, status: 'idle', availability_reasons: [], observed_at: initial.details.observed_at,
    });
    for (const [patch, reason] of [
      [{ status: 'running' }, 'session_not_idle'],
      [{ nativeProcessing: true }, 'native_processing'],
      [{ nativeProcessing: undefined }, 'native_processing_unconfirmed'],
      [{ queue: undefined }, 'queue_unconfirmed'],
      [{ queue: [{ id: 'waiting', text: 'private pending message' }] }, 'queued_messages'],
      [{ activeOperations: 1 }, 'active_operations'],
      [{ activeOperations: undefined }, 'active_operations_unconfirmed'],
      [{ activeSubagents: 1 }, 'active_subagents'],
      [{ activeMcpOperations: 1 }, 'active_mcp_operations'],
      [{ ask: { requestId: 'question', question: 'private user question' } }, 'pending_user_question'],
      [{ planRequest: { requestId: 'plan', text: 'private plan' } }, 'pending_plan'],
      [{ elicitation: { requestId: 'elicitation', message: 'private elicitation' } }, 'pending_elicitation'],
      [{ loading: true }, 'loading'],
      [{ closing: true }, 'closing'],
      [{ cancelling: true }, 'cancelling'],
    ]) {
      const original = f.meta;
      f.meta = { ...original, ...patch };
      const inspected = await adapter.inspect('executor');
      assert.equal(inspected.ready, true);
      assert.equal(inspected.idle, false);
      assert.deepEqual(inspected.details.availability_reasons, [reason]);
      assert.doesNotMatch(JSON.stringify(inspected.details), /private|requestId/);
      f.meta = original;
    }
    f.capability = { sessionId: 'executor', loaded: true, ready: false, roles: [], reasons: ['Missing role Skill'] };
    const unavailable = await adapter.inspect('executor');
    assert.equal(unavailable.ready, false);
    assert.equal(unavailable.idle, true);
    assert.deepEqual(unavailable.details.reasons, ['Missing role Skill']);
    assert.deepEqual(unavailable.details.availability_reasons, []);
    f.meta = { ...f.meta, loaded: false, status: 'unloaded' };
    const unloaded = await adapter.inspect('executor');
    assert.equal(unloaded.ready, false);
    assert.equal(unloaded.idle, false);
    assert.deepEqual(unloaded.details.availability_reasons, ['session_not_loaded', 'session_not_idle']);
    f.meta = null;
    const missing = await adapter.inspect('executor');
    assert.equal(missing.ready, false);
    assert.equal(missing.idle, false);
    assert.deepEqual(missing.details.availability_reasons, ['session_not_found']);
    assert.ok(f.calls.every(call => ['session/get', 'roles/readiness'].includes(call.name)));
  } finally { f.close(); }
});

test('HTTP dispatch failures retain bounded native reasons before and after binding across restart', async () => {
  for (const afterBinding of [false, true]) {
    const f = fixture();
    try {
      const created = await f.write('task_create', { owner: 'owner', title: 'Dispatch evidence', description: 'Complete this Task' });
      const task = (await f.read(created.body.result.task_id)).body.result;
      const idle = f.meta;
      const call = f.host.call;
      let inspections = 0;
      f.host.call = async (name, body) => {
        if (name === 'session/get' && ++inspections === (afterBinding ? 2 : 1)) {
          f.meta = {
            ...idle, queue: [{ id: 'pending', text: 'private queued content' }],
            ask: { requestId: 'ask', question: 'private question content' },
          };
        }
        return call(name, body);
      };
      const input = {
        request_id: 'busy-dispatch', task_id: task.id, executor: 'executor',
        revision: task.revision, write_context: task.write_context,
      };
      const failed = await f.write('task_assign', input);
      assert.equal(failed.body.error.code, 'EXECUTOR_NOT_READY');
      assert.equal(failed.body.result.operation.assignment, afterBinding ? 'applied' : 'not_applied');
      assert.equal(failed.body.result.operation.message, 'not_sent');
      assert.deepEqual(failed.body.result.operation.details.availability_reasons, ['queued_messages', 'pending_user_question']);
      assert.doesNotMatch(JSON.stringify(failed.body), /private|requestId/);
      assert.equal((await f.read(task.id)).body.result.executor, afterBinding ? 'executor' : null);
      assert.equal(f.calls.filter(entry => entry.name === 'prompt').length, 0);
      f.meta = idle;
      f.restart();
      const count = f.calls.length;
      const replay = await f.write('task_assign', input);
      assert.deepEqual(replay.body.result, failed.body.result);
      const receipt = await f.write('task_read', { view: 'operation', request_id: input.request_id });
      assert.deepEqual(receipt.body.result.result, failed.body.result);
      assert.equal(f.calls.length, count, 'Historical reads/replays do not inspect or resend');
      assert.deepEqual(f.errors, []);
    } finally { f.close(); }
  }
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
