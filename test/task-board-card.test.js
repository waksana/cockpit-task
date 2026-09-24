import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  activate,
  acknowledgementLabel,
  createReadResource,
  delegationLabel,
  dependencyLabel,
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
  id: taskId, title: 'Synthetic Task', orchestrator: 'synthetic-orchestrator', assignee: null,
  status: 'todo', revision: 1, acknowledged_revision: null, activity: null,
};
const response = (data = result, error = null, status = 200) =>
  new Response(JSON.stringify({ result: data, error, definition_check: null }), { status });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('dialog delegates initial/return focus and revisions use native lazy disclosure', () => {
  const source = readFileSync(new URL('../web/task-board/index.js', import.meta.url), 'utf8');
  const detail = source.slice(source.indexOf('function Detail('), source.indexOf('function Card('));
  assert.match(detail, /element\.showModal\(\)/);
  assert.match(detail, /if \(element\.open\) element\.close\(\)/);
  assert.match(detail, /useLayoutEffect\(\(\) =>/);
  assert.match(detail, /onClick: \(\) => dialog.current.close\(\)/);
  assert.doesNotMatch(detail, /onCancel:/);
  assert.doesNotMatch(detail, /\.focus\(|trigger/);
  const history = source.slice(source.indexOf('function Revision('), source.indexOf('function Detail('));
  assert.match(history, /h\('details', \{ onToggle: event => setOpen\(event\.currentTarget\.open\) \}/);
  assert.match(history, /h\('summary', null, `Read full definition/);
  assert.match(history, /open \? h\(Revision, \{ taskId, revision \}\) : null/);
  assert.doesNotMatch(history, /back\.current|revisionButton|returnRevision/);
});

test('Task presentation composes public surfaces, headings and actions without private host styles', () => {
  const source = readFileSync(new URL('../web/task-board/index.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../web/task-board/style.css', import.meta.url), 'utf8');
  assert.match(source, /className: 'ck-surface ck-modal tb-dialog'/);
  assert.match(source, /className: 'ck-heading'/);
  assert.match(source, /className: 'ck-actions tb-dialog-header'/);
  assert.match(source, /className: 'ck-actions tb-dialog-footer'/);
  const modal = css.match(/\.tb-dialog\s*\{([^}]+)\}/)[1];
  assert.doesNotMatch(modal, /background:|border:|border-radius:|padding:|font:/);
  assert.doesNotMatch(css, /::backdrop|\.tb-card:focus-visible|var\(--(?:host|chat)-/);
});

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
  assert.equal(parseTaskReference({ kind: 'link', target: `task:${taskId}?event=status_changed` }), taskId);
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
  assert.equal(safeReferenceHref('mailto:orchestrator@example.test'), 'mailto:orchestrator@example.test');
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
  for (const uiSurfaceVersion of [undefined, 0, 2]) {
    assert.throws(() => activate({ apiVersion: 2, uiVersion: 1, uiSurfaceVersion }), /uiSurfaceVersion v1/);
  }
  assert.throws(() => activate({ apiVersion: 2, uiVersion: 1, uiSurfaceVersion: 1 }), /createPortal/);
  const module = activate({
    apiVersion: 2, uiVersion: 1, uiSurfaceVersion: 1, createPortal() {},
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
  for (const event of ['assigned', 'updated', 'status_changed', 'ready', 'blocker_cancelled', 'child_done', 'child_blocked', 'child_cancelled']) {
    const node = { kind: 'link', target: `task:${taskId}?event=${event}`, label: 'An unrelated label' };
    assert.equal(renderer.matches(node), true);
    assert.equal(renderer.component({ node, fallback }).props.event, event);
  }
  const unknown = { kind: 'link', target: `task:${taskId}?event=deleted`, label: 'Task assigned' };
  assert.equal(renderer.matches(unknown), false);
  assert.equal(renderer.component({ node: unknown, fallback }), fallback);
});

test('card event headings come from the message and survive loading, failure and Task updates', () => {
  let snapshot = { phase: 'loading', data: null, error: null };
  const context = {
    apiVersion: 2, uiVersion: 1, uiSurfaceVersion: 1, createPortal() {},
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
  assert.equal(render('assigned').props.className, 'ck-button tb-card');
  assert.deepEqual(heading(render('assigned')).children, ['Task assigned']);
  assert.deepEqual(heading(render('status_changed')).children, ['Subtask status changed']);
  snapshot = { phase: 'ready', data: { ...result, status: 'done', revision: 4 }, error: null };
  assert.deepEqual(heading(render('assigned', 'Task updated')).children, ['Task assigned']);
  assert.deepEqual(heading(render('updated', 'Task assigned')).children, ['Task updated']);
  const notification = render('status_changed', 'Task updated');
  assert.deepEqual(heading(notification).children, ['Subtask status changed']);
  assert.match(heading(notification).props.title, /not a requirement update for its assignee/);
  assert.ok(notification.children.some(child => child?.children?.includes('Orchestrator subscription triggered · current state shown below')));
  snapshot = { phase: 'ready', data: { ...result, status: 'in_progress', revision: 5 }, error: null };
  assert.deepEqual(heading(render('status_changed')).children, ['Subtask status changed']);
  assert.equal(heading(render(null, 'Task updated')), undefined);
  const ready = render('ready');
  assert.deepEqual(heading(ready).children, ['Subtask ready']);
  assert.match(heading(ready).props.title, /Nothing was assigned or started/);
  assert.ok(ready.children.some(child => child?.children?.includes('Dependency notice to orchestrator · not assigned or started · current state shown below')));
  assert.deepEqual(heading(render('blocker_cancelled')).children, ['Subtask blocker cancelled']);
  for (const status of ['done', 'blocked', 'cancelled']) {
    const child = render(`child_${status}`, 'An unrelated label');
    assert.deepEqual(heading(child).children, [`Subtask ${status}`]);
    assert.match(heading(child).props.title, /once per transition without a subscription/);
    assert.ok(child.children.some(entry => entry?.children?.includes('Subtask notice to orchestrator · integrate before completing the parent · current state shown below')));
  }
  assert.deepEqual(heading(render('child_done', 'As Owner: child Task done')).children, ['Subtask done']);
  snapshot = { phase: 'ready', data: { ...result, blocked_by: [{ task_id: taskId, status: 'cancelled' }], ready: false }, error: null };
  assert.ok(render(null).children.some(child => child?.children?.includes('Blocked by 1 Task · 0 done · 1 cancelled (orchestrator decision needed) · not ready')));
  snapshot = { phase: 'ready', data: { ...result, blocked_by: [], ready: true }, error: null };
  assert.equal(render(null).children.some(child => String(child?.children?.[0] ?? '').startsWith('Blocked by')), false);
  snapshot = { phase: 'missing', data: null, error: new Error('Missing Task') };
  assert.deepEqual(heading(render('updated')).children, ['Task updated']);
  assert.deepEqual(heading(render('status_changed')).children, ['Subtask status changed']);
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
      revision: input.revision, description: 'Full earlier definition', author: 'synthetic-orchestrator',
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
  const revision = { revision: 1, author: 'synthetic-orchestrator', at: '2026-09-20T01:02:03Z', reason: 'Created', description };
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
  source: 'native', session_id: 'synthetic-assignee', loaded: true, status: 'idle',
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

const automation = {
  run_id: '5a674d65-213e-46c2-9bf9-52c84398bf26', script_id: 'synthetic-check',
  state: 'running', queued_at: '2026-09-20T01:02:03Z', started_at: '2026-09-20T01:02:04Z',
  finished_at: null, exit_code: null, signal: null, error: null, cancel_requested: false,
  process_group: 123, pid: 123, barrier: true, revision: 1,
};
const automatedOverview = { ...result, kind: 'automation', automation, retro: { status: 'not_applicable' } };
const automatedExecution = {
  ...automatedOverview, description: 'Run a synthetic check', references: [], metadata: {},
  automation: {
    ...automation,
    script: {
      script_id: automation.script_id, title: 'Synthetic check', description: 'Read-only synthetic script.',
      executable: '/usr/bin/node', script_path: '/synthetic/check.js', argv: ['--no-warnings'],
      sha256: 'a'.repeat(64),
      parameters: [{ name: 'count', type: 'integer', description: 'Number of checks' }],
    },
    parameters: { count: 2, enabled: false, label: '<script>literal</script>' },
  },
};
const automatedOutcome = {
  revision: 1, at: '2026-09-20T01:02:05Z', author: `automation:${automation.run_id}`,
  source: 'automation', run_id: automation.run_id, assignee: null, summary: 'Script exited with code 0.', references: [],
  retro: { status: 'not_applicable' },
};
const automationLog = {
  task_id: taskId, run_id: automation.run_id, offset: 0, text: '<script>literal output</script>',
  next_offset: 4096, retained_characters: 5000, omitted_characters: 12, complete: false,
};

test('automation reads preserve snapshots and runner-authored outcomes without a fake Assignee or ACK', async () => {
  const { source, run_id, ...ordinaryOutcome } = automatedOutcome;
  for (const [view, data] of [
    ['overview', automatedOverview], ['overview', { ...automatedOverview, automation: null }],
    ['execution', automatedExecution], ['outcomes', { items: [automatedOutcome], next_cursor: null }],
    ['outcomes', { items: [{ ...ordinaryOutcome, author: 'worker', assignee: 'worker' }], next_cursor: null }],
  ]) {
    assert.deepEqual(await readTask({ request: async () => response(data) }, { view, task_id: taskId }), data);
  }
  for (const data of [
    { ...automatedOverview, assignee: 'fake-native-session' },
    { ...automatedOverview, acknowledged_revision: 1 },
    { ...automatedOverview, automation: {} },
    { ...automatedOverview, kind: 'unknown' },
  ]) await assert.rejects(readTask({ request: async () => response(data) }, input), /invalid result/);
  await assert.rejects(readTask({ request: async () => response({
    ...automatedExecution, automation: { ...automatedExecution.automation, script: null },
  }) }, { view: 'execution', task_id: taskId }), /invalid result/);
  await assert.rejects(readTask({ request: async () => response({
    items: [{ ...automatedOutcome, author: 'not-the-runner' }], next_cursor: null,
  }) }, { view: 'outcomes', task_id: taskId }), /invalid result/);
});

test('automation logs use bounded offset reads and reject malformed or oversized results', async () => {
  const f = fixture();
  const logInput = { view: 'automation_log', task_id: taskId, offset: 0, limit: 4096 };
  const resource = createReadResource(f.context, logInput);
  resource.start();
  assert.equal(f.requests[0].path, '/read');
  assert.deepEqual(JSON.parse(f.requests[0].init.body), logInput);
  f.requests[0].resolve(response(automationLog));
  await settle();
  assert.deepEqual(resource.getSnapshot().data, automationLog);
  await settle();
  assert.equal(f.requests.length, 1, 'log reads do not poll');
  resource.stop();
  for (const data of [
    { ...automationLog, task_id: 'another-task' }, { ...automationLog, offset: 1 },
    { ...automationLog, next_offset: 0 }, { ...automationLog, text: 'x'.repeat(4097) },
    { ...automationLog, omitted_characters: -1 }, { ...automationLog, complete: null },
  ]) await assert.rejects(readTask({ request: async () => response(data) }, logInput), /invalid result/);
});

// Exercise mounted components with the existing read resources, without adding a DOM/React dependency.
function componentHarness(context) {
  const instances = new Map();
  let current;
  let hookIndex;
  let effects;
  let mounted;
  const hook = (create) => {
    const index = hookIndex++;
    if (!current.hooks[index]) current.hooks[index] = create();
    return current.hooks[index];
  };
  const memo = (callback, dependencies) => {
    const slot = hook(() => ({}));
    if (!slot.dependencies || dependencies.some((value, index) => value !== slot.dependencies[index])) {
      slot.value = callback();
      slot.dependencies = dependencies;
    }
    return slot.value;
  };
  const react = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children } }),
    useMemo: memo,
    useRef: () => hook(() => ({ current: { focus() {} } })),
    useState(initial) {
      const slot = hook(() => ({ value: initial }));
      return [slot.value, value => { slot.value = typeof value === 'function' ? value(slot.value) : value; }];
    },
    useEffect(callback, dependencies) {
      const slot = hook(() => ({}));
      if (!slot.dependencies || dependencies.some((value, index) => value !== slot.dependencies[index])) {
        effects.push(() => { slot.cleanup?.(); slot.cleanup = callback(); slot.dependencies = dependencies; });
      }
    },
    useLayoutEffect() {},
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useId: () => 'synthetic-dialog-title',
  };
  const renderer = activate({ ...context, apiVersion: 2, uiVersion: 1, uiSurfaceVersion: 1, react, createPortal: node => node }).markdown[0];
  const resolve = (node, path) => {
    if (Array.isArray(node)) return node.map((child, index) => resolve(child, `${path}.${index}`));
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      const key = `${path}:${node.type.name}:${node.props.key ?? ''}`;
      mounted.add(key);
      if (!instances.has(key)) instances.set(key, { hooks: [] });
      current = instances.get(key);
      hookIndex = 0;
      return resolve(node.type(node.props), `${key}.render`);
    }
    return { ...node, children: resolve(node.props.children, `${path}.children`) };
  };
  return {
    render() {
      effects = [];
      mounted = new Set();
      const tree = resolve(renderer.component({ node: { kind: 'link', target: `task:${taskId}` } }), 'root');
      for (const [key, instance] of instances) if (!mounted.has(key)) {
        for (const slot of instance.hooks) slot.cleanup?.();
        instances.delete(key);
      }
      for (const effect of effects) effect();
      return tree;
    },
    stop() {
      for (const instance of instances.values()) for (const slot of instance.hooks) slot.cleanup?.();
    },
  };
}

function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  return tree && typeof tree === 'object' ? [tree, ...elements(tree.children)] : [];
}
function textContent(tree) {
  if (Array.isArray(tree)) return tree.map(textContent).join(' ');
  return tree && typeof tree === 'object' ? textContent(tree.children) : String(tree ?? '');
}
const button = (tree, label) => elements(tree).find(node => node.type === 'button' && textContent(node) === label);

test('mounted automation UI shows immutable facts and logs, paginates on demand, and never requests native observation', async () => {
  const f = fixture();
  const harness = componentHarness(f.context);
  const oldDocument = globalThis.document;
  globalThis.document = { body: {} };
  try {
    let tree = harness.render();
    f.requests[0].resolve(response(automatedOverview));
    await settle();
    tree = harness.render();
    assert.match(textContent(tree), /Automation/);
    assert.match(textContent(tree), /synthetic-check/);
    assert.doesNotMatch(textContent(tree), /ACK|Unassigned|No reported activity/);
    elements(tree).find(node => node.props.className === 'ck-button tb-card').props.onClick();
    tree = harness.render();
    assert.equal(f.requests.length, 2);
    assert.deepEqual(JSON.parse(f.requests[1].init.body), { view: 'execution', task_id: taskId });
    f.requests[1].resolve(response(automatedExecution));
    await settle();
    tree = harness.render();
    assert.match(textContent(tree), /Immutable script snapshot/);
    assert.match(textContent(tree), /Immutable parameter snapshot/);
    assert.match(textContent(tree), /"enabled": false/);
    assert.match(textContent(tree), /<script>literal<\/script>/);
    assert.match(textContent(tree), /Launch barrier Set/);
    assert.match(textContent(tree), /Not applicable to script automation/);
    assert.equal(button(tree, 'Native session'), undefined);
    assert.equal(button(tree, 'Reported activity'), undefined);
    assert.equal(elements(tree).some(node => node.type === 'script'), false);
    button(tree, 'Logs').props.onClick();
    harness.render();
    assert.deepEqual(JSON.parse(f.requests[2].init.body), { view: 'automation_log', task_id: taskId, offset: 0, limit: 4096 });
    f.requests[2].resolve(response(automationLog));
    await settle();
    tree = harness.render();
    assert.match(textContent(tree), /12 omitted characters/);
    assert.match(textContent(tree), /Incomplete/);
    assert.equal(elements(tree).some(node => node.type === 'script'), false);
    button(tree, 'Next page').props.onClick();
    harness.render();
    assert.equal(JSON.parse(f.requests[3].init.body).offset, 4096);
    f.requests[3].resolve(response({ ...automationLog, offset: 4096, text: 'Final output', next_offset: null, complete: true }));
    await settle();
    tree = harness.render();
    assert.equal(button(tree, 'Next page').props.disabled, true);
    assert.match(textContent(tree), /Complete/);
    button(tree, 'Previous page').props.onClick();
    harness.render();
    assert.equal(JSON.parse(f.requests[4].init.body).offset, 0);
    f.requests[4].resolve(response(automationLog));
    await settle();
    tree = harness.render();
    button(tree, 'Refresh log').props.onClick();
    assert.equal(f.requests.length, 6);
    f.requests[5].resolve(response(automationLog));
    await settle();
    tree = harness.render();
    button(tree, 'Outcomes').props.onClick();
    harness.render();
    f.requests[6].resolve(response({ items: [automatedOutcome], next_cursor: null }));
    await settle();
    tree = harness.render();
    assert.match(textContent(tree), /Source: Automation/);
    assert.match(textContent(tree), /Not applicable to script automation/);
    assert.match(textContent(tree), new RegExp(`Reported author: automation:${automation.run_id}`));
    assert.doesNotMatch(textContent(tree), /Assignee: null/);
    assert.equal(f.requests.every(request => request.path === '/read'), true);
    assert.equal(f.requests.length, 7);
  } finally {
    harness.stop();
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }
});

test('legacy agent details retain ACK, activity and lazy native session observation', async () => {
  const f = fixture();
  const harness = componentHarness(f.context);
  const oldDocument = globalThis.document;
  globalThis.document = { body: {} };
  try {
    harness.render();
    f.requests[0].resolve(response(result));
    await settle();
    let tree = harness.render();
    assert.match(textContent(tree), /not ACKed/);
    elements(tree).find(node => node.props.className === 'ck-button tb-card').props.onClick();
    harness.render();
    f.requests[1].resolve(response({ ...result, description: 'Agent definition', references: [], metadata: {} }));
    await settle();
    tree = harness.render();
    assert.ok(button(tree, 'Reported activity'));
    assert.match(textContent(tree), /No retro recorded/);
    assert.equal(button(tree, 'Logs'), undefined);
    assert.equal(f.requests.length, 2);
    button(tree, 'Native session').props.onClick();
    harness.render();
    assert.equal(f.requests[2].path, `/tasks/${taskId}/native`);
    f.requests[2].resolve(nativeResponse());
    await settle();
    tree = harness.render();
    assert.match(textContent(tree), /Native session observation/);
    assert.match(textContent(tree), /Native state idle/);
  } finally {
    harness.stop();
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }
});

test('retro detail reads reject malformed recorded content instead of presenting no findings', async () => {
  const execution = { ...result, description: 'Definition', references: [], metadata: {} };
  const recorded = {
    status: 'recorded', text: null, has_findings: false, revision: 1, assignee: 'assignee',
    author: 'assignee', source: 'reported', outcome_id: 'outcome-id', at: '2026-09-20T01:02:05Z', current: true,
  };
  for (const retro of [
    { ...recorded, text: undefined }, { ...recorded, text: '' }, { ...recorded, has_findings: true, text: ' ' },
    { ...recorded, has_findings: true, text: 'x'.repeat(2001) }, { ...recorded, revision: 0 },
    { ...recorded, current: undefined }, { status: 'unknown' }, null,
  ]) await assert.rejects(readTask({ request: async () => response({ ...execution, retro }) },
    { view: 'execution', task_id: taskId }), /invalid result/);
});

test('mounted retro detail and outcomes distinguish findings, null, historical missing and superseded definition', async () => {
  const oldDocument = globalThis.document;
  globalThis.document = { body: {} };
  const recorded = {
    status: 'recorded', text: '<script>Automate repeated setup</script>', has_findings: true,
    revision: 1, assignee: 'assignee', author: 'assignee', source: 'reported',
    outcome_id: 'outcome-id', at: '2026-09-20T01:02:05Z', current: false,
  };
  try {
    for (const [retro, expected] of [
      [recorded, /Automate repeated setup/],
      [{ ...recorded, current: true, has_findings: false, text: null }, /Explicitly reported no findings/],
      [{ status: 'not_recorded' }, /No retro recorded.*does not establish that reflection occurred/],
    ]) {
      const f = fixture(), harness = componentHarness(f.context);
      try {
        harness.render();
        const { text, ...summary } = retro;
        f.requests[0].resolve(response({ ...result, status: 'done', retro: summary }));
        await settle();
        let tree = harness.render();
        assert.doesNotMatch(textContent(tree), /Automate repeated setup/);
        elements(tree).find(node => node.props.className === 'ck-button tb-card').props.onClick();
        harness.render();
        f.requests[1].resolve(response({ ...result, description: 'Current definition', references: [], metadata: {}, retro }));
        await settle();
        tree = harness.render();
        assert.match(textContent(tree), expected);
        if (retro.current === false) assert.match(textContent(tree), /Historical retro; not a retrospective on the current definition/);
        assert.equal(elements(tree).some(node => node.type === 'script'), false);
        button(tree, 'Outcomes').props.onClick();
        harness.render();
        f.requests[2].resolve(response({ items: [{
          id: 'outcome-id', revision: 1, assignee: 'assignee', author: 'assignee', source: 'reported',
          at: recorded.at, summary: 'Delivered result', references: [], retro,
        }], next_cursor: null }));
        await settle();
        tree = harness.render();
        assert.match(textContent(tree), expected);
        assert.match(textContent(tree), /Delivered result/);
        assert.equal(elements(tree).some(node => node.type === 'script'), false);
        assert.equal(f.requests.length, 3);
      } finally { harness.stop(); }
    }
  } finally {
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }
});

test('reopen invalidation replaces cached done card and marks prior delivery retro as historical', async () => {
  const f = fixture();
  const resource = createReadResource(f.context, input);
  const retro = {
    status: 'recorded', has_findings: false, revision: 1, assignee: 'assignee', author: 'assignee',
    source: 'reported', outcome_id: 'prior-outcome', at: '2026-09-20T01:02:05Z', current: true,
  };
  resource.start();
  f.requests[0].resolve(response({
    ...result, assignee: 'assignee', status: 'done', acknowledged_revision: 1,
    outcome: { available: true, revision: 1, current: true }, retro,
  }));
  await settle();
  assert.equal(resource.getSnapshot().data.status, 'done');
  f.invalidate();
  f.requests[1].resolve(response({
    ...result, assignee: 'assignee', status: 'in_progress', revision: 2, acknowledged_revision: 2,
    outcome: { available: true, revision: 1, current: false }, retro: { ...retro, current: false },
  }));
  await settle();
  const reopened = resource.getSnapshot().data;
  assert.equal(reopened.status, 'in_progress');
  assert.equal(reopened.revision, 2);
  assert.equal(reopened.outcome.current, false);
  assert.equal(reopened.retro.current, false);
  resource.stop();
});

test('detail refresh preserves Agent history cursors and automation log offsets', async () => {
  const oldDocument = globalThis.document;
  globalThis.document = { body: {} };
  try {
    for (const automated of [false, true]) {
      const f = fixture(), harness = componentHarness(f.context);
      const overview = automated ? automatedOverview : result;
      const execution = automated ? automatedExecution : { ...result, description: 'Agent definition', references: [], metadata: {} };
      const firstPage = automated ? automationLog : {
        items: [{ revision: 1, author: 'assignee', assignee: 'assignee', at: '2026-09-20T01:02:05Z', summary: 'First', references: [] }],
        next_cursor: 'history-page-two',
      };
      const secondPage = automated ? { ...automationLog, offset: 4096, text: 'Second page', next_offset: null }
        : { ...firstPage, next_cursor: null };
      try {
        harness.render();
        f.requests[0].resolve(response(overview));
        await settle();
        let tree = harness.render();
        elements(tree).find(node => node.props.className === 'ck-button tb-card').props.onClick();
        harness.render();
        f.requests[1].resolve(response(execution));
        await settle();
        tree = harness.render();
        button(tree, automated ? 'Logs' : 'Outcomes').props.onClick();
        harness.render();
        f.requests[2].resolve(response(firstPage));
        await settle();
        tree = harness.render();
        button(tree, 'Next page').props.onClick();
        harness.render();
        f.requests[3].resolve(response(secondPage));
        await settle();
        tree = harness.render();
        assert.match(textContent(tree), /Page 2/);
        const before = f.requests.length;
        f.event({ type: 'task/changed', task_id: taskId });
        harness.render();
        const refreshes = f.requests.slice(before);
        assert.equal(refreshes.length, 3);
        const pageRead = refreshes.find(request => ['outcomes', 'automation_log'].includes(JSON.parse(request.init.body).view));
        assert.equal(JSON.parse(pageRead.init.body)[automated ? 'offset' : 'cursor'], automated ? 4096 : 'history-page-two');
        for (const request of refreshes) {
          const { view } = JSON.parse(request.init.body);
          request.resolve(response(view === 'overview' ? overview : view === 'execution' ? execution : secondPage));
        }
        await settle();
        tree = harness.render();
        assert.match(textContent(tree), /Page 2/);
        assert.equal(f.requests.length, before + 3, 'Refreshing execution must not remount the active detail section');
      } finally { harness.stop(); }
    }
  } finally {
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }
});

test('dependency labels stay compact and never imply dispatch', () => {
  assert.equal(dependencyLabel(undefined, true), null);
  assert.equal(dependencyLabel([], true), null);
  assert.equal(dependencyLabel([{ task_id: 'a', status: 'done' }, { task_id: 'b', status: 'done' }], true), 'Blocked by 2 Tasks · all done · ready to dispatch');
  assert.equal(dependencyLabel([{ task_id: 'a', status: 'done' }, { task_id: 'b', status: 'in_progress' }], false), 'Blocked by 2 Tasks · 1 done · not ready');
});

test('delegation lineage shows parent and lazily reads direct Subtasks without extra eager reads', async () => {
  assert.equal(delegationLabel(null, 1), null);
  assert.equal(delegationLabel(undefined, undefined), null);
  assert.equal(delegationLabel('parent', 2), 'Subtask · delegation level 2');
  const parentId = '6f1c0c92-3580-4cdd-85bf-d7fcf22ab3ff';
  const childId = '7a2c0c92-3580-4cdd-85bf-d7fcf22ab3ff';
  const f = fixture();
  const harness = componentHarness(f.context);
  const oldDocument = globalThis.document;
  globalThis.document = { body: {} };
  try {
    harness.render();
    f.requests[0].resolve(response({ ...result, parent_task_id: parentId, depth: 2 }));
    await settle();
    let tree = harness.render();
    assert.match(textContent(tree), /Subtask · delegation level 2/);
    elements(tree).find(node => node.props.className === 'ck-button tb-card').props.onClick();
    harness.render();
    f.requests[1].resolve(response({ ...result, parent_task_id: parentId, depth: 2, description: 'Child definition', references: [], metadata: {} }));
    await settle();
    tree = harness.render();
    assert.match(textContent(tree), /Parent Task/);
    assert.match(textContent(tree), new RegExp(parentId));
    assert.equal(f.requests.length, 2, 'Parent and child lineage are not read until disclosed');
    const disclosures = elements(tree).filter(node => node.type === 'details');
    const children = disclosures.find(node => textContent(node).includes('Subtasks delegated from this Task'));
    children.props.onToggle({ currentTarget: { open: true } });
    harness.render();
    assert.deepEqual(JSON.parse(f.requests[2].init.body), { view: 'list', parent_task_id: taskId, status: 'all', limit: 50 });
    f.requests[2].resolve(response({ items: [{ task_id: childId, title: 'Specific child', status: 'in_progress', assignee: 'worker', parent_task_id: taskId, depth: 3 }], next_cursor: null }));
    await settle();
    tree = harness.render();
    assert.match(textContent(tree), /Specific child · In progress · Assignee: worker/);
    assert.equal(f.requests.length, 3);
  } finally {
    harness.stop();
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }
});

test('malformed lineage and child lists fail rather than imply a top-level Task or no children', async () => {
  for (const [request, data] of [
    [input, { ...result, parent_task_id: 7 }],
    [input, { ...result, depth: 0 }],
    [{ view: 'list', parent_task_id: taskId }, { items: [{ task_id: 'x', title: 'Other', status: 'todo', parent_task_id: 'someone-else' }], next_cursor: null }],
    [{ view: 'list', parent_task_id: taskId }, { items: 'none', next_cursor: null }],
  ]) {
    const context = { request: async () => response(data) };
    await assert.rejects(readTask(context, request), /invalid|malformed|unexpected/i, JSON.stringify(data));
  }
});
