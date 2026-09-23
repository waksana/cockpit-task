import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../src/task-board/store.js';
import { TaskService } from '../src/task-board/service.js';
import { LIMITS } from '../src/task-board/contracts.js';

function fixture(t) {
  const root = join(process.cwd(), '.task-board-tests', randomUUID());
  mkdirSync(root, { recursive: true });
  const store = new TaskStore(root);
  const host = {
    ownerExists: async () => true,
    send: async () => ({ ok: true }),
    inspect: async () => ({ ready: true, idle: true, executor: true }),
  };
  const service = new TaskService(store, host, { report: () => {} });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const as = (actor, name, input) => service.execute(name, { actor_session_id: actor, request_id: randomUUID(), ...input });
  const context = id => ({ task_id: id, write_context: store.task(id).write_context, revision: store.task(id).revision });
  const f = {
    root, store, service,
    create: (owner, fields = {}) => as(owner, 'task_create', { owner, title: `Task by ${owner}`, description: 'Synthetic requirements', ...fields }),
    async start(owner, executor, fields) {
      const created = await f.create(owner, fields);
      assert.equal(created.error, null, JSON.stringify(created.error));
      const id = created.result.task_id;
      assert.equal((await as(owner, 'task_assign', { ...context(id), executor })).error, null);
      assert.equal((await as(executor, 'task_ack', context(id))).error, null);
      return id;
    },
    report: (executor, id, fields) => as(executor, 'task_report', { ...context(id), ...fields }),
  };
  return f;
}

test('Tasks created by an Owner executing its own Agent Task record it as parent, up to the level cap', async t => {
  const f = fixture(t);
  assert.equal(LIMITS.delegationDepth, 3);
  const root = await f.start('user-owner', 'lead');
  assert.equal(f.store.task(root).parent_task_id, null);
  assert.equal(f.store.task(root).depth, 1);

  const child = await f.start('lead', 'worker');
  assert.equal(f.store.task(child).parent_task_id, root);
  assert.equal(f.store.task(child).depth, 2);
  assert.equal(f.store.task(child).owner, 'lead', 'Child notices keep going to the direct parent Executor as Owner');

  const grandchild = await f.start('worker', 'specialist');
  assert.equal(f.store.task(grandchild).parent_task_id, child);
  assert.equal(f.store.task(grandchild).depth, 3);

  const rejected = await f.create('specialist');
  assert.equal(rejected.error.code, 'DELEGATION_DEPTH_EXCEEDED');
  assert.match(rejected.error.message, /limited to 3 levels/);
  assert.equal(f.store.read({ view: 'list', owner: 'specialist', status: 'all' }).items.length, 0, 'A rejected child is not saved');

  const children = f.store.read({ view: 'list', parent_task_id: root.toUpperCase(), status: 'all' }).items;
  assert.deepEqual(children.map(task => task.task_id), [child]);
  assert.equal(children[0].depth, 2);
  const overview = f.store.read({ view: 'overview', task_id: grandchild, include: ['context'] });
  assert.equal(overview.parent_task_id, child);
  assert.equal(overview.depth, 3);
});

test('Owners without an unfinished Agent assignment create top-level Tasks', async t => {
  const f = fixture(t);
  const earlier = await f.start('user-owner', 'lead');
  const done = await f.report('lead', earlier, { status: 'done', outcome: { summary: 'Delivered' }, retro: null });
  assert.equal(done.error, null);
  const after = await f.create('lead');
  assert.equal(after.error, null);
  assert.equal(f.store.task(after.result.task_id).parent_task_id, null);
  assert.equal(f.store.task(after.result.task_id).depth, 1);

  const unassigned = await f.create('user-owner');
  const other = await f.create('someone-else');
  assert.equal(f.store.task(unassigned.result.task_id).parent_task_id, null);
  assert.equal(f.store.task(other.result.task_id).parent_task_id, null);
});

test('a blocked parent still owns its children, and lineage survives the parent finishing', async t => {
  const f = fixture(t);
  const root = await f.start('user-owner', 'lead');
  assert.equal((await f.report('lead', root, { status: 'blocked', activity: { text: 'Waiting for children' } })).error, null);
  const child = await f.create('lead');
  assert.equal(f.store.task(child.result.task_id).parent_task_id, root);
  assert.equal((await f.report('lead', root, { status: 'done', outcome: { summary: 'Integrated' }, retro: null })).error, null);
  assert.equal(f.store.task(child.result.task_id).parent_task_id, root);
});

test('schema v6 databases migrate forward to v7 as top-level Tasks without inventing lineage', t => {
  const root = join(process.cwd(), '.task-board-tests', randomUUID());
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let store = new TaskStore(root);
  const task = store.executeLocal('task_create', { actor_session_id: 'owner', request_id: 'legacy', owner: 'owner', title: 'Legacy', description: 'Existing' });
  const receipts = store.db.prepare('SELECT * FROM operations').all();
  store.db.exec('DROP INDEX tasks_parent; ALTER TABLE tasks DROP COLUMN parent_task_id; ALTER TABLE tasks DROP COLUMN depth; PRAGMA user_version=6');
  store.close();
  const legacy = new DatabaseSync(join(root, 'task-board.sqlite'));
  assert.equal(legacy.prepare('PRAGMA user_version').get().user_version, 6);
  legacy.close();
  store = new TaskStore(root);
  try {
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 7);
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.deepEqual(store.db.prepare('SELECT * FROM operations').all(), receipts);
    const migrated = store.task(task.task_id);
    assert.equal(migrated.parent_task_id, null);
    assert.equal(migrated.depth, 1);
  } finally { store.close(); }
});
