import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { TaskStore } from '../src/task-board/store.js';
import { parseInput, TaskError, LIMITS } from '../src/task-board/contracts.js';

function fixture(t) {
  const directory = join(process.cwd(), '.task-board-tests', randomUUID());
  mkdirSync(directory, { recursive: true });
  let store = new TaskStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const input = (task, fields = {}) => ({
    request_id: randomUUID(), actor_session_id: 'owner', task_id: task.task_id,
    write_context: task.write_context, revision: task.revision, ...fields,
  });
  const create = (fields = {}) => store.executeLocal('task_create', {
    request_id: randomUUID(), actor_session_id: 'owner', owner: 'owner',
    title: 'Task', description: 'Complete definition', ...fields,
  });
  const bind = (task, executor = 'executor') => {
    const value = input(task, { executor });
    store.reserveOperation('task_assign', value);
    return store.bindAssignment(value);
  };
  const ack = task => store.executeLocal('task_ack', input(task, { actor_session_id: 'executor' }));
  const edit = (task, fields = {}) => store.executeLocal('task_edit', input(task, { reason: 'Clarified requirements', ...fields }));
  const report = (task, fields) => store.executeLocal('task_report', input(task, { actor_session_id: 'executor', ...fields }));
  return {
    get store() { return store; }, directory, input, create, bind, ack, edit, report,
    restart() { store.close(); store = new TaskStore(directory); },
  };
}
function rejects(fn, code) {
  assert.throws(fn, error => error instanceof TaskError && error.code === code);
}

test('independent durable database, initial definition and exact receipt replay', t => {
  const f = fixture(t), request_id = randomUUID();
  const first = f.create({ request_id });
  assert.deepEqual(f.create({ request_id }), first);
  assert.equal(first.revision, 1);
  assert.equal(first.task_status, 'todo');
  assert.equal(first.executor, null);
  assert.equal('description' in first, false);
  assert.equal(f.store.read({ view: 'changelog', task_id: first.task_id }).items.length, 1);
  assert.equal(f.store.read({ view: 'changelog', task_id: first.task_id, revision: 1 }).description, 'Complete definition');
  assert.ok(readdirSync(f.directory).includes('task-board.sqlite'));
  assert.equal(readdirSync(f.directory).some(x => x.startsWith('work-commander')), false);
  f.restart();
  assert.deepEqual(f.create({ request_id }), first);
  rejects(() => f.create({ request_id, title: 'different' }), 'REQUEST_ID_CONFLICT');
  assert.equal(f.store.read({ view: 'list' }).items.length, 1);
});

test('strict bounded schemas reject unknown identity fields, malformed JSON and invalid report', () => {
  const input = { request_id: 'id', actor_session_id: 'actor', owner: 'owner', title: 'Title', description: 'Definition' };
  for (const addition of [
    { executor: 'hidden' }, { status: 'done' }, { title: ' ' },
    { description: 'x'.repeat(24001) }, { metadata: { value: Infinity } },
    { metadata: { value: undefined } }, { metadata: { value: new Date() } },
    { metadata: { value: 'x'.repeat(8001) } },
  ]) rejects(() => parseInput('task_create', { ...input, ...addition }), 'INVALID_INPUT');
  const cycle = {}; cycle.self = cycle;
  rejects(() => parseInput('task_create', { ...input, metadata: cycle }), 'INVALID_INPUT');
  rejects(() => parseInput('task_create', { ...input, metadata: JSON.parse('{"__proto__":{"bad":true}}') }), 'INVALID_INPUT');
  rejects(() => parseInput('task_read', { view: 'list', limit: 51 }), 'INVALID_INPUT');
  rejects(() => parseInput('task_read', { view: 'overview', task_id: randomUUID(), cursor: 'x' }), 'INVALID_INPUT');
});

test('ACK is separate from activity/status and reported actor is not an ACL', t => {
  const f = fixture(t), task = f.bind(f.create());
  const ack = f.store.executeLocal('task_ack', f.input(task, { actor_session_id: 'other-session' }));
  assert.equal(ack.task_status, 'todo');
  assert.equal(ack.acknowledged_revision, 1);
  assert.equal(f.store.read({ view: 'activity', task_id: task.id }).items.length, 0);
  assert.equal(f.store.read({ view: 'changelog', task_id: task.id }).items.length, 1);
  assert.equal(f.ack(task).status, 'unchanged');
  const activity = f.report(task, { actor_session_id: 'cross-task-actor', activity: { text: 'Working' } });
  assert.equal(activity.activity.status, 'saved');
  const entry = f.store.read({ view: 'activity', task_id: task.id }).items[0];
  assert.equal(entry.author, 'cross-task-actor');
  assert.equal(entry.executor, 'executor');
  assert.equal(entry.source, 'reported');
});

test('own definition changes auto-ACK, no-op and metadata edits do not', t => {
  const f = fixture(t), task = f.bind(f.create());
  const title = f.edit(task, { title: 'Different', actor_session_id: 'executor' });
  assert.equal(title.revision, 1);
  assert.equal(title.acknowledged_revision, null);
  const noop = f.edit(title, { description: 'Complete definition', actor_session_id: 'executor' });
  assert.equal(noop.status, 'unchanged');
  assert.equal(noop.acknowledged_revision, null);
  const own = f.edit(title, { description: 'Version two', actor_session_id: 'executor' });
  assert.equal(own.revision, 2);
  assert.equal(own.acknowledged_revision, 2);
  const owner = f.edit(own, { description: 'Version three' });
  assert.equal(owner.acknowledged_revision, 2);
  rejects(() => f.report(owner, { revision: 1, activity: { text: 'Never acknowledged version one' } }), 'ACK_REQUIRED');
  assert.equal(f.report(owner, { revision: 2, activity: { text: 'Version two work' } }).activity.status, 'saved');
});

test('skipped ACK revision never authorizes activity, even after higher ACK', t => {
  const f = fixture(t);
  const one = f.ack(f.bind(f.create()));
  const two = f.edit(one, { description: 'Two' });
  const three = f.ack(f.edit(two, { description: 'Three' }));
  rejects(() => f.report(three, { revision: 2, activity: { text: 'Skipped version' } }), 'ACK_REQUIRED');
  assert.equal(f.report(three, { revision: 1, activity: { text: 'Actual version one work' } }).activity.revision, 1);
  rejects(() => f.report(three, { revision: 900, activity: { text: 'Unknown version' } }), 'ACK_REQUIRED');
});

test('stale mixed report saves only acknowledged activity and replay preserves partial effects', t => {
  const f = fixture(t), one = f.ack(f.bind(f.create()));
  const two = f.edit(one, { description: 'New requirements' });
  const input = f.input(one, { actor_session_id: 'executor', activity: { text: 'Old work' }, status: 'done', outcome: { summary: 'Old result' } });
  let partial;
  assert.throws(() => f.store.executeLocal('task_report', input), error => {
    partial = error.result;
    return error.code === 'DESCRIPTION_UPDATED' && partial.status === 'partially_applied';
  });
  assert.equal(partial.activity.status, 'saved');
  assert.equal(partial.task_status.status, 'rejected');
  assert.equal(partial.outcome.status, 'rejected');
  assert.equal(f.store.task(one.task_id).status, 'todo');
  assert.equal(f.store.read({ view: 'outcomes', task_id: one.task_id }).items.length, 0);
  f.ack(two);
  f.restart();
  assert.throws(() => f.store.executeLocal('task_report', input), error => {
    assert.deepEqual(error.result, partial);
    return error.code === 'DESCRIPTION_UPDATED';
  });
  assert.equal(f.store.read({ view: 'activity', task_id: one.task_id }).items.length, 1);
  assert.equal(f.store.definitionCheck({ task_id: one.task_id }).tasks[0].needs_ack, false);
});

test('stale status-only is rejected, stale activity-only succeeds without invented field failures', t => {
  const f = fixture(t), one = f.ack(f.bind(f.create()));
  f.edit(one, { description: 'Changed' });
  assert.throws(() => f.report(one, { status: 'in_progress' }), error => {
    assert.equal(error.result.status, 'rejected');
    assert.equal(error.result.activity.status, 'not_requested');
    return error.code === 'DESCRIPTION_UPDATED';
  });
  const only = f.report(one, { activity: { text: 'Old but acknowledged' } });
  assert.equal(only.status, 'applied');
  assert.equal(only.task_status.status, 'not_requested');
  assert.equal(only.outcome.status, 'not_requested');
});

test('non-staleness validation errors never partially save activity', t => {
  const f = fixture(t), task = f.ack(f.bind(f.create()));
  for (const fields of [
    { status: 'done' }, { status: 'cancelled' }, { outcome: { summary: '' } },
    { revision: 99 }, { write_context: 'not-a-context' },
  ]) {
    assert.throws(() => f.report(task, { activity: { text: 'Must not be saved' }, ...fields }), TaskError);
  }
  assert.equal(f.store.read({ view: 'activity', task_id: task.task_id }).items.length, 0);
  assert.equal(f.store.task(task.task_id).status, 'todo');
});

test('separate lifecycle/editable/revision generations protect only relevant dependencies', t => {
  const f = fixture(t), task = f.ack(f.bind(f.create()));
  f.report(task, { activity: { text: 'Does not invalidate context' } });
  const metadata = f.edit(task, { metadata: { environment: 'test' } });
  rejects(() => f.edit(task, { title: 'Overwrites newer materials' }), 'EDIT_CONFLICT');
  assert.equal(f.report(task, { activity: { text: 'Metadata irrelevant to activity' } }).status, 'applied');
  const definition = f.edit(metadata, { description: 'New definition' });
  assert.equal(f.report(task, { activity: { text: 'Description does not invalidate historical activity' } }).status, 'applied');
  const ack = f.ack(definition);
  const progress = f.report(ack, { status: 'in_progress' });
  rejects(() => f.report(ack, { activity: { text: 'Late lifecycle' } }), 'TASK_STATE_CONFLICT');
  rejects(() => f.edit(ack, { description: 'Late edit' }), 'TASK_STATE_CONFLICT');
  assert.equal(f.ack(progress).status, 'unchanged');
});

test('terminal Tasks reject execution and ACK, preserve outcomes and permit definition edits without ACK', t => {
  const f = fixture(t), task = f.ack(f.bind(f.create()));
  f.report(task, { outcome: { summary: 'Draft' } });
  rejects(() => f.report(task, { status: 'done', activity: { text: 'No fresh outcome' } }), 'INVALID_INPUT');
  const done = f.report(task, { status: 'done', outcome: { summary: 'Delivered' } });
  rejects(() => f.report(done, { activity: { text: 'Late' } }), 'TASK_STATE_CONFLICT');
  rejects(() => f.ack(done), 'TASK_STATE_CONFLICT');
  const { revision, ...cancel } = f.input(done, { reason: 'Cannot rewrite completion' });
  rejects(() => f.store.executeLocal('task_cancel', cancel), 'TASK_STATE_CONFLICT');
  const changed = f.edit(done, { description: 'Post-completion clarification', actor_session_id: 'executor' });
  assert.equal(changed.task_status, 'done');
  assert.equal(changed.revision, 2);
  assert.equal(changed.acknowledged_revision, 1);
  assert.equal(f.store.read({ view: 'overview', task_id: task.task_id }).outcome.current, false);
  assert.equal(f.store.read({ view: 'outcomes', task_id: task.task_id }).items.length, 2);
});

test('cancel needs no ACK, late reports cannot overwrite it, repeated cancel is unchanged', t => {
  const f = fixture(t), task = f.bind(f.create());
  const { revision, ...input } = f.input(task, { reason: 'User cancelled' });
  const cancelled = f.store.executeLocal('task_cancel', input);
  assert.equal(cancelled.task_status, 'cancelled');
  rejects(() => f.report(task, { status: 'in_progress' }), 'TASK_STATE_CONFLICT');
  rejects(() => f.report(cancelled, { activity: { text: 'Cancelled' } }), 'TASK_STATE_CONFLICT');
  const { revision: ignored, ...again } = f.input(cancelled, { reason: 'Already cancelled' });
  assert.equal(f.store.executeLocal('task_cancel', again).status, 'unchanged');
  assert.equal(f.store.read({ view: 'activity', task_id: task.id }).items.length, 0);
});

test('fixed Executor occupancy is durable, atomic across connections and released only by terminal status', t => {
  const f = fixture(t), first = f.bind(f.create());
  const other = new TaskStore(f.directory);
  t.after(() => other.close());
  const second = f.create(), input = f.input(second, { executor: 'executor' });
  other.reserveOperation('task_assign', input);
  rejects(() => other.bindAssignment(input), 'EXECUTOR_OCCUPIED');
  assert.equal(other.task(second.task_id).executor, null);
  const replace = f.input(first, { executor: 'replacement' });
  f.store.reserveOperation('task_assign', replace);
  rejects(() => f.store.bindAssignment(replace), 'ASSIGNMENT_CONFLICT');
  const { revision, ...cancel } = f.input(first, { reason: 'Release executor' });
  f.store.executeLocal('task_cancel', cancel);
  assert.equal(other.bindAssignment(input).executor, 'executor');
});

test('pending external receipts replay after restart and changed input conflicts', t => {
  const f = fixture(t), input = { request_id: 'external', actor_session_id: 'owner', cwd: '/synthetic' };
  assert.equal(f.store.reserveOperation('task_session_create', input).replay, false);
  f.restart();
  const replay = f.store.reserveOperation('task_session_create', input);
  assert.equal(replay.replay, true);
  assert.equal(replay.status, 'pending');
  assert.equal(replay.error.code, 'OPERATION_UNCONFIRMED');
  assert.equal(replay.result.operation.status, 'unconfirmed');
  rejects(() => f.store.reserveOperation('task_session_create', { ...input, cwd: '/other' }), 'REQUEST_ID_CONFLICT');
  f.store.saveOperation(input.request_id, { result: { operation: { session_id: 'known', creation: 'created' } } }, { final: false });
  assert.equal(f.store.read({ view: 'operation', request_id: input.request_id }).result.operation.session_id, 'known');
  f.store.saveOperation(input.request_id, { result: { operation: { status: 'applied', session_id: 'known' } } });
  rejects(() => f.store.saveOperation(input.request_id, { result: { changed: true } }), 'OPERATION_FINALIZED');
});

test('assignment commit stores binding facts atomically and rechecks revision/lifecycle before send', t => {
  const f = fixture(t), task = f.create(), input = f.input(task, { executor: 'executor' });
  f.store.reserveOperation('task_assign', input);
  const bound = f.store.bindAssignment(input);
  assert.equal(f.store.operation(input.request_id).result.operation.assignment, 'applied');
  assert.equal(f.store.dispatchPreflight(input).executor, 'executor');
  rejects(() => f.store.bindAssignment(input), 'ASSIGNMENT_CONFLICT');
  f.edit(bound, { description: 'Changed before dispatch' });
  rejects(() => f.store.dispatchPreflight(input), 'DESCRIPTION_UPDATED');
});

test('explicit dispatch recovery requires confirmed not-sent result and cannot consume it twice', t => {
  const f = fixture(t), task = f.create(), original = f.input(task, { executor: 'executor' });
  f.store.reserveOperation('task_assign', original);
  const bound = f.store.bindAssignment(original);
  const resume = f.input(bound, { executor: 'executor', resume_request_id: original.request_id });
  f.store.reserveOperation('task_assign', resume);
  rejects(() => f.store.bindAssignment(resume), 'UNSAFE_DISPATCH_RECOVERY');
  f.store.saveOperation(original.request_id, { result: { operation: { assignment: 'applied', message: 'not_sent', status: 'partially_applied' } } });
  assert.equal(f.store.bindAssignment(resume).executor, 'executor');
  assert.equal(f.store.dispatchPreflight(resume).executor, 'executor');
  const another = { ...resume, request_id: randomUUID() };
  f.store.reserveOperation('task_assign', another);
  rejects(() => f.store.bindAssignment(another), 'UNSAFE_DISPATCH_RECOVERY');
});

test('unknown, accepted and unexpectedly queued dispatches never authorize recovery', t => {
  const f = fixture(t);
  for (const message of ['unknown', 'accepted', 'queued']) {
    const task = f.create(), original = f.input(task, { executor: `executor-${message}` });
    f.store.reserveOperation('task_assign', original);
    const bound = f.store.bindAssignment(original);
    f.store.saveOperation(original.request_id, { result: { operation: { assignment: 'applied', message, status: 'unconfirmed' } } });
    const resume = f.input(bound, { executor: original.executor, resume_request_id: original.request_id });
    f.store.reserveOperation('task_assign', resume);
    rejects(() => f.store.bindAssignment(resume), 'UNSAFE_DISPATCH_RECOVERY');
  }
});

test('role-focused bounded views never attach full definitions, history or outcome to overview', t => {
  const f = fixture(t), task = f.ack(f.bind(f.create({ description: 'd'.repeat(24000), metadata: { environment: 'synthetic' } })));
  f.report(task, { activity: { text: 'a'.repeat(1000) }, outcome: { summary: 'o'.repeat(8000) } });
  const overview = f.store.read({ view: 'overview', task_id: task.task_id });
  assert.equal(overview.activity.text.length, 320);
  assert.equal(overview.activity.truncated, true);
  assert.equal(overview.outcome.available, true);
  for (const key of ['description', 'references', 'metadata']) assert.equal(key in overview, false);
  assert.equal('summary' in overview.outcome, false);
  const execution = f.store.read({ view: 'execution', task_id: task.task_id });
  assert.equal(execution.description.length, 24000);
  assert.equal(execution.metadata.environment, 'synthetic');
  assert.equal('activity' in execution, false);
  const changes = f.store.read({ view: 'changelog', task_id: task.task_id });
  assert.equal('description' in changes.items[0], false);
  assert.equal(changes.items[0].description_available, true);
});

test('opaque keyset pagination is stable under insertions and rejects task/filter/view mismatch', t => {
  const f = fixture(t);
  for (let n = 0; n < 23; n++) f.create({ title: `Task ${n}` });
  const first = f.store.read({ view: 'list' });
  assert.equal(first.items.length, 20);
  f.create({ title: 'Inserted later' });
  const next = f.store.read({ view: 'list', cursor: first.next_cursor });
  assert.equal(next.items.length, 3);
  assert.equal(next.next_cursor, null);
  assert.equal(new Set([...first.items, ...next.items].map(x => x.id)).size, 23);
  rejects(() => f.store.read({ view: 'list', owner: 'someone', cursor: first.next_cursor }), 'INVALID_CURSOR');
  rejects(() => f.store.read({ view: 'list', cursor: 'malformed' }), 'INVALID_CURSOR');
  const a = f.ack(f.bind(f.create())), b = f.create();
  for (let n = 0; n < 3; n++) f.report(a, { activity: { text: `${n}` } });
  const page = f.store.read({ view: 'activity', task_id: a.task_id, limit: 1 });
  rejects(() => f.store.read({ view: 'activity', task_id: b.task_id, cursor: page.next_cursor }), 'INVALID_CURSOR');
  rejects(() => f.store.read({ view: 'outcomes', task_id: a.task_id, cursor: page.next_cursor }), 'INVALID_CURSOR');
  assert.equal(f.store.read({ view: 'activity', task_id: a.task_id, cursor: page.next_cursor }).items.length, 2);
});

test('list defaults unfinished, filters are explicit and never interpreted as actor authorization', t => {
  const f = fixture(t), unfinished = f.create({ owner: 'other' }), ended = f.create();
  const { revision, ...cancel } = f.input(ended, { reason: 'Ended' });
  f.store.executeLocal('task_cancel', cancel);
  assert.equal(f.store.read({ view: 'list', actor_session_id: 'unrelated' }).items.length, 1);
  assert.equal(f.store.read({ view: 'list', owner: 'other' }).items[0].id, unfinished.task_id);
  assert.equal(f.store.read({ view: 'list', status: 'cancelled' }).items[0].id, ended.task_id);
  assert.equal(f.store.read({ view: 'list', status: 'all' }).items.length, 2);
  assert.equal(f.store.read({ view: 'list', query: '%' }).items.length, 0);
});

test('definition check covers related Task and actors current Task; missing definitions report unavailable', t => {
  const f = fixture(t), a = f.bind(f.create()), b = f.create();
  const result = f.store.definitionCheck({ task_id: b.task_id, actor_session_id: 'executor' });
  assert.equal(result.status, 'checked');
  assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks.find(x => x.task_id === a.id).needs_ack, true);
  assert.equal(result.tasks.find(x => x.task_id === b.task_id).needs_ack, false);
  f.ack(a);
  assert.equal(f.store.definitionCheck({ actor_session_id: 'executor' }).tasks[0].needs_ack, false);
  assert.equal(f.store.definitionCheck({ task_id: randomUUID(), actor_session_id: 'executor' }).status, 'unavailable');
  assert.equal(f.store.definitionCheck({ actor_session_id: 'none' }).status, 'not_applicable');
});

test('failed business receipts are final and cannot later become newly applied effects', t => {
  const f = fixture(t), task = f.bind(f.create());
  const report = f.input(task, { activity: { text: 'Not acknowledged yet' } });
  rejects(() => f.store.executeLocal('task_report', report), 'ACK_REQUIRED');
  f.ack(task);
  rejects(() => f.store.executeLocal('task_report', report), 'ACK_REQUIRED');
  assert.equal(f.store.read({ view: 'activity', task_id: task.id }).items.length, 0);
  assert.equal(f.store.operation(report.request_id).status, 'final');
});

test('serialized history pages enforce aggregate budget and retain every remainder through cursors', t => {
  const f = fixture(t), task = f.ack(f.bind(f.create()));
  const references = Array.from({ length: 4 }, (_, i) => ({ label: `${i}`, target: 'r'.repeat(1500) }));
  for (let i = 0; i < 6; i++) {
    f.report(task, { activity: { text: '"'.repeat(4000) }, outcome: { summary: 'o'.repeat(8000), references } });
  }
  for (const view of ['activity', 'outcomes']) {
    const ids = [];
    let cursor;
    let pages = 0;
    do {
      const page = f.store.read({ view, task_id: task.task_id, limit: 10, ...(cursor ? { cursor } : {}) });
      assert.ok(JSON.stringify(page).length <= LIMITS.page);
      ids.push(...page.items.map(item => item.id));
      cursor = page.next_cursor;
      pages++;
    } while (cursor);
    assert.ok(pages > 1);
    assert.equal(ids.length, 6);
    assert.equal(new Set(ids).size, 6);
  }
  let current = task;
  for (let i = 0; i < 4; i++) current = f.edit(current, { description: `Definition ${i}`, reason: '\0'.repeat(1999) + 'r' });
  const revisions = [];
  let cursor;
  do {
    const page = f.store.read({ view: 'changelog', task_id: task.task_id, limit: 10, ...(cursor ? { cursor } : {}) });
    assert.ok(JSON.stringify(page).length <= LIMITS.page);
    revisions.push(...page.items.map(item => item.revision));
    cursor = page.next_cursor;
  } while (cursor);
  assert.deepEqual(revisions, [5, 4, 3, 2, 1]);
});

test('list pages respect serialized budget rather than multiplying large summaries by limit', t => {
  const f = fixture(t);
  for (let i = 0; i < 50; i++) f.create({ title: '"'.repeat(240), owner: '\0'.repeat(200) });
  let cursor;
  const ids = [];
  do {
    const page = f.store.read({ view: 'list', limit: 50, ...(cursor ? { cursor } : {}) });
    assert.ok(JSON.stringify(page).length <= LIMITS.page);
    assert.ok(page.items.length < 50);
    ids.push(...page.items.map(item => item.id));
    cursor = page.next_cursor;
  } while (cursor);
  assert.equal(new Set(ids).size, 50);
  assert.equal(ids.length, 50);
});

test('combined definition and report payload bounds account for JSON escaping without truncation', t => {
  const f = fixture(t);
  const description = '\0'.repeat(10000);
  const task = f.create({ description });
  assert.equal(f.store.read({ view: 'definition', task_id: task.task_id }).description, description);
  assert.ok(JSON.stringify(f.store.read({ view: 'definition', task_id: task.task_id })).length < 80000);
  rejects(() => f.edit(task, { metadata: { data: 'm'.repeat(5000) } }), 'INVALID_INPUT');
  assert.deepEqual(f.store.task(task.task_id).metadata, {});
  rejects(() => f.create({ description: '\0'.repeat(24000) }), 'INVALID_INPUT');
  const assigned = f.ack(f.bind(task));
  rejects(() => f.report(assigned, { activity: { text: '\0'.repeat(4000) } }), 'INVALID_INPUT');
  rejects(() => f.report(assigned, { outcome: { summary: '\0'.repeat(8000) } }), 'INVALID_INPUT');
  assert.equal(f.store.read({ view: 'activity', task_id: task.task_id }).items.length, 0);
});
