import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store, WorkError, readCredential } from '../src/store.js';
import { createApp } from '../src/server.js';

test('real MCP stdio client discovers and invokes scoped tools against HTTP service', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wc-mcp-')), store = new Store(directory);
  mkdirSync(join(directory, 'credentials'), { mode: 0o700 });
  const credential = store.credentialFile(store.issue('caller', 'fixture-caller'), 'caller');
  let targetChecks = 0;
  const cockpit = { async meta(sessionId) {
    targetChecks++;
    assert.equal(sessionId, 'fixture-caller');
    throw new WorkError('SESSION_NOT_FOUND', 'Isolated fixture native caller is missing', 404);
  } };
  const { app } = createApp({ store, cockpit, port: 18791 });
  await app.listen({ host: '127.0.0.1', port: 18791 });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(process.cwd(), 'src/mcp.js')],
    env: { ...process.env, WORK_URL: 'http://127.0.0.1:18791', WORK_CREDENTIAL_DIR: join(directory, 'credentials') },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'work-fixture', version: '1.0.0' });
  t.after(async () => { await client.close(); await app.close(); store.close(); rmSync(directory, { recursive: true }); });
  await client.connect(transport);
  assert.equal(client.getServerVersion().version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 10);
  const dispatchTool = tools.tools.find(tool => tool.name === 'work_dispatch');
  const modelSchema = dispatchTool.inputSchema.properties.modelId;
  assert.equal(modelSchema.default, 'gpt-6-astra');
  for (const modelId of ['gpt-4.1', 'gpt-5.5']) assert.match(modelId, new RegExp(modelSchema.pattern));
  for (const modelId of ['gpt-4.1\n', '../gpt-4.1', 'models\\gpt-5.5']) {
    assert.doesNotMatch(modelId, new RegExp(modelSchema.pattern));
  }
  for (const field of ['taskId', 'workstream', 'sourceSessionId', 'toEventId']) {
    assert.doesNotMatch('invalid.id', new RegExp(dispatchTool.inputSchema.properties[field].pattern));
  }
  const dependencyTool = tools.tools.find(tool => tool.name === 'work_dependency');
  assert.deepEqual(dependencyTool.inputSchema.required.sort(),
    ['action', 'credential', 'idempotencyKey', 'prerequisiteId', 'recordRevision', 'taskId']);
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
  const prerequisite = JSON.parse((await client.callTool({ name: 'work_record', arguments: {
    ...register, title: 'Prerequisite', idempotencyKey: 'mcp-prerequisite-001',
  } })).content[0].text);
  const added = await client.callTool({ name: 'work_dependency', arguments: {
    credential, action: 'add', taskId: record.task.taskId, prerequisiteId: prerequisite.task.taskId,
    recordRevision: record.task.recordRevision, idempotencyKey: 'mcp-dependency-001',
  } });
  assert.equal(added.isError, false);
  assert.equal(JSON.parse(added.content[0].text).task.conditions.needsConfirmation, 1);
  const dependencies = await client.callTool({ name: 'work_read', arguments: {
    credential, taskId: record.task.taskId, view: 'dependencies',
  } });
  assert.equal(JSON.parse(dependencies.content[0].text).items[0].reason, 'no_bound_goal');
  const removed = await client.callTool({ name: 'work_dependency', arguments: {
    credential, action: 'remove', taskId: record.task.taskId, prerequisiteId: prerequisite.task.taskId,
    recordRevision: 2, idempotencyKey: 'mcp-remove-dependency-001',
  } });
  assert.equal(removed.isError, false);
  assert.equal(store.get('SELECT count(*) n FROM operations').n, 0);
  assert.equal(targetChecks, 0);
  const dispatch = { selection: 'new', taskId: record.task.taskId,
    recordRevision: store.task(record.task.taskId).record_revision, cwd: directory,
    goal: { objective: 'Fixture goal', scope: 'Private fixture', acceptance: 'No native creation', authorization: 'Fixture only' },
    idempotencyKey: 'mcp-missing-caller' };
  const failed = await client.callTool({ name: 'work_dispatch', arguments: { credential, ...dispatch } });
  assert.equal(failed.isError, true);
  const failure = JSON.parse(failed.content[0].text);
  assert.equal(failure.operation.status, 'failed');
  assert.match(failure.operation.error, /SESSION_NOT_FOUND/);
  assert.equal(failure.task.ownerSessionId, null);
  const http = await app.inject({ method: 'POST', url: '/api/tools/work_dispatch', payload: dispatch,
    headers: { host: '127.0.0.1:18791', authorization: `Bearer ${readCredential(credential)}` } });
  assert.equal(http.statusCode, 200);
  assert.deepEqual(http.json(), failure);
  assert.equal(targetChecks, 1, 'HTTP readback does not replay the failed native lookup');
  assert.equal(store.get('SELECT count(*) n FROM credentials').n, 1);
  const escaped = await client.callTool({ name: 'work_read', arguments: { credential: '/etc/passwd' } });
  assert.equal(escaped.isError, true);
  assert.equal(JSON.stringify(tools).includes('callerSessionId'), false);
});
