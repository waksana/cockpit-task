import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TaskStore } from '../src/task-board/store.js';
import { TaskService } from '../src/task-board/service.js';
import { CANCEL_NOTICE_INSTRUCTION, UPDATE_NOTICE_INSTRUCTION } from '../src/task-board/reference.js';

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
    get service() { return service; },
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

test('a description change by the orchestrator automatically sends one fixed immediate update card, and the assignee then ACKs', async t => {
  const f = fixture(t);
  const id = await f.assigned();
  const edited = await f.edit('orchestrator', id, { description: 'v2' });
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
  const notices = f.store.read({ view: 'assignee_notices', task_id: id }).items;
  assert.equal(notices.length, 1);
  assert.equal(notices[0].assignee, 'assignee');
  assert.equal(notices[0].revision, 2);
  assert.equal(notices[0].notification.status, 'accepted');
  const execution = await f.as('assignee', 'task_read', { view: 'execution', task_id: id });
  assert.equal(execution.definition_check.tasks[0].needs_ack, true);
  assert.equal((await f.as('assignee', 'task_ack', f.context(id))).result.acknowledged_revision, 2);
});

test('edits that need no update notice save normally and send nothing', async t => {
  const f = fixture(t);
  const unassigned = (await f.as('orchestrator', 'task_create', { title: 'Draft', description: 'v1' })).result.task_id;
  const assigned = await f.assigned();
  const done = await f.assigned('finisher');
  assert.equal((await f.as('finisher', 'task_report', { ...f.context(done), status: 'done', outcome: { summary: 'Delivered' }, retro: null })).error, null);
  const cases = [
    ['unassigned', unassigned, 'orchestrator', { description: 'v2' }, 2],
    ['unchanged description', assigned, 'orchestrator', { description: 'v1' }, 1],
    ['metadata only', assigned, 'orchestrator', { title: 'Renamed' }, 1],
    ['assignee revising its own Task', assigned, 'assignee', { description: 'v2' }, 2],
    ['terminal', done, 'orchestrator', { description: 'v2' }, 2],
  ];
  for (const [label, id, actor, fields, revision] of cases) {
    const result = await f.edit(actor, id, fields);
    assert.equal(result.error, null, `${label}: ${JSON.stringify(result.error)}`);
    assert.equal(result.result.notice_ids, undefined, label);
    assert.equal(f.store.task(id).revision, revision, label);
    assert.equal(f.store.read({ view: 'assignee_notices', task_id: id }).items.length, 0, label);
  }
  assert.equal(f.store.task(assigned).title, 'Renamed');
  assert.equal(f.store.task(assigned).acknowledged_revision, 2);
  assert.deepEqual(f.sent, []);
});

test('task_edit has no notification switch or free-text note', async t => {
  const f = fixture(t);
  const id = await f.assigned();
  for (const extra of [{ notify_assignee: true }, { note: 'Pause now' }]) {
    const result = await f.edit('orchestrator', id, { description: 'v2', ...extra });
    assert.equal(result.error?.code, 'INVALID_INPUT', JSON.stringify(extra));
  }
  assert.equal(f.store.task(id).revision, 1);
  assert.deepEqual(f.sent, []);
});

test('cancel notifies the assignee only when someone else cancels', async t => {
  const f = fixture(t);
  const byOrchestrator = await f.assigned('cancelled-worker');
  const cancelled = await f.as('orchestrator', 'task_cancel', {
    task_id: byOrchestrator, write_context: f.store.task(byOrchestrator).write_context, reason: 'User stopped it',
  });
  assert.equal(cancelled.error, null, JSON.stringify(cancelled.error));
  assert.equal(cancelled.result.notice_ids.length, 1);
  assert.deepEqual(f.sent, [{
    session: 'cancelled-worker', mode: 'immediate',
    text: `[Task cancelled](task:${byOrchestrator}?event=cancelled)\n${CANCEL_NOTICE_INSTRUCTION}`,
  }]);
  const [notice] = f.store.read({ view: 'assignee_notices', task_id: byOrchestrator }).items;
  assert.equal(notice.kind, 'cancelled');
  assert.equal(notice.assignee, 'cancelled-worker');

  f.sent.length = 0;
  const byAssignee = await f.assigned('self-canceller');
  const self = await f.as('self-canceller', 'task_cancel', {
    task_id: byAssignee, write_context: f.store.task(byAssignee).write_context, reason: 'Stopping my own work',
  });
  assert.equal(self.error, null, JSON.stringify(self.error));
  assert.equal(self.result.notice_ids, undefined);
  assert.deepEqual(f.sent, []);
  assert.equal(f.store.read({ view: 'assignee_notices', task_id: byAssignee }).items.length, 0);
});

test('orchestrator reopen sends an update and leaves ACK pending while assignee reopen auto-ACKs silently', async t => {
  const f = fixture(t);
  const byOrchestrator = await f.assigned('reopen-worker');
  assert.equal((await f.as('reopen-worker', 'task_report', {
    ...f.context(byOrchestrator), status: 'done', outcome: { summary: 'Delivered' }, retro: null,
  })).error, null);
  f.sent.length = 0;
  const reopened = await f.as('orchestrator', 'task_reopen', {
    ...f.context(byOrchestrator), description: 'Rework', reason: 'User requested changes',
  });
  assert.equal(reopened.error, null, JSON.stringify(reopened.error));
  assert.equal(reopened.result.acknowledged_revision, 1);
  assert.deepEqual(f.sent, [{
    session: 'reopen-worker', mode: 'immediate',
    text: `[Task updated](task:${byOrchestrator}?event=updated)\n${UPDATE_NOTICE_INSTRUCTION}`,
  }]);
  assert.equal((await f.as('reopen-worker', 'task_read', { view: 'execution', task_id: byOrchestrator })).definition_check.tasks[0].needs_ack, true);

  const byAssignee = await f.assigned('self-reopener');
  assert.equal((await f.as('self-reopener', 'task_report', {
    ...f.context(byAssignee), status: 'done', outcome: { summary: 'Delivered' }, retro: null,
  })).error, null);
  f.sent.length = 0;
  const self = await f.as('self-reopener', 'task_reopen', {
    ...f.context(byAssignee), description: 'Self rework', reason: 'I found a gap',
  });
  assert.equal(self.error, null, JSON.stringify(self.error));
  assert.equal(self.result.acknowledged_revision, self.result.revision);
  assert.equal(self.result.notice_ids, undefined);
  assert.deepEqual(f.sent, []);
});

test('Web user cancel, reopen and edit send assignee notices without auto-ACKing', async t => {
  const f = fixture(t);
  const cancelled = await f.assigned('web-cancel-worker');
  const cancel = await f.as('user', 'task_cancel', {
    task_id: cancelled, write_context: f.store.task(cancelled).write_context, reason: 'User stopped it',
  });
  assert.equal(cancel.error, null, JSON.stringify(cancel.error));
  assert.deepEqual(f.sent, [{
    session: 'web-cancel-worker', mode: 'immediate',
    text: `[Task cancelled](task:${cancelled}?event=cancelled)\n${CANCEL_NOTICE_INSTRUCTION}`,
  }]);

  const reopened = await f.assigned('web-reopen-worker');
  assert.equal((await f.as('web-reopen-worker', 'task_report', {
    ...f.context(reopened), status: 'done', outcome: { summary: 'Delivered' }, retro: null,
  })).error, null);
  f.sent.length = 0;
  const webReopen = await f.as('user', 'task_reopen', {
    ...f.context(reopened), description: 'Rework from user', reason: 'User asked',
  });
  assert.equal(webReopen.error, null, JSON.stringify(webReopen.error));
  assert.equal(webReopen.result.acknowledged_revision, 1);
  assert.deepEqual(f.sent, [{
    session: 'web-reopen-worker', mode: 'immediate',
    text: `[Task updated](task:${reopened}?event=updated)\n${UPDATE_NOTICE_INSTRUCTION}`,
  }]);

  const edited = await f.assigned('web-edit-worker');
  const webEdit = await f.edit('user', edited, { description: 'Edited from Web board' });
  assert.equal(webEdit.error, null, JSON.stringify(webEdit.error));
  assert.equal(webEdit.result.acknowledged_revision, 1);
  assert.deepEqual(f.sent.at(-1), {
    session: 'web-edit-worker', mode: 'immediate',
    text: `[Task updated](task:${edited}?event=updated)\n${UPDATE_NOTICE_INSTRUCTION}`,
  });
});

test('update notice failures keep the saved edit and report notification_error', async t => {
  let exists = true;
  const f = fixture(t, { sessionExists: async () => exists });
  const id = await f.assigned();
  exists = false;
  const edited = await f.edit('orchestrator', id, { description: 'v2' });
  assert.equal(edited.error, null);
  assert.equal(edited.result.revision, 2);
  assert.equal(edited.notifications[0].notification.status, 'not_sent');
  assert.equal(edited.notification_error.code, 'ASSIGNEE_NOT_FOUND');
  assert.deepEqual(f.sent, []);
});

test('recoverNotifications does not expire a live assignee notice beyond its startup boundary', async t => {
  let releaseExists;
  const entered = [];
  const f = fixture(t, {
    sessionExists: async () => {
      entered.push(true);
      return new Promise(resolve => { releaseExists = resolve; });
    },
  });
  const id = await f.assigned('slow-worker');
  const editing = f.edit('orchestrator', id, { description: 'v2' });
  while (!entered.length) await new Promise(resolve => setImmediate(resolve));
  await f.service.recoverNotifications();
  await f.service.recoverNotifications();
  const pending = f.store.read({ view: 'assignee_notices', task_id: id }).items[0];
  assert.equal(pending.notification.status, 'pending');
  releaseExists(true);
  const edited = await editing;
  assert.equal(edited.error, null, JSON.stringify(edited.error));
  assert.equal(edited.notifications[0].notification.status, 'accepted');
  assert.deepEqual(f.sent, [{
    session: 'slow-worker', mode: 'immediate',
    text: `[Task updated](task:${id}?event=updated)\n${UPDATE_NOTICE_INSTRUCTION}`,
  }]);
});

test('an update notice left pending by a restart expires as not sent instead of arriving late', async t => {
  const f = fixture(t);
  const id = await f.assigned();
  const row = f.store.task(id);
  const noticeId = f.store.recordAssigneeNotice(f.store.row(id), { actor: 'orchestrator' }, new Date().toISOString());
  assert.equal(row.revision, 1);
  const service = f.restart();
  await service.recoverNotifications?.();
  await new Promise(resolve => setTimeout(resolve, 50));
  const notice = f.store.read({ view: 'assignee_notices', task_id: id }).items.find(item => item.notice_id === noticeId);
  assert.equal(notice.notification.status, 'not_sent');
  assert.equal(notice.notification.error.code, 'ASSIGNEE_NOTICE_EXPIRED');
  assert.deepEqual(f.sent, []);
});

test('a replay after restart never sends an assignee notice left pending by the earlier process', async t => {
  const f = fixture(t);
  const id = await f.assigned();
  const input = { actor: 'orchestrator', request_id: randomUUID(), ...f.context(id), reason: 'Important change', description: 'v2' };
  const saved = f.store.executeLocal('task_edit', input);
  assert.equal(saved.notice_ids.length, 1);
  const service = f.restart();
  const replay = await service.execute('task_edit', input);
  assert.equal(replay.error, null);
  assert.equal(replay.notifications[0].notification.status, 'not_sent');
  assert.equal(replay.notifications[0].notification.error.code, 'ASSIGNEE_NOTICE_EXPIRED');
  assert.deepEqual(f.sent, []);
});
