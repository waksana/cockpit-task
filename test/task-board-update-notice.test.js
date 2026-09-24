import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TaskStore } from '../src/task-board/store.js';
import { TaskService } from '../src/task-board/service.js';
import { UPDATE_NOTICE_INSTRUCTION } from '../src/task-board/reference.js';

function fixture(t, { sessionExists = async () => true, send } = {}) {
  const root = join(process.cwd(), '.task-board-tests', randomUUID());
  mkdirSync(root, { recursive: true });
  let store = new TaskStore(root);
  const sent = [];
  const host = {
    sessionExists: id => sessionExists(id),
    send: send ?? (async (session, text, options = {}) => { sent.push({ session, text, mode: options.mode ?? 'enqueue' }); return { ok: true }; }),
    inspect: async () => ({ ready: true, idle: true, node: true }),
  };
  let service = new TaskService(store, host, { report: () => {} });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const as = (actor, name, input) => service.execute(name, { actor, request_id: randomUUID(), ...input });
  const context = id => ({ task_id: id, write_context: store.task(id).write_context, revision: store.task(id).revision });
  const f = {
    sent, as, context,
    get store() { return store; },
    restart() { service.close(); store = new TaskStore(root); service = new TaskService(store, host, { report: () => {} }); return service; },
    async assigned(assignee = 'assignee') {
      const id = (await as('orchestrator', 'task_create', { title: 'Update target', description: 'v1' })).result.task_id;
      assert.equal((await as('orchestrator', 'task_assign', { ...context(id), assignee })).error, null);
      assert.equal((await as(assignee, 'task_ack', context(id))).error, null);
      sent.length = 0;
      return id;
    },
    edit: (actor, id, fields) => as(actor, 'task_edit', { ...context(id), reason: 'Important change', ...fields }),
  };
  return f;
}

test('notify_assignee sends one fixed immediate update card to the assignee, who then ACKs the new revision', async t => {
  const f = fixture(t);
  const id = await f.assigned();
  const edited = await f.edit('orchestrator', id, { description: 'v2', notify_assignee: true });
  assert.equal(edited.error, null, JSON.stringify(edited.error));
  assert.equal(edited.result.revision, 2);
  assert.equal(edited.result.notice_ids.length, 1);
  assert.equal(edited.notifications[0].notification.status, 'accepted');
  assert.equal(edited.notification_error, null);
  assert.deepEqual(f.sent, [{
    session: 'assignee', mode: 'immediate',
    text: `[Task updated](task:${id}?event=updated)\n${UPDATE_NOTICE_INSTRUCTION}`,
  }]);
  assert.doesNotMatch(f.sent[0].text, /\b(you|your|As Orchestrator|As Assignee)\b/i);
  const notices = f.store.read({ view: 'update_notices', task_id: id }).items;
  assert.equal(notices.length, 1);
  assert.equal(notices[0].assignee, 'assignee');
  assert.equal(notices[0].revision, 2);
  assert.equal(notices[0].notification.status, 'accepted');
  const execution = await f.as('assignee', 'task_read', { view: 'execution', task_id: id });
  assert.equal(execution.definition_check.tasks[0].needs_ack, true);
  assert.equal((await f.as('assignee', 'task_ack', f.context(id))).result.acknowledged_revision, 2);
});

test('without notify_assignee, task_edit stays silent', async t => {
  const f = fixture(t);
  const id = await f.assigned();
  const edited = await f.edit('orchestrator', id, { description: 'v2' });
  assert.equal(edited.error, null);
  assert.equal(edited.result.notice_ids, undefined);
  assert.deepEqual(f.sent, []);
});

test('notify_assignee is rejected, saving nothing, when no update notice applies', async t => {
  const f = fixture(t);
  const unassigned = (await f.as('orchestrator', 'task_create', { title: 'Draft', description: 'v1' })).result.task_id;
  const cases = [
    ['unassigned', unassigned, 'orchestrator', { description: 'v2' }],
  ];
  const assigned = await f.assigned();
  cases.push(['unchanged description', assigned, 'orchestrator', { description: 'v1' }]);
  cases.push(['metadata only', assigned, 'orchestrator', { title: 'Renamed' }]);
  cases.push(['assignee notifying itself', assigned, 'assignee', { description: 'v2' }]);
  const done = await f.assigned('finisher');
  assert.equal((await f.as('finisher', 'task_report', { ...f.context(done), status: 'done', outcome: { summary: 'Delivered' }, retro: null })).error, null);
  cases.push(['terminal', done, 'orchestrator', { description: 'v2' }]);
  for (const [label, id, actor, fields] of cases) {
    const before = f.store.task(id);
    const result = await f.edit(actor, id, { ...fields, notify_assignee: true });
    assert.equal(result.error?.code, 'UPDATE_NOTICE_NOT_APPLICABLE', label);
    const after = f.store.task(id);
    assert.equal(after.revision, before.revision, label);
    assert.equal(after.title, before.title, label);
    assert.equal(f.store.read({ view: 'update_notices', task_id: id }).items.length, 0, label);
  }
  assert.deepEqual(f.sent.filter(entry => entry.mode === 'immediate'), []);
});

test('notify_assignee rejects free-text notes at the contract', async t => {
  const f = fixture(t);
  const id = await f.assigned();
  const result = await f.edit('orchestrator', id, { description: 'v2', notify_assignee: true, note: 'Pause now' });
  assert.equal(result.error?.code, 'INVALID_INPUT');
  const text = await f.edit('orchestrator', id, { description: 'v2', notify_assignee: 'Pause now' });
  assert.equal(text.error?.code, 'INVALID_INPUT');
  assert.equal(f.store.task(id).revision, 1);
});

test('update notice failures keep the saved edit and report notification_error', async t => {
  let exists = true;
  const f = fixture(t, { sessionExists: async () => exists });
  const id = await f.assigned();
  exists = false;
  const edited = await f.edit('orchestrator', id, { description: 'v2', notify_assignee: true });
  assert.equal(edited.error, null);
  assert.equal(edited.result.revision, 2);
  assert.equal(edited.notifications[0].notification.status, 'not_sent');
  assert.equal(edited.notification_error.code, 'ASSIGNEE_NOT_FOUND');
  assert.deepEqual(f.sent, []);
});

test('an update notice left pending by a restart expires as not sent instead of arriving late', async t => {
  const f = fixture(t);
  const id = await f.assigned();
  const row = f.store.task(id);
  const noticeId = f.store.recordUpdateNotice(f.store.row(id), { actor: 'orchestrator' }, new Date().toISOString());
  assert.equal(row.revision, 1);
  const service = f.restart();
  await service.recoverNotifications?.();
  await new Promise(resolve => setTimeout(resolve, 50));
  const notice = f.store.read({ view: 'update_notices', task_id: id }).items.find(item => item.notice_id === noticeId);
  assert.equal(notice.notification.status, 'not_sent');
  assert.equal(notice.notification.error.code, 'UPDATE_NOTICE_EXPIRED');
  assert.deepEqual(f.sent, []);
});
