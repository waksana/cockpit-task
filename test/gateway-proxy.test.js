import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

const nginx = spawnSync('nginx', ['-v']);
test('nginx template authenticates every read, overwrites client identity and never proxies writes', {
  skip: nginx.error?.code === 'ENOENT' ? 'nginx not installed; backend boundary tests still run' : false,
}, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-proxy-'));
  const store = new Store(dir), viewer = store.issue('viewer'), caller = store.issue('caller', 'fixture');
  const { app, work } = createApp({ store, gatewayUrl: 'https://task.example.com', gatewayStreamMs: 500 });
  await app.listen({ host: '127.0.0.1', port: 0 });
  let gateValid = true;
  // This is an isolated Gate contract fixture, never a production session or passkey.
  const gate = createServer((req, res) => {
    if (req.url === '/_gate/check') {
      res.writeHead(gateValid && req.headers.host === 'task.example.com' && req.headers.cookie?.includes('fixture-gate=valid') ? 204 : 401);
    } else if (req.url === '/_gate/redirect') res.writeHead(302, { location: '/_gate/login?return=%2F' });
    else res.writeHead(200, { 'content-type': 'text/plain' });
    res.end();
  });
  gate.listen(0, '127.0.0.1'); await once(gate, 'listening');
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const fixtureGate = `
    location = /_gate/check {
      internal; proxy_pass http://127.0.0.1:${gate.address().port};
      proxy_pass_request_body off; proxy_set_header Content-Length ""; proxy_set_header Host $host;
    }
    location = /_gate/redirect {
      internal; proxy_pass http://127.0.0.1:${gate.address().port};
      proxy_pass_request_body off; proxy_set_header Content-Length ""; proxy_set_header Host $host;
    }
    location ^~ /_gate/ { proxy_pass http://127.0.0.1:${gate.address().port}; proxy_set_header Host $host; }
  `;
  const upstream = readFileSync(new URL('../deploy/task-readonly-upstream.inc', import.meta.url), 'utf8')
    .replace('127.0.0.1:8790', `127.0.0.1:${app.server.address().port}`)
    .replaceAll('task.rbym47.com', 'task.example.com')
    .replace('/etc/nginx/task-viewer-secret.inc', join(dir, 'secret.inc'));
  writeFileSync(join(dir, 'secret.inc'), `proxy_set_header Authorization "Bearer ${viewer}";`, { mode: 0o600 });
  writeFileSync(join(dir, 'upstream.inc'), upstream);
  const server = readFileSync(new URL('../deploy/task.nginx.conf', import.meta.url), 'utf8')
    .replace('127.0.0.1:8080', `127.0.0.1:${port}`).replaceAll('task.rbym47.com', 'task.example.com')
    .replace('include /etc/nginx/snippets/security-headers.inc;', '')
    .replace('include /etc/nginx/snippets/passkey-gate-endpoints.inc;', fixtureGate)
    .replaceAll('/etc/nginx/snippets/task-readonly-upstream.inc', join(dir, 'upstream.inc'));
  writeFileSync(join(dir, 'nginx.conf'), `pid ${dir}/nginx.pid;\nerror_log ${dir}/error.log;\nevents {}\nhttp { access_log off; ${server} }\n`);
  const child = spawn('nginx', ['-p', dir, '-c', join(dir, 'nginx.conf'), '-g', 'daemon off;'], { stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGQUIT'); await once(child, 'exit'); }
    await app.close(); await new Promise(resolve => gate.close(resolve));
    store.close(); rmSync(dir, { recursive: true });
  });
  function send(path, { method = 'GET', authenticated = false, headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method, headers: {
        host: 'task.example.com', ...(authenticated ? { cookie: 'fixture-gate=valid' } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}), ...headers,
      } }, resolve);
      req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  async function read(path, options) {
    const response = await send(path, options); let text = '';
    for await (const chunk of response) text += chunk;
    return { status: response.statusCode, headers: response.headers, text };
  }
  for (let attempt = 0; ; attempt++) {
    try { await read('/_gate/login'); break; }
    catch (e) { if (e.code !== 'ECONNREFUSED' || attempt === 30) throw e; await delay(50); }
  }
  for (const path of ['/', '/app.js', '/style.css']) assert.equal((await read(path)).status, 302, path);
  for (const path of ['/api/read', '/api/session', '/api/events']) {
    const options = path === '/api/read' ? { method: 'POST', body: {} } : {};
    const response = await read(path, options);
    assert.equal(response.status, 401, path); assert.equal(JSON.parse(response.text).error, 'PASSKEY_REQUIRED');
  }
  const forged = { authorization: `Bearer ${caller}`, cookie: `wc_view=${viewer}`,
    'x-forwarded-host': '127.0.0.1:8790', 'x-work-role': 'caller' };
  assert.equal((await read('/api/read', { method: 'POST', headers: forged, body: {} })).status, 401);
  const board = await read('/api/read', { method: 'POST', authenticated: true,
    headers: { ...forged, cookie: `fixture-gate=valid; wc_view=${caller}` }, body: { view: 'board' } });
  assert.equal(board.status, 200); assert.ok(JSON.parse(board.text).groups);
  for (const path of ['/', '/app.js', '/style.css', '/api/session']) {
    const response = await read(path, { authenticated: true });
    assert.equal(response.status, 200, path); assert.ok(!response.text.includes(viewer));
  }
  for (const path of ['/api/tools/work_read', '/api/tools/work_dispatch', '/api/login', '/api/logout', '/admin/restart', '/health', '/status', '/version']) {
    for (const authenticated of [false, true]) assert.equal((await read(path, { method: 'POST', authenticated, body: {} })).status, 404, path);
  }
  assert.equal((await read('/api/read', { authenticated: true })).status, 403);
  const response = await send('/api/events', { authenticated: true });
  assert.equal(response.statusCode, 200);
  const events = response[Symbol.asyncIterator]();
  assert.match((await events.next()).value.toString(), /event: ready/);
  await work.execute(store.authenticate(caller), 'work_record', { action: 'create', title: 'Proxy fixture', idempotencyKey: 'proxy-fixture-event' });
  assert.match((await events.next()).value.toString(), /event: changed/);
  gateValid = false;
  assert.equal((await events.next()).done, true);
  assert.equal((await read('/api/events', { authenticated: true })).status, 401);
  assert.equal((await read('/api/read', { method: 'POST', authenticated: true, body: {} })).status, 401);
});
