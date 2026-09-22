import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, CancelledNotificationSchema, ErrorCode, JSONRPCMessageSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';

const descriptions = {
  task_read: 'Read bounded Task views. For list, explicitly filter by owner or executor; actor_session_id checks your assigned Task but is not an automatic list filter or authentication. Use overview for summary, definition before edits and execution for full requirements and automation snapshot. Histories/outcomes/subscriptions are separate. automation_log reads retained output with offset/limit and explicit omitted counts. Reads never acknowledge.',
  task_create: 'Register an independent Task with complete requirements. Optional automation selects a registered script and typed parameters, saving an immutable snapshot without an Agent Executor. Creation never executes: optionally subscribe, then task_automation_start. Ordinary Tasks remain unassigned. Keep request_id stable on retry.',
  task_script_register: 'Register an existing trusted local script; never execute it. Immutable script_id, absolute executable/script_path, fixed argv and ordered required parameter descriptions. Execution uses executable [...argv, script_path, ...parameterValues], no shell. Strings pass literally, booleans as true/false. Script bytes are fingerprinted; changing code requires a new ID. Same-user trust, not a sandbox; Linux only, no daemonization or detached descendants.',
  task_script_read: 'Discover immutable registered scripts and their input/execution boundary. Select script_id for one complete registration or paginate the catalog. Does not execute scripts.',
  task_automation_start: 'Explicitly enqueue a created automation Task once, after optional status subscription. The module executes one script at a time without Agent polling. Freezes the definition until execution ends. Success writes done+outcome, failure/interruption blocked+outcome; no retry. Replaying a request never reruns the script.',
  task_automation_reconcile: 'Clear an interrupted/finished automation barrier after the kernel proves the recorded Linux group absent, or no durable PID proves no launch handshake was sent. Existing groups, including unreaped zombies, stay blocked. Does not kill recovered processes, rerun scripts, change Task status or claim success. Inspect effects first; another run requires a newly authorized Task.',
  task_session_create: 'Create a real Executor with its Task role. Optionally prepare explicitly selected existing skills and mcp_servers; no automatic matching, installation or authentication. Omitted selections preserve ordinary creation. Resource-aware creation requires host preparation v1 before creating. Does not bind a Task or send a prompt. Inspect per-step effects and readiness; never recreate on an unknown result.',
  task_session_prepare: 'Prepare explicitly selected existing skills and mcp_servers for an already loaded idle Executor with no unfinished Task. Enables only selected resources, initializes tools when needed and checks actual offered tools plus Executor readiness. Preserves unrelated choices; no reload, new role, model change, Task binding or prompt. Stable request replay never repeats effects; inspect operation and native state before any new request. Enabled Skill does not mean its body was loaded.',
  task_assign: 'Assign an unassigned Agent Task to an existing capable Executor and send one assigned reference. Automation is rejected. Checks capability and idle/empty state without installing capability or proactively interrupting. The checks and enqueue send are not atomic: a race may return queued or unconfirmed. Inspect durable per-step results and failure-time availability_reasons; never blindly resend.',
  task_edit: 'Replace the complete description or edit Task metadata. Description changes keep a changelog. Only an actual description change by the assigned Executor on an unfinished Task automatically acknowledges that revision; unchanged text and metadata-only edits do not. Queued/running automation rejects edits; script and parameter snapshots are immutable. Does not send messages or change execution status.',
  task_ack: 'Record that the assigned Executor has read the current description revision. Automation is service-managed and rejects ACK. Does not start work, add activity or send messages. Report authorship truthfully; actor_session_id is attribution, not verified identity.',
  task_report: 'Report against an acknowledged revision. Automation rejects Agent reports. done requires a new outcome in the same request and explicit retro: useful text or null for no findings; omission is rejected. Retro is completion-only; submission does not prove reflection quality. Stale activity may save while stale status/outcome/retro are rejected. Only matching subscribed transitions notify Owner. Inspect notification_error separately from saved effects; never blindly resend.',
  task_cancel: 'Cancel an unfinished Task with a reason. Agent sessions are not interrupted. Queued automation never launches; running automation requests process-group termination, but cancelled is not proof of exit or rollback: read run facts/outcome/barrier. Only an explicit subscription targeting cancelled notifies Owner. Terminal Tasks cannot reopen. Inspect notification_error separately from saved effects.',
  task_subscribe: 'Optional: default to no subscription. Register a one-shot wait only when a target state enables necessary Owner follow-up, not progress tracking. Recipient is derived from the Task, not the actor. Rejects an already-matching status, terminal Task or duplicate waiting subscription. First matching transition consumes the wait and enqueues a status card. Inspect subscriptions for delivery facts; acceptance does not mean read.',
  task_unsubscribe: 'Cancel a still-waiting Task status subscription using its subscription_id and a stable request_id, including when the planned Owner follow-up is no longer needed. Cannot recall a consumed notification. Read subscriptions to inspect the recorded transition and notification result. Actor attribution is not authentication.',
};

export function createMcpRoutes({ execute, schemas, signal, report }) {
  const connections = new Set();
  const sessions = new Map();
  const tools = Object.entries(schemas).map(([name, schema]) => ({
    name, description: descriptions[name], inputSchema: z.toJSONSchema(schema, { target: 'draft-7' }),
    annotations: {
      readOnlyHint: ['task_read', 'task_script_read'].includes(name), destructiveHint: !['task_read', 'task_script_read'].includes(name),
      idempotentHint: true, openWorldHint: ['task_assign', 'task_session_create', 'task_session_prepare', 'task_report', 'task_cancel', 'task_automation_start'].includes(name),
    },
  }));
  let stopped = false;

  async function connection() {
    const server = new Server({ name: 'cockpit-task', version: '0.1.7' }, { capabilities: { tools: {} } });
    const lifetime = new AbortController();
    const pending = new Map();
    const state = {
      server, lifetime, pending, release: undefined, transport: undefined,
      terminated: false, released: false, initializing: true, executing: 0, streams: 0, requests: 0, idleTimer: undefined,
      idle: () => !state.initializing && pending.size === 0 && state.executing === 0 && state.streams === 0 && state.requests === 0,
      maintain: () => {
        clearTimeout(state.idleTimer);
        if (!state.released && state.idle()) {
          state.idleTimer = setTimeout(() => state.release(), 5 * 60_000);
          state.idleTimer.unref();
        }
      },
    };
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: id => { state.initializing = false; sessions.set(id, state); },
      onsessionclosed: id => { sessions.delete(id); state.terminated = true; },
    });
    state.transport = transport;
    const release = () => {
      if (state.released) return;
      state.released = true;
      clearTimeout(state.idleTimer);
      lifetime.abort(new Error('Task MCP connection closed'));
      connections.delete(state);
      sessions.delete(transport.sessionId);
      signal.removeEventListener('abort', release);
      void server.close().catch(report);
    };
    state.release = release;
    connections.add(state);
    signal.addEventListener('abort', release, { once: true });
    for (const method of ['tools/list', 'tools/call', 'ping']) {
      // Business validation stays in the shared service, inside this lifetime.
      server.setRequestHandler(z.object({ method: z.literal(method), params: z.unknown().optional() }), async (message, extra) => {
        const request = pending.get(extra.requestId);
        if (!request) throw new Error('MCP request has no active HTTP context');
        request.protocolSignal = extra.signal;
        request.executing = true;
        state.executing++;
        state.maintain();
        try {
          if (method === 'ping') return {};
          if (method === 'tools/list') return { tools };
          const params = message.params;
          const name = params?.name;
          if (typeof name !== 'string' || !Object.hasOwn(schemas, name)) {
            throw new McpError(ErrorCode.InvalidParams, 'Unknown Task tool');
          }
          const result = await execute(name, params.arguments, {
            signal: AbortSignal.any([request.signal, extra.signal, lifetime.signal, signal]),
      });
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
            ...(result.error || result.notification_error ? { isError: true } : {}),
          };
        } finally {
          request.executing = false;
          if (request.cleaned && extra.signal.aborted && pending.get(extra.requestId) === request) pending.delete(extra.requestId);
          state.executing--;
          state.maintain();
        }
      });
    }
    try {
      await server.connect(transport);
      const send = transport.send.bind(transport);
      transport.send = (message, options) => {
        if ('result' in message || 'error' in message) {
          const request = pending.get(message.id);
          if (request?.cancelled) {
            pending.delete(message.id);
            state.maintain();
            return Promise.resolve();
          }
          if (request) request.responseStarted = true;
        }
        return send(message, options);
      };
      const receive = transport.onmessage;
      const cancelledResponse = id => {
        // The SDK suppresses cancelled responses but retains their HTTP stream.
        void send({ jsonrpc: '2.0', id, error: { code: -32800, message: 'Request cancelled' } }).catch(report);
      };
      transport.onmessage = (message, extra) => {
        if ('id' in message && 'method' in message) {
          const request = pending.get(message.id);
          if (state.released) return;
          if (!request || request.cancelled) {
            if (request) request.completedWithoutCallback = true;
            cancelledResponse(message.id);
            return;
          }
          request.dispatched = true;
          receive(message, extra);
          return;
        }
        if ('id' in message || message.method !== 'notifications/cancelled') {
          receive(message, extra);
          return;
        }
        const id = message.params?.requestId;
        const request = pending.get(id);
        if (!request || request.method === 'initialize' || request.responseStarted || state.released) return;
        request.cancelled = true;
        request.responseStarted = true;
        request.cancellation.abort(new Error('MCP request cancelled'));
        if (request.dispatched) {
          receive(message, extra);
          cancelledResponse(id);
        }
      };
      return state;
    } catch (error) { release(); throw error; }
  }

  async function handle(method, request) {
    if (stopped || signal.aborted) return rpcError(503, 'Task module is stopping');
    if (method === 'POST') {
      if (!JSONRPCMessageSchema.safeParse(request.body).success) return rpcError(400, 'Invalid JSON-RPC message; batch requests are not supported');
      if (request.body.method === 'tools/call' && (!CallToolRequestSchema.safeParse(request.body).success
        || request.body.params.task !== undefined)) return rpcError(400, 'Invalid tools/call envelope; MCP task-augmented execution is not supported');
      if (request.body.method === 'notifications/cancelled' && !('id' in request.body)
        && !CancelledNotificationSchema.safeParse(request.body).success) return rpcError(400, 'Invalid MCP cancellation notification');
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) for (const entry of value) headers.append(key, entry);
      else if (value !== undefined) headers.set(key, value);
    }
    const sessionId = headers.get('mcp-session-id');
    let state = sessionId ? sessions.get(sessionId) : undefined;
    if (sessionId && !state) return rpcError(404, 'MCP session does not exist; reconnect explicitly');
    if (!state) {
      if (method !== 'POST' || request.body?.method !== 'initialize') return rpcError(400, 'Initialize an MCP session first');
      if (connections.size >= 256) {
        for (const candidate of connections) {
          if (candidate.idle()) { candidate.release(); break; }
        }
      }
      if (connections.size >= 256) return rpcError(503, 'Task MCP connection capacity reached; close unused connections');
      state = await connection();
    }
    const cancellation = new AbortController();
    const requestSignal = AbortSignal.any([request.signal, signal, state.lifetime.signal, cancellation.signal]);
    const requestId = method === 'POST' ? request.body?.id : undefined;
    if (requestId !== undefined && state.pending.has(requestId)) return rpcError(409, 'MCP request ID is already active');
    const context = { signal: requestSignal, method: request.body?.method, dispatched: false, responseStarted: false, cancellation, cancelled: false, cleaned: false, executing: false };
    if (requestId !== undefined) state.pending.set(requestId, context);
    state.requests++;
    state.maintain();
    let complete = false;
    let body;
    const cleanup = () => {
      if (complete) return;
      complete = true;
      context.cleaned = true;
      requestSignal.removeEventListener('abort', abort);
      if (requestId !== undefined && (!context.cancelled || !context.dispatched || context.completedWithoutCallback
        || (!context.executing && context.protocolSignal?.aborted) || state.released)) state.pending.delete(requestId);
      if (body) state.streams--;
      state.maintain();
    };
    const abort = () => {
      if (!state.released && !context.cancelled && requestId !== undefined && !context.responseStarted) {
        state.transport.onmessage({
          jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId },
        });
      }
      if (!context.cancelled || state.released) body?.destroy();
    };
    requestSignal.addEventListener('abort', abort, { once: true });
    try {
      requestSignal.throwIfAborted();
      const nativeRequest = new Request('http://cockpit-task.invalid/mcp', {
        method, headers, signal: requestSignal,
      });
      const response = await untilAborted(
        state.transport.handleRequest(nativeRequest, { parsedBody: request.body }), requestSignal,
      );
      body = response.body ? Readable.fromWeb(response.body) : undefined;
      if (body) {
        state.streams++;
        body.once('end', cleanup);
        body.once('close', cleanup);
        if (requestSignal.aborted) abort();
      } else cleanup();
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        ...(body ? { body } : {}),
      };
    } catch (error) {
      cleanup();
      throw error;
    } finally {
      state.requests--;
      state.maintain();
      if (!state.transport.sessionId || (method === 'DELETE' && state.terminated)) state.release();
    }
  }

  return {
    routes: [
      { method: 'POST', path: '/mcp', body: 'json', bodyLimit: 262144, handler: request => handle('POST', request) },
      ...['GET', 'DELETE'].map(method => ({
        method, path: '/mcp',
        handler: request => handle(method, request),
      })),
    ],
    close() {
      stopped = true;
      for (const state of [...connections]) state.release();
    },
  };
}

function rpcError(status, message) {
  return { status, headers: { 'Content-Type': 'application/json' }, body: { jsonrpc: '2.0', id: null, error: { code: -32000, message } } };
}

function untilAborted(promise, signal) {
  let abort;
  return new Promise((resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject);
    if (signal.aborted) abort();
  }).finally(() => signal.removeEventListener('abort', abort));
}
