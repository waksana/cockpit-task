import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import {
  activate,
  acknowledgementLabel,
  cardSummary,
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
  taskStateIcon,
} from '../web/task-board/index.js';
import { ICONS } from '../web/task-board/icons.js';

const taskId = 'd10c0c92-3580-4cdd-85bf-d7fcf22ab3ff';
const input = { view: 'overview', task_id: taskId };
const dataVersion = 'a'.repeat(64);
const nextDataVersion = 'b'.repeat(64);
const sessionInfo = (session_id, title) => ({ session_id, title, available: title !== null });
const result = {
  id: taskId, title: 'Synthetic Task', orchestrator: 'synthetic-orchestrator', assignee: null,
  status: 'todo', revision: 1, acknowledged_revision: null, activity: null,
};
const response = (data = result, error = null, status = 200) =>
  new Response(JSON.stringify({ result: data, error, definition_check: null }), { status });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('every frontend import and the icon license is a declared module asset', () => {
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('cockpit.module.json', root), 'utf8'));
  const visited = new Set();
  const check = path => {
    assert.ok(manifest.frontend.assets.some(asset => path === asset || path.startsWith(`${asset}/`)),
      `${path} is not exposed by the module asset allowlist`);
    const source = readFileSync(new URL(path, root), 'utf8');
    if (visited.has(path)) return;
    visited.add(path);
    for (const [, relative] of source.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
      check(posix.normalize(posix.join(posix.dirname(path), relative)));
    }
  };
  check(manifest.frontend.entry);
  for (const style of manifest.frontend.styles) check(style);
  check('web/task-board/licenses/lucide.txt');
  assert.ok(visited.has('web/task-board/read-resource.js'));
  assert.ok(visited.has('web/task-board/icons.js'));
});

test('StrictMode effect replay retains more resources than the inactive cache limit', async () => {
  const f = fixture();
  const resources = Array.from({ length: 129 }, (_, index) => createReadResource(f.context, {
    view: 'overview', task_id: `d10c0c92-3580-4cdd-85bf-${String(index).padStart(12, '0')}`,
  }));
  resources.forEach(resource => resource.start());
  resources.forEach(resource => resource.stop());
  resources.forEach(resource => resource.start());
  await settle();
  assert.equal(f.requests.length, 129);
  assert.equal(f.requests.some(request => request.init.signal.aborted), false);
  const firstQuery = JSON.parse(f.requests[0].init.body);
  assert.equal(createReadResource(f.context, firstQuery), resources[0]);
  f.event({ type: 'task/changed', task_id: firstQuery.task_id });
  assert.equal(f.requests.length, 130);
  f.requests.at(-1).resolve(response({ ...result, id: firstQuery.task_id }));
  await settle();
  assert.equal(resources[0].getSnapshot().phase, 'ready');
  f.controller.abort();
});

test('evicted retained handles resume and share a newer canonical resource for the same key', async () => {
  for (const recreate of [false, true]) {
    const f = fixture();
    const resources = Array.from({ length: 129 }, (_, index) => createReadResource(f.context, {
      view: 'overview', task_id: `d10c0c92-3580-4cdd-85bf-${String(index).padStart(12, '0')}`,
    }));
    resources.forEach(resource => resource.start());
    resources.forEach(resource => resource.stop());
    await settle();
    assert.equal(f.requests[0].init.signal.aborted, true);
    const query = JSON.parse(f.requests[0].init.body);
    const replacement = recreate ? createReadResource(f.context, query) : resources[0];
    replacement.start();
    if (recreate) resources[0].start();
    assert.equal(f.requests.length, 130);
    assert.equal(createReadResource(f.context, query), replacement);
    f.requests.at(-1).resolve(response({ ...result, id: query.task_id, title: 'Resumed' }));
    await settle();
    assert.equal(resources[0].getSnapshot().data.title, 'Resumed');
    f.event({ type: 'task/changed', task_id: query.task_id });
    assert.equal(f.requests.length, 131);
    f.controller.abort();
  }
});

test('dialog delegates focus and revisions use accessible lazy chevron disclosure', () => {
  const source = readFileSync(new URL('../web/task-board/index.js', import.meta.url), 'utf8');
  const detail = source.slice(source.indexOf('function Detail('), source.indexOf('function Card('));
  assert.match(detail, /element\.showModal\(\)/);
  assert.match(detail, /if \(element\.open\) element\.close\(\)/);
  assert.match(detail, /useLayoutEffect\(\(\) =>/);
  assert.match(detail, /onClick: \(\) => dialog.current.close\(\)/);
  assert.doesNotMatch(detail, /onCancel:/);
  assert.doesNotMatch(detail, /\.focus\(|trigger/);
  const history = source.slice(source.indexOf('function Revision('), source.indexOf('function Detail('));
  assert.match(history, /h\(Disclosure, \{ title: `Read full definition v\$\{revision\}` \}, h\(Revision, \{ taskId, revision \}\)\)/);
  const disclosure = source.slice(source.indexOf('function Disclosure('), source.indexOf('function SessionName('));
  assert.match(disclosure, /'aria-expanded': open, 'aria-controls': id/);
  assert.match(disclosure, /h\(Icon, \{ name: 'chevron' \}\), title/);
  assert.match(disclosure, /open \? children : null/);
  assert.doesNotMatch(history, /back\.current|revisionButton|returnRevision/);
});

test('Task presentation composes public surfaces, headings and actions without private host styles', () => {
  const source = readFileSync(new URL('../web/task-board/index.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../web/task-board/style.css', import.meta.url), 'utf8');
  assert.match(source, /className: 'ck-surface ck-modal tb-dialog'/);
  assert.match(source, /className: 'ck-heading'/);
  assert.match(source, /className: 'ck-actions tb-dialog-header'/);
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
  assert.match(statusLabel('in_review'), /Unknown status/);
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
  for (const event of ['assigned', 'updated', 'status_changed', 'blocked', 'ready', 'blocker_cancelled', 'child_done', 'child_blocked', 'child_cancelled']) {
    const node = { kind: 'link', target: `task:${taskId}?event=${event}`, label: 'An unrelated label' };
    assert.equal(renderer.matches(node), true);
    assert.equal(renderer.component({ node, fallback }).props.event, event);
  }
  const unknown = { kind: 'link', target: `task:${taskId}?event=deleted`, label: 'Task assigned' };
  assert.equal(renderer.matches(unknown), false);
  assert.equal(renderer.component({ node: unknown, fallback }), fallback);
});

test('compact cards expose state, authoritative count, owner and ACK without message-event clutter', () => {
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
  const field = (card, className) => elements(card).find(child => child.props?.className === className);
  const loading = render('assigned');
  assert.equal(loading.props.className, 'tb-card');
  assert.equal(field(loading, 'tb-card-count').props['aria-label'], 'Activity count: unknown');
  assert.equal(field(loading, 'tb-card-version').children[0], 'v— · ACK —');
  const task = { ...result, status: 'done', revision: 4, acknowledged_revision: 3, activity_count: 12,
    assignee: 'session-id', sessions: { assignee: sessionInfo('session-id', 'Long human-readable session name'),
      orchestrator: sessionInfo(result.orchestrator, null) },
    outcome: { current: true, summary: 'Delivered current result' } };
  snapshot = { phase: 'ready', data: task, error: null };
  for (const event of [null, 'assigned', 'updated', 'status_changed', 'ready', 'blocked', 'blocker_cancelled', 'child_done', 'child_blocked', 'child_cancelled']) {
    const card = render(event, 'An unrelated message label');
    assert.deepEqual(card.children.slice(1).map(child => child.props.className),
      ['tb-card-top', 'tb-card-summary', 'tb-card-meta']);
    assert.equal(card.props['data-status'], 'done');
    assert.equal(field(card, 'tb-card-top').children[0].props.name, 'done');
    assert.equal(field(card, 'tb-card-title').props.title, task.title);
    assert.equal(field(card, 'tb-card-summary').children[0], task.outcome.summary);
    assert.equal(field(card, 'tb-card-owner').props.title, task.sessions.assignee.title);
    assert.equal(field(card, 'tb-card-count').children[1], 12);
    assert.equal(field(card, 'tb-card-version').children[0], 'v4 · ACK v3');
    assert.equal(field(card, 'tb-card-meta').children.at(-1).type.name, 'Refresh');
    assert.equal(field(card, 'tb-card-event'), undefined);
    assert.equal(field(card, 'tb-card-open').props['aria-haspopup'], 'dialog');
  }
  for (const [status, icon] of [['todo', 'todo'], ['in_progress', 'progress'], ['done', 'done'], ['cancelled', 'cancelled'], ['future', 'unknown']]) {
    assert.equal(taskStateIcon({ data: { ...task, status } }), icon);
    assert.ok(ICONS[icon]);
  }
  assert.equal(taskStateIcon({ data: { ...task, status: 'in_progress', ready: false } }), 'blocked');
  for (const [phase, icon] of [['loading', 'refresh'], ['offline', 'offline'], ['error', 'error'], ['missing', 'unknown']]) {
    assert.equal(taskStateIcon({ phase, data: null }), icon);
  }
  assert.equal(cardSummary(task), 'Delivered current result');
  assert.equal(cardSummary({ ...task, outcome: { current: false, summary: 'Obsolete result' } }), 'No reported activity.');
  assert.match(cardSummary({ ...task, ready: false, blocked_by: [{ condition: 'Needs approval' }] }), /Blocked by 1/);
});

test('card summaries distinguish earlier activity, absent reports, cancellation and current outcomes', () => {
  const activity = { revision: 1, text: 'Previously completed checks', current: false };
  const task = { ...result, revision: 2, activity };
  assert.equal(cardSummary(task), 'Earlier activity · v1: Previously completed checks');
  assert.equal(cardSummary({ ...task, activity: { ...activity, revision: 2, current: true } }),
    'Previously completed checks');
  assert.equal(cardSummary({ ...task, activity: null }), 'No reported activity.');
  assert.equal(cardSummary({ ...task, activity: undefined }), 'Reported activity unavailable in this read.');
  assert.equal(cardSummary({ ...task, outcome: { current: false, summary: 'Prior delivery' } }),
    'Earlier activity · v1: Previously completed checks');
  assert.equal(cardSummary({ ...task, outcome: { current: true, summary: 'Current delivery' } }), 'Current delivery');
  assert.equal(cardSummary({ ...task, status: 'cancelled', cancellation: { reason: 'Requested scope withdrawn' },
    outcome: { current: true, summary: 'An earlier report' } }), 'Requested scope withdrawn');
  assert.equal(taskStateIcon({ data: { ...task, status: 'cancelled', ready: false } }), 'cancelled');
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

test('presentation reads validate authoritative counts, opaque versions and session identity metadata', async () => {
  const assigned = {
    ...result, assignee: 'worker-session-id', activity_count: 4, data_version: dataVersion,
    sessions: {
      assignee: sessionInfo('worker-session-id', 'Worker display name'),
      orchestrator: sessionInfo(result.orchestrator, 'Coordinator display name'),
    },
  };
  for (const view of ['overview', 'execution']) {
    const base = view === 'execution' ? { ...assigned, description: 'Full definition', references: [], metadata: {} } : assigned;
    const request = { view, task_id: taskId };
    for (const valid of [
      base,
      { ...base, activity_count: 0 },
      { ...base, sessions: { ...base.sessions,
        assignee: { ...sessionInfo(base.assignee, null), error: { code: 'UNAVAILABLE', message: 'Session metadata unavailable' } } } },
      { ...base, assignee: null, sessions: { ...base.sessions, assignee: null } },
      { ...base, assignee: 'user', sessions: { ...base.sessions, assignee: null } },
      { ...base, orchestrator: 'user', sessions: { ...base.sessions, orchestrator: null } },
    ]) assert.deepEqual(await readTask({ request: async () => response(valid) }, request), valid);
    const invalid = [
      ...[-1, 1.5, '4', {}, Number.MAX_SAFE_INTEGER + 1].map(activity_count => ({ ...base, activity_count })),
      ...[null, '', 'a'.repeat(63), 'g'.repeat(64), 'A'.repeat(64), 123].map(data_version => ({ ...base, data_version })),
      ...[null, [], {}, { assignee: null, orchestrator: null }].map(sessions => ({ ...base, sessions })),
      ...[
        { ...base.sessions.assignee, session_id: 'another-session' },
        { ...base.sessions.assignee, title: 123 },
        { ...base.sessions.assignee, title: undefined },
        { ...base.sessions.assignee, available: 'yes' },
        { ...base.sessions.assignee, available: undefined },
      ].map(assignee => ({ ...base, sessions: { ...base.sessions, assignee } })),
      { ...base, assignee: null },
      { ...base, orchestrator: 'user' },
    ];
    for (const value of invalid) {
      await assert.rejects(readTask({ request: async () => response(value) }, request), /invalid result/,
        `${view}: ${JSON.stringify(value)}`);
    }
  }
});

test('superseded reads cannot overwrite current data even if abort is ignored', async () => {
  const f = fixture();
  const resource = createReadResource(f.context, input);
  resource.start();
  assert.equal(f.requests.length, 1);
  f.event({ type: 'task/changed', task_id: taskId });
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

test('only matching Task events refresh; activation abort revokes subscriptions and late updates', async () => {
  const f = fixture();
  const resource = createReadResource(f.context, input);
  let notifications = 0;
  const unsubscribe = resource.subscribe(() => notifications++);
  resource.start();
  resource.start();
  f.event({ type: 'task/changed', task_id: 'other-task' });
  f.event({ type: 'other', task_id: taskId });
  f.invalidate();
  assert.equal(f.requests.length, 1);
  f.event({ type: 'task/changed', task_id: taskId });
  assert.equal(f.requests.length, 2);
  resource.stop();
  resource.stop();
  f.controller.abort();
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

test('duplicate reads and remounts retain data and in-flight work; explicit refreshes coalesce', async () => {
  const f = fixture();
  const resource = createReadResource(f.context, input);
  resource.start();
  resource.stop();
  const duplicate = createReadResource(f.context, { task_id: taskId, view: 'overview' });
  assert.equal(duplicate, resource, 'read keys are independent of object property order');
  resource.start();
  duplicate.start();
  const first = resource.refresh();
  assert.equal(duplicate.refresh(), first);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].init.signal.aborted, false);
  f.requests[0].resolve(response());
  await first;
  await settle();
  assert.equal(resource.getSnapshot().data.title, result.title);
  assert.equal(f.events.size, 1);
  resource.stop();
  duplicate.stop();
  resource.start();
  assert.equal(f.requests.length, 1, 'settled remount is cache-only');
  const refresh = resource.refresh();
  assert.equal(duplicate.refresh(), refresh);
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve(response());
  await refresh;
  resource.stop();
  f.controller.abort();
});

test('cached content survives pending, failed, missing and offline reads; reconnect rejects obsolete replies', async () => {
  const f = fixture();
  const resource = createReadResource(f.context, input);
  resource.start();
  f.requests[0].resolve(response());
  await settle();
  const cached = resource.getSnapshot().data;
  const refresh = resource.refresh();
  assert.equal(resource.getSnapshot().refreshing, true);
  assert.equal(resource.getSnapshot().phase, 'ready');
  assert.equal(resource.getSnapshot().data, cached);
  f.requests[1].reject(new Error('Network failed'));
  await refresh;
  assert.equal(resource.getSnapshot().phase, 'error');
  assert.equal(resource.getSnapshot().data, cached);
  const missing = resource.refresh();
  f.requests[2].resolve(response(null, { code: 'TASK_NOT_FOUND', message: 'Missing' }));
  await missing;
  assert.equal(resource.getSnapshot().phase, 'missing');
  assert.equal(resource.getSnapshot().data, cached);
  const obsolete = resource.refresh();
  f.host({ connected: false });
  assert.equal(f.requests[3].init.signal.aborted, true);
  assert.equal(resource.getSnapshot().phase, 'offline');
  assert.equal(resource.getSnapshot().data, cached);
  await resource.refresh();
  assert.equal(f.requests.length, 4);
  f.host({ connected: true });
  assert.equal(f.requests.length, 5, 'reconnect reconciles changes missed without replay');
  f.requests[4].resolve(response({ ...result, revision: 2, title: 'Reconciled result' }));
  await settle();
  f.requests[3].resolve(response({ ...result, title: 'Obsolete response' }));
  await obsolete;
  assert.equal(resource.getSnapshot().data.title, 'Reconciled result');
  const unchanged = resource.getSnapshot().data;
  const reread = resource.refresh();
  f.requests[5].resolve(response({ ...unchanged }));
  await reread;
  assert.equal(resource.getSnapshot().data, unchanged, 'unchanged reads retain their data identity');
  resource.stop();
  f.controller.abort();
});

test('Task events isolate unrelated identities and refresh only the matching parent list', async () => {
  const f = fixture();
  const otherId = '6f1c0c92-3580-4cdd-85bf-d7fcf22ab3ff';
  const task = createReadResource(f.context, input);
  const other = createReadResource(f.context, { ...input, task_id: otherId });
  const children = createReadResource(f.context, { view: 'list', parent_task_id: taskId, status: 'all', limit: 50 });
  for (const resource of [task, other, children]) resource.start();
  f.requests[0].resolve(response());
  f.requests[1].resolve(response({ ...result, id: otherId }));
  f.requests[2].resolve(response({ items: [], next_cursor: null }));
  await settle();
  f.invalidate();
  f.event({ type: 'task/changed', task_id: 'unrelated', data_version: dataVersion });
  assert.equal(f.requests.length, 3);
  f.event({ type: 'task/changed', task_id: otherId, data_version: dataVersion });
  assert.deepEqual(f.requests.slice(3).map(request => JSON.parse(request.init.body)), [
    { ...input, task_id: otherId },
  ]);
  assert.equal(task.getSnapshot().refreshing, false);
  assert.equal(children.getSnapshot().refreshing, false);
  f.requests[3].resolve(response({ ...result, id: otherId, revision: 2, data_version: dataVersion }));
  await settle();
  f.event({ type: 'task/changed', task_id: taskId, data_version: dataVersion });
  assert.deepEqual(f.requests.slice(4).map(request => JSON.parse(request.init.body)), [
    input, { view: 'list', parent_task_id: taskId, status: 'all', limit: 50 },
  ]);
  f.requests[4].resolve(response({ ...result, data_version: dataVersion }));
  f.requests[5].resolve(response({ items: [], next_cursor: null }));
  await settle();
  other.stop();
  f.event({ type: 'task/changed', task_id: otherId, data_version: nextDataVersion });
  assert.equal(f.requests.length, 6, 'unmounted resources are marked dirty, not fetched');
  other.start();
  assert.equal(f.requests.length, 7, 'remount reconciles a known Task change');
  f.requests[6].resolve(response({ ...result, id: otherId, revision: 3, data_version: nextDataVersion }));
  await settle();
  for (const resource of [task, other, children]) resource.stop();
  f.controller.abort();
});

test('same-version Task events cause no rereads before, during or after changed-version reconciliation', async () => {
  const f = fixture();
  const resource = createReadResource(f.context, input);
  resource.start();
  f.requests[0].resolve(response({ ...result, data_version: dataVersion }));
  await settle();
  f.event({ type: 'task/changed', task_id: taskId, data_version: dataVersion });
  assert.equal(f.requests.length, 1);
  f.event({ type: 'task/changed', task_id: taskId, data_version: nextDataVersion });
  assert.equal(f.requests.length, 2);
  f.event({ type: 'task/changed', task_id: taskId, data_version: nextDataVersion });
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].init.signal.aborted, false, 'duplicate events must not cancel reconciliation');
  f.requests[1].resolve(response({ ...result, revision: 2, data_version: nextDataVersion }));
  await settle();
  f.event({ type: 'task/changed', task_id: taskId, data_version: nextDataVersion });
  resource.stop();
  resource.start();
  assert.equal(f.requests.length, 2);
  assert.equal(resource.getSnapshot().data.revision, 2);
  resource.stop();
  f.controller.abort();
});

test('manual overview version changes invalidate related active and retained caches, not unrelated or native reads', async () => {
  const f = fixture();
  const otherId = '6f1c0c92-3580-4cdd-85bf-d7fcf22ab3ff';
  const overview = createReadResource(f.context, input);
  const execution = createReadResource(f.context, { view: 'execution', task_id: taskId });
  const history = createReadResource(f.context, { view: 'activity', task_id: taskId, limit: 10, cursor: 'opaque+/=' });
  const observation = createReadResource(f.context, { view: 'native', task_id: taskId });
  const other = createReadResource(f.context, { ...input, task_id: otherId });
  const definition = { ...result, data_version: dataVersion, description: 'Current definition', references: [], metadata: {} };
  overview.start();
  f.requests[0].resolve(response({ ...result, data_version: dataVersion }));
  await settle();
  for (const resource of [execution, history, observation, other]) resource.start();
  f.requests[1].resolve(response(definition));
  f.requests[2].resolve(response({ items: [], next_cursor: null }));
  f.requests[3].resolve(nativeResponse());
  f.requests[4].resolve(response({ ...result, id: otherId, data_version: dataVersion }));
  await settle();
  assert.equal(f.requests.length, 5, 'establishing a version baseline is not a mutation');
  history.stop();
  const unchanged = overview.refresh();
  f.requests[5].resolve(response({ ...result, data_version: dataVersion }));
  await unchanged;
  assert.equal(f.requests.length, 6, 'unchanged manual overview does not refresh sibling resources');
  const changed = overview.refresh();
  f.requests[6].resolve(response({ ...result, revision: 2, data_version: nextDataVersion }));
  await changed;
  assert.equal(f.requests.length, 8);
  assert.deepEqual(JSON.parse(f.requests[7].init.body), { view: 'execution', task_id: taskId });
  assert.equal(execution.getSnapshot().data.description, 'Current definition');
  assert.equal(execution.getSnapshot().refreshing, true);
  assert.equal(other.getSnapshot().refreshing, false);
  assert.equal(observation.getSnapshot().refreshing, false);
  f.requests[7].resolve(response({ ...definition, revision: 2, data_version: nextDataVersion }));
  await settle();
  assert.equal(f.requests.length, 8, 'matching execution response does not cause an overview refresh loop');
  history.start();
  assert.deepEqual(JSON.parse(f.requests[8].init.body),
    { view: 'activity', task_id: taskId, limit: 10, cursor: 'opaque+/=' });
  f.requests[8].resolve(response({ items: [], next_cursor: null }));
  await settle();
  for (const resource of [overview, execution, history, observation, other]) resource.stop();
  f.controller.abort();
});

test('identical reads in distinct activation contexts never share response data', async () => {
  const first = fixture(), second = fixture();
  const a = createReadResource(first.context, input), b = createReadResource(second.context, input);
  assert.notEqual(a, b);
  a.start();
  b.start();
  first.requests[0].resolve(response({ ...result, title: 'First activation' }));
  second.requests[0].resolve(response({ ...result, title: 'Second activation' }));
  await settle();
  assert.equal(a.getSnapshot().data.title, 'First activation');
  assert.equal(b.getSnapshot().data.title, 'Second activation');
  first.controller.abort();
  assert.equal(second.requests[0].init.signal.aborted, false);
  b.stop();
  second.controller.abort();
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

test('native observation is lazy and ignores Task events; disclosure remount retains its observation', async () => {
  const f = fixture();
  const resource = createReadResource(f.context, { view: 'native', task_id: taskId });
  assert.equal(f.requests.length, 0);
  resource.start();
  assert.equal(f.requests.length, 1);
  f.event({ type: 'task/changed', task_id: taskId });
  f.invalidate();
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve(nativeResponse());
  await settle();
  resource.stop();
  resource.start();
  assert.equal(f.requests.length, 1);
  const refresh = resource.refresh();
  assert.equal(resource.refresh(), refresh);
  f.requests[1].resolve(nativeResponse({ ...native, status: 'running' }));
  await refresh;
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
  let nextId = 0;
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
    useId: () => hook(() => ({ value: `synthetic-id-${++nextId}` })).value,
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
    render(count = 1, event = null) {
      effects = [];
      mounted = new Set();
      const reference = () => renderer.component({ node: { kind: 'link', target: `task:${taskId}${event ? `?event=${event}` : ''}` } });
      const tree = resolve(count === 1 ? reference() : Array.from({ length: count }, reference), 'root');
      for (const [key, instance] of instances) if (!mounted.has(key)) {
        for (const slot of instance.hooks) slot.cleanup?.();
        instances.delete(key);
      }
      for (const effect of effects) effect();
      return tree;
    },
    stop() {
      for (const instance of instances.values()) for (const slot of instance.hooks) slot.cleanup?.();
      instances.clear();
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
const button = (tree, label) => elements(tree).find(node => node.type === 'button'
  && (node.props['aria-label'] === label || textContent(node).trim() === label));
const openCard = tree => elements(tree).find(node => node.props.className === 'tb-card-open').props.onClick();
const showHistory = (harness, tree, title) => {
  button(tree, 'History').props.onClick();
  tree = harness.render();
  button(tree, title).props.onClick();
  return harness.render();
};

test('mounted duplicate references share pending reads, retained snapshots and spinner-only refresh', async () => {
  const f = fixture(), harness = componentHarness(f.context);
  try {
    let tree = harness.render(2);
    assert.equal(f.requests.length, 1);
    assert.equal(elements(tree).filter(node => node.props.className === 'tb-card').length, 2);
    harness.stop();
    harness.render(2);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].init.signal.aborted, false);
    f.requests[0].resolve(response({ ...result, activity_count: 0 }));
    await settle();
    tree = harness.render(2);
    const refreshes = elements(tree).filter(node => node.props['aria-label'] === 'Refresh Task');
    assert.equal(refreshes.length, 2);
    for (const refresh of refreshes) {
      assert.equal(textContent(refresh).trim(), '', 'refresh must not add a footer label');
      assert.equal(elements(refresh).filter(node => node.type === 'svg').length, 1);
      assert.equal(refresh.props.disabled, false);
    }
    for (const refresh of refreshes) refresh.props.onClick();
    assert.equal(f.requests.length, 2);
    tree = harness.render(2);
    for (const refresh of elements(tree).filter(node => node.props['aria-label'] === 'Refresh Task')) {
      assert.equal(refresh.props['aria-busy'], true);
      assert.equal(refresh.props.disabled, true);
    }
    f.requests[1].resolve(response({ ...result, activity_count: 7 }));
    await settle();
    tree = harness.render(2);
    assert.equal(elements(tree).filter(node => node.props['aria-label'] === 'Activity count: 7').length, 2);
    harness.stop();
    harness.render();
    assert.equal(f.requests.length, 2, 'settled React remount retains the overview');
  } finally {
    harness.stop();
    f.controller.abort();
  }
});

test('progressive sections and disclosures preserve session-name semantics and cached close/reopen', async () => {
  const f = fixture(), harness = componentHarness(f.context);
  const oldDocument = globalThis.document;
  globalThis.document = { body: {} };
  const task = { ...result, assignee: 'worker-session-id', activity_count: 8,
    sessions: { assignee: sessionInfo('worker-session-id', 'Human-readable worker name'),
      orchestrator: sessionInfo(result.orchestrator, 'Human-readable coordinator name') } };
  const execution = { ...task, description: 'Complete current definition', references: [], metadata: { diagnostic: true } };
  try {
    harness.render();
    f.requests[0].resolve(response(task));
    await settle();
    let tree = harness.render();
    assert.match(textContent(tree), /Human-readable worker name/);
    assert.doesNotMatch(textContent(tree), /worker-session-id/);
    openCard(tree);
    harness.render();
    assert.equal(f.requests.length, 2, 'detail shares the card overview read');
    f.requests[1].resolve(response(execution));
    await settle();
    tree = harness.render();
    const sections = elements(tree).find(node => node.props['aria-label'] === 'Task detail sections');
    assert.deepEqual(elements(sections).filter(node => node.type === 'button').map(node => textContent(node)),
      ['Overview', 'Activity · 8', 'Relations', 'History']);
    assert.match(textContent(tree), /Complete current definition/);
    assert.match(textContent(tree), /Human-readable coordinator name/);
    assert.doesNotMatch(textContent(tree), /worker-session-id|diagnostic|Native state/);
    for (const toggle of elements(tree).filter(node => node.props.className === 'ck-button tb-disclosure-toggle')) {
      assert.equal(toggle.props['aria-expanded'], false);
      assert.equal(toggle.children[0].type, 'svg', 'chevron precedes disclosure text');
      const panel = elements(tree).find(node => node.props.id === toggle.props['aria-controls']);
      assert.ok(panel);
      assert.equal(panel.props.hidden, true);
    }
    button(tree, 'Full session names and IDs').props.onClick();
    tree = harness.render();
    assert.match(textContent(tree), /Assignee ID: worker-session-id/);
    assert.match(textContent(tree), /Orchestrator ID: synthetic-orchestrator/);
    assert.equal(f.requests.length, 2);
    button(tree, 'Activity · 8').props.onClick();
    harness.render();
    assert.deepEqual(JSON.parse(f.requests[2].init.body), { view: 'activity', task_id: taskId, limit: 10 });
    f.requests[2].resolve(response({ items: [{
      revision: 1, author: 'worker-session-id', assignee: 'worker-session-id',
      at: '2026-09-20T01:02:05Z', text: 'Reported progress, not native activity',
    }], next_cursor: null }));
    await settle();
    tree = harness.render();
    assert.match(textContent(tree), /Reported progress, not native activity/);
    button(tree, 'Overview').props.onClick();
    tree = harness.render();
    button(tree, 'Activity · 8').props.onClick();
    tree = harness.render();
    assert.equal(f.requests.length, 3, 're-entering an unchanged read uses cache');
    assert.match(textContent(tree), /Reported progress, not native activity/);
    elements(tree).find(node => node.type === 'dialog').props.onClose();
    tree = harness.render();
    assert.equal(elements(tree).some(node => node.type === 'dialog'), false);
    assert.equal(f.requests.length, 3, 'close does not refresh the card');
    openCard(tree);
    tree = harness.render();
    assert.equal(f.requests.length, 3, 'reopen is cache-only until a real change or manual refresh');
    assert.match(textContent(tree), /Complete current definition/);
    const dialog = elements(tree).find(node => node.type === 'dialog');
    button(dialog, 'Refresh Task').props.onClick();
    button(dialog, 'Refresh Task').props.onClick();
    assert.deepEqual(f.requests.slice(3).map(request => JSON.parse(request.init.body).view).sort(), ['execution', 'overview']);
    tree = harness.render();
    assert.match(textContent(tree), /Complete current definition/);
    for (const request of f.requests.slice(3)) request.reject(new Error('Explicit refresh failed'));
    await settle();
    tree = harness.render();
    assert.match(textContent(tree), /Complete current definition/);
    assert.match(textContent(tree), /Showing last-read data/);
    f.host({ connected: false });
    tree = harness.render();
    assert.match(textContent(tree), /Complete current definition/);
    assert.match(textContent(tree), /Disconnected/);
  } finally {
    harness.stop();
    f.controller.abort();
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }
});

test('unassigned Overview has no native observation and History lazily reads complete selected revisions', async () => {
  const f = fixture(), harness = componentHarness(f.context);
  const oldDocument = globalThis.document;
  globalThis.document = { body: {} };
  try {
    harness.render(1, 'assigned');
    f.requests[0].resolve(response());
    await settle();
    let tree = harness.render(1, 'assigned');
    assert.doesNotMatch(textContent(tree), /Task assigned/);
    openCard(tree);
    harness.render(1, 'assigned');
    f.requests[1].resolve(response({ ...result, description: 'Current definition', references: [], metadata: {} }));
    await settle();
    tree = harness.render(1, 'assigned');
    assert.equal(button(tree, 'Session observation'), undefined);
    button(tree, 'History').props.onClick();
    tree = harness.render(1, 'assigned');
    assert.equal(f.requests.length, 2);
    button(tree, 'Message context').props.onClick();
    tree = harness.render(1, 'assigned');
    assert.match(textContent(tree), /Task assigned.*past event, not the current Task state/);
    button(tree, 'Definition versions').props.onClick();
    harness.render(1, 'assigned');
    assert.deepEqual(JSON.parse(f.requests[2].init.body), { view: 'changelog', task_id: taskId, limit: 10 });
    const revision = { revision: 1, author: 'synthetic-orchestrator', at: '2026-09-20T01:02:05Z', reason: 'Original agreement' };
    f.requests[2].resolve(response({ items: [revision], next_cursor: null }));
    await settle();
    tree = harness.render(1, 'assigned');
    assert.equal(f.requests.length, 3);
    button(tree, 'Read full definition v1').props.onClick();
    harness.render(1, 'assigned');
    assert.deepEqual(JSON.parse(f.requests[3].init.body), { view: 'changelog', task_id: taskId, revision: 1 });
    const definition = '<script>literal earlier definition</script>\n' + 'Complete earlier line.\n'.repeat(1200);
    f.requests[3].resolve(response({ ...revision, description: definition }));
    await settle();
    tree = harness.render(1, 'assigned');
    assert.ok(textContent(tree).includes(definition));
    assert.equal(elements(tree).some(node => node.type === 'script'), false);
    button(tree, 'Read full definition v1').props.onClick();
    tree = harness.render(1, 'assigned');
    assert.equal(textContent(tree).includes(definition), false);
    button(tree, 'Read full definition v1').props.onClick();
    tree = harness.render(1, 'assigned');
    assert.ok(textContent(tree).includes(definition));
    assert.equal(f.requests.length, 4);
    assert.ok(f.requests.every(request => request.path === '/read'));
  } finally {
    harness.stop();
    f.controller.abort();
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }
});

test('unavailable session titles retain assignment identity and expose metadata failure without native inference', async () => {
  const f = fixture(), harness = componentHarness(f.context);
  const oldDocument = globalThis.document;
  globalThis.document = { body: {} };
  const task = { ...result, assignee: 'retained-assignee-id', sessions: {
    assignee: { ...sessionInfo('retained-assignee-id', null),
      error: { code: 'HOST_UNAVAILABLE', message: 'Title lookup failed' } },
    orchestrator: sessionInfo(result.orchestrator, null),
  } };
  try {
    harness.render();
    f.requests[0].resolve(response(task));
    await settle();
    let tree = harness.render();
    assert.match(textContent(tree), /retained-assignee-id/);
    assert.doesNotMatch(textContent(tree), /Unassigned/);
    openCard(tree);
    harness.render();
    f.requests[1].resolve(response({ ...task, description: 'Task definition', references: [], metadata: {} }));
    await settle();
    tree = harness.render();
    assert.ok(button(tree, 'Session observation'), 'unavailable metadata does not erase the assignee');
    assert.match(textContent(tree), /synthetic-orchestrator/);
    assert.doesNotMatch(textContent(tree), /Native state|running|idle/);
    button(tree, 'Full session names and IDs').props.onClick();
    tree = harness.render();
    assert.match(textContent(tree), /Assignee ID: retained-assignee-id/);
    assert.match(textContent(tree), /Title lookup failed/);
    assert.equal(f.requests.length, 2, 'name disclosure never fetches native observation');
  } finally {
    harness.stop();
    f.controller.abort();
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }
});

test('Overview labels earlier execution activity and cancellation, and renders full current Agent and automation outcomes', async () => {
  const oldDocument = globalThis.document;
  globalThis.document = { body: {} };
  const activity = { revision: 1, author: 'worker', at: '2026-09-20T01:02:05Z',
    text: 'Earlier checks belong to definition one', truncated: false, current: false };
  const fullSummary = 'Full current result\n' + 'Outcome detail must not be truncated.\n'.repeat(60);
  const references = [{ label: 'Current outcome evidence', target: 'https://example.test/evidence' }];
  try {
    for (const [overview, execution, heading, expected] of [
      [
        { ...result, revision: 2, activity },
        { ...result, revision: 2, activity, description: 'Revised definition', references: [], metadata: {} },
        'Earlier reported activity', 'Earlier activity · v1: Earlier checks belong to definition one',
      ],
      [
        { ...result, status: 'cancelled', cancellation: { reason: 'Authorization withdrawn' }, activity },
        { ...result, status: 'cancelled', cancellation: { reason: 'Authorization withdrawn' }, activity,
          description: 'Cancelled definition', references: [], metadata: {} },
        'Cancellation', 'Authorization withdrawn',
      ],
      ...[false, true].map(automated => [
        { ...(automated ? automatedOverview : result), status: 'cancelled', cancellation: { reason: 'Authorization withdrawn' }, ready: false, blocked_by: [{ condition: 'Unresolved when cancelled' }],
          outcome: { current: true, summary: 'Interim result before cancellation' } },
        { ...(automated ? automatedExecution : { ...result, description: 'Definition', references: [], metadata: {} }),
          status: 'cancelled', cancellation: { reason: 'Authorization withdrawn' }, ready: false, blocked_by: [{ condition: 'Unresolved when cancelled' }],
          outcome: { current: true, summary: 'Interim result before cancellation', references } },
        'Cancellation', 'Authorization withdrawn',
      ]),
      ...[false, true].map(automated => [
        { ...(automated ? automatedOverview : result), status: 'done',
          outcome: { current: true, summary: 'Bounded excerpt only', truncated: true } },
        { ...(automated ? automatedExecution : { ...result, description: 'Definition', references: [], metadata: {} }),
          status: 'done', outcome: { current: true, summary: fullSummary, references } },
        'Latest outcome', fullSummary,
      ]),
    ]) {
      const f = fixture(), harness = componentHarness(f.context);
      try {
        harness.render();
        f.requests[0].resolve(response(overview));
        await settle();
        let tree = harness.render();
        openCard(tree);
        harness.render();
        f.requests[1].resolve(response(execution));
        await settle();
        tree = harness.render();
        const current = elements(tree).find(node => node.props.className === 'tb-current');
        assert.equal(elements(current).find(node => node.type === 'h3').children, heading);
        assert.ok(textContent(current).includes(expected));
        if (heading === 'Latest outcome') {
          assert.doesNotMatch(textContent(current), /Bounded excerpt only|Automation · running/);
          assert.equal(elements(current).find(node => node.type === 'a').props.href, references[0].target);
        }
        if (heading === 'Cancellation') {
          assert.doesNotMatch(textContent(current), /Interim result before cancellation|Current outcome evidence/);
        }
        assert.equal(f.requests.length, 2);
      } finally {
        harness.stop();
        f.controller.abort();
      }
    }
  } finally {
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }
});

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
    assert.match(textContent(tree), /ACK n\/a/);
    assert.doesNotMatch(textContent(tree), /Unassigned|No reported activity/);
    openCard(tree);
    tree = harness.render();
    assert.equal(f.requests.length, 2);
    assert.deepEqual(JSON.parse(f.requests[1].init.body), { view: 'execution', task_id: taskId });
    f.requests[1].resolve(response(automatedExecution));
    await settle();
    tree = harness.render();
    assert.doesNotMatch(textContent(tree), /Immutable script snapshot/);
    button(tree, 'Immutable script and parameter snapshot').props.onClick();
    tree = harness.render();
    assert.match(textContent(tree), /Immutable script snapshot/);
    assert.match(textContent(tree), /Immutable parameter snapshot/);
    assert.match(textContent(tree), /"enabled": false/);
    assert.match(textContent(tree), /<script>literal<\/script>/);
    assert.match(textContent(tree), /Launch barrier Set/);
    assert.equal(button(tree, 'Session observation'), undefined);
    assert.equal(button(tree, 'Reported activity'), undefined);
    assert.equal(elements(tree).some(node => node.type === 'script'), false);
    button(tree, 'Execution log').props.onClick();
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
    tree = harness.render();
    assert.equal(f.requests.length, 4, 'previous log page comes from its retained cache');
    assert.match(textContent(tree), /Offset 0/);
    button(tree, 'Refresh log').props.onClick();
    assert.equal(f.requests.length, 5);
    f.requests[4].resolve(response(automationLog));
    await settle();
    tree = harness.render();
    showHistory(harness, tree, 'Outcomes and retrospectives');
    f.requests[5].resolve(response({ items: [automatedOutcome], next_cursor: null }));
    await settle();
    tree = harness.render();
    assert.match(textContent(tree), /Source: Automation/);
    assert.match(textContent(tree), /Not applicable to script automation/);
    assert.match(textContent(tree), new RegExp(`Reported author:\\s+automation:${automation.run_id}`));
    assert.doesNotMatch(textContent(tree), /Assignee: null/);
    assert.equal(f.requests.every(request => request.path === '/read'), true);
    assert.equal(f.requests.length, 6);
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
    const assigned = { ...result, assignee: 'synthetic-assignee', activity_count: 0 };
    f.requests[0].resolve(response(assigned));
    await settle();
    let tree = harness.render();
    assert.match(textContent(tree), /No ACK/);
    openCard(tree);
    harness.render();
    f.requests[1].resolve(response({ ...assigned, description: 'Agent definition', references: [], metadata: {} }));
    await settle();
    tree = harness.render();
    assert.ok(button(tree, 'Activity · 0'));
    assert.match(textContent(tree), /not ACKed/);
    assert.doesNotMatch(textContent(tree), /No retro recorded/);
    assert.equal(button(tree, 'Logs'), undefined);
    assert.equal(f.requests.length, 2);
    button(tree, 'Session observation').props.onClick();
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
        openCard(tree);
        harness.render();
        f.requests[1].resolve(response({ ...result, description: 'Current definition', references: [], metadata: {}, retro }));
        await settle();
        tree = harness.render();
        tree = showHistory(harness, tree, 'Current retrospective');
        assert.match(textContent(tree), expected);
        if (retro.current === false) assert.match(textContent(tree), /Historical retro; not a retrospective on the current definition/);
        assert.equal(elements(tree).some(node => node.type === 'script'), false);
        button(tree, 'Outcomes and retrospectives').props.onClick();
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
  f.event({ type: 'task/changed', task_id: taskId });
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
        openCard(tree);
        harness.render();
        f.requests[1].resolve(response(execution));
        await settle();
        tree = harness.render();
        if (automated) {
          button(tree, 'Execution log').props.onClick();
          harness.render();
        } else showHistory(harness, tree, 'Outcomes and retrospectives');
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
  assert.equal(dependencyLabel([{ task_id: 'b', status: 'in_progress' }, { condition: 'User must choose a target.' }], false),
    'Blocked by 2 unmet prerequisites (1 Task + 1 condition)');
});

test('prerequisite history validates active conditions and permanently resolved Task rounds', async () => {
  const entry = {
    dependency_id: 'round-id', task_id: taskId, author: 'orchestrator', created_at: '2026-09-25T00:00:00Z',
    kind: 'condition', condition: 'Provide the complete source.', active: true,
    resolved_at: null, resolved_by: null, resolution: null, blocker_lifecycle: null,
  };
  const request = { view: 'dependencies', task_id: taskId };
  const page = items => ({ task_id: taskId, items, next_cursor: null });
  assert.deepEqual(await readTask({ request: async () => response(page([entry])) }, request), page([entry]));
  const { condition, ...common } = entry;
  const resolved = {
    ...common, kind: 'task', blocker_id: 'blocker-id', active: false,
    resolved_at: '2026-09-25T01:00:00Z', resolved_by: 'worker', resolution: 'done', blocker_lifecycle: 3,
  };
  assert.deepEqual(await readTask({ request: async () => response(page([resolved])) }, request), page([resolved]));
  for (const invalid of [{ ...entry, active: false }, { ...resolved, resolution: null }, { ...entry, task_id: 'wrong' }]) {
    await assert.rejects(readTask({ request: async () => response(page([invalid])) }, request), /invalid result/);
  }
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
    assert.doesNotMatch(textContent(tree), /Subtask · delegation level 2/);
    openCard(tree);
    harness.render();
    f.requests[1].resolve(response({ ...result, parent_task_id: parentId, depth: 2, description: 'Child definition', references: [], metadata: {} }));
    await settle();
    tree = harness.render();
    button(tree, 'Relations').props.onClick();
    tree = harness.render();
    assert.match(textContent(tree), /Subtask · delegation level 2/);
    assert.match(textContent(tree), /Parent Task/);
    assert.match(textContent(tree), new RegExp(parentId));
    assert.equal(f.requests.length, 2, 'Parent and child lineage are not read until disclosed');
    button(tree, 'Subtasks delegated from this Task').props.onClick();
    harness.render();
    assert.deepEqual(JSON.parse(f.requests[2].init.body), { view: 'list', parent_task_id: taskId, status: 'all', limit: 50 });
    f.requests[2].resolve(response({ items: [{ task_id: childId, title: 'Specific child', status: 'in_progress',
      assignee: 'worker', parent_task_id: taskId, depth: 3,
      sessions: { assignee: sessionInfo('worker', 'Child worker display name'),
        orchestrator: sessionInfo(result.orchestrator, null) } }], next_cursor: 'children+/=opaque' }));
    await settle();
    tree = harness.render();
    assert.match(textContent(tree), /Specific child\s+In progress\s+· Assignee:\s+Child worker display name/);
    assert.ok(button(tree, 'Specific child'));
    assert.equal(button(tree, childId), undefined, 'child disclosure uses the title rather than its ID');
    assert.equal(f.requests.length, 3);
    button(tree, 'Next page').props.onClick();
    harness.render();
    assert.deepEqual(JSON.parse(f.requests[3].init.body),
      { view: 'list', parent_task_id: taskId, status: 'all', limit: 50, cursor: 'children+/=opaque' });
    f.requests[3].resolve(response({ items: [], next_cursor: null }));
    await settle();
    tree = harness.render();
    assert.equal(button(tree, 'Next page').props.disabled, true);
    assert.match(textContent(tree), /Page 2/);
    button(tree, 'Previous page').props.onClick();
    tree = harness.render();
    assert.match(textContent(tree), /Specific child/);
    assert.equal(f.requests.length, 4, 'returning to a retained child-list page is cache-only');
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
