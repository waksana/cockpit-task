import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

test('real MCP stdio client discovers and invokes scoped tools against HTTP service', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wc-mcp-')), store = new Store(directory);
  mkdirSync(join(directory, 'credentials'), { mode: 0o700 });
  const credential = store.credentialFile(store.issue('caller', 'fixture-caller'), 'caller');
  const { app } = createApp({ store, cockpit: {}, port: 18791 });
  await app.listen({ host: '127.0.0.1', port: 18791 });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(process.cwd(), 'src/mcp.js')],
    env: { ...process.env, WORK_URL: 'http://127.0.0.1:18791', WORK_CREDENTIAL_DIR: join(directory, 'credentials') },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'work-fixture', version: '1.0.0' });
  t.after(async () => { await client.close(); await app.close(); store.close(); rmSync(directory, { recursive: true }); });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 9);
  const result = await client.callTool({ name: 'work_read', arguments: { credential } });
  assert.deepEqual(JSON.parse(result.content[0].text), { items: [], nextBefore: null });
  const register = { credential, action: 'create', title: 'One phrase is enough', idempotencyKey: 'mcp-backlog-001' };
  const created = await client.callTool({ name: 'work_record', arguments: register });
  assert.equal(created.isError, false);
  const record = JSON.parse(created.content[0].text);
  assert.equal(record.task.goalVersion, 0); assert.equal(record.task.ownerSessionId, null);
  const replay = await client.callTool({ name: 'work_record', arguments: register });
  assert.equal(JSON.parse(replay.content[0].text).task.taskId, record.task.taskId);
  assert.equal(store.get('SELECT count(*) n FROM operations').n, 0);
  const escaped = await client.callTool({ name: 'work_read', arguments: { credential: '/etc/passwd' } });
  assert.equal(escaped.isError, true);
  assert.equal(JSON.stringify(tools).includes('callerSessionId'), false);
});
