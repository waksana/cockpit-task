import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Cockpit } from '../src/cockpit.js';
import { Store, readCredential } from '../src/store.js';
import { Work } from '../src/work.js';

const goal = { objective: 'Isolated native-reference fixture', scope: 'Fresh private loopback data only',
  acceptance: 'No replacement or replay', authorization: 'Synthetic local fixture only' };

async function fixture(t, { moduleVersion = '1.2.7' } = {}) {
  const directory = join(process.cwd(), `.native-reference-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  const store = new Store(directory), sessions = new Map(), modules = new Map(), responses = new Map(), calls = [];
  const metadata = sessionId => ({ sessionId, cwd: directory, loaded: true, status: 'idle',
    currentModelId: 'gpt-6-astra', queue: [], ask: null, planRequest: null, elicitation: null,
    nativeProcessing: false, activeSubagents: 0, activeMcpOperations: 0, activeOperations: 0 });
  sessions.set('caller-fixture', metadata('caller-fixture'));
  let sequence = 0, onModules, onNew, loadResponse;
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    calls.push({ name: request.url.slice('/intent/'.length), body });
    const reply = (value, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    switch (request.url) {
      case '/intent/session/get': {
        const override = responses.get(body.sessionId);
        if (override?.hold) return;
        return reply(override?.value ?? { meta: sessions.get(body.sessionId) ?? null }, override?.status);
      }
      case '/intent/session/new': {
        const sessionId = `fixture-owner-${++sequence}`;
        sessions.set(sessionId, metadata(sessionId));
        modules.set(sessionId, { sessionId, selections: body.modules, phase: 'applied', nativePresent: true });
        onNew?.(sessionId);
        return reply({ sessionId });
      }
      case '/intent/session/modules/get': {
        const value = modules.get(body.sessionId);
        onModules?.(body.sessionId);
        return reply({ modules: value ?? null });
      }
      case '/intent/session/load':
        if (!sessions.has(body.sessionId)) return reply({ error: 'Missing fixture target' }, 404);
        sessions.get(body.sessionId).loaded = true;
        sessions.get(body.sessionId).status = 'idle';
        return reply(loadResponse ?? { ok: true, sessionId: body.sessionId });
      case '/intent/prompt':
        if (!sessions.has(body.sessionId)) return reply({ error: 'Missing fixture target' }, 404);
        sessions.get(body.sessionId).loaded = true;
        return reply({ ok: true, queued: true });
      default:
        return reply({ error: 'Unexpected fixture operation' }, 400);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const cockpit = new Cockpit({ url: `http://127.0.0.1:${server.address().port}`, timeout: 2000 });
  const work = new Work(store, cockpit, { moduleVersion });
  const caller = store.authenticate(store.issue('caller', 'caller-fixture'));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true });
  });
  return { directory, store, cockpit, work, caller, sessions, modules, responses, calls,
    onModules(callback) { onModules = callback; }, onNew(callback) { onNew = callback; },
    loadResponse(value) { loadResponse = value; },
    dispatch() {
      return work.execute(caller, 'work_dispatch', {
        selection: 'new', cwd: directory, workstream: 'native-reference', goal, idempotencyKey: 'initial-dispatch',
      });
    },
    continue(taskId, idempotencyKey = 'explicit-continue') {
      return work.execute(caller, 'work_dispatch', {
        selection: 'continue', taskId, goalVersion: 1, message: 'Continue the exact original target', idempotencyKey,
      });
    },
    owner(taskId) { return store.authenticate(readCredential(store.task(taskId).credential_path)); },
    credentials() { return store.all('SELECT * FROM credentials ORDER BY digest'); },
  };
}

test('native metadata recognizes only explicit successful meta:null as missing', async t => {
  const f = await fixture(t);
  const cases = [
    [{}, 200], [{ meta: false }, 200], [{ meta: '' }, 200], [{ meta: {} }, 200],
    [{ meta: [] }, 200], [{ meta: { sessionId: 'other', loaded: false, status: 'unloaded' } }, 200],
    [{ meta: { sessionId: 'caller-fixture', status: 'idle' } }, 200],
    [{ meta: { sessionId: 'caller-fixture', loaded: true, status: 'invented' } }, 200],
    [{ ok: false, meta: null }, 200], [{ ok: 'true', meta: null }, 200],
    [{ error: 'Read not authoritative', meta: null }, 200],
    [{ meta: null }, 403], [{ meta: null }, 404], [{ meta: null }, 500],
  ];
  for (const [value, status] of cases) {
    f.responses.set('caller-fixture', { value, status });
    await assert.rejects(f.cockpit.meta('caller-fixture'), { code: 'UPSTREAM_READ_FAILED' });
  }
  f.responses.set('caller-fixture', { value: { meta: null } });
  await assert.rejects(f.cockpit.meta('caller-fixture'), { code: 'SESSION_NOT_FOUND' });
  f.responses.delete('caller-fixture');
  Object.assign(f.sessions.get('caller-fixture'), { loaded: false, status: 'unloaded' });
  assert.equal((await f.cockpit.meta('caller-fixture')).loaded, false);
  assert.equal(f.calls.length, cases.length + 2);
  assert.ok(f.calls.every(call => call.name === 'session/get' && call.body.sessionId === 'caller-fixture'));
});

test('native metadata timeout is unknown read failure, never missing or automatically retried', async t => {
  const f = await fixture(t);
  f.cockpit.timeout = 100;
  f.responses.set('caller-fixture', { hold: true });
  await assert.rejects(f.cockpit.meta('caller-fixture'), { code: 'UPSTREAM_READ_FAILED' });
  assert.equal(f.calls.length, 1);
});

test('missing original caller refuses dispatch before creation without revoking its credential or rewriting the task', async t => {
  const f = await fixture(t), credentials = f.credentials();
  f.sessions.delete('caller-fixture');
  const result = await f.dispatch();
  assert.equal(result.operation.status, 'failed');
  assert.equal(result.operation.step, 'inspect_caller');
  assert.match(result.operation.error, /SESSION_NOT_FOUND.*caller-fixture/);
  assert.equal(result.task.ownerSessionId, null);
  assert.equal(result.task.callerSessionId, 'caller-fixture');
  assert.deepEqual(f.credentials(), credentials);
  assert.deepEqual(f.calls.map(call => call.name), ['session/get']);
  assert.deepEqual(await f.dispatch(), result);
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.get('SELECT count(*) AS n FROM tasks').n, 1);
  assert.equal(f.store.get('SELECT count(*) AS n FROM versions').n, 1);
});

test('new managed owner is created once and never reapplied, closed, or initialized with a hidden prompt', async t => {
  const f = await fixture(t), result = await f.dispatch();
  assert.equal(result.operation.status, 'succeeded');
  assert.deepEqual(f.calls.map(call => call.name), [
    'session/get', 'session/new', 'session/get', 'session/modules/get', 'session/get', 'prompt',
  ]);
  assert.deepEqual(f.calls[1].body.modules, [{ moduleId: 'task', roleId: 'owner', version: '1.2.7' }]);
  assert.equal(f.calls.at(-1).body.sessionId, result.task.ownerSessionId);
  assert.equal(f.calls.at(-1).body.mode, 'enqueue');
  assert.match(f.calls.at(-1).body.text, /Legacy Work Commander execution/);
  assert.doesNotMatch(f.calls.at(-1).body.text, /Use skill |legacy-skills|Retired executing Skill|collaboration reference/);
});

for (const stage of ['create', 'module-check']) {
  test(`owner removed after ${stage} fails before prompt and retains its native creation identity without issuing credentials`, async t => {
    const f = await fixture(t), credentials = f.credentials();
    if (stage === 'create') f.onNew(id => f.sessions.delete(id));
    else f.onModules(id => f.sessions.delete(id));
    const result = await f.dispatch();
    assert.equal(result.operation.status, 'failed');
    assert.match(result.operation.error, /SESSION_NOT_FOUND.*fixture-owner-1/);
    assert.equal(result.task.ownerSessionId, 'fixture-owner-1');
    assert.equal(result.task.callerSessionId, 'caller-fixture');
    assert.deepEqual(f.credentials(), credentials);
    assert.equal(f.store.task(result.task.taskId).credential_path, null);
    assert.equal(f.calls.filter(call => call.name === 'session/new').length, 1);
    assert.equal(f.calls.some(call => call.name === 'prompt'), false);
    const requests = f.calls.length;
    await f.dispatch();
    assert.equal(f.calls.length, requests);
  });
}

for (const outcome of ['missing', 'forbidden', 'schema']) {
  test(`${outcome} original owner refuses continuation while preserving owner/caller/version/credential history`, async t => {
    const f = await fixture(t), initial = await f.dispatch(), taskId = initial.task.taskId;
    const original = f.store.task(taskId), credentials = f.credentials();
    const credentialFile = readFileSync(original.credential_path), version = f.store.all('SELECT * FROM versions');
    const before = f.calls.length;
    f.responses.set(original.owner, outcome === 'missing' ? { value: { meta: null } }
      : outcome === 'forbidden' ? { value: { meta: null }, status: 403 } : { value: { meta: {} } });
    const result = await f.continue(taskId);
    assert.equal(result.operation.status, 'failed');
    assert.match(result.operation.error, outcome === 'missing' ? /SESSION_NOT_FOUND/ : /UPSTREAM_READ_FAILED/);
    assert.equal(result.task.taskId, taskId);
    assert.equal(result.task.ownerSessionId, original.owner);
    assert.equal(result.task.callerSessionId, original.caller);
    assert.equal(result.task.goalVersion, original.version);
    assert.deepEqual(f.credentials(), credentials);
    assert.deepEqual(readFileSync(original.credential_path), credentialFile);
    assert.deepEqual(f.store.all('SELECT * FROM versions'), version);
    assert.ok(f.calls.slice(before).every(call => call.name === 'session/get'));
    const requests = f.calls.length;
    await f.continue(taskId);
    assert.equal(f.calls.length, requests);
    const reopened = new Store(f.directory);
    try {
      assert.equal(reopened.task(taskId).owner, original.owner);
      assert.equal(reopened.get('SELECT status FROM operations WHERE id=?', result.operation.operationId).status, 'failed');
    } finally { reopened.close(); }
  });
}

test('cold continuation loads only the original ID and keeps its applied owner release', async t => {
  const f = await fixture(t, { moduleVersion: '1.2.6' }), initial = await f.dispatch(), before = f.calls.length;
  const owner = initial.task.ownerSessionId;
  Object.assign(f.sessions.get(owner), { loaded: false, status: 'unloaded' });
  const upgraded = new Work(f.store, f.cockpit, { moduleVersion: '1.2.7' });
  const result = await upgraded.execute(f.caller, 'work_dispatch', {
    selection: 'continue', taskId: initial.task.taskId, goalVersion: 1,
    message: 'Keep the original owner', idempotencyKey: 'cold-continue',
  });
  assert.equal(result.operation.status, 'succeeded');
  const calls = f.calls.slice(before);
  assert.deepEqual(calls.filter(call => call.name === 'session/load').map(call => call.body), [{ sessionId: owner }]);
  assert.equal(calls.filter(call => call.name === 'prompt').length, 1);
  assert.equal(calls.some(call => ['session/new', 'session/reload', 'session/modules/apply'].includes(call.name)), false);
  assert.equal(f.modules.get(owner).selections[0].version, '1.2.6');
  assert.equal(f.store.get("SELECT count(*) AS n FROM credentials WHERE role='owner'").n, 1);
});

test('unconfirmed original-target load cannot proceed to module application, credentials, or prompt', async t => {
  const f = await fixture(t), initial = await f.dispatch(), before = f.calls.length, credentials = f.credentials();
  Object.assign(f.sessions.get(initial.task.ownerSessionId), { loaded: false, status: 'unloaded' });
  f.loadResponse({ ok: true, sessionId: 'wrong-target' });
  const result = await f.continue(initial.task.taskId);
  assert.equal(result.operation.status, 'unknown');
  assert.match(result.operation.error, /EFFECT_UNKNOWN/);
  assert.equal(f.calls.slice(before).filter(call => call.name === 'session/load').length, 1);
  assert.equal(f.calls.slice(before).some(call => call.name === 'prompt' || call.name === 'session/modules/get'), false);
  assert.deepEqual(f.credentials(), credentials);
  const requests = f.calls.length;
  await f.continue(initial.task.taskId);
  assert.equal(f.calls.length, requests);
});

for (const missing of [false, true]) {
  test(`${missing ? 'missing' : 'unloaded'} notification target retains final result and never replaces its caller`, async t => {
    const f = await fixture(t), initial = await f.dispatch(), taskId = initial.task.taskId;
    await f.work.execute(f.owner(taskId), 'work_report', {
      taskId, goalVersion: 1, kind: 'accepted', summary: 'Fixture accepted', idempotencyKey: 'accept-version',
    });
    if (missing) f.sessions.delete('caller-fixture');
    else Object.assign(f.sessions.get('caller-fixture'), { loaded: false, status: 'unloaded' });
    const before = f.calls.length, credentials = f.credentials();
    const input = { taskId, goalVersion: 1, outcome: 'delivered', summary: 'Retained final result',
      artifacts: [join(f.directory, 'fixture-result')], idempotencyKey: 'final-result' };
    const result = await f.work.execute(f.owner(taskId), 'work_deliver', input);
    assert.equal(result.task.status, 'delivered');
    assert.equal(result.task.summary, 'Retained final result');
    assert.equal(result.task.ownerSessionId, initial.task.ownerSessionId);
    assert.equal(result.task.callerSessionId, 'caller-fixture');
    assert.equal(result.operation.status, missing ? 'failed' : 'succeeded');
    if (missing) {
      assert.equal(result.operation.step, 'inspect_notification_target');
      assert.match(result.operation.error, /SESSION_NOT_FOUND.*caller-fixture/);
    }
    assert.deepEqual(f.calls.slice(before).map(call => call.name), missing ? ['session/get'] : ['session/get', 'prompt']);
    assert.deepEqual(f.credentials(), credentials);
    assert.deepEqual(JSON.parse(f.store.task(taskId).artifacts), input.artifacts);
    const requests = f.calls.length;
    await f.work.execute(f.owner(taskId), 'work_deliver', input);
    assert.equal(f.calls.length, requests);
  });
}
