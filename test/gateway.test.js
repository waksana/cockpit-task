import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { request } from 'node:http';
import { Store, hash } from '../src/store.js';
import { createApp } from '../src/server.js';

const gatewayUrl = 'https://task.example.com';
function fixture(t, options = {}) {
  const dir = join(process.cwd(), `.gateway-test-${randomUUID()}`);
  mkdirSync(dir, { mode: 0o700 });
  const store = new Store(dir);
  const viewer = store.issue('viewer'), caller = store.issue('caller', 'fixture-caller');
  const cockpit = { call() { throw new Error('Gateway must not call Cockpit'); } };
  const { app, work } = createApp({ store, cockpit, publicUrl: gatewayUrl, gatewayUrl, ...options });
  t.after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true }); });
  const inject = (url, { method = 'GET', token = viewer, ...extra } = {}) => app.inject({
    method, url, headers: { host: 'task.example.com', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...extra,
  });
  return { store, app, work, viewer, caller, inject };
}

test('gateway protects static and read endpoints, accepts only viewer and retains local auth', async t => {
  const f = fixture(t);
  for (const url of ['/', '/app.js', '/style.css', '/api/read', '/api/events']) {
    const method = url === '/api/read' ? 'POST' : 'GET';
    assert.equal((await f.inject(url, { method, token: null })).statusCode, 401, url);
    assert.equal((await f.inject(url, { method, token: f.caller })).statusCode, 403, url);
  }
  for (const url of ['/', '/app.js', '/style.css']) {
    assert.equal((await f.inject(url)).statusCode, 200, url);
  }
  const board = await f.inject('/api/read', { method: 'POST', payload: { view: 'board' } });
  assert.equal(board.statusCode, 200);
  assert.deepEqual(Object.keys(board.json().groups), ['backlog', 'working', 'blocked', 'decision', 'deferred', 'closed']);
  assert.equal(f.work.taskUrl('fixture-id'), 'https://task.example.com/?task=fixture-id');
  const local = await f.app.inject({ method: 'POST', url: '/api/tools/work_read', headers: {
    host: '127.0.0.1:8790', authorization: `Bearer ${f.caller}`, origin: 'http://127.0.0.1:8790',
  }, payload: {} });
  assert.equal(local.statusCode, 200);
  for (const url of ['/api/login', '/api/logout', '/api/session']) {
    const response = await f.app.inject({ method: url === '/api/session' ? 'GET' : 'POST', url,
      headers: { host: 'localhost:8790' }, ...(url === '/api/login' ? { payload: { token: f.viewer } } : {}) });
    assert.equal(response.statusCode, 404, url);
    assert.equal(response.headers['set-cookie'], undefined);
  }
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/read', payload: {},
    headers: { host: 'localhost:8790', cookie: `wc_view=${f.viewer}` } })).statusCode, 401);
});

test('public host never exposes tools or admin, including with valid caller or forged proxy headers', async t => {
  const f = fixture(t);
  for (const url of ['/api/tools/work_read', '/api/tools/work_record', '/admin/restart', '/api/login', '/api/logout', '/api/session',
    '/health', '/version', '/status', '/unknown', '/api/%72ead', '//api/read']) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      assert.equal((await f.inject(url, { method, token: f.caller, payload: method === 'POST' ? {} : undefined })).statusCode, 404, `${method} ${url}`);
    }
  }
  assert.equal((await f.inject('/api/read')).statusCode, 404);
  assert.equal((await f.inject('/', { method: 'POST', payload: {} })).statusCode, 404);
  assert.equal((await f.inject('/api/read', { method: 'POST', payload: {}, headers: {
    host: 'task.example.com', 'x-forwarded-host': 'localhost:8790', 'x-work-role': 'viewer',
    'x-pg-upstream-cookie': `wc_view=${f.viewer}`, cookie: `wc_view=${f.viewer}`,
  } })).statusCode, 401);
  assert.equal((await f.inject('/api/read', { method: 'POST', payload: {}, headers: {
    host: 'task.example.com', authorization: `Bearer ${f.viewer}`, origin: 'https://evil.example',
  } })).statusCode, 403);
  assert.equal((await f.inject('/', { headers: { host: 'evil.example', authorization: `Bearer ${f.viewer}` } })).statusCode, 403);
  f.store.run('UPDATE credentials SET revoked=1 WHERE digest=?', hash(f.viewer));
  assert.equal((await f.inject('/')).statusCode, 401);
});

test('browser is independent of gateway authentication and contains no credential UI', () => {
  for (const file of ['app.js', 'index.html', 'style.css']) {
    const source = readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /passkey|viewer|\/_gate\/|api\/(?:login|logout|session)|credentialFile|wc_view|id="(?:login|logout|token)"/i);
  }
});

test('gateway stream delivers committed changes and closes for Gate reauthorization', async t => {
  const f = fixture(t, { port: 18795, gatewayStreamMs: 100 });
  await f.app.listen({ host: '127.0.0.1', port: 18795 });
  const response = await new Promise((resolve, reject) => {
    const req = request('http://127.0.0.1:18795/api/events', { headers: {
      host: 'task.example.com', authorization: `Bearer ${f.viewer}`,
    } }, resolve);
    req.on('error', reject); req.end();
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['x-accel-buffering'], 'no');
  const reader = response[Symbol.asyncIterator]();
  assert.match((await reader.next()).value.toString(), /event: ready/);
  await f.work.execute(f.store.authenticate(f.caller), 'work_record', {
    action: 'create', title: 'Gateway fixture', idempotencyKey: 'gateway-event-001',
  });
  assert.match((await reader.next()).value.toString(), /event: changed/);
  assert.equal((await reader.next()).done, true);
  assert.equal(f.work.listeners.size, 0);
});

test('gateway configuration fails closed on insecure URL or unbounded streams', () => {
  for (const value of ['http://task.example.com', 'https://task.example.com/', 'https://task.example.com/path', 'https://user:pass@task.example.com',
    'https://127.0.0.1:34907/', 'https://127.0.0.1:34907/path', 'https://127.0.0.1:34907?query',
    'https://127.0.0.1:34907#fragment', 'https://127.0.0.1:443', 'https://127.0.0.1:034907']) {
    for (const key of ['gatewayUrl', 'moduleGatewayUrl']) {
      assert.throws(() => createApp({ [key]: value }), /canonical HTTPS origin/);
    }
  }
  assert.throws(() => createApp({ gatewayStreamMs: 60001 }), /reauthorize within 60 seconds/);
});

for (const legacyOrigin of ['https://task.example.com', 'https://127.0.0.1:34908']) {
  test(`real HTTP forwarding accepts a port-qualified HTTPS module origin and isolates legacy ${legacyOrigin}`, async t => {
    const moduleOrigin = 'https://127.0.0.1:34907';
    const f = fixture(t, { gatewayUrl: legacyOrigin, moduleGatewayUrl: moduleOrigin,
      publicUrl: legacyOrigin, basePath: '/modules/task', gatewayStreamMs: 30 });
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const forwarded = (path, { host, origin, token = f.viewer, method = 'GET', payload } = {}) => new Promise((resolve, reject) => {
      const req = request(new URL(path, address), { method, headers: {
        host, ...(origin ? { origin } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'content-type': 'application/json' } : {}),
      } }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.setTimeout(2000, () => req.destroy(new Error('Fixture HTTP request timed out')));
      req.on('error', reject);
      req.end(payload ? JSON.stringify(payload) : undefined);
    });
    for (const [origin, prefix, otherOrigin] of [[moduleOrigin, '/modules/task', legacyOrigin], [legacyOrigin, '', moduleOrigin]]) {
      const host = new URL(origin).host;
      const page = await forwarded('/?task=fixture', { host, origin });
      assert.equal(page.status, 200);
      assert.ok(page.body.includes(`href="${prefix}/style.css"`));
      assert.ok(page.body.includes(`src="${prefix}/app.js"`));
      assert.ok(page.body.includes(`name="task-base-path" content="${prefix}"`));
      for (const path of ['/app.js', '/style.css']) {
        assert.equal((await forwarded(path, { host, origin })).status, 200);
        assert.equal((await forwarded(path, { host, origin, method: 'HEAD' })).status, 200);
      }
      const board = await forwarded('/api/read', { host, origin, method: 'POST', payload: { view: 'board' } });
      assert.equal(board.status, 200);
      assert.ok(JSON.parse(board.body).groups);
      const events = await forwarded('/api/events', { host, origin });
      assert.equal(events.status, 200);
      assert.match(events.headers['content-type'], /text\/event-stream/);
      assert.match(events.body, /event: ready/);
      assert.equal((await forwarded('/', { host })).status, 200);
      assert.equal((await forwarded('/', { host, origin, token: null })).status, 401);
      assert.equal((await forwarded('/', { host, origin, token: f.caller })).status, 403);
      for (const crossOrigin of [otherOrigin, 'https://127.0.0.1', 'https://127.0.0.1:443',
        'https://127.0.0.1:34909', 'http://127.0.0.1:34907', `${origin}/`]) {
        assert.equal((await forwarded('/api/read', { host, origin: crossOrigin, method: 'POST', payload: {} })).status, 403, crossOrigin);
      }
      for (const path of ['/admin/module/caller', '/admin/restart', '/drain', '/api/tools/work_record', '/version', '/health', '/status']) {
        for (const method of ['GET', 'POST']) {
          assert.equal((await forwarded(path, { host, origin, method, ...(method === 'POST' ? { payload: {} } : {}) })).status, 404);
        }
      }
      assert.equal((await forwarded('/', { host, origin, method: 'POST', payload: {} })).status, 404);
      assert.equal((await forwarded('/api/read', { host, origin })).status, 404);
    }
    for (const host of ['127.0.0.1', '127.0.0.1:443', '127.0.0.1:34909', 'other.example.com:34907']) {
      assert.equal((await forwarded('/', { host, origin: moduleOrigin })).status, 403, host);
    }
    assert.equal(f.work.taskUrl('fixture-id'), `${legacyOrigin}/?task=fixture-id`);
    assert.equal(f.work.listeners.size, 0);
  });
}
