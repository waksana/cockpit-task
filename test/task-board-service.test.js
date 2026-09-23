import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/task-board/store.js';
import { TaskService } from '../src/task-board/service.js';

function fixture(host = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'task-board-service-'));
  const store = new TaskStore(directory);
  const sent = [];
  const reports = [];
  const service = new TaskService(store, {
    create: async () => ({ sessionId: 'executor' }),
    inspect: async () => ({ ready: true, idle: true }),
    send: async (id, text) => { sent.push({ id, text }); return { ok: true, queued: false }; },
    ...host,
  }, { report: error => reports.push(error) });
  let sequence = 0;
  const write = (name, input, actor = 'owner') => service.execute(name, {
    request_id: `request-${++sequence}`, actor_session_id: actor, ...input,
  });
  return {
    directory, store, service, sent, reports, write,
    async create() {
      const result = await write('task_create', { owner: 'owner', title: 'Synthetic Task', description: 'Complete the work' });
      assert.equal(result.error, null);
      return store.task(result.result.task_id);
    },
    close() { service.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('Task service integrates assignment, ACK, revision reminders and partial reporting', async () => {
  const f = fixture();
  try {
    const task = await f.create();
    const assigned = await f.write('task_assign', {
      task_id: task.id, executor: 'executor', revision: 1, write_context: task.write_context,
    });
    assert.equal(assigned.error, null);
    assert.equal(assigned.result.operation.message, 'accepted');
    assert.match(assigned.definition_check.tasks[0].message, /Awaiting the assigned Executor's acknowledgement/);
    assert.doesNotMatch(assigned.definition_check.tasks[0].message, /read it and acknowledge it/);
    assert.equal(f.sent.length, 1);
    const bound = f.store.task(task.id);
    const ack = await f.write('task_ack', { task_id: task.id, revision: 1, write_context: bound.write_context }, 'executor');
    assert.equal(ack.result.task_status, 'todo');
    await f.write('task_report', { task_id: task.id, revision: 1, write_context: bound.write_context, status: 'in_progress' }, 'executor');
    const current = f.store.task(task.id);
    await f.write('task_edit', { task_id: task.id, revision: 1, write_context: current.write_context, description: 'Updated complete work', reason: 'Clarified scope' });
    const report = {
      request_id: 'old-activity', actor_session_id: 'executor', task_id: task.id,
      revision: 1, write_context: current.write_context,
      activity: { text: 'Work performed before the update' }, status: 'done', outcome: { summary: 'Old result' }, retro: null,
    };
    const partial = await f.service.execute('task_report', report);
    assert.equal(partial.error.code, 'DESCRIPTION_UPDATED');
    assert.match(partial.error.message, /acknowledgement belongs to the assigned Executor/);
    assert.equal(partial.definition_check.tasks[0].needs_ack, true);
    assert.match(partial.definition_check.tasks[0].message, /changed; awaiting the assigned Executor's acknowledgement/);
    assert.equal(f.store.task(task.id).status, 'in_progress');
    const updated = f.store.task(task.id);
    await f.write('task_ack', { task_id: task.id, revision: 2, write_context: updated.write_context }, 'executor');
    const replay = await f.service.execute('task_report', report);
    assert.deepEqual(replay.result, partial.result);
    assert.equal(replay.definition_check.tasks[0].needs_ack, false);
    assert.equal(f.store.read({ view: 'activity', task_id: task.id }).items.length, 1);
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.reports, []);
  } finally { f.close(); }
});

test('failed dispatch observations survive restart and replay without becoming live status', async () => {
  const details = {
    reasons: [], loaded: true, status: 'idle', availability_reasons: ['queued_messages', 'pending_plan'],
    observed_at: '2026-09-21T00:00:00.000Z',
  };
  const f = fixture({ inspect: async () => ({ ready: true, idle: false, details }) });
  let replacement;
  try {
    const task = await f.create();
    const request = {
      request_id: 'busy-receipt', actor_session_id: 'owner', task_id: task.id,
      revision: 1, executor: 'executor', write_context: task.write_context,
    };
    const first = await f.service.execute('task_assign', request);
    assert.equal(first.error.code, 'EXECUTOR_NOT_READY');
    assert.deepEqual(first.result.operation.details, details);
    assert.equal(first.result.operation.assignment, 'not_applied');
    assert.equal(first.result.operation.message, 'not_sent');
    assert.equal(f.store.task(task.id).executor, null);
    f.service.close();
    replacement = new TaskService(new TaskStore(f.directory), {
      inspect: () => assert.fail('Receipt replay must not inspect current availability'),
      send: () => assert.fail('Receipt replay must not send'),
    });
    const replay = await replacement.execute('task_assign', request);
    assert.deepEqual(replay.result, first.result);
    const read = await replacement.execute('task_read', {
      view: 'operation', request_id: request.request_id, actor_session_id: 'owner',
    });
    assert.deepEqual(read.result.result.operation.details, details);
    assert.equal(f.sent.length, 0);
  } finally { replacement?.close(); f.close(); }
});

test('unknown dispatch stays unknown across service restart and cannot be resent', async () => {
  let sends = 0;
  const f = fixture({ send: async () => { sends++; throw new Error('Network response lost'); } });
  let replacement;
  try {
    const task = await f.create();
    const request = { request_id: 'unknown-send', actor_session_id: 'owner', task_id: task.id, revision: 1, executor: 'executor', write_context: task.write_context };
    const first = await f.service.execute('task_assign', request);
    assert.equal(first.result.operation.message, 'unknown');
    f.service.close();
    replacement = new TaskService(new TaskStore(f.directory), {
      inspect: () => assert.fail('replay must not inspect'), send: () => assert.fail('replay must not send'),
    });
    const replay = await replacement.execute('task_assign', request);
    assert.equal(replay.result.operation.message, 'unknown');
    assert.equal(replay.error.code, 'OPERATION_UNCONFIRMED');
    assert.equal(sends, 1);
    const operation = await replacement.execute('task_read', { view: 'operation', request_id: 'unknown-send' });
    assert.equal(operation.definition_check.tasks[0].task_id, task.id);
  } finally { replacement?.close(); f.close(); }
});

test('a confirmed not-sent assignment can resume explicitly without rebinding', async () => {
  let reads = 0;
  const f = fixture({ inspect: async () => ({ ready: true, idle: ++reads !== 2 }) });
  try {
    const task = await f.create();
    const first = await f.service.execute('task_assign', {
      request_id: 'not-sent', actor_session_id: 'owner', task_id: task.id,
      executor: 'executor', revision: 1, write_context: task.write_context,
    });
    assert.equal(first.result.operation.message, 'not_sent');
    assert.equal(first.result.operation.assignment, 'applied');
    const bound = f.store.task(task.id);
    const resumed = await f.write('task_assign', {
      task_id: task.id, executor: 'executor', revision: 1,
      write_context: bound.write_context, resume_request_id: 'not-sent',
    });
    assert.equal(resumed.error, null);
    assert.equal(resumed.result.operation.message, 'accepted');
    assert.equal(f.sent.length, 1);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM task_assignments WHERE task_id=?').get(task.id).n, 1);
  } finally { f.close(); }
});

test('failed-operation reads retain their Task and check its current definition after restart', async () => {
  const f = fixture();
  let replacement;
  try {
    const task = await f.create();
    await f.write('task_assign', { task_id: task.id, executor: 'executor', revision: 1, write_context: task.write_context });
    const bound = f.store.task(task.id);
    const failed = await f.service.execute('task_report', {
      request_id: 'report-before-ack', actor_session_id: 'executor', task_id: task.id,
      revision: 1, write_context: bound.write_context, status: 'in_progress',
    });
    assert.equal(failed.error.code, 'ACK_REQUIRED');
    assert.equal(failed.result, null);
    const read = { view: 'operation', request_id: 'report-before-ack', actor_session_id: 'owner' };
    const operation = await f.service.execute('task_read', read);
    assert.equal(operation.error, null);
    assert.equal(operation.result.task_id, task.id);
    assert.equal(operation.result.result, null);
    assert.equal(operation.result.error.code, 'ACK_REQUIRED');
    assert.equal(operation.definition_check.status, 'checked');
    assert.equal(operation.definition_check.tasks[0].task_id, task.id);
    assert.equal(operation.definition_check.tasks[0].needs_ack, true);

    await f.write('task_ack', { task_id: task.id, revision: 1, write_context: bound.write_context }, 'executor');
    const acknowledged = await f.service.execute('task_read', read);
    assert.equal(acknowledged.result.error.code, 'ACK_REQUIRED');
    assert.equal(acknowledged.definition_check.tasks[0].needs_ack, false);
    await f.write('task_edit', {
      task_id: task.id, revision: 1, write_context: bound.write_context,
      description: 'New complete requirements', reason: 'Scope clarified',
    });
    f.service.close();
    replacement = new TaskService(new TaskStore(f.directory), {});
    const restored = await replacement.execute('task_read', read);
    assert.deepEqual(restored.result, operation.result);
    assert.equal(restored.definition_check.tasks[0].revision, 2);
    assert.equal(restored.definition_check.tasks[0].needs_ack, true);
    assert.deepEqual(f.reports, []);
  } finally { replacement?.close(); f.close(); }
});

test('business validation failures and unrelated reads still check the acting Executor Task', async () => {
  const f = fixture();
  try {
    const task = await f.create();
    await f.write('task_assign', { task_id: task.id, executor: 'executor', revision: 1, write_context: task.write_context });
    const failure = await f.service.execute('task_report', {
      actor_session_id: 'executor', task_id: task.id, request_id: 'malformed',
      write_context: f.store.task(task.id).write_context, revision: 1, status: 'done', retro: null,
    });
    assert.equal(failure.error.code, 'INVALID_INPUT');
    assert.equal(failure.definition_check.tasks[0].needs_ack, true);
    const list = await f.service.execute('task_read', { view: 'list', owner: 'unrelated', actor_session_id: 'executor' });
    assert.equal(list.result.items.length, 0);
    assert.equal(list.definition_check.tasks[0].task_id, task.id);
  } finally { f.close(); }
});

test('module close drains admitted external calls, persists their outcome and rejects new work', async () => {
  let finish;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = fixture({
    create: async () => { entered(); return new Promise(resolve => { finish = resolve; }); },
  });

  try {
    const pending = f.write('task_session_create', { cwd: '/synthetic' });
    await started;
    f.service.close();
    const rejected = await f.service.execute('task_read', { view: 'list' });
    assert.equal(rejected.error.code, 'MODULE_CLOSING');
    finish({ sessionId: 'executor' });
    const completed = await pending;
    assert.equal(completed.result.operation.creation, 'created');
    const reopened = new TaskStore(f.directory);
    try { assert.equal(reopened.operation('request-1').result.operation.creation, 'created'); }
    finally { reopened.close(); }
  } finally { f.close(); }
});

test('Task storage is private and a newer schema is rejected rather than overwritten', () => {
  const f = fixture();
  try {
    assert.equal(statSync(join(f.directory, 'task-board.sqlite')).mode & 0o777, 0o600);
    f.service.close();
    const future = new DatabaseSync(join(f.directory, 'task-board.sqlite'));
    future.exec('PRAGMA user_version=8');
    future.close();
    assert.throws(() => new TaskStore(f.directory), error => error.code === 'SCHEMA_TOO_NEW');
    const unchanged = new DatabaseSync(join(f.directory, 'task-board.sqlite'));
    try { assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 8); }
    finally { unchanged.close(); }
  } finally { f.close(); }
});
