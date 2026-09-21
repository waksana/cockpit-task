import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, CancelledNotificationSchema, ErrorCode, JSONRPCMessageSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';

const descriptions = {
  task_read: 'Read bounded Task views. For list, explicitly filter by owner or executor; actor_session_id checks your current assigned Task too but is not an automatic list filter or authentication. Use overview for one Task, definition before edits and execution for complete current requirements. Histories, outcomes and subscriptions are separate; subscriptions include durable notification evidence even for terminal Tasks. Reads never acknowledge.',
  task_create: 'Register an independent unassigned Task with complete requirements. Does not create a session or send a message. Keep request_id stable on retry.',
  task_session_create: 'Create a real Executor session with the Task role, Skill and MCP through Cockpit. Does not bind a Task or send a prompt. Inspect readiness and any partial result; never recreate on an unknown result.',
  task_assign: 'Assign an unassigned Task to an existing capable Executor and send one assigned reference. Checks capability and idle/empty state without installing capability or proactively interrupting. The checks and enqueue send are not atomic: a race may return queued or unconfirmed. Inspect durable per-step results; never blindly resend.',
  task_edit: 'Replace the complete description or edit Task metadata. Description changes keep a changelog. Only an actual description change by the assigned Executor on an unfinished Task automatically acknowledges that revision; unchanged text and metadata-only edits do not. Does not send messages or change execution status.',
  task_ack: 'Record that the assigned Executor has read the current description revision. Does not start work, add activity or send messages. Report authorship truthfully; actor_session_id is attribution, not verified identity.',
  task_report: 'Report activity against an acknowledged revision, explicit status and/or an outcome. done requires a new outcome in the same request. Stale activity may save while stale status/outcome are rejected; never relabel old work as a new revision. Only an actual transition matching an explicit subscription notifies the Task Owner. Inspect notification_error separately from saved Task effects; never blindly resend.',
  task_cancel: 'Cancel an unfinished Task with a reason. Does not interrupt its session or clear messages. Only an explicit subscription targeting cancelled notifies its Task Owner. Terminal Tasks cannot reopen. Inspect notification_error separately from saved Task effects.',
  task_subscribe: 'Explicitly register one waiting, one-shot subscription for this Task Owner, derived from the Task, not the actor. Rejects an already-matching status, terminal Task or duplicate waiting subscription. The first actual transition into any target status consumes it and enqueues one status-update card. Read subscriptions for durable delivery evidence; acceptance does not mean read.',
  task_unsubscribe: 'Cancel a still-waiting Task status subscription using its subscription_id and a stable request_id. Cannot recall a consumed notification. Read subscriptions to inspect the recorded transition and notification result. Actor attribution is not authentication.',
};

export function createMcpRoutes({ execute, schemas, signal, report }) {
  const connections = new Set();
  const sessions = new Map();
  const tools = Object.entries(schemas).map(([name, schema]) => ({
    name, description: descriptions[name], inputSchema: z.toJSONSchema(schema, { target: 'draft-7' }),
    annotations: {
      readOnlyHint: name === 'task_read', destructiveHint: name !== 'task_read',
      idempotentHint: true, openWorldHint: ['task_assign', 'task_session_create', 'task_report', 'task_cancel'].includes(name),
    },
  }));
  let stopped = false;

  async function connection() {
    const server = new Server({ name: 'cockpit-task', version: '0.1.0' }, { capabilities: { tools: {} } });
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
