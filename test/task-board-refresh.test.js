import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activate } from '../src/task-board/module.js';
import { cardSummary, createReadResource } from '../web/task-board/index.js';

test('real module mutations refresh only their shared frontend identity; receipt replay does not reread', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-refresh-integration-'));
  const controller = new AbortController();
  const listeners = new Set(), invalidations = new Set(), events = [], reads = [], errors = [];
  const module = activate({
    apiVersion: 1, serviceReadyVersion: 1, moduleId: 'cockpit-task', dataRoot: root,
    signal: controller.signal,
    host: { call: async name => assert.fail(`Unexpected native operation: ${name}`) },
    publish(event) { events.push(event); for (const listener of listeners) listener(event); },
    invalidate() { for (const listener of invalidations) listener(); },
    report: error => errors.push(error),
  });
  const write = (name, body) => module.routes.find(route => route.path === '/tools/:name').handler({
    params: { name }, body, signal: controller.signal,
  });
  const context = {
    signal: controller.signal,
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    onInvalidate(listener) { invalidations.add(listener); return () => invalidations.delete(listener); },
    async request(path, init) {
      assert.equal(path, '/read');
      const body = JSON.parse(init.body);
      reads.push(body);
      const reply = await module.routes.find(route => route.path === '/read').handler({ body, signal: init.signal });
      return Response.json(reply.body, { status: reply.status });
    },
  };
  try {
    const create = title => write('task_create', { request_id: `create-${title}`, title, description: 'Synthetic integration only.' });
    const first = (await create('First')).body.result;
    const other = (await create('Other')).body.result;
    const query = { view: 'overview', task_id: first.task_id };
    const card = createReadResource(context, query);
    const duplicate = createReadResource(context, { task_id: first.task_id, view: 'overview' });
    const unrelated = createReadResource(context, { view: 'overview', task_id: other.task_id });
    const detail = createReadResource(context, { view: 'execution', task_id: first.task_id });
    assert.equal(card, duplicate);
    card.start(); duplicate.start(); unrelated.start(); detail.start();
    await Promise.all([card.refresh(), unrelated.refresh(), detail.refresh()]);
    assert.equal(reads.length, 3);
    assert.equal(card.getSnapshot().data.activity_count, 0);
    assert.deepEqual(card.getSnapshot().data.sessions, { orchestrator: null, assignee: null });
    const initialVersion = card.getSnapshot().data.data_version;
    const before = reads.length;
    const edit = {
      task_id: first.task_id, request_id: 'edit-first', revision: 1, write_context: first.write_context,
      title: 'Changed title', reason: 'Exercise actual committed publication.',
    };
    assert.equal((await write('task_edit', edit)).body.error, null);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reads.slice(before).map(read => read.task_id), [first.task_id, first.task_id]);
    assert.equal(card.getSnapshot().data.title, 'Changed title');
    assert.equal(detail.getSnapshot().data.title, 'Changed title');
    assert.notEqual(card.getSnapshot().data.data_version, initialVersion);
    assert.equal(events.at(-1).data_version, card.getSnapshot().data.data_version);
    const after = reads.length, eventCount = events.length;
    assert.equal((await write('task_edit', edit)).body.error, null);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(events.length, eventCount);
    assert.equal(reads.length, after);
    const cancelled = await write('task_cancel', {
      task_id: first.task_id, request_id: 'cancel-first', reason: 'Authorization withdrawn',
      write_context: detail.getSnapshot().data.write_context,
    });
    assert.equal(cancelled.body.error, null);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(detail.getSnapshot().data.cancellation.reason, 'Authorization withdrawn');
    assert.equal(cardSummary(detail.getSnapshot().data), 'Authorization withdrawn');
    const afterCancellation = reads.length;
    card.stop(); duplicate.stop(); detail.stop();
    createReadResource(context, query).start();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads.length, afterCancellation, 'Remount must reuse the real module read');
    assert.deepEqual(errors, []);
  } finally {
    controller.abort();
    module.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
