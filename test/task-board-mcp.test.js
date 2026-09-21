import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod/v4';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { assignExecutor } from '../src/task-board/operations.js';
import { createMcpRoutes } from '../src/task-board/mcp.js';
import { toolSchemas } from '../src/task-board/contracts.js';
import { TaskService } from '../src/task-board/service.js';
import { TaskStore } from '../src/task-board/store.js';

function fixture(execute, sharedModule, schemas = { task_read: z.object({ task_id: z.string() }).strict() }) {
  const controller = new AbortController();
  const errors = [];
  const module = sharedModule ?? createMcpRoutes({
    schemas,
    execute, signal: controller.signal, report: error => errors.push(error),
  });
  const client = new Client({ name: 'task-test', version: '1.0.0' });
  let activeCalls = 0;
  let cancellationHandled;
  const cancellation = new Promise(resolve => { cancellationHandled = resolve; });
  const transport = new StreamableHTTPClientTransport(new URL('http://task-test.invalid/mcp'), {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const route = module.routes.find(route => route.method === request.method);
      const body = request.method === 'POST' ? await request.json() : undefined;
      const result = await route.handler({
        params: {}, query: {}, headers: Object.fromEntries(request.headers),
        body,
        signal: request.signal,
      });
      if (body?.method === 'notifications/cancelled') cancellationHandled();
      if (body?.method === 'tools/call' && result.body instanceof Readable) {
        activeCalls++;
        result.body.once('close', () => { activeCalls--; });
      }
      return new Response(result.body instanceof Readable ? Readable.toWeb(result.body)
        : result.body === undefined ? null : JSON.stringify(result.body),
      { status: result.status ?? 200, headers: result.headers });
    },
  });
  return {
    client, errors, controller, module, transport, cancellation,
    get activeCalls() { return activeCalls; },
    connect: () => client.connect(transport),
    async close() { await client.close(); module.close(); },
  };
}

test('Task HTTP MCP speaks the official protocol and retains structured failures', async () => {
  const calls = [];
  const expected = {
    result: { activity: 'saved', status: 'rejected' },
    error: { code: 'DESCRIPTION_UPDATED', message: 'Read the new definition' },
    definition_check: { status: 'checked', tasks: [{ task_id: 'one', needs_ack: true }] },
  };
  const f = fixture(async (name, input) => { calls.push({ name, input }); return expected; });
  try {
    await f.connect();
    assert.deepEqual(f.client.getServerVersion(), { name: 'cockpit-task', version: '0.1.0' });
    const listed = await f.client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name), ['task_read']);
    const response = await f.client.callTool({ name: 'task_read', arguments: { task_id: 'one' } });
    assert.equal(response.isError, true);
    assert.deepEqual(response.structuredContent, expected);
    assert.deepEqual(JSON.parse(response.content[0].text), expected);
    assert.deepEqual(calls, [{ name: 'task_read', input: { task_id: 'one' } }]);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('published tool descriptions explain filters, dispatch races and same-report delivery without changing schemas', async () => {
  const f = fixture(() => assert.fail('Listing descriptions must not execute a Task operation'), undefined, toolSchemas);
  try {
    await f.connect();
    const { tools } = await f.client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), Object.keys(toolSchemas).sort());
    const descriptions = Object.fromEntries(tools.map(tool => [tool.name, tool.description]));
    for (const tool of tools) {
      assert.deepEqual(tool.inputSchema, z.toJSONSchema(toolSchemas[tool.name], { target: 'draft-7' }));
      assert.ok(tool.description.length < 500, `${tool.name}: keep workflow detail in Skills`);
    }
    assert.match(descriptions.task_read, /list, explicitly filter by owner or executor/);
    assert.match(descriptions.task_read, /actor_session_id.*not an automatic list filter or authentication/);
    assert.match(descriptions.task_read, /Reads never acknowledge/);
    assert.match(descriptions.task_assign, /send one assigned reference/);
    assert.match(descriptions.task_assign, /without installing capability or proactively interrupting/);
    assert.match(descriptions.task_assign, /not atomic.*queued or unconfirmed/);
    assert.match(descriptions.task_assign, /per-step results; never blindly resend/);
    assert.doesNotMatch(descriptions.task_assign, /Does not interrupt or queue instructions/);
    assert.match(descriptions.task_edit, /actual description change.*unfinished Task/);
    assert.match(descriptions.task_edit, /unchanged text and metadata-only edits do not/);
    assert.match(descriptions.task_edit, /Does not send messages or change execution status/);
    assert.match(descriptions.task_report, /done requires a new outcome in the same request/);
    assert.match(descriptions.task_report, /Stale activity may save while stale status\/outcome are rejected/);
    assert.match(descriptions.task_subscribe, /Rejects an already-matching status/);
    assert.match(descriptions.task_subscribe, /derived from the Task, not the actor/);
    assert.match(descriptions.task_unsubscribe, /Cannot recall a consumed notification/);
  } finally { await f.close(); }
});

test('real notification failure crosses MCP without erasing Task effects or resending on inspection/replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-mcp-subscription-'));
  const store = new TaskStore(root);
  const sent = [];
  const service = new TaskService(store, {
    ownerExists: async () => true,
    async send(owner, text) { sent.push({ owner, text }); throw new Error('Synthetic lost acceptance response'); },
  });
  const f = fixture((name, input, options) => service.execute(name, input, options), undefined, toolSchemas);
  const call = async (name, input) => {
    const response = await f.client.callTool({ name, arguments: { actor_session_id: 'actor', ...input } });
    assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
    assert.ok(response.structuredContent.definition_check);
    return response;
  };
  try {
    await f.connect();
    const created = await call('task_create', {
      request_id: 'create', owner: 'recorded-owner', title: 'Synthetic Task', description: 'Verify delivery evidence.',
    });
    assert.notEqual(created.isError, true);
    const { task_id, write_context } = created.structuredContent.result;
    const registered = await call('task_subscribe', {
      request_id: 'subscribe', task_id, write_context, statuses: ['cancelled'],
    });
    assert.notEqual(registered.isError, true);
    assert.deepEqual(sent, []);
    const input = { request_id: 'cancel', task_id, write_context, reason: 'Synthetic cancellation' };
    const response = await call('task_cancel', input);
    assert.equal(response.isError, true);
    const envelope = response.structuredContent;
    assert.equal(envelope.error, null);
    assert.equal(envelope.result.task_status, 'cancelled');
    assert.equal(envelope.notification_error.code, 'NOTIFICATION_UNCONFIRMED');
    assert.equal(envelope.notifications[0].notification.status, 'unknown');
    const overview = await call('task_read', { view: 'overview', task_id });
    assert.equal(overview.structuredContent.result.status, 'cancelled');
    const history = await call('task_read', { view: 'subscriptions', task_id });
    assert.notEqual(history.isError, true, 'Inspecting failed delivery is a successful bounded read');
    assert.deepEqual(history.structuredContent.result.items, envelope.notifications);
    const replay = await call('task_cancel', input);
    assert.equal(replay.isError, true);
    assert.deepEqual(replay.structuredContent, envelope);
    assert.deepEqual(sent, [{
      owner: 'recorded-owner', text: `[Task status updated](task:${task_id}?event=status_changed)`,
    }]);
  } finally {
    await f.close();
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('malformed envelopes and rejected headers cannot retain cancelled protocol sessions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(() => assert.fail('Rejected protocol envelopes cannot execute'));
  const post = f.module.routes.find(route => route.method === 'POST');
  try {
    const ids = [];
    const cases = [
      ...Array.from({ length: 260 }, () => ({ params: { name: 'task_read', arguments: 123 } })),
      { params: [] },
      { params: { name: 'task_read', arguments: { task_id: 'one' }, task: { ttl: 100 } } },
      { params: { name: 'task_read', arguments: { task_id: 'one' } }, accept: 'application/json' },
    ];
    for (const entry of cases) {
      const peer = fixture(undefined, f.module);
      await peer.connect();
      ids.push(peer.transport.sessionId);
      const headers = {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-session-id': peer.transport.sessionId,
      };
      const response = post.handler({
        headers: { ...headers, ...(entry.accept ? { accept: entry.accept } : {}) },
        body: { jsonrpc: '2.0', id: 99, method: 'tools/call', params: entry.params },
        signal: new AbortController().signal,
      }).catch(error => { assert.match(error.message, /cancelled/); return null; });
      await post.handler({
        headers, signal: new AbortController().signal,
        body: { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } },
      });
      const result = await response;
      if (result) assert.ok(result.status >= 400);
      if (result?.body instanceof Readable) for await (const _chunk of result.body) { /* Drain the error response. */ }
      await peer.client.close();
      await new Promise(resolve => setImmediate(resolve));
    }
    t.mock.timers.tick(6 * 60_000);
    for (const id of ids) {
      const result = await post.handler({
        headers: { 'mcp-session-id': id },
        body: { jsonrpc: '2.0', id: 101, method: 'tools/list' },
        signal: new AbortController().signal,
      });
      assert.equal(result.status, 404);
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Task HTTP MCP preserves shared-service validation failures', async () => {
  let calls = 0;
  const f = fixture(async (_name, input) => {
    if (!z.object({ task_id: z.string() }).strict().safeParse(input).success) {
      return { result: null, error: { code: 'INVALID_INPUT' }, definition_check: { status: 'checked' } };
    }
    calls++;
    return { result: {}, error: null };
  });
  try {
    await f.connect();
    const response = await f.client.callTool({
      name: 'task_read', arguments: { task_id: 'one', guessed_role: 'owner' },
    });
    assert.equal(response.isError, true);
    assert.deepEqual(response.structuredContent.definition_check, { status: 'checked' });
    assert.equal(calls, 0);
  } finally { await f.close(); }
});

test('module stop rejects new HTTP MCP requests and GET requires an initialized session', async () => {
  const f = fixture(async () => ({ result: {}, error: null }));
  try {
    const get = f.module.routes.find(route => route.method === 'GET');
    assert.equal((await get.handler({ headers: {} })).status, 400);
    f.module.close();
    const post = f.module.routes.find(route => route.method === 'POST');
    const response = await post.handler({ signal: new AbortController().signal });
    assert.equal(response.status, 503);
  } finally { await f.close(); }
});

test('separate MCP clients do not share request IDs', async () => {
  const a = fixture(async (_name, input) => ({ result: input, error: null }));
  const b = fixture(async (_name, input) => ({ result: input, error: null }));
  try {
    await a.connect();
    await b.connect();
    const first = await a.client.callTool({ name: 'task_read', arguments: { task_id: 'a' } });
    const second = await b.client.callTool({ name: 'task_read', arguments: { task_id: 'b' } });
    assert.equal(first.structuredContent.result.task_id, 'a');
    assert.equal(second.structuredContent.result.task_id, 'b');
  } finally { await a.close(); await b.close(); }
});

test('closing the module releases a pending MCP stream', async () => {
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const f = fixture(async (_name, _input, { signal }) => {
    started();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { result: null, error: { code: 'CANCELLED', message: 'Request ended' } };
  });
  await f.connect();
  const response = f.client.callTool({ name: 'task_read', arguments: { task_id: 'one' } });
  const rejected = assert.rejects(response, /connection closed/i);
  await began;
  f.module.close();
  await f.client.close();
  await rejected;
  await f.close();
});

test('official MCP cancellation reaches the original call across HTTP POST requests', async () => {
  let started;
  let resume;
  const began = new Promise(resolve => { started = resolve; });
  const waiting = new Promise(resolve => { resume = resolve; });
  let observedSignal;
  let effects = 0;
  const f = fixture(async (_name, _input, { signal }) => {
    observedSignal = signal;
    started();
    await waiting;
    if (!signal.aborted) effects++;
    return { result: null, error: signal.aborted ? { code: 'REQUEST_CANCELLED' } : null };
  });
  try {
    await f.connect();
    const controller = new AbortController();
    const pending = f.client.request({
      method: 'tools/call', params: { name: 'task_read', arguments: { task_id: 'one' } },
    }, CallToolResultSchema, { signal: controller.signal });
    const rejected = assert.rejects(pending);
    await began;
    controller.abort();
    await f.cancellation;
    assert.equal(observedSignal.aborted, true);
    resume();
    await rejected;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(effects, 0);
    assert.equal(f.activeCalls, 0);
    const next = await f.client.listTools();
    assert.equal(next.tools.length, 1);
  } finally { resume(); await f.close(); }
});

test('ordinary client disconnects do not permanently exhaust the session capacity', async () => {
  const f = fixture(async () => ({ result: {}, error: null }));
  try {
    for (let i = 0; i < 260; i++) {
      const peer = fixture(undefined, f.module);
      await peer.connect();
      await peer.client.close();
      await new Promise(resolve => setImmediate(resolve));
    }
    await f.connect();
    assert.equal((await f.client.listTools()).tools.length, 1);
  } finally { await f.close(); }
});

test('unused protocol sessions expire while a connected stream remains usable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(async () => ({ result: {}, error: null }));
  const peer = fixture(undefined, f.module);
  try {
    await f.connect();
    await peer.connect();
    const id = peer.transport.sessionId;
    await peer.client.close();
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(5 * 60_000);
    assert.equal((await f.client.listTools()).tools.length, 1);
    const post = f.module.routes.find(route => route.method === 'POST');
    const response = await post.handler({
      headers: { 'mcp-session-id': id },
      body: { jsonrpc: '2.0', id: 55, method: 'tools/list' },
      signal: new AbortController().signal,
    });
    assert.equal(response.status, 404);
  } finally { await peer.client.close(); await f.close(); }
});

test('MCP DELETE terminates only its initialized connection', async () => {
  const f = fixture(async () => ({ result: {}, error: null }));
  try {
    await f.connect();
    await f.transport.terminateSession();
    assert.equal(f.transport.sessionId, undefined);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('cancelled request IDs stay reserved and never bind or dispatch', async () => {
  for (const id of [0, '', 'ordinary-id']) {
    let started;
    let resume;
    let finished;
    const began = new Promise(resolve => { started = resolve; });
    const waiting = new Promise(resolve => { resume = resolve; });
    const ended = new Promise(resolve => { finished = resolve; });
    const effects = [];
    const f = fixture(async (_name, input, { signal }) => {
      const result = await assignExecutor({
        input: { ...input, executor: 'synthetic-executor', request_id: 'cancelled-operation' },
        signal,
        inspect: async () => { started(); await waiting; return { ready: true, idle: true }; },
        bind: () => { effects.push('bind'); return {}; },
        recheck: () => {},
        send: async () => { effects.push('send'); return { ok: true }; },
        save: () => {},
      });

      finished(result);
      return result;
    }, undefined, { task_assign: z.object({ task_id: z.string() }).strict() });
    try {
      await f.connect();
      await new Promise(resolve => setImmediate(resolve));
      const post = f.module.routes.find(route => route.method === 'POST');
      const request = body => post.handler({
        headers: {
          'content-type': 'application/json', accept: 'application/json, text/event-stream',
          'mcp-session-id': f.transport.sessionId,
        },
        body, signal: new AbortController().signal,
      });
      const response = await request({
        jsonrpc: '2.0', id, method: 'tools/call',
        params: { name: 'task_assign', arguments: { task_id: 'synthetic-task' } },
      });
      assert.equal(response.status, 200);
      await began;
      await request({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } });
      let text = '';
      for await (const chunk of response.body) text += chunk;
      assert.match(text, /"code":-32800/);
      const duplicate = await request({
        jsonrpc: '2.0', id, method: 'tools/call',
        params: { name: 'task_assign', arguments: { task_id: 'synthetic-task' } },
      });
      assert.equal(duplicate.status, 409, 'cancelled execution must unwind before reusing its protocol ID');
      resume();
      assert.equal((await ended).error.code, 'REQUEST_CANCELLED');
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(effects, []);
      assert.deepEqual(f.errors, []);
      assert.equal((await f.client.listTools()).tools.length, 1);
    } finally { resume(); await f.close(); }
  }
});

test('cancellation during shared-service validation releases idle session capacity', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(async (_name, input) => {
    assert.equal(input.task_id, 123);
    return { result: null, error: { code: 'INVALID_INPUT' } };
  });
  try {
    const post = f.module.routes.find(route => route.method === 'POST');
    let lastSession;
    for (let i = 0; i < 260; i++) {
      const peer = fixture(undefined, f.module);
      await peer.connect();
      lastSession = peer.transport.sessionId;
      const request = body => post.handler({
        headers: {
          'content-type': 'application/json', accept: 'application/json, text/event-stream',
          'mcp-session-id': lastSession,
        },
        body, signal: new AbortController().signal,
      });
      const response = request({
        jsonrpc: '2.0', id: 99, method: 'tools/call',
        params: { name: 'task_read', arguments: { task_id: 123 } },
      }).then(async result => {
        if (result.body instanceof Readable) for await (const _chunk of result.body) { /* Drain the terminal response. */ }
      }, error => assert.match(error.message, /cancelled/));
      await request({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } });
      await response;
      await peer.client.close();
      await new Promise(resolve => setImmediate(resolve));
    }
    t.mock.timers.tick(6 * 60_000);
    const expired = await post.handler({
      headers: { 'mcp-session-id': lastSession },
      body: { jsonrpc: '2.0', id: 101, method: 'tools/list' },
      signal: new AbortController().signal,
    });
    assert.equal(expired.status, 404);
    await f.connect();
    assert.equal((await f.client.listTools()).tools.length, 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
