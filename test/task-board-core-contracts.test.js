import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { schemas, toolSchemas, TOOL_NAMES, READ_GROUPS } from '../src/task-board/contracts.js';

const task_id = 'de33dc0a-2f93-4c5a-b14e-87111940d520';

test('reopen public schema requires a full explicit revision agreement and excludes takeover fields', async t => {
  const { client } = await fixture(t);
  const schema = (await client.listTools()).tools.find(tool => tool.name === 'task_reopen').inputSchema;
  const input = {
    request_id: 'rework', task_id, write_context: 'context',
    revision: 1, description: 'Full revised agreement', reason: 'User requested rework',
  };
  assert.deepEqual(schema.required, Object.keys(input));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.description.maxLength, 24000);
  assert.equal(schema.properties.reason.maxLength, 2000);
  assert.notEqual((await client.callTool({ name: 'task_reopen', arguments: input })).isError, true);
  for (const key of Object.keys(input)) {
    const missing = { ...input };
    delete missing[key];
    assert.equal((await client.callTool({ name: 'task_reopen', arguments: missing })).isError, true, key);
  }
  for (const change of [
    { assignee: 'replacement' }, { orchestrator: 'replacement' }, { status: 'todo' },
    { description: '' }, { reason: ' ' }, { description: 'x'.repeat(24001) },
  ]) assert.equal((await client.callTool({ name: 'task_reopen', arguments: { ...input, ...change } })).isError, true);
});

async function fixture(t) {
  const server = new McpServer({ name: 'task-contract-test', version: '1.0.0' });
  const calls = [];
  for (const name of TOOL_NAMES) {
    server.registerTool(name, { inputSchema: toolSchemas[name] }, async input => {
      calls.push({ name, input });
      return { content: [{ type: 'text', text: JSON.stringify(input) }] };
    });
  }
  const client = new Client({ name: 'task-contract-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, calls };
}

test('official MCP tools/list publishes all Task read selectors and a required view', async t => {
  const { client } = await fixture(t);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name), TOOL_NAMES);
  const schema = listed.tools.find(tool => tool.name === 'task_read').inputSchema;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['view']);
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    'cursor', 'assignee', 'include', 'limit', 'offset', 'orchestrator', 'parent_task_id', 'query',
    'request_id', 'retro', 'revision', 'status', 'task_id', 'view',
  ].sort());
  assert.deepEqual(schema.properties.view.enum, [
    'list', 'overview', 'execution', 'definition', 'changelog', 'activity', 'outcomes', 'retro_handlings', 'subscriptions', 'dependency_notices', 'child_notices', 'update_notices', 'automation_log', 'operation',
  ]);
  assert.equal(schema.properties.task_id.type, 'string');
  assert.equal(schema.properties.task_id.format, 'uuid');
  assert.equal(schema.properties.limit.maximum, 8192);
  assert.equal(schema.properties.revision.minimum, 1);
  assert.deepEqual(schema.properties.include.items.enum, READ_GROUPS);
  assert.equal(schema.properties.include.minItems, 1);
  assert.equal(schema.properties.include.maxItems, READ_GROUPS.length);
  assert.deepEqual(schema.properties.retro.enum, ['unhandled', 'watching']);
  const handle = listed.tools.find(tool => tool.name === 'task_retro_handle').inputSchema;
  assert.deepEqual(handle.properties.status.enum, ['fixed', 'followup', 'watching', 'dismissed']);
  assert.deepEqual([...handle.required].sort(), ['note', 'outcome_id', 'request_id', 'status', 'task_id']);
  for (const tool of listed.tools) assert.ok(Object.keys(tool.inputSchema.properties).length > 0, tool.name);
});

test('official MCP tools/call retains strict per-view requirements despite the public object root', async t => {
  const { client, calls } = await fixture(t);
  const valid = [
    { view: 'list' },
    { view: 'list', orchestrator: 'orchestrator', assignee: 'assignee', status: 'unfinished', query: 'word', limit: 50 },
    ...['overview', 'execution', 'definition'].map(view => ({ view, task_id })),
    { view: 'overview', task_id, include: ['context'] },
    { view: 'overview', task_id, include: ['activity', 'outcome', 'retro'] },
    { view: 'changelog', task_id, limit: 10, cursor: 'opaque-cursor' },
    { view: 'changelog', task_id, revision: 2 },
    { view: 'activity', task_id, limit: 10 },
    { view: 'outcomes', task_id, limit: 10 },
    { view: 'subscriptions', task_id, limit: 10, cursor: 'opaque-cursor' },
    { view: 'operation', request_id: 'operation-id' },
  ];
  for (const input of valid) {
    assert.deepEqual(toolSchemas.task_read.parse(input), schemas.task_read.parse(input));
    const result = await client.callTool({ name: 'task_read', arguments: input });
    assert.notEqual(result.isError, true, JSON.stringify(input));
    assert.deepEqual(JSON.parse(result.content[0].text), input);
  }
  assert.equal(calls.length, valid.length);
  const invalid = [
    {}, { view: 'unknown' }, { view: 'list', task_id }, { view: 'list', revision: 1 },
    { view: 'list', limit: 51 }, { view: 'list', extra: true },
    { view: 'overview' }, { view: 'overview', task_id, limit: 1 },
    { view: 'overview', task_id, include: [] },
    { view: 'overview', task_id, include: ['outcome', 'outcome'] },
    { view: 'overview', task_id, include: ['summary'] },
    { view: 'overview', task_id, include: ['activity'], cursor: 'cursor' },
    { view: 'execution', task_id, include: ['context'] },
    { view: 'execution', task_id, orchestrator: 'orchestrator' },
    { view: 'definition', task_id, revision: 1 },
    { view: 'changelog', task_id, revision: 1, limit: 1 },
    { view: 'changelog', task_id, revision: 1, cursor: 'cursor' },
    { view: 'activity', task_id, limit: 11 },
    { view: 'outcomes', task_id, revision: 1 },
    { view: 'subscriptions', task_id, limit: 11 }, { view: 'subscriptions' },
    { view: 'subscriptions', task_id, status: 'done' },
    { view: 'operation' }, { view: 'operation', request_id: 'id', task_id },
    { view: 'list', actor: '' },
  ];
  for (const input of invalid) {
    assert.equal(schemas.task_read.safeParse(input).success, false);
    assert.equal(toolSchemas.task_read.safeParse(input).success, false);
    const result = await client.callTool({ name: 'task_read', arguments: input });
    assert.equal(result.isError, true, JSON.stringify(input));
  }
  assert.equal(calls.length, valid.length, 'Invalid inputs never reach the tool handler');
});

test('official MCP publishes optional selections for both preparation entrypoints', async t => {
  const { client } = await fixture(t);
  const listed = await client.listTools();
  for (const [name, target] of [['task_session_create', 'cwd'], ['task_session_prepare', 'session_id']]) {
    const schema = listed.tools.find(tool => tool.name === name).inputSchema;
    assert.deepEqual(schema.required, ['request_id', target]);
    assert.deepEqual(Object.keys(schema.properties).sort(), [
      'request_id', target, 'skills', 'mcp_servers',
    ].sort());
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.skills.maxItems, 64);
    assert.equal(schema.properties.mcp_servers.maxItems, 64);
    assert.equal(schema.properties.mcp_servers.items.properties.tools.maxItems, 256);
    const input = {
      request_id: name, [target]: 'synthetic',
      skills: ['synthetic-work'], mcp_servers: [{ name: 'synthetic-tools', tools: ['read'] }],
    };
    const response = await client.callTool({ name, arguments: input });
    assert.notEqual(response.isError, true);
    assert.deepEqual(JSON.parse(response.content[0].text), input);
  }
});

test('official MCP publishes nullable bounded retro and requires explicit completion submission', async t => {
  const { client, calls } = await fixture(t);
  const schema = (await client.listTools()).tools.find(tool => tool.name === 'task_report').inputSchema;
  assert.equal(schema.required.includes('retro'), false, 'Non-completion reports do not require retro');
  assert.match(schema.properties.retro.description, /Required with done only/);
  assert.ok(schema.properties.retro.anyOf.some(branch => branch.type === 'null'));
  assert.ok(schema.properties.retro.anyOf.some(branch => branch.type === 'string' && branch.maxLength === 2000));
  const base = { request_id: 'retro-schema', task_id, write_context: 'context', revision: 1 };
  const completed = { ...base, status: 'done', outcome: { summary: 'Delivered' } };
  for (const input of [
    completed, { ...completed, retro: '' }, { ...completed, retro: ' \n' },
    { ...completed, retro: false }, { ...completed, retro: {} }, { ...completed, retro: 'x'.repeat(2001) },
    { ...base, status: 'in_progress', retro: null }, { ...base, status: 'done', retro: null },
  ]) {
    assert.equal(schemas.task_report.safeParse(input).success, false);
    assert.equal((await client.callTool({ name: 'task_report', arguments: input })).isError, true);
  }
  assert.equal(calls.length, 0);
  for (const input of [
    { ...completed, retro: null }, { ...completed, retro: 'Automate repeated fixture setup.' },
    { ...base, activity: { text: 'Actual work' } },
    ...['in_progress', 'blocked', 'in_review'].map(status => ({ ...base, status })),
  ]) {
    const response = await client.callTool({ name: 'task_report', arguments: input });
    assert.notEqual(response.isError, true);
    assert.deepEqual(JSON.parse(response.content[0].text), input);
  }
});
