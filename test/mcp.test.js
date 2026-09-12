import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store, WorkError, readCredential } from '../src/store.js';
import { createApp } from '../src/server.js';

test('real MCP stdio client discovers and invokes scoped tools against HTTP service', async t => {
  const directory = join(process.cwd(), `.mcp-test-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  const store = new Store(directory);
  mkdirSync(join(directory, 'credentials'), { mode: 0o700 });
  const credential = store.credentialFile(store.issue('caller', 'fixture-caller'), 'caller');
  const retainedDirectory = join(directory, 'retained-credentials');
  mkdirSync(retainedDirectory, { mode: 0o700 });
  const retainedCredential = join(retainedDirectory, 'legacy-caller.json');
  writeFileSync(retainedCredential, `${JSON.stringify({ token: store.issue('caller', 'fixture-caller') })}\n`,
    { mode: 0o600 });
  const credentialAlias = join(directory, 'credentials', 'legacy-alias.json');
  symlinkSync(retainedCredential, credentialAlias);
  const targetChecks = [];
  const cockpit = { async meta(sessionId) {
    targetChecks.push(sessionId);
    assert.equal(sessionId, 'fixture-caller');
    throw new WorkError('SESSION_NOT_FOUND', 'Isolated fixture native caller is missing', 404);
  } };
  const { app } = createApp({ store, cockpit, port: 18791 });
  await app.listen({ host: '127.0.0.1', port: 18791 });
  const clients = [];
  const connect = async extraEnv => {
    const env = { ...process.env, WORK_URL: 'http://127.0.0.1:18791',
      WORK_CREDENTIAL_DIR: join(directory, 'credentials') };
    delete env.WORK_RETAINED_CREDENTIAL_DIR;
    delete env.WORK_COCKPIT_MODULE_VERSION;
    Object.assign(env, extraEnv);
    const transport = new StdioClientTransport({
      command: process.execPath, args: [join(process.cwd(), 'src/mcp.js')],
      env,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'work-fixture', version: '1.0.0' });
    await client.connect(transport);
    clients.push(client);
    return client;
  };
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await app.close(); store.close(); rmSync(directory, { recursive: true });
  });
  const oldClient = await connect();
  const deniedRetained = await oldClient.callTool({ name: 'work_read',
    arguments: { credential: retainedCredential } });
  assert.equal(deniedRetained.isError, true,
    'an unconfigured old client remains limited to its single credential root');
  const client = await connect({
    WORK_COCKPIT_MODULE_VERSION: JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version,
    WORK_RETAINED_CREDENTIAL_DIR: retainedDirectory,
  });
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
  for (const name of ['work_amend', 'work_record']) {
    const tool = tools.tools.find(tool => tool.name === name);
    assert.equal(tool.inputSchema.properties.source.type, 'string');
    assert.match(tool.inputSchema.properties.source.description, /Required for owner edits/);
    assert.match(tool.description, /bound owner/);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  const result = await client.callTool({ name: 'work_read', arguments: { credential } });
  assert.deepEqual(JSON.parse(result.content[0].text), { items: [], nextBefore: null });
  const retained = await client.callTool({ name: 'work_read', arguments: { credential: retainedCredential } });
  assert.deepEqual(JSON.parse(retained.content[0].text), { items: [], nextBefore: null });
  const alias = await client.callTool({ name: 'work_read', arguments: { credential: credentialAlias } });
  assert.equal(alias.isError, true, 'credential-file symlinks are never accepted');
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
  const dispatch = { selection: 'new', taskId: record.task.taskId,
    recordRevision: store.task(record.task.taskId).record_revision, cwd: directory,
    goal: { objective: 'Fixture goal', scope: 'Private fixture', acceptance: 'No native creation', authorization: 'Fixture only' },
    idempotencyKey: 'mcp-missing-caller' };
  assert.deepEqual(targetChecks, []);
  const failed = await client.callTool({ name: 'work_dispatch', arguments: { credential, ...dispatch } });
  assert.equal(failed.isError, true);
  const failure = JSON.parse(failed.content[0].text);
  assert.equal(failure.operation.status, 'failed');
  assert.match(failure.operation.error, /SESSION_NOT_FOUND/);
  assert.equal(failure.task.ownerSessionId, null);
  assert.deepEqual(targetChecks, ['fixture-caller']);
  const http = await app.inject({ method: 'POST', url: '/api/tools/work_dispatch', payload: dispatch,
    headers: { host: '127.0.0.1:18791', authorization: `Bearer ${readCredential(credential)}` } });
  assert.equal(http.statusCode, 200);
  assert.deepEqual(http.json(), failure);
  assert.deepEqual(targetChecks, ['fixture-caller'], 'HTTP readback does not replay the failed native lookup');
  assert.equal(store.get('SELECT count(*) n FROM credentials').n, 2);
  const escaped = await client.callTool({ name: 'work_read', arguments: { credential: '/etc/passwd' } });
  assert.equal(escaped.isError, true);
  assert.equal(JSON.stringify(tools).includes('callerSessionId'), false);

  const nativeCalls = [];
  cockpit.meta = async sessionId => {
    nativeCalls.push({ name: 'session/get', sessionId });
    return { loaded: true, status: 'idle', currentModelId: 'gpt-6-astra' };
  };
  cockpit.call = async (name, body) => {
    nativeCalls.push({ name, ...body });
    return name === 'session/new' ? { sessionId: 'synthetic-owner' } : { ok: true, status: 'connected' };
  };
  const assigned = await client.callTool({ name: 'work_dispatch', arguments: {
    credential, selection: 'new', cwd: directory, workstream: 'owner-reopen-fixture',
    goal: dispatch.goal, idempotencyKey: 'mcp-owner-dispatch',
  } });
  assert.equal(assigned.isError, false);
  const taskId = JSON.parse(assigned.content[0].text).task.taskId;
  const ownerCredential = join(retainedDirectory, 'legacy-owner.json');
  renameSync(store.task(taskId).credential_path, ownerCredential);
  store.run('UPDATE tasks SET credential_path=? WHERE id=?', ownerCredential, taskId);
  const ownerCall = (name, input) => client.callTool({ name, arguments: {
    credential: ownerCredential, taskId, ...input,
  } });
  const deniedOwner = await oldClient.callTool({ name: 'work_read', arguments: { credential: ownerCredential, taskId } });
  assert.equal(deniedOwner.isError, true);
  const credentialsBefore = store.all('SELECT * FROM credentials');
  assert.equal((await ownerCall('work_report', { goalVersion: 1, kind: 'accepted', summary: 'Accepted',
    idempotencyKey: 'mcp-owner-accept-v1' })).isError, false);
  assert.equal((await ownerCall('work_deliver', { goalVersion: 1, outcome: 'delivered', summary: 'Initial result',
    artifacts: ['/fixture/mcp-v1'], idempotencyKey: 'mcp-owner-deliver-v1' })).isError, false);
  const callsBefore = nativeCalls.length;
  const provenance = { reason: 'Explicit same-goal follow-up', source: 'User in synthetic owner session requests continuation' };
  const metadata = await ownerCall('work_record', { action: 'update', recordRevision: 1,
    notes: 'Same retained owner credential', ...provenance, idempotencyKey: 'mcp-owner-edit' });
  assert.equal(metadata.isError, false);
  assert.equal(JSON.parse(metadata.content[0].text).task.status, 'delivered');
  const amendment = { taskId, goalVersion: 1, goal: dispatch.goal, ...provenance, idempotencyKey: 'mcp-owner-amend' };
  const amended = await ownerCall('work_amend', amendment);
  assert.equal(amended.isError, false);
  const sameHttp = await app.inject({ method: 'POST', url: '/api/tools/work_amend', payload: amendment,
    headers: { host: '127.0.0.1:18791', authorization: `Bearer ${readCredential(ownerCredential)}` } });
  assert.deepEqual(sameHttp.json(), JSON.parse(amended.content[0].text));
  assert.equal(JSON.parse(amended.content[0].text).task.goalVersion, 2);
  assert.equal((await ownerCall('work_report', { goalVersion: 2, kind: 'accepted', summary: 'Continue directly',
    idempotencyKey: 'mcp-owner-accept-v2' })).isError, false);
  assert.equal(nativeCalls.length, callsBefore);
  assert.deepEqual(store.all('SELECT * FROM credentials'), credentialsBefore);
  assert.equal(store.task(taskId).owner, 'synthetic-owner');
  assert.equal(store.task(taskId).credential_path, ownerCredential);
  assert.equal((await ownerCall('work_deliver', { goalVersion: 2, outcome: 'delivered', summary: 'Follow-up result',
    artifacts: ['/fixture/mcp-v2'], idempotencyKey: 'mcp-owner-deliver-v2' })).isError, false);
  assert.equal(nativeCalls.filter(call => call.name === 'session/new').length, 1);
  assert.equal(nativeCalls.filter(call => call.name === 'prompt' && call.sessionId === 'synthetic-owner').length, 1);
  assert.equal(nativeCalls.filter(call => call.name === 'prompt' && call.sessionId === 'fixture-caller').length, 2);
});
