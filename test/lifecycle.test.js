import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

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
