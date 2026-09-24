import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, CancelledNotificationSchema, ErrorCode, JSONRPCMessageSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';
import { invocationFromMeta } from './contracts.js';

const descriptions = {
  task_read: 'Read bounded Task data. The caller is the session named by host invocation metadata; reads return actor_role (orchestrator, assignee or none) relative to it. overview+include combines only needed latest groups in one consistent read. For list, filter by orchestrator, assignee or parent_task_id, or omit them with status=unfinished for the pre-dispatch conflict check across all Tasks. An assignee starts/resumes with execution, not a selection. Context: blocked_by, ready, parent/depth. retro filter: unhandled|watching. Histories, retro_handlings, notices and automation_log stay paginated. Reads never acknowledge.',
  task_create: 'Register a Task with complete requirements; the calling session becomes its orchestrator. If the caller is executing a Task, the new Task is automatically that Task\'s Subtask (lineage recorded, no parent input; max 3 levels, DELEGATION_DEPTH_EXCEEDED). Optional automation selects a registered script and typed parameters, saving an immutable snapshot, no Agent assignee; Linux/WSL2 only, else AUTOMATION_PLATFORM. Never executes or assigns. Optional blocked_by: Tasks (any orchestrator, never an ancestor: BLOCKER_ANCESTOR) that must be done before assign/start. Keep request_id stable on retry.',
  task_script_register: 'Register an existing trusted local script; never execute it. Immutable script_id, absolute executable/script_path, fixed argv and ordered required parameter descriptions. Execution uses executable [...argv, script_path, ...parameterValues], no shell. Strings pass literally, booleans as true/false. Script bytes are fingerprinted; changing code requires a new ID. Same-user trust, not a sandbox; Linux/WSL2 only, else AUTOMATION_PLATFORM; no daemonization or detached descendants.',
  task_script_read: 'Discover immutable registered scripts and their input/execution boundary. Select script_id for one complete registration or paginate the catalog. Does not execute scripts.',
  task_automation_start: 'Orchestrator only (ORCHESTRATOR_REQUIRED). Explicitly enqueue a created automation Task once, after optional status subscription. The module executes one script at a time without Agent polling. Rejects TASK_NOT_READY while a blocked_by Task is not done. Freezes the definition until execution ends. Success writes done+outcome, failure/interruption blocked+outcome; no retry. Replaying a request never reruns the script.',
  task_automation_reconcile: 'Orchestrator only (ORCHESTRATOR_REQUIRED). Clear an interrupted/finished automation barrier after the kernel proves the recorded Linux group absent, or no durable PID proves no launch handshake was sent. Existing groups, including unreaped zombies, stay blocked. Does not kill recovered processes, rerun scripts, change Task status or claim success. Inspect effects first; another run requires a newly authorized Task.',
  task_session_create: 'Create a real session with the Node role; readiness checks Node capability. Optionally prepare explicitly selected existing skills and mcp_servers; no automatic matching, installation or authentication. Omitted selections preserve ordinary creation. Resource-aware creation requires host preparation v1 before creating. Does not bind a Task or send a prompt. Inspect per-step effects and readiness; never recreate on an unknown result.',
  task_session_prepare: 'Prepare explicitly selected existing skills and mcp_servers for an already loaded idle Node session with no unfinished Task. Enables only selected resources, initializes tools when needed and checks actual offered tools plus Node readiness. Preserves unrelated choices; no reload, new role, model change, Task binding or prompt. Stable request replay never repeats effects; inspect operation and native state before any new request. Enabled Skill does not mean its body was loaded.',
  task_assign: 'Orchestrator only (ORCHESTRATOR_REQUIRED). Assign an unassigned Agent Task to another existing capable Node session (its assignee) and send one "Task assigned" reference. Rejects automation, SELF_ASSIGNMENT (the orchestrator itself) and DELEGATION_CYCLE (ancestors). Checks capability and idle/empty state without installing capability or proactively interrupting. TASK_NOT_READY until blocked_by is done. Checks and send are not atomic; a race may return queued or unconfirmed. Inspect durable per-step results and failure-time availability_reasons; never blindly resend. A finalized receipt proving assignment=applied and message=not_sent may be finished once with resume_request_id.',
  task_edit: 'Orchestrator or assignee only (ORCHESTRATOR_OR_ASSIGNEE_REQUIRED). Replace the complete description or edit Task metadata. Description changes keep a changelog. Only an actual description change by the assignee on its unfinished Task automatically acknowledges that revision; unchanged text and metadata-only edits do not. Queued/running automation rejects edits; script and parameter snapshots are immutable. blocked_by replaces the complete blocker set on any unfinished Task (automation only before it starts). A description or blocked_by change by anyone but the assignee on an assigned unfinished Agent Task makes the service send the assignee one fixed immediate [Task updated] card; other edits save silently. When every blocker is done, or one is cancelled, the service notifies the assignee of an assigned dependent the same way, or the orchestrator of an undispatched one. Put every explanation in the definition; there are no free-text notes. Never changes execution status; inspect notifications/notification_error separately from saved effects.',
  task_ack: 'Assignee only (ASSIGNEE_REQUIRED). Record that the assignee has read the current description revision. Automation is service-managed and rejects ACK. Does not start work, add activity or send messages.',
  task_reopen: 'Explicit user rework: the orchestrator or the original assignee (ORCHESTRATOR_OR_ASSIGNEE_REQUIRED) reopens a done Agent Task to in_progress for that ready assignee with full description/reason and a new revision, even for identical text. The assignee reopening auto-ACKs; anyone else makes the service send the assignee one fixed immediate [Task updated] card to read and ACK. Requires post-upgrade assignment tracking, no later assignment or unfinished Task, fresh revision/context and safe retained workspace. Preserves history; old outcomes/retros become historical. No cancelled/automation reopen, dispatch or subscription renewal. Keep request_id stable.',
  task_report: 'Assignee only (ASSIGNEE_REQUIRED). Reports against an acknowledged revision. Automation rejects Agent reports. done requires a new outcome in the same request and explicit retro: useful text or null for no findings; omission is rejected. Stale activity may save while stale status/outcome/retro are rejected. Notices: a matching subscription notifies its subscriber; dependents whose blockers are all done notify their assignee, or their orchestrator while undispatched; a Subtask\'s done/blocked notifies its parent Task\'s assignee. Inspect notification_error separately from saved effects; never blindly resend.',
  task_cancel: 'Orchestrator or assignee only (ORCHESTRATOR_OR_ASSIGNEE_REQUIRED). Cancel an unfinished Task with a reason. Anyone but the assignee cancelling an assigned Agent Task makes the service send the assignee one fixed immediate [Task cancelled] card; sessions are otherwise not interrupted. Queued automation never launches; running automation requests process-group termination, but cancelled is not proof of exit or rollback: read run facts/outcome/barrier. Other notices: a matching subscription notifies its subscriber; a dependent of this blocker notifies its assignee, or its orchestrator while undispatched; a Subtask notifies its parent Task\'s assignee. Cancelled Tasks cannot reopen. Inspect notification_error separately from saved effects.',
  task_subscribe: 'Optional: default to no subscription. Any caller may register a one-shot wait, only when a target state enables its necessary follow-up, not progress tracking. The subscriber (the caller) receives the card; a Web board user\'s card goes to the orchestrator. Rejects an already-matching status, terminal Task or a duplicate waiting subscription by the same subscriber. First matching transition consumes the wait and enqueues a status card. Inspect subscriptions for delivery facts; acceptance does not mean read.',
  task_retro_handle: 'Any caller records how a recorded retro with findings (by outcome_id, normally the latest) was handled: fixed, followup (reference required; terminal, never revisited when the follow-up finishes), watching or dismissed, with a note. A newer retro after reopen is a separate retro. Rewrites append history. Sends no messages and changes no Task status. List retro=unhandled|watching finds pending ones.',
  task_unsubscribe: 'Cancel a still-waiting Task status subscription using its subscription_id and a stable request_id, including when the planned follow-up is no longer needed; any caller may cancel it. Cannot recall a consumed notification. Read subscriptions to inspect the recorded transition and notification result.',
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
    const server = new Server({ name: 'cockpit-task', version: '0.2.0' }, { capabilities: { tools: {} } });
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
          // Caller identity comes only from host-injected invocation metadata, never from arguments.
          const result = await execute(name, params.arguments, {
            signal: AbortSignal.any([request.signal, extra.signal, lifetime.signal, signal]),
            invocation: invocationFromMeta(params._meta), external: true,
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
