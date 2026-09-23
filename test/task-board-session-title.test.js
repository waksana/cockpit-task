import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/task-board/store.js';
import { TaskService } from '../src/task-board/service.js';
import { createHostAdapter } from '../src/task-board/host.js';

function nativeHost(t, { name = null, userSet = false, provenance = true, rename } = {}) {
  const native = { name, userSet };
  const calls = [];
  const host = {
    async call(intent, body) {
      calls.push({ intent, body: structuredClone(body) });
      if (intent === 'session/get') return { meta: {
        sessionId: body.sessionId, loaded: true, status: 'idle', nativeProcessing: false, activeOperations: 0, queue: [],
        title: native.name ?? 'summary', ...(provenance ? { nativeName: native.name, nativeNameUserSet: native.userSet } : {}),
      } };
      if (intent === 'roles/readiness') return {
        sessionId: body.sessionId, ready: true, loaded: true, reasons: [], rolesNeedReload: false,
        appliedRoles: [{ moduleId: 'cockpit-task', roleId: 'executor' }],
      };
      if (intent === 'prompt') return { ok: true, queued: false };
      if (intent === 'session/rename') {
        if (rename) return rename(body, native);
        native.name = body.name.trim();
        native.userSet = true;
        return { ok: true, title: native.name };
      }
      assert.fail(`Unexpected intent ${intent}`);
    },
  };
  const directory = mkdtempSync(join(tmpdir(), 'task-board-title-'));
  const store = new TaskStore(directory);
  const service = new TaskService(store, createHostAdapter(host), { report: error => assert.fail(error.stack) });
  t.after(() => { service.close(); rmSync(directory, { recursive: true, force: true }); });
  let sequence = 0;
  const write = (name, input, actor = 'owner') => service.execute(name, {
    request_id: `title-${++sequence}`, actor_session_id: actor, ...input,
  });
  const create = async title => {
    const created = await write('task_create', { owner: 'owner', title, description: 'Synthetic work' });
    assert.equal(created.error, null);
    return store.task(created.result.task_id);
  };
  const assign = (task, extra = {}) => service.execute('task_assign', {
    request_id: `assign-${task.id}`, actor_session_id: 'owner', task_id: task.id, executor: 'executor',
    revision: task.revision, write_context: task.write_context, ...extra,
  });
  const finish = async task => {
    const bound = store.task(task.id);
    await write('task_ack', { task_id: task.id, revision: bound.revision, write_context: bound.write_context }, 'executor');
    const acked = store.task(task.id);
    const done = await write('task_report', {
      task_id: task.id, revision: acked.revision, write_context: acked.write_context,
      status: 'done', outcome: { summary: 'Done' }, retro: null,
    }, 'executor');
    assert.equal(done.error, null);
  };
  const renames = () => calls.filter(call => call.intent === 'session/rename');
  return { native, calls, store, service, create, assign, finish, renames };
}

test('assignment renames an auto-titled Executor to the Task title before dispatch', async t => {
  const f = nativeHost(t);
  const task = await f.create('  Synthetic title  ');
  const assigned = await f.assign(task);
  assert.equal(assigned.error, null);
  assert.equal(assigned.result.operation.status, 'applied');
  assert.equal(assigned.result.operation.message, 'accepted');
  assert.deepEqual(assigned.result.operation.session_title, { status: 'renamed', title: 'Synthetic title' });
  assert.deepEqual(f.renames().map(call => call.body), [{ sessionId: 'executor', name: task.title }]);
  const order = f.calls.map(call => call.intent);
  assert.ok(order.indexOf('session/rename') < order.indexOf('prompt'));

  const replay = await f.assign(task);
  assert.deepEqual(replay.result, assigned.result);
  assert.equal(f.renames().length, 1, 'request replay must not rename again');
});

test('an auto-applied native summary is replaced, a user-set custom title is preserved', async t => {
  const auto = nativeHost(t, { name: 'auto summary', userSet: false });
  const first = await auto.assign(await auto.create('Replace auto'));
  assert.equal(first.result.operation.session_title.status, 'renamed');

  const custom = nativeHost(t, { name: 'My own title', userSet: true });
  const assigned = await custom.assign(await custom.create('Must not overwrite'));
  assert.equal(assigned.error, null);
  assert.equal(assigned.result.operation.status, 'applied');
  assert.equal(assigned.result.operation.session_title.status, 'skipped');
  assert.equal(assigned.result.operation.session_title.error.code, 'CUSTOM_TITLE_PRESERVED');
  assert.equal(custom.renames().length, 0);
  assert.equal(custom.native.name, 'My own title');
});

test('a later assignment replaces only the title Task itself set, never a user rename', async t => {
  const f = nativeHost(t);
  const first = await f.create('First Task');
  await f.assign(first);
  await f.finish(first);
  const second = await f.create('Second Task');
  const reassigned = await f.assign(second);
  assert.deepEqual(reassigned.result.operation.session_title, { status: 'renamed', title: 'Second Task' });
  await f.finish(second);

  f.native.name = 'Renamed by user';
  const third = await f.create('Third Task');
  const preserved = await f.assign(third);
  assert.equal(preserved.result.operation.session_title.error.code, 'CUSTOM_TITLE_PRESERVED');
  assert.equal(f.native.name, 'Renamed by user');
  assert.equal(f.renames().length, 2);
});

test('rename failure or an unconfirmed result is reported without affecting the assignment', async t => {
  for (const rename of [
    () => { throw new Error('native rename rejected'); },
    () => ({ ok: false }),
  ]) {
    const f = nativeHost(t, { rename });
    const task = await f.create('Failing rename');
    const assigned = await f.assign(task);
    assert.equal(assigned.error, null);
    assert.equal(assigned.result.operation.status, 'applied');
    assert.equal(assigned.result.operation.assignment, 'applied');
    assert.equal(assigned.result.operation.message, 'accepted');
    assert.equal(assigned.result.operation.session_title.status, 'unconfirmed');
    assert.equal(assigned.result.operation.session_title.error.code, 'TITLE_UNCONFIRMED');
    assert.equal(f.store.task(task.id).executor, 'executor');
    assert.equal(f.renames().length, 1, 'no retry');
  }
});

test('hosts without name provenance are skipped safely without calling session/rename', async t => {
  const f = nativeHost(t, { provenance: false });
  const assigned = await f.assign(await f.create('Old host'));
  assert.equal(assigned.error, null);
  assert.equal(assigned.result.operation.status, 'applied');
  assert.equal(assigned.result.operation.session_title.status, 'skipped');
  assert.equal(assigned.result.operation.session_title.error.code, 'TITLE_PROVENANCE_UNAVAILABLE');
  assert.equal(f.renames().length, 0);
});

test('an already matching title needs no rename', async t => {
  const f = nativeHost(t, { name: 'Same title', userSet: true });
  const assigned = await f.assign(await f.create('Same title'));
  assert.deepEqual(assigned.result.operation.session_title, { status: 'unchanged', title: 'Same title' });
  assert.equal(f.renames().length, 0);
});
