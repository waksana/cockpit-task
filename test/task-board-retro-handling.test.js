import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TaskStore } from '../src/task-board/store.js';
import { TaskService } from '../src/task-board/service.js';
import { parseInput } from '../src/task-board/contracts.js';

function fixture(t) {
  const root = join(process.cwd(), '.task-board-tests', randomUUID());
  mkdirSync(root, { recursive: true });
  let store = new TaskStore(root);
  const sent = [];
  const host = {
    sessionExists: async () => true,
    send: async (session, text) => { sent.push({ session, text }); return { ok: true }; },
    inspect: async () => ({ ready: true, idle: true, node: true }),
  };
  let service = new TaskService(store, host, { report: () => {} });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const as = (actor, name, input) => f.service.execute(name, { actor: actor, request_id: randomUUID(), ...input });
  const context = id => ({ task_id: id, write_context: f.store.task(id).write_context, revision: f.store.task(id).revision });
  const f = {
    root, sent, as, context,
    get store() { return store; },
    get service() { return service; },
    restart() { service.close(); store = new TaskStore(root); service = new TaskService(store, host, { report: () => {} }); },
    async start(orchestrator, assignee) {
      const created = await as(orchestrator, 'task_create', { title: `Task by ${orchestrator}`, description: 'Synthetic requirements' });
      assert.equal(created.error, null, JSON.stringify(created.error));
      const id = created.result.task_id;
      assert.equal((await as(orchestrator, 'task_assign', { ...context(id), assignee })).error, null);
      assert.equal((await as(assignee, 'task_ack', context(id))).error, null);
      return id;
    },
    async finish(assignee, id, retro) {
      const done = await as(assignee, 'task_report', { ...context(id), status: 'done', outcome: { summary: 'Delivered' }, retro });
      assert.equal(done.error, null, JSON.stringify(done.error));
      return done.result.outcome.id;
    },
    handle: (actor, id, outcome_id, fields) => as(actor, 'task_retro_handle', { task_id: id, outcome_id, ...fields }),
    list: fields => store.read({ view: 'list', orchestrator: 'orchestrator', ...fields }).items.map(item => item.id),
  };
  return f;
}

test('the Orchestrator records fixed, followup, watching and dismissed handling on the latest retro with append-only history', async t => {
  const f = fixture(t);
  const id = await f.start('orchestrator', 'worker');
  const outcomeId = await f.finish('worker', id, 'Fresh worktrees lack node_modules');
  assert.deepEqual(f.store.read({ view: 'overview', task_id: id }).retro.handling, { status: 'unhandled' });

  const watching = await f.handle('orchestrator', id, outcomeId, { status: 'watching', note: 'Seen once; decide if it repeats' });
  assert.equal(watching.error, null, JSON.stringify(watching.error));
  assert.equal(watching.result.status, 'applied');
  assert.equal(watching.result.handling.status, 'watching');
  assert.equal(watching.notifications, undefined);
  assert.equal(f.sent.length, 1, 'Only the assignment card was sent; handling sends nothing');
  assert.equal(f.store.task(id).status, 'done');

  const followup = await f.handle('orchestrator', id, outcomeId, {
    status: 'followup', note: 'Add an install step to github-coding',
    references: [{ label: 'Follow-up', target: 'task:11111111-1111-4111-8111-111111111111' }],
  });
  assert.equal(followup.error, null);
  const summary = f.store.read({ view: 'overview', task_id: id }).retro.handling;
  assert.deepEqual(Object.keys(summary).sort(), ['at', 'author', 'id', 'status']);
  assert.equal(summary.status, 'followup');
  const full = f.store.read({ view: 'overview', task_id: id, include: ['retro'] }).retro;
  assert.equal(full.handling.note, 'Add an install step to github-coding');
  assert.equal(full.handling.references[0].target, 'task:11111111-1111-4111-8111-111111111111');
  assert.equal(full.handling.author, 'orchestrator');
  assert.equal(f.store.task(id).retro.handling.status, 'followup');

  const same = await f.handle('orchestrator', id, outcomeId, {
    status: 'followup', note: 'Add an install step to github-coding',
    references: [{ label: 'Follow-up', target: 'task:11111111-1111-4111-8111-111111111111' }],
  });
  assert.equal(same.result.status, 'unchanged');
  assert.equal((await f.handle('orchestrator', id, outcomeId, { status: 'fixed', note: 'Fixed in #81', references: [{ label: 'PR', target: 'https://example.invalid/pr/81' }] })).error, null);
  assert.equal((await f.handle('orchestrator', id, outcomeId, { status: 'dismissed', note: 'Not reproducible' })).error, null);
  const history = f.store.read({ view: 'retro_handlings', task_id: id, limit: 10 });
  assert.deepEqual(history.items.map(item => item.status), ['dismissed', 'fixed', 'followup', 'watching']);
  assert.ok(history.items.every(item => item.outcome_id === outcomeId));
  const outcomes = f.store.read({ view: 'outcomes', task_id: id }).items;
  assert.equal(outcomes[0].retro.handling.status, 'dismissed');
});

test('any caller may handle a recorded retro that has findings', async t => {
  const f = fixture(t);
  const id = await f.start('orchestrator', 'worker');
  const outcomeId = await f.finish('worker', id, 'Finding');
  const code = async (result, expected) => assert.equal((await result).error?.code, expected);
  assert.equal((await f.handle('worker', id, outcomeId, { status: 'fixed', note: 'I fixed my own finding' })).error, null);
  assert.equal((await f.handle('someone', id, outcomeId, { status: 'dismissed', note: 'Reviewed by another session' })).error, null);
  await code(f.handle('orchestrator', id, randomUUID(), { status: 'fixed', note: 'x' }), 'RETRO_NOT_FOUND');
  await code(f.handle('orchestrator', id, outcomeId, { status: 'followup', note: 'x' }), 'INVALID_INPUT');
  await code(f.handle('orchestrator', id, outcomeId, { status: 'done', note: 'x' }), 'INVALID_INPUT');
  await code(f.handle('orchestrator', id, outcomeId, { status: 'fixed', note: ' ' }), 'INVALID_INPUT');
  assert.throws(() => parseInput('task_retro_handle', { actor: 'orchestrator', request_id: 'r', task_id: id, outcome_id: outcomeId, status: 'fixed', note: 'x', write_context: 'x' }));

  const empty = await f.start('orchestrator', 'quiet');
  const nullOutcome = await f.finish('quiet', empty, null);
  assert.equal(f.store.read({ view: 'overview', task_id: empty }).retro.handling, undefined, 'No handling is needed without findings');
  await code(f.handle('orchestrator', empty, nullOutcome, { status: 'dismissed', note: 'x' }), 'RETRO_NO_FINDINGS');

  const pending = await f.as('orchestrator', 'task_create', { title: 'Not done', description: 'Synthetic' });
  await code(f.handle('orchestrator', pending.result.task_id, randomUUID(), { status: 'fixed', note: 'x' }), 'RETRO_NOT_FOUND');
});

test('reopened delivery needs its own handling while the old handling stays in history', async t => {
  const f = fixture(t);
  const id = await f.start('orchestrator', 'worker');
  const first = await f.finish('worker', id, 'First finding');
  assert.equal((await f.handle('orchestrator', id, first, { status: 'fixed', note: 'Fixed' })).error, null);
  const reopened = await f.as('worker', 'task_reopen', { ...f.context(id), description: 'Rework', reason: 'User asked for rework' });
  assert.equal(reopened.error, null, JSON.stringify(reopened.error));
  const second = await f.finish('worker', id, 'Second finding');
  assert.deepEqual(f.store.read({ view: 'overview', task_id: id }).retro.handling, { status: 'unhandled' });
  assert.equal((await f.handle('orchestrator', id, second, { status: 'watching', note: 'Watch' })).error, null);
  let [latest, previous] = f.store.read({ view: 'outcomes', task_id: id }).items;
  assert.equal(latest.retro.handling.status, 'watching');
  assert.equal(previous.retro.handling.status, 'fixed');
  assert.equal((await f.handle('orchestrator', id, first, { status: 'dismissed', note: 'Old finding superseded' })).error, null, 'An older retro stays handleable by outcome_id');
  [latest, previous] = f.store.read({ view: 'outcomes', task_id: id }).items;
  assert.equal(latest.retro.handling.status, 'watching');
  assert.equal(previous.retro.handling.status, 'dismissed');
});

test('list filters find unhandled and watching retros across statuses without automation', async t => {
  const f = fixture(t);
  const unhandled = await f.start('orchestrator', 'a');
  await f.finish('a', unhandled, 'Needs handling');
  const watched = await f.start('orchestrator', 'b');
  const watchedOutcome = await f.finish('b', watched, 'Watch me');
  await f.handle('orchestrator', watched, watchedOutcome, { status: 'watching', note: 'Watching' });
  const fixed = await f.start('orchestrator', 'c');
  const fixedOutcome = await f.finish('c', fixed, 'Fixed');
  await f.handle('orchestrator', fixed, fixedOutcome, { status: 'watching', note: 'Watching first' });
  await f.handle('orchestrator', fixed, fixedOutcome, { status: 'fixed', note: 'Then fixed' });
  const quiet = await f.start('orchestrator', 'd');
  await f.finish('d', quiet, null);
  await f.start('orchestrator', 'e');

  assert.deepEqual(f.list({ retro: 'unhandled' }), [unhandled]);
  assert.deepEqual(f.list({ retro: 'watching' }), [watched]);
  assert.deepEqual(f.list({ retro: 'unhandled', status: 'unfinished' }), []);
  assert.deepEqual(f.store.read({ view: 'list', orchestrator: 'other', retro: 'unhandled' }).items, []);
  const listed = f.store.read({ view: 'list', orchestrator: 'orchestrator', status: 'done' }).items.find(item => item.id === watched);
  assert.equal(listed.retro.handling.status, 'watching');
  assert.equal('note' in listed.retro.handling, false);
  assert.throws(() => parseInput('task_read', { view: 'list', retro: 'fixed' }));

  const page = f.store.read({ view: 'list', orchestrator: 'orchestrator', retro: 'unhandled', limit: 1 });
  assert.equal(page.next_cursor, null);
  const all = f.store.read({ view: 'list', orchestrator: 'orchestrator', status: 'all', limit: 1 });
  assert.throws(() => f.store.read({ view: 'list', orchestrator: 'orchestrator', retro: 'unhandled', status: 'all', cursor: all.next_cursor }), error => error.code === 'INVALID_CURSOR');
});

test('retro handling survives restart without backfilling completed outcomes', async t => {
  const f = fixture(t);
  const id = await f.start('orchestrator', 'worker');
  await f.finish('worker', id, 'Legacy finding');
  f.restart();
  assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version, 9);
  assert.deepEqual(f.store.read({ view: 'overview', task_id: id }).retro.handling, { status: 'unhandled' });
  const outcomeId = f.store.task(id).retro.outcome_id;
  assert.equal((await f.handle('orchestrator', id, outcomeId, { status: 'dismissed', note: 'Legacy' })).error, null);
  f.restart();
  assert.equal(f.store.task(id).retro.handling.status, 'dismissed');
});
