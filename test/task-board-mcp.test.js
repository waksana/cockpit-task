import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod/v4';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { assignTask } from '../src/task-board/operations.js';
import { createMcpRoutes } from '../src/task-board/mcp.js';
import { toolSchemas, READ_GROUPS } from '../src/task-board/contracts.js';
import { TaskService } from '../src/task-board/service.js';
import { TaskStore } from '../src/task-board/store.js';

const manifest = JSON.parse(readFileSync(new URL('../cockpit.module.json', import.meta.url), 'utf8'));

const invocationMeta = { 'cockpit/invocation': { sessionId: 'orchestrator', runtimeSessionId: 'orchestrator', subagent: false } };

function fixture(execute, sharedModule, schemas = { task_read: z.object({ task_id: z.string() }).strict() }, { injectMeta = true } = {}) {
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
      let body = request.method === 'POST' ? await request.json() : undefined;
      if (injectMeta && body?.method === 'tools/call' && body.params && !body.params._meta) {
        body = { ...body, params: { ...body.params, _meta: invocationMeta } };
      }
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
    assert.deepEqual(f.client.getServerVersion(), { name: manifest.id, version: manifest.version });
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
      assert.ok(tool.description.length < 1400, `${tool.name}: keep workflow detail in Skills`);
    }
    assert.match(descriptions.task_read, /list, filter by orchestrator, assignee or parent_task_id, or omit them with status=unfinished for the pre-dispatch conflict check/);
    assert.match(descriptions.task_read, /caller is the session named by host invocation metadata/);
    assert.match(descriptions.task_read, /Reads never acknowledge/);
    const readSchema = tools.find(tool => tool.name === 'task_read').inputSchema;
    assert.deepEqual(readSchema.properties.include.items.enum, READ_GROUPS);
    assert.equal(readSchema.properties.include.minItems, 1);
    assert.equal(readSchema.properties.include.maxItems, READ_GROUPS.length);
    assert.match(readSchema.properties.include.description, /overview only.*48000.*RESULT_TOO_LARGE/);
    assert.match(descriptions.task_read, /overview\+include.*one consistent read/);
    assert.match(descriptions.task_assign, /send one "Task assigned" reference/);
    assert.match(descriptions.task_assign, /without installing capability or proactively interrupting/);
    assert.match(descriptions.task_assign, /not atomic.*queued or unconfirmed/);
    assert.match(descriptions.task_assign, /per-step results and failure-time availability_reasons; never blindly resend/);
    assert.doesNotMatch(descriptions.task_assign, /Does not interrupt or queue instructions/);
    assert.match(descriptions.task_edit, /actual description change.*automatically acknowledges/);
    assert.match(descriptions.task_reopen, /orchestrator or the original assignee.*done Agent Task to in_progress/);
    assert.match(descriptions.task_reopen, /no later assignment/);
    assert.match(descriptions.task_cancel, /Cancelled Tasks cannot reopen/);
    assert.match(descriptions.task_edit, /unchanged text and metadata-only edits do not/);
    assert.match(descriptions.task_edit, /Never changes lifecycle status/);
    assert.match(descriptions.task_report, /done requires a new outcome in the same request/);
    assert.match(descriptions.task_report, /Stale activity may save while stale status\/outcome\/retro are rejected/);
    assert.match(descriptions.task_report, /explicit retro: useful text or null for no findings; omission is rejected/);
    assert.match(descriptions.task_subscribe, /Rejects an already-matching status/);
    assert.match(descriptions.task_subscribe, /subscriber \(the caller\) receives the card/);
    assert.match(descriptions.task_subscribe, /Optional: default to no subscription/);
    assert.match(descriptions.task_subscribe, /only when a target state enables its necessary follow-up, not progress tracking/);
    assert.match(descriptions.task_unsubscribe, /Cannot recall a consumed notification/);
    assert.match(descriptions.task_unsubscribe, /planned follow-up is no longer needed/);
    assert.match(descriptions.task_retro_handle, /Any caller records/);
    assert.match(descriptions.task_retro_handle, /followup \(reference required; terminal, never revisited/);
    assert.match(descriptions.task_retro_handle, /Sends no messages and changes no Task status/);
    assert.match(descriptions.task_read, /retro filter: unhandled\|watching/);
  } finally { await f.close(); }
});

test('a status notification needs only one selective MCP read for done, in-progress and absent outcomes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-selective-mcp-'));
  const store = new TaskStore(root), sent = [], reads = [];
  const service = new TaskService(store, {
    sessionExists: async () => true,
    async send(orchestrator, text) { sent.push({ orchestrator, text }); return { ok: true, queued: false }; },
  });
  const f = fixture((name, input, options) => {
    if (name === 'task_read') reads.push(input);
    return service.execute(name, input, options);
  }, undefined, toolSchemas);
  try {
    await f.connect();
    for (const [index, status, hasOutcome] of [[0, 'done', true], [1, 'in_progress', true], [2, 'in_progress', false]]) {
      const created = store.executeLocal('task_create', {
        actor: 'orchestrator', request_id: `create-${index}`, title: 'Selective notification', description: 'Synthetic only',
      });
      const assignment = {
        actor: 'orchestrator', request_id: `assign-${index}`, task_id: created.task_id,
        revision: 1, write_context: created.write_context, assignee: `assignee-${index}`,
      };
      store.reserveOperation('task_assign', assignment);
      const task = store.bindAssignment(assignment);
      const base = { task_id: task.task_id, revision: 1, write_context: task.write_context, actor: task.assignee };
      store.executeLocal('task_ack', { ...base, request_id: `ack-${index}` });
      const { revision, ...subscription } = base;
      store.executeLocal('task_subscribe', { ...subscription, actor: 'observer', request_id: `subscribe-${index}`, statuses: [status] });
      const text = `${'Full activity. '.repeat(80)}${status === 'in_progress' ? 'Work remains owned by the assignee.' : 'Delivered.'}`;
      const { actor, ...reportBase } = base;
      const report = await f.client.callTool({ name: 'task_report', arguments: {
        ...reportBase, request_id: `report-${index}`, status, activity: { text },
        ...(hasOutcome ? { outcome: { summary: `Result ${index}` } } : {}),
        ...(status === 'done' ? { retro: null } : {}),
      }, _meta: { 'cockpit/invocation': { sessionId: actor, runtimeSessionId: actor, subagent: false } } });
      assert.notEqual(report.isError, true);
      assert.equal(sent.length, index + 1);
      assert.deepEqual(sent[index], { orchestrator: 'observer', text: `[Subscribed Task status changed](task:${task.task_id}?event=status_changed)` });
      const count = reads.length;
      const response = await f.client.callTool({ name: 'task_read', arguments: {
        view: 'overview', task_id: task.task_id, include: ['activity', 'outcome', 'retro'],
      } });
      assert.notEqual(response.isError, true);
      assert.equal(reads.length, count + 1);
      const selected = response.structuredContent.result;
      assert.equal(selected.status, status);
      assert.equal(selected.activity.text, text);
      assert.equal(selected.activity.current, true);
      if (hasOutcome) assert.equal(selected.outcome.summary, `Result ${index}`);
      else assert.equal(selected.outcome, null);
      assert.deepEqual(selected.retro.status, status === 'done' ? 'recorded' : 'not_recorded');
      assert.equal('description' in selected, false);
      assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
      const context = await f.client.callTool({ name: 'task_read', arguments: {
        view: 'overview', task_id: task.task_id, include: ['context'],
      } });
      assert.equal(context.structuredContent.result.status, status);
      for (const key of ['activity', 'outcome', 'retro']) assert.equal(key in context.structuredContent.result, false);
      for (const invalid of [{ include: ['outcome', 'outcome'] }, { view: 'execution', include: ['outcome'] }, { include: ['summary'] }]) {
        const rejected = await f.client.callTool({ name: 'task_read', arguments: {
          view: 'overview', task_id: task.task_id, ...invalid,
        }, _meta: { 'cockpit/invocation': { sessionId: actor, runtimeSessionId: actor, subagent: false } } });
        assert.equal(rejected.isError, true);
        assert.equal(rejected.structuredContent.error.code, 'INVALID_INPUT');
        assert.equal(rejected.structuredContent.definition_check.status, 'checked');
      }
    }
    const large = store.executeLocal('task_create', {
      actor: 'orchestrator', request_id: 'large-definition',
      title: 'Large definition', description: '\u0001'.repeat(9000),
    });
    const oversized = await f.client.callTool({ name: 'task_read', arguments: {
      view: 'overview', task_id: large.task_id, include: ['definition', 'outcome'],
    } });
    assert.equal(oversized.isError, true);
    assert.equal(oversized.structuredContent.error.code, 'RESULT_TOO_LARGE');
    assert.equal(oversized.structuredContent.error.status, 413);
    assert.ok(oversized.structuredContent.result.group_characters.definition > 48000);
    assert.equal('definition' in oversized.structuredContent.result, false);
    assert.equal(oversized.structuredContent.definition_check.status, 'checked');
  } finally {
    await f.close();
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('real MCP completion never defaults missing retro and persists text or null exactly once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-retro-mcp-'));
  const store = new TaskStore(root);
  const service = new TaskService(store, {});
  const f = fixture((name, input, options) => service.execute(name, input, options), undefined, toolSchemas);
  try {
    await f.connect();
    for (const retro of [null, 'Automate the repeated deterministic setup.']) {
      const created = store.executeLocal('task_create', {
        actor: 'orchestrator', request_id: `create-${retro}`, title: 'Retro', description: 'Synthetic completion',
      });
      const assign = {
        actor: 'orchestrator', request_id: `assign-${retro}`, task_id: created.task_id,
        write_context: created.write_context, revision: 1, assignee: 'assignee',
      };
      store.reserveOperation('task_assign', assign);
      const task = store.bindAssignment(assign);
      const base = { actor: 'assignee', task_id: task.task_id, revision: 1, write_context: task.write_context };
      store.executeLocal('task_ack', { ...base, request_id: `ack-${retro}` });
      const { actor, ...requestBase } = base;
      const meta = { _meta: { 'cockpit/invocation': { sessionId: actor, runtimeSessionId: actor, subagent: false } } };
      const request = { ...requestBase, request_id: `done-${retro}`, status: 'done', outcome: { summary: 'Delivered' } };
      for (const value of [undefined, '', ' \t', 0, {}, [], 'r'.repeat(2001)]) {
        const response = await f.client.callTool({ name: 'task_report', arguments: { ...request, ...(value === undefined ? {} : { retro: value }) }, ...meta });
        assert.equal(response.isError, true);
        assert.equal(response.structuredContent.error.code, 'INVALID_INPUT');
        assert.equal(response.structuredContent.definition_check.tasks[0].needs_ack, false);
      }
      assert.equal(store.task(task.task_id).status, 'todo');
      assert.equal(store.read({ view: 'outcomes', task_id: task.task_id }).items.length, 0);
      const completed = await f.client.callTool({ name: 'task_report', arguments: { ...request, retro }, ...meta });
      assert.notEqual(completed.isError, true);
      const replay = await f.client.callTool({ name: 'task_report', arguments: { ...request, retro }, ...meta });
      assert.deepEqual(replay.structuredContent.result, completed.structuredContent.result);
      const read = await f.client.callTool({ name: 'task_read', arguments: { view: 'execution', task_id: task.task_id } });
      assert.equal(read.structuredContent.result.retro.text, retro);
      assert.equal(store.read({ view: 'outcomes', task_id: task.task_id }).items.length, 1);
    }
  } finally {
    await f.close();
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('official MCP discovers, registers and executes an automation Task without any Agent session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-automation-mcp-'));
  const store = new TaskStore(root);
  const errors = [];
  const service = new TaskService(store, {}, { report: error => errors.push(error) });
  service.automation.recover();
  const f = fixture((name, input, options) => service.execute(name, input, options), undefined, toolSchemas);
  let sequence = 0;
  const call = async (name, input) => {
    const response = await f.client.callTool({
      name, arguments: name.endsWith('_read') ? input : { request_id: `mcp-auto-${++sequence}`, ...input },
    });
    assert.equal(response.isError, undefined, JSON.stringify(response));
    return response.structuredContent.result;
  };
  try {
    await f.connect();
    const path = join(root, 'synthetic.mjs');
    writeFileSync(path, 'console.log("mcp automation "+process.argv[2]);');
    await call('task_script_register', {
      script_id: 'mcp-script', title: 'MCP script', description: 'Synthetic only',
      executable: process.execPath, script_path: path,
      parameters: [{ name: 'value', type: 'string', description: 'Value' }],
    });
    assert.equal((await call('task_script_read', {})).items[0].script_id, 'mcp-script');
    const created = await call('task_create', {
      title: 'MCP automation', description: 'Execute synthetic only',
      automation: { script_id: 'mcp-script', parameters: { value: 'literal' } },
    });
    assert.equal(created.automation.state, 'created');
    await call('task_automation_start', { task_id: created.task_id, revision: 1, write_context: created.write_context });
    // Synthetic integration waits for a result; the documented Agent flow never polls.
    for (let tries = 0; tries < 500 && store.task(created.task_id).status !== 'done'; tries++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const execution = await call('task_read', { view: 'execution', task_id: created.task_id });
    assert.equal(execution.status, 'done');
    assert.equal(execution.assignee, null);
    const log = await call('task_read', { view: 'automation_log', task_id: created.task_id, offset: 0, limit: 8192 });
    assert.match(log.text, /mcp automation literal/);
    assert.equal((await call('task_read', { view: 'outcomes', task_id: created.task_id })).items[0].source, 'automation');
    const prepare = store.db.prepare.bind(store.db), queries = [];
    store.db.prepare = sql => { queries.push(sql); return prepare(sql); };
    const selected = await call('task_read', {
      view: 'overview', task_id: created.task_id, include: ['automation', 'outcome', 'retro', 'activity'],
    });
    store.db.prepare = prepare;
    assert.deepEqual(selected.automation, execution.automation);
    assert.equal(selected.outcome.source, 'automation');
    assert.equal(selected.outcome.assignee, null);
    assert.equal(selected.outcome.run_id, execution.automation.run_id);
    assert.equal(selected.outcome.current, true);
    assert.deepEqual(selected.retro, { status: 'not_applicable' });
    assert.equal(selected.activity, null);
    for (const query of queries) assert.doesNotMatch(query, /\*|\blog\b/);
    assert.deepEqual(errors, []);
  } finally {
    await f.close();
    service.close();
    for (let tries = 0; !service.closed && tries < 500; tries++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(service.closed, true);
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP invocation metadata supplies caller identity and rejects identity arguments before effects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-mcp-invocation-'));
  const store = new TaskStore(root);
  const service = new TaskService(store, {});
  const f = fixture((name, input, options) => service.execute(name, input, options), undefined, toolSchemas, { injectMeta: false });
  try {
    await f.connect();
    const missing = await f.client.callTool({
      name: 'task_create',
      arguments: { request_id: 'missing', title: 'No meta', description: 'No write' },
    });
    assert.equal(missing.isError, true);
    assert.equal(missing.structuredContent.error.code, 'INVOCATION_REQUIRED');
    assert.equal(store.read({ view: 'list', status: 'all' }).items.length, 0);

    for (const identity of [{ actor: 'victim' }, { invocation: { sessionId: 'victim' } }]) {
      const rejected = await f.client.callTool({
        name: 'task_create',
        arguments: { request_id: randomUUID(), title: 'Legacy identity', description: 'Reject', ...identity },
        _meta: invocationMeta,
      });
      assert.equal(rejected.isError, true);
      assert.equal(rejected.structuredContent.error.code, 'INVALID_INPUT');
      assert.equal(store.read({ view: 'list', status: 'all' }).items.length, 0);
    }

    const created = await f.client.callTool({
      name: 'task_create',
      arguments: { request_id: 'with-meta', title: 'With meta', description: 'Caller wins' },
      _meta: invocationMeta,
    });
    assert.notEqual(created.isError, true, JSON.stringify(created));
    assert.equal(store.task(created.structuredContent.result.task_id).orchestrator, 'orchestrator');
  } finally {
    await f.close();
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('real notification failure crosses MCP without erasing Task effects or resending on inspection/replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-mcp-subscription-'));
  const store = new TaskStore(root);
  const sent = [];
  const service = new TaskService(store, {
    sessionExists: async () => true,
    async send(orchestrator, text) { sent.push({ orchestrator, text }); throw new Error('Synthetic lost acceptance response'); },
  });

  const f = fixture((name, input, options) => service.execute(name, input, options), undefined, toolSchemas);
  const call = async (name, input, sessionId = 'orchestrator') => {
    const response = await f.client.callTool({ name, arguments: input,
      _meta: { 'cockpit/invocation': { sessionId, runtimeSessionId: sessionId, subagent: false } },
    });
    assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
    assert.ok(response.structuredContent.definition_check);
    return response;
  };
  try {
    await f.connect();
    const created = await call('task_create', {
      request_id: 'create', title: 'Synthetic Task', description: 'Verify delivery evidence.',
    });
    assert.notEqual(created.isError, true);
    const { task_id, write_context } = created.structuredContent.result;
    const registered = await call('task_subscribe', {
      request_id: 'subscribe', task_id, write_context, statuses: ['cancelled'],
    }, 'observer');
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
      orchestrator: 'observer', text: `[Subscribed Task status changed](task:${task_id}?event=status_changed)`,
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
      name: 'task_read', arguments: { task_id: 'one', guessed_role: 'orchestrator' },
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
      const result = await assignTask({
        input: { ...input, assignee: 'synthetic-assignee', request_id: 'cancelled-operation' },
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
