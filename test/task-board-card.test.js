import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activate,
  acknowledgementLabel,
  createReadResource,
  formatTimestamp,
  nativeStatusLabel,
  parseTaskReference,
  readNativeSession,
  readTask,
  safeReferenceHref,
  statusLabel,
} from '../web/task-board/index.js';

const taskId = 'd10c0c92-3580-4cdd-85bf-d7fcf22ab3ff';
const input = { view: 'overview', task_id: taskId };
const result = {
  id: taskId, title: 'Synthetic Task', owner: 'synthetic-owner', executor: null,
  status: 'todo', revision: 1, acknowledged_revision: null, activity: null,
};
const response = (data = result, error = null, status = 200) =>
  new Response(JSON.stringify({ result: data, error, definition_check: null }), { status });
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  const requests = [];
  const invalidations = new Set();
  const events = new Set();
  const hostListeners = new Set();
  const controller = new AbortController();
  let hostSnapshot = { visible: true, connected: true, sessionId: null };
  const subscribe = (set) => (listener) => {
    set.add(listener);
    return () => set.delete(listener);
  };
  const context = {
    signal: controller.signal,
    state: {
      host: { getSnapshot: () => hostSnapshot, subscribe: subscribe(hostListeners) },
    },
    request(path, init) {
      return new Promise((resolve, reject) => requests.push({ path, init, resolve, reject }));
    },
    onInvalidate: subscribe(invalidations),
    onEvent: subscribe(events),
  };
  return {
    context, controller, requests, invalidations, events, hostListeners,
    invalidate() { for (const listener of invalidations) listener(); },
    event(event) { for (const listener of events) listener(event); },
    host(change) {
      hostSnapshot = { ...hostSnapshot, ...change };
      for (const listener of hostListeners) listener();
    },
  };
}

test('Task references claim only exact link targets with canonical UUIDs', () => {
  assert.equal(parseTaskReference({ kind: 'link', target: `task:${taskId}` }), taskId);
  assert.equal(parseTaskReference({ kind: 'link', target: `task:${taskId.toUpperCase()}` }), taskId);
  assert.equal(parseTaskReference({ kind: 'link', target: `task:${taskId}?event=assigned` }), taskId);
  assert.equal(parseTaskReference({ kind: 'link', target: `task:${taskId}?event=updated` }), taskId);
  for (const target of [
    `TASK:${taskId}`, `Task:${taskId}`, `task:${taskId}#revision`, `task:${taskId}?view=execution`,
    `task://${taskId}`, ` task:${taskId}`, `task:${taskId}\n`, `task:${taskId}/`, 'task:not-an-id',
    `https://example.test/task:${taskId}`, `[Task](task:${taskId})`, null, {},
    `task:${taskId}?event=unknown`, `task:${taskId}?event=updated&event=assigned`,
    './report.csv', 'file:///tmp/report.csv',
  ]) assert.equal(parseTaskReference({ kind: 'link', target }), null, String(target));
  assert.equal(parseTaskReference({ kind: 'image', target: `task:${taskId}` }), null);
  assert.equal(parseTaskReference(null), null);
});

test('reference URLs allow only explicit safe protocols and no credentials', () => {
  assert.equal(safeReferenceHref('https://example.test/path?q=one#two'), 'https://example.test/path?q=one#two');
  assert.equal(safeReferenceHref('http://example.test'), 'http://example.test/');
  assert.equal(safeReferenceHref('mailto:owner@example.test'), 'mailto:owner@example.test');
  for (const target of [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,hello', 'file:///etc/passwd',
    'blob:https://example.test/123', '//example.test/path', '/relative', 'https://user:pass@example.test',
    'https://example.test/\nhello', ' https://example.test', `task:${taskId}`, null, {},
  ]) assert.equal(safeReferenceHref(target), null, String(target));
});

test('status, revision and time helpers keep unknown and stale state explicit', () => {
  assert.equal(statusLabel('in_review'), 'In review');
  assert.equal(statusLabel('cancelled'), 'Cancelled');
  assert.match(statusLabel('new_status'), /Unknown status/);
  assert.match(statusLabel('__proto__'), /Unknown status/);
  assert.equal(acknowledgementLabel(3, null), 'Definition v3 · not ACKed');
  assert.equal(acknowledgementLabel(3, 3), 'Definition v3 · ACK v3');
  assert.match(acknowledgementLabel(3, 1), /ACK v1 · current definition not ACKed/);
  assert.equal(formatTimestamp('2026-09-20T01:02:03Z'), '2026-09-20 01:02:03 UTC');
  assert.equal(formatTimestamp('not a date'), 'Time unavailable');
  assert.equal(formatTimestamp(null), 'Time unavailable');
});

test('activation requires public compatibility and preserves native fallback on nonmatch', () => {
  assert.throws(() => activate({ apiVersion: 1, uiVersion: 1 }), /Web API v2/);
  assert.throws(() => activate({ apiVersion: 2, uiVersion: 0 }), /Module UI v1/);
  assert.throws(() => activate({ apiVersion: 2, uiVersion: 1 }), /createPortal/);
  const module = activate({
    apiVersion: 2, uiVersion: 1, createPortal() {},
    react: { createElement: (type, props) => ({ type, props }) },
  });
  assert.equal(module.apiVersion, 2);
  assert.equal(module.markdown.length, 1);
  const renderer = module.markdown[0];
  assert.equal(renderer.matches({ kind: 'image', target: `task:${taskId}` }), false);
  const fallback = { native: 'unchanged' };
  assert.equal(renderer.component({ node: { kind: 'link', target: 'https://example.test' }, fallback }), fallback);
  const rendered = renderer.component({ node: { kind: 'link', target: `task:${taskId}` }, fallback });
  assert.equal(rendered.props.taskId, taskId);
  assert.equal(rendered.props.event, null);
  for (const event of ['assigned', 'updated']) {
    const node = { kind: 'link', target: `task:${taskId}?event=${event}`, label: 'An unrelated label' };
    assert.equal(renderer.matches(node), true);
    assert.equal(renderer.component({ node, fallback }).props.event, event);
  }
  const unknown = { kind: 'link', target: `task:${taskId}?event=deleted`, label: 'Task assigned to you' };
  assert.equal(renderer.matches(unknown), false);
  assert.equal(renderer.component({ node: unknown, fallback }), fallback);
});

test('card event headings come from the message and survive loading, failure and Task updates', () => {
  let snapshot = { phase: 'loading', data: null, error: null };
  const context = {
    apiVersion: 2, uiVersion: 1, createPortal() {},
    signal: new AbortController().signal,
    react: {
      Fragment: 'fragment',
      createElement: (type, props, ...children) => ({ type, props, children }),
      useMemo: callback => callback(),
      useSyncExternalStore: () => snapshot,
      useEffect() {},
      useRef: () => ({ current: null }),
      useState: value => [value, () => {}],
    },
  };
  const renderer = activate(context).markdown[0];
  const render = (event, label = 'Task') => {
    const node = { kind: 'link', target: `task:${taskId}${event ? `?event=${event}` : ''}`, label };
    const card = renderer.component({ node, fallback: null });
    return card.type(card.props).children[0];
  };
  const heading = card => card.children.find(child => child?.props?.className === 'tb-card-event');
  assert.deepEqual(heading(render('assigned')).children, ['Task assigned to you']);
  snapshot = { phase: 'ready', data: { ...result, status: 'done', revision: 4 }, error: null };
  assert.deepEqual(heading(render('assigned', 'Task updated')).children, ['Task assigned to you']);
  assert.deepEqual(heading(render('updated', 'Task assigned to you')).children, ['Task updated']);
  assert.equal(heading(render(null, 'Task updated')), undefined);
  snapshot = { phase: 'missing', data: null, error: new Error('Missing Task') };
  assert.deepEqual(heading(render('updated')).children, ['Task updated']);
});

test('HTTP reads use the scoped POST contract, without reported actor or chat requests', async () => {
  const f = fixture();
  const controller = new AbortController();
  const promise = readTask(f.context, input, controller.signal);
  assert.equal(f.requests[0].path, '/read');
  assert.equal(f.requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(f.requests[0].init.body), input);
  assert.equal(f.requests[0].init.signal, controller.signal);
  f.requests[0].resolve(response());
  assert.deepEqual(await promise, result);
});

test('HTTP and envelope failures are explicit rather than empty successful data', async () => {
  for (const [reply, pattern] of [
    [response(null, { code: 'TASK_NOT_FOUND', message: 'Missing Task' }), /Missing Task/],
    [response(null, null, 503), /HTTP 503/],
    [new Response('not JSON', { status: 502 }), /invalid response/],
    [new Response(JSON.stringify({ result })), /invalid result/],
    [response(null), /invalid result/],
    [response({}), /invalid result/],
    [response({ ...result, acknowledged_revision: undefined }), /invalid result/],
    [response({ ...result, activity: {} }), /invalid result/],
    [response({ ...result, id: 'wrong-task' }), /invalid result/],
  ]) {
    await assert.rejects(readTask({ request: async () => reply }, input), pattern);
  }
});

test('superseded reads cannot overwrite current data even if abort is ignored', async () => {
  const f = fixture();
  const resource = createReadResource(f.context, input);
  resource.start();
  assert.equal(f.requests.length, 1);
  f.invalidate();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].init.signal.aborted, true);
  f.requests[1].resolve(response({ ...result, title: 'New' }));
  await settle();
  assert.equal(resource.getSnapshot().data.title, 'New');
  f.requests[0].resolve(response({ ...result, title: 'Old' }));
  await settle();
  assert.equal(resource.getSnapshot().data.title, 'New');
  resource.stop();
});

test('only relevant Task events refresh and cleanup revokes subscriptions and late updates', async () => {
  const f = fixture();
  const resource = createReadResource(f.context, input);
  let notifications = 0;
  const unsubscribe = resource.subscribe(() => notifications++);
  resource.start();
  resource.start();
  f.event({ type: 'task/changed', task_id: 'other-task' });
  f.event({ type: 'other', task_id: taskId });
  assert.equal(f.requests.length, 1);
  f.event({ type: 'task/changed', task_id: taskId });
  assert.equal(f.requests.length, 2);
  resource.stop();
  const stoppedNotifications = notifications;
  assert.equal(f.invalidations.size, 0);
  assert.equal(f.events.size, 0);
  assert.equal(f.hostListeners.size, 0);
  f.requests[1].resolve(response());
  await settle();
  assert.equal(notifications, stoppedNotifications);
  assert.equal(f.requests[1].init.signal.aborted, true);
  unsubscribe();
});

test('module abort stops pending work and does not auto-retry', async () => {
  const f = fixture();
  const resource = createReadResource(f.context, input);
  resource.start();
  f.controller.abort();
  assert.equal(f.requests[0].init.signal.aborted, true);
  f.requests[0].reject(new Error('late failure'));
  await settle();
  await resource.refresh();
  resource.start();
  assert.equal(f.requests.length, 1);
  assert.equal(f.events.size, 0);
});

test('read state differentiates missing/error and explicit retry recovers', async () => {
  const f = fixture();
  const resource = createReadResource(f.context, input);
  resource.start();
  f.requests[0].resolve(response(null, { code: 'TASK_NOT_FOUND', message: 'No Task' }));
  await settle();
  assert.equal(resource.getSnapshot().phase, 'missing');
  const retry = resource.refresh();
  f.requests[1].reject(new Error('Network unavailable'));
  await retry;
  assert.equal(resource.getSnapshot().phase, 'error');
  assert.match(resource.getSnapshot().error.message, /Network unavailable/);
  const recover = resource.refresh();
  f.requests[2].resolve(response());
  await recover;
  assert.equal(resource.getSnapshot().phase, 'ready');
  resource.stop();
});

test('hidden views do not fetch; visibility and reconnect re-read current data', async () => {
  const f = fixture();
  f.host({ visible: false });
  const resource = createReadResource(f.context, input);
  resource.start();
  f.invalidate();
  assert.equal(f.requests.length, 0);
  f.host({ visible: true });
  assert.equal(f.requests.length, 1);
  f.host({ connected: false });
  assert.equal(f.requests[0].init.signal.aborted, true);
  assert.equal(resource.getSnapshot().phase, 'offline');
  f.invalidate();
  assert.equal(f.requests.length, 1);
  f.host({ connected: true });
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve(response());
  await settle();
  assert.equal(resource.getSnapshot().phase, 'ready');
  resource.stop();
});

test('read resource can restart after effect cleanup without accepting the old request', async () => {
  const f = fixture();
  const resource = createReadResource(f.context, input);
  resource.start();
  resource.stop();
  resource.start();
  f.requests[0].resolve(response({ ...result, title: 'Old effect' }));
  f.requests[1].resolve(response());
  await settle();
  assert.equal(resource.getSnapshot().data.title, result.title);
  assert.equal(f.events.size, 1);
  resource.stop();
});

test('history and selected revision reads stay separate and pass opaque cursors unchanged', async () => {
  const requests = [];
  const context = { request: async (_path, init) => {
    const input = JSON.parse(init.body);
    requests.push(input);
    return response(input.revision ? {
      revision: input.revision, description: 'Full earlier definition', author: 'synthetic-owner',
      at: '2026-09-20T01:02:03Z', reason: 'Updated requirements',
    } : { items: [], next_cursor: null });
  } };
  await readTask(context, { view: 'changelog', task_id: taskId, limit: 10, cursor: 'opaque+/=' });
  await readTask(context, { view: 'changelog', task_id: taskId, revision: 2 });
  assert.deepEqual(requests, [
    { view: 'changelog', task_id: taskId, limit: 10, cursor: 'opaque+/=' },
    { view: 'changelog', task_id: taskId, revision: 2 },
  ]);
});

test('execution and selected revisions preserve the whole definition and references', async () => {
  const description = '<script>not executed</script>\n' + 'Definition line.\n'.repeat(1400);
  const execution = {
    ...result, description, references: [{ label: 'Unsafe but visible', target: 'javascript:alert(1)' }],
    metadata: { purpose: 'test' },
  };
  const read = await readTask({ request: async () => response(execution) }, { view: 'execution', task_id: taskId });
  assert.equal(read.description, description);
  assert.deepEqual(read.references, execution.references);
  const revision = { revision: 1, author: 'synthetic-owner', at: '2026-09-20T01:02:03Z', reason: 'Created', description };
  const earlier = await readTask({ request: async () => response(revision) }, { view: 'changelog', task_id: taskId, revision: 1 });
  assert.equal(earlier.description, description);
});

test('malformed history and selected revision results fail rather than imply empty history', async () => {
  for (const value of [{}, { items: [] }, { items: [{}], next_cursor: null }, { items: [], next_cursor: '' }]) {
    await assert.rejects(readTask({ request: async () => response(value) }, { view: 'activity', task_id: taskId }), /invalid result/);
  }
  await assert.rejects(readTask({ request: async () => response({ items: [], next_cursor: null }) },
    { view: 'changelog', task_id: taskId, revision: 1 }), /invalid result/);
});

const native = {
  source: 'native', session_id: 'synthetic-executor', loaded: true, status: 'idle',
  observed_at: '2026-09-20T01:02:03Z', available: true,
};
const nativeResponse = (data = native, status = 200) => new Response(JSON.stringify(data), { status });

test('native state uses its optional GET endpoint without loading or sending session commands', async () => {
  const f = fixture();
  const controller = new AbortController();
  const promise = readNativeSession(f.context, taskId, controller.signal);
  assert.equal(f.requests[0].path, `/tasks/${taskId}/native`);
  assert.equal(f.requests[0].init.method, 'GET');
  assert.equal(f.requests[0].init.body, undefined);
  assert.equal(f.requests[0].init.signal, controller.signal);
  f.requests[0].resolve(nativeResponse());
  assert.deepEqual(await promise, native);
});

test('native observations keep unavailable, unloaded, unknown and errors distinct', async () => {
  assert.equal(nativeStatusLabel(native), 'idle');
  assert.equal(nativeStatusLabel({ ...native, loaded: false, status: undefined }), 'Unloaded');
  assert.equal(nativeStatusLabel({ ...native, status: undefined }), 'Unknown (not provided by host)');
  assert.equal(nativeStatusLabel({ ...native, available: false, loaded: null }), 'Unavailable');
  const unavailable = { ...native, available: false, loaded: null, error: 'Host observation failed' };
  const value = await readNativeSession({ request: async () => nativeResponse(unavailable) }, taskId);
  assert.equal(value.error, unavailable.error);
  assert.equal(value.available, false);
  await assert.rejects(readNativeSession({ request: async () => nativeResponse({}, 404) }, taskId), /unavailable.*HTTP 404/);
  await assert.rejects(readNativeSession({ request: async () => nativeResponse({ available: true }) }, taskId), /invalid result/);
  await assert.rejects(readNativeSession({ request: async () => new Response('bad JSON') }, taskId), /invalid response/);
});

test('native resource is lazy, abort-safe, and refreshes only while its detail view is mounted', async () => {
  const f = fixture();
  const resource = createReadResource(f.context, { view: 'native', task_id: taskId });
  assert.equal(f.requests.length, 0);
  resource.start();
  assert.equal(f.requests.length, 1);
  f.event({ type: 'task/changed', task_id: taskId });
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].init.signal.aborted, true);
  f.requests[1].resolve(nativeResponse({ ...native, status: 'running' }));
  await settle();
  f.requests[0].resolve(nativeResponse());
  await settle();
  assert.equal(resource.getSnapshot().data.status, 'running');
  resource.stop();
  f.event({ type: 'task/changed', task_id: taskId });
  f.host({ connected: false });
  f.host({ connected: true });
  assert.equal(f.requests.length, 2);
});
