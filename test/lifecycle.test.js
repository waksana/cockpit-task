import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Work } from '../src/work.js';

test('v2 data migrates in a real server process and dependency edits survive two clean restarts', { timeout: 20000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wc-dependency-life-'));
  const store = new Store(directory), token = store.issue('caller', 'lifecycle-caller');
  const caller = store.authenticate(token), work = new Work(store, {});
  const ids = [];
  for (const title of ['Dependent', 'Prerequisite']) {
    ids.push((await work.execute(caller, 'work_record', { action: 'create', title, idempotencyKey: `life-create-${title}` })).task.taskId);
  }
  store.db.exec('DROP TABLE dependencies; PRAGMA user_version=2');
  store.close();
  const children = [];
  const start = async () => {
    const child = spawn(process.execPath, [join(process.cwd(), 'src/launch.js')], {
      env: { ...process.env, WORK_DATA_DIR: directory, WORK_PORT: '18812', COCKPIT_URL: 'http://127.0.0.1:1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    await Promise.race([
      once(child.stdout, 'data'),
      once(child, 'exit').then(([code]) => { throw new Error(`Service exited ${code}`); }),
    ]);
    return child;
  };
  const stop = async child => { const exited = once(child, 'exit'); child.kill('SIGTERM'); assert.equal((await exited)[0], 0); };
  const call = async (name, input) => {
    const response = await fetch(`http://127.0.0.1:18812/api/tools/${name}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await stop(child);
    rmSync(directory, { recursive: true });
  });
  let child = await start();
  const args = { action: 'add', taskId: ids[0], prerequisiteId: ids[1], recordRevision: 1, idempotencyKey: 'life-add-dependency' };
  const added = await call('work_dependency', args);
  assert.equal(added.task.conditions.needsConfirmation, 1);
  await stop(child); child = await start();
  assert.deepEqual(await call('work_dependency', args), added);
  const page = await call('work_read', { taskId: ids[0], view: 'dependencies' });
  assert.equal(page.items[0].prerequisiteId, ids[1]);
  assert.equal(page.items[0].reason, 'no_bound_goal');
  await call('work_dependency', { ...args, action: 'remove', recordRevision: 2, idempotencyKey: 'life-remove-dependency' });
  await stop(child); child = await start();
  assert.equal((await call('work_read', { taskId: ids[0], view: 'dependencies' })).conditions.total, 0);
  await stop(child);
});

test('killed process, restart, kernel lock and replay preserve unknown prompt', { timeout: 20000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wc-life-'));
  const store = new Store(directory), token = store.issue('caller', 'lifecycle-caller');
  store.close();
  let promptCalls = 0, wakePrompt;
  const reachedPrompt = new Promise(resolve => { wakePrompt = resolve; });
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    const name = req.url.slice('/intent/'.length);
    if (name === 'prompt') { promptCalls++; wakePrompt(); return; }
    const value = name === 'session/new' ? { sessionId: 'lifecycle-owner' } :
      name === 'session/get' ? { meta: { sessionId: input.sessionId, loaded: true, status: 'idle', currentModelId: 'gpt-6-astra' } } :
      { ok: true, status: 'connected' };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const env = { ...process.env, WORK_DATA_DIR: directory, WORK_PORT: '18792', WORK_LOCK_HELD: '1', COCKPIT_URL: `http://127.0.0.1:${upstream.address().port}` };
  const children = [];
  const start = async () => {
    const child = spawn('flock', ['-n', '-E', '73', '--no-fork', join(directory, 'service.lock'), process.execPath, join(process.cwd(), 'src/server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    await Promise.race([
      once(child.stdout, 'data'),
      once(child, 'exit').then(([code]) => { throw new Error(`Service exited: ${code}`); }),
    ]);
    return child;
  };
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    }
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    rmSync(directory, { recursive: true });
  });
  const first = await start();
  const args = { selection: 'new', workstream: 'lifecycle', cwd: directory, goal: { objective: 'o', scope: 's', acceptance: 'a', authorization: 'x' }, idempotencyKey: 'lifecycle-dispatch' };
  const send = () => fetch('http://127.0.0.1:18792/api/tools/work_dispatch', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(args),
  });
  const pending = send().then(() => null, error => error);
  await reachedPrompt;
  const exit = once(first, 'exit'); first.kill('SIGKILL'); await exit;
  assert.ok(await pending);
  await start();
  const result = await (await send()).json();
  assert.equal(result.operation.status, 'unknown');
  assert.equal(result.task.ownerSessionId, 'lifecycle-owner');
  assert.equal(promptCalls, 1);
  const competitor = spawn('flock', ['-n', '-E', '73', join(directory, 'service.lock'), 'true']);
  assert.equal((await once(competitor, 'exit'))[0], 73);
});

test('real admin drain preserves dispatch response, closes SSE only after completion and exits cleanly', { timeout: 20000 }, async t => {
  const directory = mkdtempSync(join(process.cwd(), '.runtime-life-'));
  const store = new Store(directory), token = store.issue('caller', 'drain-caller'), viewer = store.issue('viewer');
  store.close();
  let releasePrompt, reachedPrompt;
  const blocked = new Promise(resolve => { releasePrompt = resolve; });
  const reached = new Promise(resolve => { reachedPrompt = resolve; });
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const name = req.url.slice('/intent/'.length);
    if (name === 'prompt') { reachedPrompt(); await blocked; }
    const value = name === 'session/new' ? { sessionId: 'drain-owner' } :
      name === 'session/get' ? { meta: { loaded: true, status: 'idle', currentModelId: 'gpt-6-astra' } } :
      { ok: true, status: 'connected' };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const child = spawn(process.execPath, [join(process.cwd(), 'src/launch.js')], {
    env: { ...process.env, WORK_DATA_DIR: directory, WORK_PORT: '18813', WORK_ADMIN_TOKEN: '',
      SERVICE_DELIVERY_SHA: 'd'.repeat(40), SERVICE_DELIVERY_ARTIFACT: 'e'.repeat(64),
      SERVICE_DELIVERY_REQUEST: 'real-drain-request', SERVICE_DELIVERY_INSTANCE: 'da97a7a9-08c6-4bb9-bc8f-b4ce113f78a3',
      COCKPIT_URL: `http://127.0.0.1:${upstream.address().port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  const controller = new AbortController();
  t.after(async () => {
    releasePrompt(); controller.abort();
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    rmSync(directory, { recursive: true });
  });
  await Promise.race([once(child.stdout, 'data'), exited.then(([code]) => { throw new Error(`Service exited ${code}`); })]);
  const base = 'http://127.0.0.1:18813';
  const post = (path, input, credential) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
    body: JSON.stringify(input),
  });
  const sse = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${viewer}` }, signal: controller.signal });
  assert.equal(sse.status, 200);
  const version = await (await fetch(`${base}/version`)).json();
  assert.deepEqual({ sha: version.sha, artifactSha256: version.artifactSha256, requestId: version.requestId, instanceId: version.instanceId }, {
    sha: 'd'.repeat(40), artifactSha256: 'e'.repeat(64), requestId: 'real-drain-request', instanceId: 'da97a7a9-08c6-4bb9-bc8f-b4ce113f78a3',
  });
  assert.equal((await (await fetch(`${base}/health`)).json()).instanceId, version.instanceId);
  const pending = post('/api/tools/work_dispatch', {
    selection: 'new', workstream: 'drain-fixture', cwd: directory,
    goal: { objective: 'fixture', scope: 'fixture', acceptance: 'fixture', authorization: 'fixture' },
    idempotencyKey: 'real-drain-dispatch',
  }, token).then(async response => ({ status: response.status, body: await response.json() }));
  await Promise.race([reached, pending.then(value => assert.fail(`Dispatch ended early: ${JSON.stringify(value)}`))]);
  for (let i = 0; i < 2; i++) {
    const restart = await post('/admin/restart', { pending: true });
    assert.equal(restart.status, 200);
    assert.equal((await restart.json()).activeMutations, 1);
  }
  child.kill('SIGTERM');
  child.kill('SIGINT');
  assert.equal((await post('/api/tools/work_record', {
    action: 'create', title: 'denied', idempotencyKey: 'real-drain-denied',
  }, token)).status, 503);
  assert.equal((await post('/api/read', {}, token)).status, 200);
  const status = await (await fetch(`${base}/status`)).json();
  assert.equal(status.activeDispatches, 1);
  assert.equal(status.inFlight, 1);
  assert.equal(status.acceptingMutations, false);
  assert.equal(child.exitCode, null);
  releasePrompt();
  const result = await pending;
  assert.equal(result.status, 200);
  assert.equal(result.body.operation.status, 'succeeded');
  assert.equal(result.body.task.status, 'dispatched');
  assert.equal((await exited)[0], 0);
  const restored = new Store(directory);
  try {
    restored.recoverInterrupted();
    assert.equal(restored.get('SELECT status FROM operations WHERE id=?', result.body.operation.operationId).status, 'succeeded');
  } finally { restored.close(); }
});
