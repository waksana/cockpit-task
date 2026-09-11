import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { Lifecycle } from '../src/lifecycle.js';
import { captureRuntime } from '../src/runtime.js';
import { Store, readCredential } from '../src/store.js';
import { createApp } from '../src/server.js';

const goal = { objective: 'fixture', scope: 'fixture', acceptance: 'fixture', authorization: 'fixture' };
function gate() {
  let release, reached;
  return { promise: new Promise(resolve => { release = resolve; }),
    entered: new Promise(resolve => { reached = resolve; }),
    release: () => release(), reached: () => reached() };
}
async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(process.cwd(), '.runtime-test-'));
  const store = new Store(directory), callerToken = store.issue('caller', 'runtime-caller');
  const cockpit = {
    calls: [], gate: null,
    async call(name, body) {
      this.calls.push({ name, body });
      if (name === 'prompt' && this.gate) { this.gate.reached(); await this.gate.promise; }
      return name === 'session/new' ? { sessionId: 'runtime-owner' } : { ok: true, status: 'connected' };
    },
    async meta() { return { loaded: true, status: 'idle', currentModelId: 'gpt-6-astra' }; },
  };
  const created = createApp({ store, cockpit, adminToken: '', ...options });
  await created.app.ready();
  t.after(async () => { cockpit.gate?.release(); await created.app.close(); store.close(); rmSync(directory, { recursive: true }); });
  const request = (url, payload, token, extra = {}) => created.app.inject({
    method: payload === undefined ? 'GET' : 'POST', url, payload,
    headers: { host: '127.0.0.1:8790', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
  });
  return { ...created, store, cockpit, request, callerToken, directory };
}

test('runtime identity is captured once; source mode never derives a Git SHA', async t => {
  const env = { SERVICE_DELIVERY_SHA: 'a'.repeat(40), SERVICE_DELIVERY_ARTIFACT: 'b'.repeat(64),
    SERVICE_DELIVERY_REQUEST: 'runtime-request', SERVICE_DELIVERY_INSTANCE: 'runtime-instance' };
  const runtime = captureRuntime(env);
  env.SERVICE_DELIVERY_SHA = 'c'.repeat(40);
  env.SERVICE_DELIVERY_INSTANCE = 'changed';
  const f = await fixture(t, { runtime });
  const version = await f.request('/version'), health = await f.request('/health');
  assert.equal(version.headers['cache-control'], 'no-store');
  assert.equal(health.headers['cache-control'], 'no-store');
  assert.equal(version.json().sourceSha, 'a'.repeat(40));
  assert.equal(version.json().artifactDigest, 'b'.repeat(64));
  assert.equal(version.json().requestId, 'runtime-request');
  assert.equal(version.json().instanceId, health.json().instanceId);
  assert.equal(version.json().instanceId, 'runtime-instance');
  assert.equal(version.json().version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
  for (const source of [{}, { SERVICE_DELIVERY_SHA: 'main' }]) {
    const unknown = captureRuntime(source);
    assert.equal(unknown.sourceSha, null);
    assert.equal(unknown.identitySource, 'unknown');
    assert.ok(unknown.instanceId);
  }
});

for (const kind of ['dispatch', 'notification']) {
  test(`restart waits for actual blocked ${kind}, denies new authenticated execution and does not wait for business owners`, async t => {
    let exited = 0;
    const lifecycle = new Lifecycle({ onDrained: () => { exited++; } });
    const f = await fixture(t, { lifecycle });
    const dispatch = () => f.request('/api/tools/work_dispatch', {
      selection: 'new', workstream: 'runtime-fixture', cwd: f.directory, goal, idempotencyKey: 'runtime-dispatch',
    }, f.callerToken);
    let send = dispatch;
    if (kind === 'notification') {
      const result = (await dispatch()).json(), taskId = result.task.taskId;
      const ownerToken = readCredential(f.store.task(taskId).credential_path);
      assert.equal((await f.request('/api/tools/work_report', {
        taskId, goalVersion: 1, kind: 'accepted', summary: 'accepted', idempotencyKey: 'runtime-accepted',
      }, ownerToken)).statusCode, 200);
      send = () => f.request('/api/tools/work_deliver', {
        taskId, goalVersion: 1, outcome: 'delivered', summary: 'fixture done',
        artifacts: [f.directory], idempotencyKey: 'runtime-delivered',
      }, ownerToken);
    }
    f.cockpit.gate = gate();
    const pending = send().then(response => response);
    await Promise.race([f.cockpit.gate.entered, pending.then(response => assert.fail(`Operation ended before gate: ${response.body}`))]);
    const restart = await f.request('/admin/restart', { pending: true });
    assert.equal(restart.statusCode, 200);
    assert.equal(restart.json().activeMutations, 1);
    assert.equal(restart.json()[kind === 'dispatch' ? 'activeDispatches' : 'activeNotifications'], 1);
    assert.equal(restart.json().safeToRestart, false);
    assert.deepEqual((await f.request('/admin/restart', { pending: true })).json(), restart.json());
    let attempts = 0;
    const originalExecute = f.work.execute.bind(f.work);
    f.work.execute = (...args) => { attempts++; return originalExecute(...args); };
    const denied = await f.request('/api/tools/work_dispatch', {
      selection: 'new', cwd: f.directory, goal, idempotencyKey: 'runtime-second',
    }, f.callerToken);
    assert.equal(denied.statusCode, 503);
    assert.equal(denied.json().error, 'SERVICE_DRAINING');
    assert.equal(attempts, 0);
    assert.equal((await f.request('/api/tools/work_record', {}, 'invalid')).statusCode, 401);
    assert.equal((await f.request('/api/read', {}, f.callerToken)).statusCode, 200);
    assert.equal((await f.request('/api/tools/work_read', {}, f.callerToken)).statusCode, 200);
    for (const path of ['/', '/app.js', '/style.css', '/health', '/version', '/status']) {
      assert.equal((await f.request(path)).statusCode, 200);
    }
    assert.equal((await f.request('/api/login', { token: f.store.issue('viewer') })).statusCode, 503);
    assert.equal((await f.request('/api/logout', {})).statusCode, 503);
    await tick(); await tick();
    assert.equal(exited, 0);
    f.cockpit.gate.release();
    const result = await pending;
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().operation.status, 'succeeded');
    await tick();
    assert.equal(exited, 1);
    assert.equal(lifecycle.status().activeMutations, 0);
    assert.equal(lifecycle.status().safeToRestart, true);
    lifecycle.requestRestart(); await tick();
    assert.equal(exited, 1);
    assert.equal(f.cockpit.calls.filter(c => c.name === 'session/new').length, 1);
  });
}

test('admin rejects browsers, remote sockets, invalid hosts/bodies and optional bearer mismatch', async t => {
  const f = await fixture(t, { adminToken: 'fixture-admin' });
  for (const headers of [{ origin: 'http://127.0.0.1:8790' }, { 'sec-fetch-site': 'same-origin' }, { host: 'hostile.test' }]) {
    assert.equal((await f.request('/admin/restart', { pending: true }, 'fixture-admin', headers)).statusCode, 403);
  }
  assert.equal((await f.app.inject({
    method: 'POST', url: '/admin/restart', payload: { pending: true }, remoteAddress: '192.0.2.1',
    headers: { host: '127.0.0.1:8790', authorization: 'Bearer fixture-admin' },
  })).statusCode, 403);
  for (const token of [undefined, f.callerToken, 'wrong']) {
    assert.equal((await f.request('/admin/restart', { pending: true }, token)).statusCode, 401);
  }
  for (const payload of [{}, { pending: false }, { pending: true, force: true }]) {
    assert.equal((await f.request('/admin/restart', payload, 'fixture-admin')).statusCode, 400);
  }
  assert.equal(f.lifecycle.status().restartPending, false);
  assert.equal((await f.request('/admin/restart', { pending: true }, 'fixture-admin')).statusCode, 200);
});

test('controller closes admission synchronously and releases failed operations without cancellation', async () => {
  let completed = 0;
  const lifecycle = new Lifecycle({ onDrained: () => { completed++; } });
  const blocked = gate();
  const operation = lifecycle.mutation('work_recover', async () => { await blocked.promise; throw new Error('fixture failure'); });
  lifecycle.requestRestart();
  assert.equal(lifecycle.status().activeRecoveries, 1);
  await assert.rejects(lifecycle.mutation('work_record', () => assert.fail('must not execute')), { code: 'SERVICE_DRAINING' });
  await tick(); assert.equal(completed, 0);
  blocked.release();
  await assert.rejects(operation, /fixture failure/);
  await tick();
  assert.equal(completed, 1);
});
