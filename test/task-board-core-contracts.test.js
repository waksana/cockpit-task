import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { schemas, toolSchemas, TOOL_NAMES } from '../src/task-board/contracts.js';

const task_id = 'de33dc0a-2f93-4c5a-b14e-87111940d520';

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
    'actor_session_id', 'cursor', 'executor', 'limit', 'owner', 'query',
    'request_id', 'revision', 'status', 'task_id', 'view',
  ].sort());
  assert.deepEqual(schema.properties.view.enum, [
    'list', 'overview', 'execution', 'definition', 'changelog', 'activity', 'outcomes', 'subscriptions', 'operation',
  ]);
  assert.equal(schema.properties.task_id.type, 'string');
  assert.equal(schema.properties.task_id.format, 'uuid');
  assert.equal(schema.properties.limit.maximum, 50);
  assert.equal(schema.properties.revision.minimum, 1);
  for (const tool of listed.tools) assert.ok(Object.keys(tool.inputSchema.properties).length > 0, tool.name);
});

test('official MCP tools/call retains strict per-view requirements despite the public object root', async t => {
  const { client, calls } = await fixture(t);
  const valid = [
    { view: 'list' },
    { view: 'list', actor_session_id: 'executor', owner: 'owner', executor: 'executor', status: 'unfinished', query: 'word', limit: 50 },
    ...['overview', 'execution', 'definition'].map(view => ({ view, task_id })),
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
    { view: 'execution', task_id, owner: 'owner' },
    { view: 'definition', task_id, revision: 1 },
    { view: 'changelog', task_id, revision: 1, limit: 1 },
    { view: 'changelog', task_id, revision: 1, cursor: 'cursor' },
    { view: 'activity', task_id, limit: 11 },
    { view: 'outcomes', task_id, revision: 1 },
    { view: 'subscriptions', task_id, limit: 11 }, { view: 'subscriptions' },
    { view: 'subscriptions', task_id, status: 'done' },
    { view: 'operation' }, { view: 'operation', request_id: 'id', task_id },
    { view: 'list', actor_session_id: '' },
  ];
  for (const input of invalid) {
    assert.equal(schemas.task_read.safeParse(input).success, false);
    assert.equal(toolSchemas.task_read.safeParse(input).success, false);
    const result = await client.callTool({ name: 'task_read', arguments: input });
    assert.equal(result.isError, true, JSON.stringify(input));
  }
  assert.equal(calls.length, valid.length, 'Invalid inputs never reach the tool handler');
});
