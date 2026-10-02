import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/task-board/store.js';
import { readSessionSummaries, sessionSummaryInput } from '../src/task-board/session-summaries.js';
import { createSessionSummaries, readSessionSummaries as readRemote } from '../web/task-board/session-summaries.js';
import { createTaskMenu, summaryNotice, summaryIcon, summaryBadgeNotice } from '../web/task-board/session-entry.js';
import { ICONS } from '../web/task-board/icons.js';
import { activate } from '../web/task-board/index.js';
import { responsibilityContext, startResponsibility } from './helpers/service-responsibility-fixtures.js';

const taskId = 'a627645b-eaf1-4e16-865c-d63630463e2b';
const tick = () => new Promise(resolve => setImmediate(resolve));
const item = (session_id, fields = {}) => ({ session_id, selection: 'current',
  task: { id: taskId, title: 'A real Task', status: 'in_progress', position: 'Root', ...fields } });

function database() {
  const root = mkdtempSync(join(tmpdir(), 'task-session-summary-'));
  const store = new TaskStore(root);
  let seq = 0;
  const call = (name, actor, fields = {}) => store.executeLocal(name, { actor, request_id: `summary-${++seq}`, ...fields });
  const create = (actor = 'user') => call('task_create', actor, { title: `Task ${seq}`, description: 'Synthetic test' });
  const claim = (task, actor) => call('task_claim', actor, responsibilityContext(store.task(task.task_id)));
  const finish = (task, actor) => {
    startResponsibility(store, task.task_id, actor);
    return call('task_report', actor, { ...responsibilityContext(store.task(task.task_id)), status: 'done',
      outcome: { summary: 'Delivered' }, retro: null });
  };
  return { store, call, create, claim, finish,
    read: (...ids) => readSessionSummaries(store.db, { session_ids: ids }).items,
    close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('session summaries select actual current or latest binding, never creator, creation order or updated time', () => {
  const f = database();
  try {
    const createdFirst = f.create();
    const boundFirst = f.create();
    f.claim(boundFirst, 'worker');
    assert.equal(f.read('worker')[0].task.id, boundFirst.task_id);
    f.finish(boundFirst, 'worker');
    f.claim(createdFirst, 'worker');
    f.finish(createdFirst, 'worker');
    f.store.db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run('2999-01-01', boundFirst.task_id);
    assert.deepEqual(f.read('worker')[0], {
      session_id: 'worker', selection: 'recent',
      task: { id: createdFirst.task_id, title: f.store.task(createdFirst.task_id).title, status: 'done', position: 'Root' },
    });
    assert.equal(f.read('user')[0].selection, 'none');
    const reopened = f.call('task_reopen', 'worker', { ...responsibilityContext(f.store.task(createdFirst.task_id)),
      description: 'Authorized correction', reason: 'Fix this delivery' });
    assert.equal(f.store.task(createdFirst.task_id).status, 'in_progress');
    assert.equal(f.read('worker')[0].selection, 'current');
    f.call('task_cancel', 'worker', { task_id: createdFirst.task_id,
      write_context: reopened.write_context, reason: 'Abandoned by user' });
    f.call('task_cancel_finalize', 'worker', { ...responsibilityContext(f.store.task(createdFirst.task_id)), summary: 'No residual work' });
    assert.equal(f.read('worker')[0].task.status, 'cancelled');
    const current = f.create();
    f.claim(current, 'worker');
    assert.equal(f.read('worker')[0].task.id, current.task_id);
  } finally { f.close(); }
});

test('structure includes terminal children and attachment changes Root into Leaf or Branch', () => {
  const f = database();
  try {
    const parent = f.create();
    f.claim(parent, 'parent');
    startResponsibility(f.store, parent.task_id, 'parent', 'orchestrate');
    const child = f.create('parent');
    const assignment = { actor: 'parent', request_id: 'assign-child', ...responsibilityContext(child), assignee: 'child' };
    f.store.reserveOperation('task_assign', assignment);
    f.store.bindAssignment(assignment);
    assert.equal(f.read('parent', 'child')[0].task.position, 'Root');
    assert.equal(f.read('child')[0].task.position, 'Leaf');
    f.finish(child, 'child');
    const outer = f.create();
    f.claim(outer, 'outer');
    startResponsibility(f.store, outer.task_id, 'outer', 'orchestrate');
    f.call('task_attach', 'user', { ...responsibilityContext(f.store.task(parent.task_id)),
      parent_task_id: outer.task_id, parent_write_context: f.store.task(outer.task_id).write_context, reason: 'Integrate this tree' });
    assert.equal(f.read('parent')[0].task.position, 'Branch');
    assert.equal(f.read('child')[0].task.position, 'Leaf');
  } finally { f.close(); }
});

test('legacy untracked terminal bindings are unknown; bounded reads do one SQL query for 100 sessions', () => {
  const f = database();
  try {
    const legacy = f.create();
    f.claim(legacy, 'legacy');
    f.finish(legacy, 'legacy');
    f.store.db.prepare('DELETE FROM task_assignments WHERE task_id=?').run(legacy.task_id);
    assert.deepEqual(f.read('legacy')[0], { session_id: 'legacy', selection: 'unknown', task: null });
    let queries = 0;
    let statement;
    const db = { prepare(sql) { queries++; statement = sql; return f.store.db.prepare(sql); } };
    const ids = Array.from({ length: 100 }, (_, i) => `worker-${i}`);
    assert.equal(readSessionSummaries(db, { session_ids: ids }).items.length, 100);
    assert.equal(queries, 1);
    const plan = f.store.db.prepare(`EXPLAIN QUERY PLAN ${statement}`).all(JSON.stringify(ids)).map(row => row.detail);
    assert.ok(plan.includes('MATERIALIZE requested'), 'do not rescan the JSON ID array for every historical Task');
    assert.ok(plan.some(detail => /SEARCH r USING AUTOMATIC.*INDEX/.test(detail)), 'join history to the indexed materialized IDs');
    for (const input of [{}, { session_ids: [] }, { session_ids: ['a', 'a'] },
      { session_ids: ['a'], actor: 'user' }, { session_ids: ids.concat('overflow') },
      { session_ids: ['x'.repeat(201)] }]) assert.equal(sessionSummaryInput.safeParse(input).success, false);
    assert.equal(sessionSummaryInput.safeParse({ session_ids: ids }).success, true);
  } finally { f.close(); }
});

function frontend() {
  let host = { sessionId: null, connected: true, visible: true };
  const hostListeners = new Set(), events = new Set(), requests = [];
  const controller = new AbortController();
  const subscribe = set => listener => { set.add(listener); return () => set.delete(listener); };
  const context = { signal: controller.signal,
    state: { host: { getSnapshot: () => host, subscribe: subscribe(hostListeners) } },
    onEvent: subscribe(events),
    request(path, init) { return new Promise((resolve, reject) => requests.push({ path, init, resolve, reject })); },
  };
  return { context, requests, controller, events, hostListeners,
    event(value) { for (const listener of events) listener(value); },
    host(value) { host = { ...host, ...value }; for (const listener of hostListeners) listener(); },
    reply(index, items) { requests[index].resolve({ ok: true, status: 200, json: async () => ({ result: { items }, error: null }) }); },
  };
}

test('rows and active header share bounded batches; no polling or per-session request fanout', async () => {
  const f = frontend(), service = createSessionSummaries(f.context);
  try {
    f.host({ sessionId: 's0' });
    const stops = Array.from({ length: 205 }, (_, i) => service.watch(`s${i}`, () => {}));
    const duplicate = service.watch('s0', () => {});
    await tick();
    assert.equal(f.requests.length, 1);
    for (let page = 0; page < 3; page++) {
      const ids = JSON.parse(f.requests[page].init.body).session_ids;
      assert.equal(ids.length, page === 2 ? 5 : 100);
      f.reply(page, ids.map(id => item(id)));
      await tick();
    }
    assert.equal(f.requests.length, 3);
    assert.equal(service.get('s0').data.task.id, taskId);
    duplicate();
    stops.forEach(stop => stop());
  } finally { service.dispose(); }
});

test('unknown Task events invalidate new assignments; ignored aborts cannot overwrite and failures retain unconfirmed data', async () => {
  const f = frontend(), service = createSessionSummaries(f.context);
  service.watch('s', () => {});
  await tick();
  f.reply(0, [item('s')]);
  await tick();
  f.event({ type: 'task/changed', task_id: 'not-cached' });
  assert.equal(summaryNotice(service.get('s')), 'Task updating');
  await tick();
  f.event({ type: 'task/changed', task_id: 'new-binding' });
  assert.equal(f.requests[1].init.signal.aborted, true);
  await tick();
  f.reply(2, [item('s', { title: 'New binding' })]);
  await tick();
  f.reply(1, [item('s', { title: 'Obsolete' })]);
  await tick();
  assert.equal(service.get('s').data.task.title, 'New binding');
  service.retry('s');
  await tick();
  f.requests[3].reject(new Error('Unavailable'));
  await tick();
  assert.equal(service.get('s').phase, 'error');
  assert.equal(service.get('s').data.task.title, 'New binding');
  assert.equal(summaryNotice(service.get('s')), 'Unable to read Task');
  assert.equal(f.requests.length, 4);
  service.retry('s');
  await tick();
  f.reply(4, [{ session_id: 's', selection: 'none', task: null }]);
  await tick();
  assert.equal(summaryNotice(service.get('s')), null);
  f.controller.abort();
  assert.equal(f.events.size, 0);
  assert.equal(f.hostListeners.size, 0);
});

test('offline and hidden views pause reads; reconnect and visibility restore authoritative snapshots', async () => {
  const f = frontend(), service = createSessionSummaries(f.context);
  f.host({ connected: false, visible: false });
  service.watch('s', () => {});
  await tick();
  assert.equal(service.get('s').phase, 'offline');
  assert.equal(f.requests.length, 0);
  f.host({ connected: true });
  await tick();
  assert.equal(f.requests.length, 0);
  f.host({ visible: true });
  await tick();
  assert.equal(f.requests.length, 1);
  f.host({ connected: false });
  assert.equal(f.requests[0].init.signal.aborted, true);
  f.reply(0, [item('s')]);
  await tick();
  assert.equal(service.get('s').phase, 'offline');
  f.host({ connected: true });
  await tick();
  f.reply(1, [item('s')]);
  await tick();
  assert.equal(service.get('s').phase, 'ready');
  service.dispose();
});

test('malformed summaries never invent no-Task or a lifecycle/position', async () => {
  for (const items of [[], [item('other')], [item('s', { status: 'blocked' })],
    [item('s', { position: null })], [{ ...item('s'), selection: 'recent' }]]) {
    const f = frontend();
    const promise = readRemote(f.context, ['s'], f.context.signal);
    f.reply(0, items);
    await assert.rejects(promise, /invalid result/);
  }
});

test('menu captures a fixed task/session until dialog close; target/module loss aborts accepted work', async () => {
  let state = { phase: 'ready', refreshing: false, data: item('s') };
  const controller = new AbortController(), action = new AbortController();
  const summaries = { get: () => state, retry() { this.retried = true; } };
  const menu = createTaskMenu(summaries, controller.signal);
  assert.equal(menu.getState({ sessionId: 's' }).label, 'Current Task: A real Task');
  state = { ...state, data: { ...item('s', { status: 'done' }), selection: 'recent' } };
  assert.equal(menu.getState({ sessionId: 's' }).label, 'Recent Task: A real Task');
  const opened = menu.onSelect({ sessionId: 's' }, { signal: action.signal });
  state = { ...state, data: item('s', { id: '767a613f-9186-4d77-8463-d72956fe5272' }) };
  assert.deepEqual(menu.getSnapshot(), { sessionId: 's', taskId });
  action.abort();
  await opened;
  assert.equal(menu.getSnapshot(), null);
  const second = menu.onSelect({ sessionId: 's' }, { signal: new AbortController().signal });
  controller.abort();
  await second;
  assert.equal(menu.getSnapshot(), null);
  state = { ...state, phase: 'error' };
  assert.equal(menu.getState({ sessionId: 's' }).label, 'Retry reading Task');
  menu.dispose();
});

test('activation rejects unsupported boundaries and registers unique shared session entry surfaces', () => {
  const f = frontend();
  const context = { ...f.context, apiVersion: 2, uiVersion: 1, uiSurfaceVersion: 1,
    createPortal() {}, react: {}, menuVersion: 1, globalComponentVersion: 1, sessionListItemVersion: 1 };
  for (const capability of ['menuVersion', 'globalComponentVersion', 'sessionListItemVersion']) {
    assert.throws(() => activate({ ...context, [capability]: undefined }), /upgrade the paired host/);
  }
  const module = activate(context);
  assert.equal(module.components[0].boundary, 'sessionListItem');
  assert.equal(module.globalComponents.length, 1);
  const ids = [...module.components, ...module.menus, ...module.markdown, ...module.globalComponents].map(value => value.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(['todo', 'in_progress', 'done', 'cancelled'].map(summaryIcon),
    ['todo', 'progress', 'done', 'cancelled']);
  for (const status of ['todo', 'in_progress', 'done', 'cancelled']) {
    assert.equal(ICONS[summaryIcon(status)][0][0], 'rect', 'lifecycle icons share the square family');
  }
  assert.ok(ICONS.unknown.every(([tag]) => tag !== 'circle'), 'unknown Task must not reuse CircleHelp');
  module.dispose();
});

test('the actual row middleware preserves all native props and adds no row for confirmed no Task', () => {
  const f = frontend();
  let snapshot = { phase: 'ready', data: { session_id: 's', selection: 'none', task: null } };
  const h = (type, props, ...children) => ({ type, props, children });
  const module = activate({ ...f.context, apiVersion: 2, uiVersion: 1, uiSurfaceVersion: 1,
    sessionListItemVersion: 1, globalComponentVersion: 1, menuVersion: 1, createPortal() {},
    react: { createElement: h, Fragment: 'fragment', useCallback: fn => fn, useSyncExternalStore: () => snapshot } });
  const Base = () => {};
  const Wrapper = module.components[0].wrap(Base);
  const original = { sessionId: 's', title: 'Session', description: 'Peer description', details: h('span', null, 'Host/peer details'), disabled: true,
    onClick() {}, onContextMenu() {}, 'aria-label': 'Native row' };
  assert.deepEqual(Wrapper(original), h(Base, original));
  snapshot = { ...snapshot, data: item('s', { title: 'Long complete Task title' }) };
  const row = Wrapper(original);
  assert.equal(row.type, Base);
  for (const key of Object.keys(original).filter(key => key !== 'details')) assert.equal(row.props[key], original[key]);
  assert.equal(row.props.details.children[1], original.details);
  const summaryElement = row.props.details.children[0];
  const summary = summaryElement.type(summaryElement.props);
  assert.match(summary.props['aria-label'], /Task: In progress; Root; Long complete Task title/);
  assert.equal(summary.type, 'span');
  assert.equal(summary.props.role, 'img', 'complete identity is accessible without hover or repeated visible title');
  assert.equal(summary.props.className, 'ck-badge tb-session-summary');
  assert.equal(summary.children[1].children[0], 'Root');
  assert.equal(summary.children[2], null, 'confirmed badge has only lifecycle icon and position');
  for (const status of ['todo', 'in_progress', 'done', 'cancelled']) {
    for (const [phase, refreshing, notice] of [['ready', false, null], ['ready', true, 'Updating'],
      ['offline', false, 'Not synced'], ['error', false, 'Read failed']]) {
      snapshot = { phase, refreshing, data: item('s', { status, position: 'Leaf' }) };
      const element = Wrapper(original).props.details.children[0];
      const badge = element.type(element.props);
      assert.equal(summaryBadgeNotice(snapshot), notice);
      assert.equal(badge.props['data-status'], status);
      assert.equal(badge.children[0].children[0].props.name, summaryIcon(status));
      assert.equal(badge.children[1].children[0], 'Leaf');
      assert.equal(badge.children[2]?.children[0] ?? null, notice ? `· ${notice}` : null);
      if (notice) assert.match(badge.props['aria-label'], /Last-read data; current state unconfirmed/);
    }
  }
  for (const [phase, data, expected] of [
    ['loading', null, 'Task loading'], ['error', null, 'Task read failed'], ['offline', null, 'Task offline'],
    ['ready', { selection: 'unknown', task: null }, 'Task unconfirmed'],
    ['error', { selection: 'none', task: null }, 'Task read failed'],
  ]) {
    snapshot = { phase, data };
    const element = Wrapper(original).props.details.children[0];
    const badge = element.type(element.props);
    assert.equal(badge.children[0], null, 'read state does not impersonate a lifecycle or ask icon');
    assert.equal(badge.children[1], null, 'unknown position is never invented');
    assert.equal(badge.children[2].children[0], expected);
  }
  module.dispose();
});

test('compact badges reserve their fixed content width alongside host roles and activity', () => {
  const css = readFileSync(new URL('../web/task-board/style.css', import.meta.url), 'utf8');
  const badge = css.match(/\.tb-session-summary\s*\{([^}]+)\}/)[1];
  assert.match(badge, /flex: none;/, 'shrinking the badge lets the fixed icon/position overlap adjacent roles');
  assert.match(badge, /white-space: nowrap;/);
  assert.match(badge, /max-width: 100%;/);
  assert.doesNotMatch(css, /\.tb-session-title/);
});
