import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { Store, readCredential, WorkError } from '../src/store.js';
import { createApp } from '../src/server.js';
import { dataDirectory, normalizeBasePath } from '../src/module.js';
import { Work } from '../src/work.js';
import { captureRuntime } from '../src/runtime.js';
import { Lifecycle } from '../src/lifecycle.js';

function fixture(t, options = {}) {
  const dir = join(process.cwd(), `.module-test-${randomUUID()}`);
  mkdirSync(dir, { mode: 0o700 });
  const store = new Store(dir);
  const token = randomUUID();
  const credential = join(dir, 'manager.json');
  writeFileSync(credential, JSON.stringify({ token }), { mode: 0o600 });
  let metaCalls = 0;
  const cockpit = { async meta(id) {
    metaCalls++;
    if (id === 'missing') throw new WorkError('SESSION_NOT_FOUND', 'Not found', 404);
    return { sessionId: id, loaded: false };
  } };
  const { app, lifecycle } = createApp({ store, cockpit, moduleManagerCredential: credential, ...options });
  t.after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true }); });
  const headers = { host: '127.0.0.1:8790', authorization: `Bearer ${token}` };
  const body = { requestId: 'provision-001', sessionId: 'real-native-session' };
  return { app, store, dir, headers, body, lifecycle, calls: () => metaCalls,
    provision(payload = body, extra = {}) {
      return app.inject({ method: 'POST', url: '/admin/module/caller', headers, payload, ...extra });
    } };
}

test('module caller requires dedicated management auth and nonbrowser loopback', async t => {
  const f = fixture(t);
  const viewer = f.store.issue('viewer');
  const caller = f.store.issue('caller', 'unrelated');
  for (const authorization of [undefined, `Bearer ${viewer}`, `Bearer ${caller}`]) {
    const headers = { ...f.headers, authorization };
    if (!authorization) delete headers.authorization;
    assert.equal((await f.provision(f.body, { headers })).statusCode, 401);
  }
  for (const extra of [
    { headers: { ...f.headers, origin: 'http://127.0.0.1:8790' } },
    { headers: { ...f.headers, 'sec-fetch-mode': 'cors' } },
    { headers: { ...f.headers, 'sec-fetch-site': 'none' } },
    { remoteAddress: '198.51.100.2' },
  ]) assert.equal((await f.provision(f.body, extra)).statusCode, 403);
  assert.equal(f.calls(), 0);
  assert.equal(f.store.get('SELECT count(*) AS n FROM module_provisions').n, 0);
});

test('module manager validates native existence and rejects self-claimed role/authority', async t => {
  const f = fixture(t);
  assert.equal((await f.provision({ ...f.body, role: 'caller' })).statusCode, 400);
  assert.equal((await f.provision({ ...f.body, sessionId: 'missing' })).statusCode, 404);
  assert.equal(f.store.get('SELECT count(*) AS n FROM credentials').n, 0);
  assert.equal(f.store.get('SELECT count(*) AS n FROM module_provisions').n, 0);
});

test('module provisioning returns only a credential path and persists idempotency across restart', async t => {
  const f = fixture(t);
  const [a, b] = await Promise.all([f.provision(), f.provision()]);
  assert.equal(a.statusCode, 200); assert.equal(b.statusCode, 200);
  assert.deepEqual(a.json(), b.json());
  assert.deepEqual(Object.keys(a.json()), ['credentialFile']);
  const principal = f.store.authenticate(readCredential(a.json().credentialFile));
  assert.equal(principal.role, 'caller');
  assert.equal(principal.session_id, f.body.sessionId);
  assert.equal(principal.task_id, null);
  assert.equal(f.store.get('SELECT count(*) AS n FROM credentials').n, 1);
  const receipt = f.store.get('SELECT * FROM module_provisions');
  assert.equal(JSON.stringify(receipt).includes(readCredential(a.json().credentialFile)), false);
  const metaCalls = f.calls();
  assert.deepEqual((await f.provision()).json(), a.json());
  assert.equal(f.calls(), metaCalls);
  assert.equal((await f.provision({ ...f.body, sessionId: 'other-session' })).statusCode, 409);
  const reopened = new Store(f.dir);
  const { app } = createApp({ store: reopened, cockpit: { meta() { throw Error('must not revalidate/reissue'); } },
    moduleManagerCredential: join(f.dir, 'manager.json') });
  try {
    const result = await app.inject({ method: 'POST', url: '/admin/module/caller', headers: f.headers, payload: f.body });
    assert.equal(result.statusCode, 200); assert.deepEqual(result.json(), a.json());
  } finally { await app.close(); reopened.close(); }
});

test('uncertain local provisioning never issues again and revocation is not bypassed', async t => {
  const f = fixture(t);
  f.store.run('INSERT INTO module_provisions(request_id,session_id,created) VALUES(?,?,?)',
    f.body.requestId, f.body.sessionId, Date.now());
  const result = await f.provision();
  assert.equal(result.statusCode, 409);
  assert.equal(result.json().error, 'MODULE_PROVISION_INCOMPLETE');
  assert.equal(f.store.get('SELECT count(*) AS n FROM credentials').n, 0);
  const issued = await f.provision({ ...f.body, requestId: 'provision-002' });
  f.store.run('UPDATE credentials SET revoked=1');
  assert.equal((await f.provision({ ...f.body, requestId: 'provision-002' })).statusCode, 401);
  assert.equal(f.store.get('SELECT count(*) AS n FROM credentials').n, 1);
  assert.ok(issued.json().credentialFile);
});

test('credential-file failure leaves a durable reservation, never a second issue on replay', async t => {
  const f = fixture(t);
  let issued = 0;
  const issue = f.store.issue.bind(f.store);
  f.store.issue = (...args) => { issued++; return issue(...args); };
  f.store.credentialFile = () => { throw new WorkError('FILE_WRITE_FAILED', 'Injected credential write failure', 500); };
  assert.equal((await f.provision()).statusCode, 500);
  assert.equal((await f.provision()).json().error, 'MODULE_PROVISION_INCOMPLETE');
  assert.equal(issued, 1);
  assert.equal(f.store.get('SELECT count(*) AS n FROM credentials').n, 0);
  assert.equal(f.store.get('SELECT count(*) AS n FROM module_provisions').n, 1);
});

test('unconfigured manager route is absent and drain denies new provisioning', async t => {
  const f = fixture(t, { moduleManagerCredential: null });
  assert.equal((await f.provision()).statusCode, 404);
  assert.equal((await f.provision({ pending: true }, { url: '/drain' })).statusCode, 404);
  const managed = fixture(t);
  managed.lifecycle.requestRestart();
  assert.equal((await managed.provision()).statusCode, 503);
  assert.equal(managed.calls(), 0);
});

test('module drain authenticates the manager, preserves in-flight effects and returns same-instance identity', async t => {
  let finish, drained = 0;
  const lifecycle = new Lifecycle({ onDrained: () => { drained++; } });
  const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
  const runtime = captureRuntime({ COCKPIT_MODULE_ID: 'task', COCKPIT_MODULE_VERSION: packageVersion,
    COCKPIT_MODULE_DIGEST: 'd'.repeat(64), COCKPIT_MODULE_INSTANCE: randomUUID() });
  const f = fixture(t, { runtime, lifecycle });
  const admitted = lifecycle.mutation('fixture', () => new Promise(resolve => { finish = resolve; }));
  t.after(() => finish());
  for (const extra of [
    { headers: { host: f.headers.host } },
    { headers: { ...f.headers, origin: 'http://127.0.0.1:8790' } },
    { headers: { ...f.headers, 'sec-fetch-mode': 'cors' } },
    { remoteAddress: '198.51.100.2' },
  ]) {
    const response = await f.provision({ pending: true }, { url: '/drain', ...extra });
    assert.ok([401, 403].includes(response.statusCode));
  }
  for (const body of [{ pending: false }, { pending: true, force: true }]) {
    assert.equal((await f.provision(body, { url: '/drain' })).statusCode, 400);
  }
  const response = await f.provision({ pending: true }, { url: '/drain' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true, pending: true, ...lifecycle.status(),
    instanceId: runtime.instanceId, moduleVersion: packageVersion, moduleDigest: runtime.moduleDigest });
  assert.equal(response.json().activeMutations, 1);
  assert.equal(response.json().safeToRestart, false);
  assert.equal((await f.provision()).statusCode, 503);
  assert.equal(drained, 0);
  finish(); await admitted;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, 1);
});

test('module capability and health are reported by the same running instance', async t => {
  const f = fixture(t);
  const version = (await f.app.inject({ url: '/version', headers: { host: f.headers.host } })).json();
  const health = (await f.app.inject({ url: '/health', headers: { host: f.headers.host } })).json();
  assert.equal(version.moduleApi, 1);
  assert.equal(version.instanceId, health.instanceId);
  assert.equal(version.version, health.version);
  assert.equal(health.ok, true);
});

test('base paths cover HTML/deep links while legacy gateway retains empty-prefix URLs', async t => {
  const f = fixture(t, { basePath: '/modules/task', gatewayUrl: 'https://task.example.com',
    moduleGatewayUrl: 'https://cockpit.example.com', publicUrl: 'https://task.example.com' });
  const viewer = f.store.issue('viewer');
  for (const [host, prefix] of [['cockpit.example.com', '/modules/task'], ['task.example.com', '']]) {
    const page = await f.app.inject({ url: '/?task=fixture', headers: { host, authorization: `Bearer ${viewer}` } });
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes(`href="${prefix}/style.css"`));
    assert.ok(page.body.includes(`src="${prefix}/app.js"`));
    assert.ok(page.body.includes(`name="task-base-path" content="${prefix}"`));
    for (const path of ['/admin/module/caller', '/drain', '/api/tools/work_record', '/version', '/status', '/health']) {
      const response = await f.app.inject({ method: 'POST', url: path, headers: { host, authorization: `Bearer ${viewer}` }, payload: {} });
      assert.equal(response.statusCode, 404);
    }
  }
  const work = new Work(f.store, {}, { publicUrl: 'https://cockpit.example.com', basePath: '/modules/task' });
  assert.equal(work.taskUrl('fixture'), 'https://cockpit.example.com/modules/task/?task=fixture');
  assert.equal(new Work(f.store, {}).taskUrl('fixture'), 'http://127.0.0.1:8790/?task=fixture');
});

test('module paths are opt-in and manifest roles are explicit, isolated roots', () => {
  assert.equal(dataDirectory({}), join(homedir(), '.local/state/work-commander'));
  assert.equal(dataDirectory({ WORK_COCKPIT_MODULE_VERSION: '1.2.0' }), join(homedir(), '.cockpit/data/task'));
  assert.equal(dataDirectory({ WORK_COCKPIT_MODULE_VERSION: '1.2.0', COCKPIT_USER_ROOT: '/custom' }), '/custom/data/task');
  assert.equal(dataDirectory({ WORK_COCKPIT_MODULE_VERSION: '1.2.0', WORK_DATA_DIR: '/existing' }), '/existing');
  for (const path of ['/', '//host', '/x/', '/x/../admin', '/x?query', '/"><script>']) assert.throws(() => normalizeBasePath(path));
  const manifest = JSON.parse(readFileSync(new URL('../module.json', import.meta.url)));
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(manifest.version, pkg.version);
  assert.deepEqual(manifest.service, {
    entry: 'src/launch.js', healthPath: '/health', versionPath: '/version', drainPath: '/drain', publicPath: '/modules/task',
  });
  assert.deepEqual(manifest.roles.map(r => r.id), ['commander', 'owner']);
  for (const role of manifest.roles) {
    assert.deepEqual(Object.keys(role.mcp), ['cockpit-task']);
    const skill = role.id === 'owner' ? 'cockpit-task-owner' : 'cockpit-task-commander';
    assert.ok(readFileSync(new URL(`../${role.skills[0]}/${skill}/SKILL.md`, import.meta.url), 'utf8').includes(`name: ${skill}`));
    assert.ok(readFileSync(new URL(`../${role.instructions}`, import.meta.url), 'utf8').includes(skill));
  }
  for (const legacy of ['work-commander', 'work-commander-owner']) {
    assert.ok(readFileSync(new URL(`../skills/${legacy}/SKILL.md`, import.meta.url), 'utf8').includes(`name: ${legacy}`));
  }
  const owner = readFileSync(new URL('../roles/owner.md', import.meta.url), 'utf8');
  assert.match(owner, /never inherited from cwd/);
  assert.match(owner, /Do not\nprovision a caller credential/);
  assert.equal(manifest.roles.some(role => role.id === 'assistant'), false);
});
