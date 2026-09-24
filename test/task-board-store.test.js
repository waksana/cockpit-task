import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../src/task-board/store.js';
import { parseInput, TaskError, LIMITS, READ_GROUPS, toolSchemas } from '../src/task-board/contracts.js';

function fixture(t) {
  const directory = join(process.cwd(), '.task-board-tests', randomUUID());
  mkdirSync(directory, { recursive: true });
  let store = new TaskStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const input = (task, fields = {}) => ({
    request_id: randomUUID(), actor: 'orchestrator', task_id: task.task_id,
    write_context: task.write_context, revision: task.revision, ...fields,
  });
  const create = (fields = {}) => store.executeLocal('task_create', {
    request_id: randomUUID(), actor: 'orchestrator',
    title: 'Task', description: 'Complete definition', ...fields,
  });
  const bind = (task, assignee = 'assignee') => {
    const value = input(task, { assignee });
    store.reserveOperation('task_assign', value);
    return store.bindAssignment(value);
  };
  const ack = task => store.executeLocal('task_ack', input(task, { actor: 'assignee' }));
  const edit = (task, fields = {}) => store.executeLocal('task_edit', input(task, { reason: 'Clarified requirements', ...fields }));
  const report = (task, fields) => store.executeLocal('task_report', input(task, { actor: 'assignee', ...fields }));
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
  assert.equal(first.assignee, null);
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

test('offline data-root relocation preserves Task IDs, contexts, receipts and session bindings without row migration', t => {
  const root = join(process.cwd(), '.task-board-tests', randomUUID());
  const source = join(root, 'task-board');
  const destination = join(root, 'cockpit-task');
  let store = new TaskStore(source);
  t.after(() => { store?.close(); rmSync(root, { recursive: true, force: true }); });
  const createInput = {
    request_id: randomUUID(), actor: 'original-orchestrator',
    title: 'Identity preservation', description: 'Keep user-authored task-board references unchanged.',
  };
  const created = store.executeLocal('task_create', createInput);
  const assignInput = {
    request_id: randomUUID(), actor: 'original-orchestrator', task_id: created.task_id,
    assignee: 'original-assignee', revision: created.revision, write_context: created.write_context,
  };
  store.reserveOperation('task_assign', assignInput);
  const assigned = store.bindAssignment(assignInput);
  const before = store.read({ view: 'execution', task_id: created.task_id });
  const receipts = store.db.prepare('SELECT * FROM operations ORDER BY request_id').all();
  store.close();
  store = null;
  renameSync(source, destination);
  store = new TaskStore(destination);
  assert.deepEqual(store.read({ view: 'execution', task_id: created.task_id }), before);
  assert.deepEqual(store.db.prepare('SELECT * FROM operations ORDER BY request_id').all(), receipts);
  assert.deepEqual(store.executeLocal('task_create', createInput), created);
  const acknowledged = store.executeLocal('task_ack', {
    request_id: randomUUID(), actor: 'original-assignee',
    task_id: created.task_id, revision: assigned.revision, write_context: assigned.write_context,
  });
  assert.equal(acknowledged.task_id, created.task_id);
  assert.equal(acknowledged.assignee, 'original-assignee');
  assert.ok(readdirSync(destination).includes('task-board.sqlite'));
});

test('strict bounded schemas reject unknown identity fields, malformed JSON and invalid report', () => {
  const input = { request_id: 'id', title: 'Title', description: 'Definition' };
  for (const addition of [
    { actor: 'actor' }, { actor_session_id: 'actor' }, { orchestrator: 'orchestrator' },
    { assignee: 'hidden' }, { status: 'done' }, { title: ' ' },
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

test('overview include has a strict, unique, bounded allowlist shared by store and MCP schemas', () => {
  const base = { view: 'overview', task_id: randomUUID(), include: ['context'] };
  assert.deepEqual(parseInput('task_read', base), base);
  assert.deepEqual(toolSchemas.task_read.parse({ ...base, include: [...READ_GROUPS] }).include, READ_GROUPS);
  for (const fields of [
    { include: [] }, { include: ['context', 'context'] }, { include: ['status'] },
    { include: ['*'] }, { include: ['log'] }, { include: ['activity.text'] },
    { include: READ_GROUPS.concat('context') }, { include: 'activity' }, { include: null },
    { cursor: 'cursor' }, { limit: 1 }, { offset: 0 }, { revision: 1 }, { fields: ['status'] },
    ...['list', 'execution', 'definition', 'changelog', 'activity', 'outcomes', 'subscriptions', 'automation_log', 'operation']
      .map(view => ({ view })),
  ]) {
    const input = { ...base, ...fields };
    rejects(() => parseInput('task_read', input), 'INVALID_INPUT');
    assert.equal(toolSchemas.task_read.safeParse(input).success, false);
  }
});

test('selected overview returns only requested full latest records, distinguishing absence from explicit null', t => {
  const f = fixture(t), task = f.bind(f.create());
  const read = include => f.store.read({ view: 'overview', task_id: task.id, include });
  const empty = read([...READ_GROUPS]);
  assert.equal(empty.activity, null);
  assert.equal(empty.outcome, null);
  assert.equal(empty.automation, null);
  assert.equal(empty.cancellation, null);
  assert.deepEqual(empty.retro, { status: 'not_recorded' });
  assert.equal(empty.definition.description, 'Complete definition');
  assert.equal(empty.definition.revision, 1);
  assert.equal(empty.definition.author, 'orchestrator');
  assert.equal(empty.definition.source, 'reported');
  assert.ok(empty.definition.at);
  assert.equal(f.store.task(task.id).acknowledged_revision, null, 'Reading never ACKs');
  f.ack(task);
  const text = 'Full activity beyond the overview excerpt. '.repeat(85);
  f.report(task, { activity: { text: 'Earlier report' }, outcome: { summary: 'Earlier outcome' } });
  const blocked = f.report(task, { status: 'blocked', activity: { text } });
  const selected = read(['activity', 'outcome']);
  assert.equal(selected.status, 'blocked');
  assert.equal(selected.write_context, blocked.write_context);
  assert.equal(selected.activity.text, text);
  assert.equal(selected.activity.current, true);
  assert.equal(selected.activity.source, 'reported');
  assert.equal(selected.activity.assignee, 'assignee');
  assert.equal(selected.activity.author, 'assignee');
  assert.ok(selected.activity.at);
  assert.equal('truncated' in selected.activity, false);
  assert.equal(selected.outcome.summary, 'Earlier outcome');
  assert.equal('retro' in selected.outcome, false);
  for (const key of ['retro', 'definition', 'description', 'automation', 'cancellation']) assert.equal(key in selected, false);
  const legacy = f.store.read({ view: 'overview', task_id: task.id });
  assert.equal(legacy.activity.text.length, LIMITS.excerpt);
  assert.equal(legacy.activity.truncated, true);
  assert.equal(legacy.outcome.available, true);
  assert.equal('summary' in legacy.outcome, false);
  assert.deepEqual(legacy.retro, { status: 'not_recorded' });
  f.report(blocked, { status: 'done', outcome: { summary: 'Delivered', references: [{ label: 'PR', target: 'https://example.invalid/pr/1' }] }, retro: null });
  const done = read(['outcome', 'retro']);
  assert.equal(done.status, 'done');
  assert.equal(done.outcome.summary, 'Delivered');
  assert.deepEqual(done.outcome.references, [{ label: 'PR', target: 'https://example.invalid/pr/1' }]);
  assert.equal(done.outcome.current, true);
  assert.equal(done.retro.status, 'recorded');
  assert.equal(done.retro.text, null);
  assert.equal(done.retro.has_findings, false);
  assert.equal(done.retro.outcome_id, done.outcome.id);
  const context = read(['context']);
  assert.deepEqual(Object.keys(context).sort(), [
    'id', 'task_id', 'title', 'orchestrator', 'assignee', 'status', 'revision', 'acknowledged_revision',
    'created_at', 'updated_at', 'write_context', 'kind', 'parent_task_id', 'depth', 'blocked_by', 'ready',
  ].sort());
  assert.equal(context.status, 'done');
  f.edit(context, { description: 'Revised after completion' });
  const revised = read(['activity', 'outcome', 'retro', 'definition']);
  assert.equal(revised.revision, 2);
  for (const key of ['activity', 'outcome', 'retro']) {
    assert.equal(revised[key].revision, 1);
    assert.equal(revised[key].current, false, `${key} must not claim to satisfy the revised requirements`);
  }
  assert.equal(revised.definition.revision, 2);
  assert.equal(revised.definition.description, 'Revised after completion');
  assert.equal(revised.definition.current, true);
  rejects(() => f.store.read({ view: 'overview', task_id: randomUUID(), include: ['context'] }), 'TASK_NOT_FOUND');
});

test('selected cancellation is explicit and current Task context never implies an outcome', t => {
  const f = fixture(t), task = f.create();
  const { revision, ...input } = f.input(task, { reason: 'No longer required' });
  f.store.executeLocal('task_cancel', input);
  const selected = f.store.read({ view: 'overview', task_id: task.task_id, include: ['cancellation', 'outcome'] });
  assert.equal(selected.status, 'cancelled');
  assert.equal(selected.outcome, null);
  assert.equal(selected.cancellation.reason, 'No longer required');
});

test('selection uses one SQLite read snapshot even when another connection commits new requirements and reports', t => {
  const f = fixture(t), task = f.bind(f.create());
  f.ack(task);
  f.report(task, { activity: { text: 'Revision one' }, outcome: { summary: 'Revision one result' } });
  const other = new TaskStore(f.directory);
  const prepare = f.store.db.prepare.bind(f.store.db);
  let changed = false;
  f.store.db.prepare = sql => {
    const statement = prepare(sql);
    if (!changed && sql.includes('FROM tasks WHERE id=?')) {
      const get = statement.get.bind(statement);
      statement.get = (...args) => {
        const row = get(...args);
        changed = true;
        const current = other.executeLocal('task_edit', f.input(task, {
          actor: 'assignee', reason: 'New requirement', description: 'Revision two',
        }));
        other.executeLocal('task_report', f.input(current, {
          actor: 'assignee', status: 'done', activity: { text: 'Revision two' },
          outcome: { summary: 'Revision two result' }, retro: 'New finding',
        }));
        return row;
      };
    }
    return statement;
  };
  try {
    const selected = f.store.read({ view: 'overview', task_id: task.id, include: ['activity', 'outcome', 'retro', 'definition'] });
    assert.equal(changed, true);
    assert.equal(selected.revision, 1);
    assert.equal(selected.status, 'todo');
    assert.equal(selected.activity.text, 'Revision one');
    assert.equal(selected.activity.current, true);
    assert.equal(selected.outcome.summary, 'Revision one result');
    assert.equal(selected.outcome.current, true);
    assert.deepEqual(selected.retro, { status: 'not_recorded' });
    assert.equal(selected.definition.description, 'Complete definition');
    assert.equal(f.store.task(task.id).revision, 2);
    assert.equal(f.store.task(task.id).status, 'done');
  } finally {
    f.store.db.prepare = prepare;
    other.close();
  }
});

test('selection does not load unrequested bodies or histories, including definition_check', t => {
  const f = fixture(t), task = f.create();
  const prepare = f.store.db.prepare.bind(f.store.db), queries = [];
  f.store.db.prepare = sql => { queries.push(sql); return prepare(sql); };
  f.store.read({ view: 'overview', task_id: task.task_id, include: ['context'] });
  f.store.definitionCheck({ task_id: task.task_id, actor: 'orchestrator' });
  // Context includes the compact dependency projection: one bounded blocker-status query.
  assert.equal(queries.length, 3);
  assert.match(queries[1], /FROM task_dependencies d/);
  for (const query of queries) assert.doesNotMatch(query, /\*|description|refs|metadata|activities|outcomes|automation_runs|cancellation/);
  queries.length = 0;
  f.store.read({ view: 'overview', task_id: task.task_id, include: ['retro'] });
  assert.equal(queries.length, 3);
  assert.match(queries[2], /retro_recorded=1 ORDER BY seq DESC LIMIT 1/);
  assert.doesNotMatch(queries[2], /\*|summary|refs/);
});

test('selection budget includes JSON escaping and fails explicitly without truncating valid definitions', t => {
  const f = fixture(t);
  const task = f.create({ description: '\u0001'.repeat(9000) });
  const before = f.store.read({ view: 'definition', task_id: task.task_id });
  assert.throws(() => f.store.read({ view: 'overview', task_id: task.task_id, include: ['definition', 'activity'] }), error => {
    assert.equal(error.code, 'RESULT_TOO_LARGE');
    assert.equal(error.status, 413);
    assert.equal(error.result.max_characters, LIMITS.selection);
    assert.ok(error.result.serialized_characters > LIMITS.selection);
    assert.ok(error.result.group_characters.definition > LIMITS.selection);
    assert.deepEqual(error.result.include, ['definition', 'activity']);
    assert.equal('definition' in error.result, false);
    return true;
  });
  assert.deepEqual(f.store.read({ view: 'definition', task_id: task.task_id }), before);
  assert.equal(f.store.read({ view: 'overview', task_id: task.task_id, include: ['context'] }).revision, 1);
});

test('notification-sized selection fits large legal activity, outcome and retro without a second read', t => {
  const f = fixture(t), task = f.bind(f.create());
  f.ack(task);
  const activity = { text: '\u0001'.repeat(2600) };
  const outcome = { summary: '\u0001'.repeat(600) };
  const retro = '\u0001'.repeat(2000);
  f.report(task, { status: 'done', activity, outcome, retro });
  const selected = f.store.read({ view: 'overview', task_id: task.id, include: ['activity', 'outcome', 'retro'] });
  assert.equal(selected.activity.text, activity.text);
  assert.equal(selected.outcome.summary, outcome.summary);
  assert.equal(selected.retro.text, retro);
  assert.ok(JSON.stringify(selected).length < LIMITS.selection);
});

test('ACK is separate from activity/status and reported actor is not an ACL', t => {
  const f = fixture(t), task = f.bind(f.create());
  const ack = f.store.executeLocal('task_ack', f.input(task, { actor: 'other-session' }));
  assert.equal(ack.task_status, 'todo');
  assert.equal(ack.acknowledged_revision, 1);
  assert.equal(f.store.read({ view: 'activity', task_id: task.id }).items.length, 0);
  assert.equal(f.store.read({ view: 'changelog', task_id: task.id }).items.length, 1);
  assert.equal(f.ack(task).status, 'unchanged');
  const activity = f.report(task, { actor: 'cross-task-actor', activity: { text: 'Working' } });
  assert.equal(activity.activity.status, 'saved');
  const entry = f.store.read({ view: 'activity', task_id: task.id }).items[0];
  assert.equal(entry.author, 'cross-task-actor');
  assert.equal(entry.assignee, 'assignee');
  assert.equal(entry.source, 'reported');
});

test('own definition changes auto-ACK, no-op and metadata edits do not', t => {
  const f = fixture(t), task = f.bind(f.create());
  const title = f.edit(task, { title: 'Different', actor: 'assignee' });
  assert.equal(title.revision, 1);
  assert.equal(title.acknowledged_revision, null);
  const noop = f.edit(title, { description: 'Complete definition', actor: 'assignee' });
  assert.equal(noop.status, 'unchanged');
  assert.equal(noop.acknowledged_revision, null);
  const own = f.edit(title, { description: 'Version two', actor: 'assignee' });
  assert.equal(own.revision, 2);
  assert.equal(own.acknowledged_revision, 2);
  const orchestrator = f.edit(own, { description: 'Version three' });
  assert.equal(orchestrator.acknowledged_revision, 2);
  rejects(() => f.report(orchestrator, { revision: 1, activity: { text: 'Never acknowledged version one' } }), 'ACK_REQUIRED');
  assert.equal(f.report(orchestrator, { revision: 2, activity: { text: 'Version two work' } }).activity.status, 'saved');
});

test('definition reminders describe Assignee ACK responsibility without instructing Orchestrator to ACK', t => {
  const f = fixture(t), task = f.bind(f.create());
  for (const actor of ['orchestrator', 'assignee', 'observer']) {
    const check = f.store.definitionCheck({ task_id: task.id, actor }).tasks[0];
    assert.equal(check.needs_ack, true);
    assert.match(check.message, /Awaiting the assignee's acknowledgement/);
  }
  const acknowledged = f.ack(task);
  assert.equal(f.store.definitionCheck({ task_id: task.id, actor: 'orchestrator' }).tasks[0].message, undefined);
  const changed = f.edit(acknowledged, { description: 'Updated requirements' });
  const check = f.store.definitionCheck({ task_id: task.id, actor: 'orchestrator' }).tasks[0];
  assert.match(check.message, /changed; awaiting the assignee's acknowledgement/);
  assert.throws(() => f.edit(acknowledged, { description: 'Stale Orchestrator edit' }), error => {
    assert.equal(error.code, 'DESCRIPTION_UPDATED');
    assert.match(error.message, /read the current definition before retrying/);
    assert.doesNotMatch(error.message, /acknowledge/i);
    return true;
  });
  const { revision, ...cancel } = f.input(changed, { reason: 'User cancelled' });
  f.store.executeLocal('task_cancel', cancel);
  assert.equal(f.store.definitionCheck({ task_id: task.id, actor: 'orchestrator' }).tasks[0].message, undefined);
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
  const input = f.input(one, { actor: 'assignee', activity: { text: 'Old work' }, status: 'done', outcome: { summary: 'Old result' }, retro: null });
  let partial;
  assert.throws(() => f.store.executeLocal('task_report', input), error => {
    partial = error.result;
    return error.code === 'DESCRIPTION_UPDATED' && partial.status === 'partially_applied';
  });
  assert.equal(partial.activity.status, 'saved');
  assert.equal(partial.task_status.status, 'rejected');
  assert.equal(partial.outcome.status, 'rejected');
  assert.equal(partial.retro.status, 'rejected');
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
  const done = f.report(task, { status: 'done', outcome: { summary: 'Delivered' }, retro: null });
  rejects(() => f.report(done, { activity: { text: 'Late' } }), 'TASK_STATE_CONFLICT');
  rejects(() => f.ack(done), 'TASK_STATE_CONFLICT');
  const { revision, ...cancel } = f.input(done, { reason: 'Cannot rewrite completion' });
  rejects(() => f.store.executeLocal('task_cancel', cancel), 'TASK_STATE_CONFLICT');
  const changed = f.edit(done, { description: 'Post-completion clarification', actor: 'assignee' });
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

test('fixed Assignee occupancy is durable, atomic across connections and released only by terminal status', t => {
  const f = fixture(t), first = f.bind(f.create());
  const other = new TaskStore(f.directory);
  t.after(() => other.close());
  const second = f.create(), input = f.input(second, { assignee: 'assignee' });
  other.reserveOperation('task_assign', input);
  rejects(() => other.bindAssignment(input), 'ASSIGNEE_OCCUPIED');
  assert.equal(other.task(second.task_id).assignee, null);
  const replace = f.input(first, { assignee: 'replacement' });
  f.store.reserveOperation('task_assign', replace);
  rejects(() => f.store.bindAssignment(replace), 'ASSIGNMENT_CONFLICT');
  const { revision, ...cancel } = f.input(first, { reason: 'Release assignee' });
  f.store.executeLocal('task_cancel', cancel);
  assert.equal(other.bindAssignment(input).assignee, 'assignee');
});

test('pending external receipts replay after restart and changed input conflicts', t => {
  const f = fixture(t), input = { request_id: 'external', actor: 'orchestrator', cwd: '/synthetic' };
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
  const f = fixture(t), task = f.create(), input = f.input(task, { assignee: 'assignee' });
  f.store.reserveOperation('task_assign', input);
  const bound = f.store.bindAssignment(input);
  assert.equal(f.store.operation(input.request_id).result.operation.assignment, 'applied');
  assert.equal(f.store.dispatchPreflight(input).assignee, 'assignee');
  rejects(() => f.store.bindAssignment(input), 'ASSIGNMENT_CONFLICT');
  f.edit(bound, { description: 'Changed before dispatch' });
  rejects(() => f.store.dispatchPreflight(input), 'DESCRIPTION_UPDATED');
});

test('explicit dispatch recovery requires confirmed not-sent result and cannot consume it twice', t => {
  const f = fixture(t), task = f.create(), original = f.input(task, { assignee: 'assignee' });
  f.store.reserveOperation('task_assign', original);
  const bound = f.store.bindAssignment(original);
  const resume = f.input(bound, { assignee: 'assignee', resume_request_id: original.request_id });
  f.store.reserveOperation('task_assign', resume);
  rejects(() => f.store.bindAssignment(resume), 'UNSAFE_DISPATCH_RECOVERY');
  f.store.saveOperation(original.request_id, { result: { operation: { assignment: 'applied', message: 'not_sent', status: 'partially_applied' } } });
  assert.equal(f.store.bindAssignment(resume).assignee, 'assignee');
  assert.equal(f.store.dispatchPreflight(resume).assignee, 'assignee');
  const another = { ...resume, request_id: randomUUID() };
  f.store.reserveOperation('task_assign', another);
  rejects(() => f.store.bindAssignment(another), 'UNSAFE_DISPATCH_RECOVERY');
});

test('unknown, accepted and unexpectedly queued dispatches never authorize recovery', t => {
  const f = fixture(t);
  for (const message of ['unknown', 'accepted', 'queued']) {
    const task = f.create(), original = f.input(task, { assignee: `assignee-${message}` });
    f.store.reserveOperation('task_assign', original);
    const bound = f.store.bindAssignment(original);
    f.store.saveOperation(original.request_id, { result: { operation: { assignment: 'applied', message, status: 'unconfirmed' } } });
    const resume = f.input(bound, { assignee: original.assignee, resume_request_id: original.request_id });
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
  rejects(() => f.store.read({ view: 'list', orchestrator: 'someone', cursor: first.next_cursor }), 'INVALID_CURSOR');
  rejects(() => f.store.read({ view: 'list', cursor: 'malformed' }), 'INVALID_CURSOR');
  const a = f.ack(f.bind(f.create())), b = f.create();
  for (let n = 0; n < 3; n++) f.report(a, { activity: { text: `${n}` } });
  const page = f.store.read({ view: 'activity', task_id: a.task_id, limit: 1 });
  rejects(() => f.store.read({ view: 'activity', task_id: b.task_id, cursor: page.next_cursor }), 'INVALID_CURSOR');
  rejects(() => f.store.read({ view: 'outcomes', task_id: a.task_id, cursor: page.next_cursor }), 'INVALID_CURSOR');
  assert.equal(f.store.read({ view: 'activity', task_id: a.task_id, cursor: page.next_cursor }).items.length, 2);
});

test('list defaults unfinished, filters are explicit and never interpreted as actor authorization', t => {
  const f = fixture(t), unfinished = f.create({ actor: 'other' }), ended = f.create();
  const { revision, ...cancel } = f.input(ended, { reason: 'Ended' });
  f.store.executeLocal('task_cancel', cancel);
  assert.equal(f.store.read({ view: 'list', actor: 'unrelated' }).items.length, 1);
  assert.equal(f.store.read({ view: 'list', orchestrator: 'other' }).items[0].id, unfinished.task_id);
  assert.equal(f.store.read({ view: 'list', status: 'cancelled' }).items[0].id, ended.task_id);
  assert.equal(f.store.read({ view: 'list', status: 'all' }).items.length, 2);
  assert.equal(f.store.read({ view: 'list', query: '%' }).items.length, 0);
});

test('definition check covers related Task and actors current Task; missing definitions report unavailable', t => {
  const f = fixture(t), a = f.bind(f.create()), b = f.create();
  const result = f.store.definitionCheck({ task_id: b.task_id, actor: 'assignee' });
  assert.equal(result.status, 'checked');
  assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks.find(x => x.task_id === a.id).needs_ack, true);
  assert.equal(result.tasks.find(x => x.task_id === b.task_id).needs_ack, false);
  f.ack(a);
  assert.equal(f.store.definitionCheck({ actor: 'assignee' }).tasks[0].needs_ack, false);
  assert.equal(f.store.definitionCheck({ task_id: randomUUID(), actor: 'assignee' }).status, 'unavailable');
  assert.equal(f.store.definitionCheck({ actor: 'none' }).status, 'not_applicable');
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
  for (let i = 0; i < 50; i++) f.create({ title: '"'.repeat(240), actor: '\0'.repeat(200) });
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

test('completion requires fresh explicit retro and rejects invalid reports before any effects', t => {
  const f = fixture(t), task = f.ack(f.bind(f.create()));
  const base = { status: 'done', outcome: { summary: 'Delivered' }, activity: { text: 'Must not partially save' } };
  for (const retro of [undefined, '', ' \n\t', 0, false, {}, [], 'r'.repeat(LIMITS.retro + 1)]) {
    const input = f.input(task, { ...base, ...(retro === undefined ? {} : { retro }) });
    rejects(() => parseInput('task_report', input), 'INVALID_INPUT');
    rejects(() => f.store.executeLocal('task_report', input), 'INVALID_INPUT');
    rejects(() => f.store.report(input), 'INVALID_INPUT');
  }
  for (const status of [undefined, 'in_progress', 'blocked', 'in_review']) {
    rejects(() => f.report(task, { status, retro: null, outcome: { summary: 'Not completion' } }), 'INVALID_INPUT');
  }
  assert.equal(f.store.task(task.task_id).status, 'todo');
  assert.deepEqual(f.store.task(task.task_id).retro, { status: 'not_recorded' });
  assert.equal(f.store.read({ view: 'activity', task_id: task.task_id }).items.length, 0);
  assert.equal(f.store.read({ view: 'outcomes', task_id: task.task_id }).items.length, 0);
  f.report(task, { outcome: { summary: 'Prior result is not a completion' } });
  rejects(() => f.report(task, { status: 'done', retro: null }), 'INVALID_INPUT');
  rejects(() => f.report(task, { status: 'done', outcome: { summary: 'Fresh but missing retro' } }), 'INVALID_INPUT');
});

test('text and explicit null retro survive restart, exact replay and later definition edits', t => {
  const f = fixture(t);
  for (const text of ['Automate the repeated deterministic fixture setup.', null, 'r'.repeat(LIMITS.retro)]) {
    const task = f.ack(f.bind(f.create()));
    const request = f.input(task, { actor: 'assignee', status: 'done', outcome: { summary: 'Delivered' }, retro: text });
    const done = f.store.executeLocal('task_report', request);
    assert.equal(done.retro.status, 'saved');
    assert.equal(done.retro.outcome_id, done.outcome.id);
    const expected = {
      status: 'recorded', text, revision: 1, assignee: 'assignee', author: 'assignee', source: 'reported',
      outcome_id: done.outcome.id, current: true, has_findings: text !== null,
      ...(text !== null ? { handling: { status: 'unhandled' } } : {}),
    };
    const retro = f.store.task(task.task_id).retro;
    assert.ok(Number.isFinite(Date.parse(retro.at)));
    assert.deepEqual(retro, { ...expected, at: retro.at });
    for (const view of ['execution', 'definition']) {
      assert.deepEqual(f.store.read({ view, task_id: task.task_id }).retro, retro);
    }
    assert.deepEqual(f.store.read({ view: 'outcomes', task_id: task.task_id }).items[0].retro, retro);
    const overview = f.store.read({ view: 'overview', task_id: task.task_id }).retro;
    assert.equal('text' in overview, false);
    assert.equal(overview.has_findings, text !== null);
    const listed = f.store.read({ view: 'list', status: 'done' }).items.find(item => item.id === task.task_id);
    assert.deepEqual(listed.retro, overview);
    f.restart();
    assert.deepEqual(f.store.executeLocal('task_report', request), done);
    assert.deepEqual(f.store.task(task.task_id).retro, retro);
    rejects(() => f.store.executeLocal('task_report', { ...request, retro: 'Different retrospective' }), 'REQUEST_ID_CONFLICT');
    rejects(() => f.report(done, { status: 'done', outcome: { summary: 'Repeat completion' }, retro: null }), 'TASK_STATE_CONFLICT');
    rejects(() => f.report(done, { status: 'done', outcome: { summary: 'Prior retro cannot satisfy a new request' } }), 'INVALID_INPUT');
    const updated = f.edit(done, { description: 'Later clarification' });
    assert.equal(updated.revision, 2);
    for (const retro of [
      f.store.task(task.task_id).retro,
      f.store.read({ view: 'outcomes', task_id: task.task_id }).items[0].retro,
    ]) {
      assert.equal(retro.current, false);
      assert.equal(retro.revision, 1);
      assert.equal(retro.text, text);
    }
    assert.deepEqual(f.store.executeLocal('task_report', request), done);
    assert.equal(f.store.read({ view: 'outcomes', task_id: task.task_id }).items.length, 1);
  }
});

test('completion transaction rolls back outcome, retro, activity and subscriptions on status failure', t => {
  const f = fixture(t), task = f.ack(f.bind(f.create()));
  const { revision, ...subscriptionInput } = f.input(task, { statuses: ['done'] });
  f.store.executeLocal('task_subscribe', subscriptionInput);
  f.store.db.exec(`CREATE TRIGGER fail_completion BEFORE UPDATE OF status ON tasks
    WHEN NEW.status='done' BEGIN SELECT RAISE(ABORT, 'synthetic completion failure'); END`);
  const request = f.input(task, { status: 'done', outcome: { summary: 'Delivered' }, retro: 'A useful finding', activity: { text: 'Final work' } });
  assert.throws(() => f.store.executeLocal('task_report', request), /synthetic completion failure/);
  assert.equal(f.store.task(task.task_id).status, 'todo');
  assert.deepEqual(f.store.task(task.task_id).retro, { status: 'not_recorded' });
  assert.equal(f.store.read({ view: 'outcomes', task_id: task.task_id }).items.length, 0);
  assert.equal(f.store.read({ view: 'activity', task_id: task.task_id }).items.length, 0);
  assert.equal(f.store.read({ view: 'subscriptions', task_id: task.task_id }).items[0].state, 'waiting');
  rejects(() => f.store.operation(request.request_id), 'OPERATION_NOT_FOUND');
  f.store.db.exec('DROP TRIGGER fail_completion');
  assert.equal(f.store.executeLocal('task_report', request).retro.status, 'saved');
  assert.equal(f.store.read({ view: 'subscriptions', task_id: task.task_id }).items[0].state, 'triggered');
});

test('competing stores preserve one completion and reject changed lifecycle or unacknowledged revisions', t => {
  const f = fixture(t), task = f.bind(f.create());
  const fields = { status: 'done', outcome: { summary: 'Delivered' }, retro: null };
  rejects(() => f.report(task, fields), 'ACK_REQUIRED');
  f.ack(task);
  const other = new TaskStore(f.directory);
  t.after(() => other.close());
  const input = f.input(task, { ...fields, retro: 'Winner retrospective' });
  f.store.executeLocal('task_report', input);
  assert.equal(other.task(task.task_id).retro.text, input.retro);
  rejects(() => other.executeLocal('task_report', f.input(task, fields)), 'TASK_STATE_CONFLICT');
  assert.equal(other.read({ view: 'outcomes', task_id: task.task_id }).items.length, 1);
});

test('completion payload bounds retain every full history entry including escaped retro', t => {
  const f = fixture(t), task = f.ack(f.bind(f.create()));
  const text = '\0'.repeat(1999) + 'r';
  rejects(() => f.report(task, { status: 'done', outcome: { summary: 's'.repeat(8000) }, retro: text }), 'INVALID_INPUT');
  for (let i = 0; i < 3; i++) f.report(task, { outcome: { summary: 's'.repeat(8000) } });
  f.report(task, { status: 'done', outcome: { summary: 's'.repeat(3000) }, retro: text });
  let cursor;
  const outcomes = [];
  do {
    const page = f.store.read({ view: 'outcomes', task_id: task.task_id, ...(cursor ? { cursor } : {}) });
    assert.ok(JSON.stringify(page).length <= LIMITS.page);
    outcomes.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);
  assert.equal(outcomes.length, 4);
  assert.equal(outcomes[0].retro.text, text);
  assert.ok(outcomes.slice(1).every(item => item.retro.status === 'not_recorded'));
});

test('v8 migration renames Task vocabulary, events and assignment receipts', t => {
  const directory = join(process.cwd(), '.task-board-tests', randomUUID());
  mkdirSync(directory, { recursive: true });
  let store;
  t.after(() => { store?.close(); rmSync(directory, { recursive: true, force: true }); });
  const db = new DatabaseSync(join(directory, 'task-board.sqlite'));
  const taskId = randomUUID(), secondId = randomUUID(), subscriptionId = randomUUID(), at = new Date().toISOString();
  db.exec(`
    CREATE TABLE tasks (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL, description TEXT NOT NULL, owner TEXT NOT NULL,
      executor TEXT, status TEXT NOT NULL DEFAULT 'todo',
      revision INTEGER NOT NULL DEFAULT 1, acknowledged_revision INTEGER,
      refs TEXT NOT NULL, metadata TEXT NOT NULL,
      lifecycle INTEGER NOT NULL DEFAULT 1, editable INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, cancellation TEXT,
      kind TEXT NOT NULL DEFAULT 'agent', parent_task_id TEXT REFERENCES tasks(id),
      depth INTEGER NOT NULL DEFAULT 1 CHECK(depth >= 1)
    );
    CREATE UNIQUE INDEX executor_occupancy ON tasks(executor)
      WHERE executor IS NOT NULL AND status NOT IN ('done','cancelled');
    CREATE TABLE definitions (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
      revision INTEGER NOT NULL, description TEXT NOT NULL, reason TEXT NOT NULL,
      author TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(task_id,revision)
    );
    CREATE TABLE acknowledgements (
      task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL,
      confirmed_for TEXT NOT NULL, author TEXT NOT NULL, at TEXT NOT NULL,
      PRIMARY KEY(task_id, revision)
    );
    CREATE TABLE activities (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL,
      executor TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL
    );
    CREATE TABLE outcomes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL,
      executor TEXT, author TEXT NOT NULL, summary TEXT NOT NULL, refs TEXT NOT NULL,
      at TEXT NOT NULL, run_id TEXT, retro TEXT, retro_recorded INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE operations (
      request_id TEXT PRIMARY KEY, tool TEXT NOT NULL, fingerprint TEXT NOT NULL,
      input TEXT NOT NULL, status TEXT NOT NULL, result TEXT, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, binding_context TEXT,
      resumed_by TEXT
    );
    CREATE TABLE task_assignments (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
      executor TEXT NOT NULL, author TEXT NOT NULL, at TEXT NOT NULL
    );
    CREATE INDEX task_assignments_executor ON task_assignments(executor,seq);
    CREATE TABLE scripts (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, script_id TEXT NOT NULL UNIQUE,
      definition TEXT NOT NULL, author TEXT NOT NULL, at TEXT NOT NULL
    );
    CREATE TABLE automation_runs (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id), script_id TEXT NOT NULL,
      script TEXT NOT NULL, parameters TEXT NOT NULL, state TEXT NOT NULL,
      revision INTEGER, queued_at TEXT, started_at TEXT, finished_at TEXT,
      pid INTEGER, process_group INTEGER, exit_code INTEGER, signal TEXT, error TEXT,
      barrier INTEGER NOT NULL DEFAULT 0, cancel_requested INTEGER NOT NULL DEFAULT 0,
      log TEXT NOT NULL DEFAULT '', omitted_characters INTEGER NOT NULL DEFAULT 0,
      reconciled_at TEXT, reconciled_by TEXT, reconciliation_reason TEXT
    );
    CREATE TABLE task_dependencies (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id), blocker_id TEXT NOT NULL REFERENCES tasks(id),
      author TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(task_id, blocker_id), CHECK(task_id <> blocker_id)
    );
    CREATE TABLE subscriptions (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL REFERENCES tasks(id), owner TEXT NOT NULL,
      actor_session_id TEXT NOT NULL, statuses TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('waiting','triggered','cancelled','expired')),
      created_at TEXT NOT NULL, ended_at TEXT, ended_by TEXT, event TEXT,
      delivery_status TEXT NOT NULL DEFAULT 'not_requested',
      attempted_at TEXT, completed_at TEXT, delivery_error TEXT
    );
    CREATE UNIQUE INDEX subscriptions_waiting_owner ON subscriptions(task_id,owner) WHERE state='waiting';
    CREATE TABLE dependency_notices (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL REFERENCES tasks(id), blocker_id TEXT NOT NULL REFERENCES tasks(id),
      blocker_lifecycle INTEGER NOT NULL, owner TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('ready','blocker_cancelled')),
      event TEXT NOT NULL, created_at TEXT NOT NULL,
      delivery_status TEXT NOT NULL DEFAULT 'pending',
      attempted_at TEXT, completed_at TEXT, delivery_error TEXT,
      UNIQUE(task_id, kind, blocker_id, blocker_lifecycle)
    );
    CREATE TABLE child_notices (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL REFERENCES tasks(id), parent_task_id TEXT NOT NULL REFERENCES tasks(id),
      child_lifecycle INTEGER NOT NULL, owner TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('done','blocked','cancelled')),
      event TEXT NOT NULL, created_at TEXT NOT NULL,
      delivery_status TEXT NOT NULL DEFAULT 'pending',
      attempted_at TEXT, completed_at TEXT, delivery_error TEXT,
      UNIQUE(task_id, status, child_lifecycle)
    );
    CREATE TABLE retro_handlings (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL REFERENCES tasks(id), outcome_id TEXT NOT NULL REFERENCES outcomes(id),
      status TEXT NOT NULL CHECK(status IN ('fixed','followup','watching','dismissed')),
      note TEXT NOT NULL, refs TEXT NOT NULL, author TEXT NOT NULL, at TEXT NOT NULL
    );
    PRAGMA user_version=8;
  `);
  db.prepare('INSERT INTO tasks(id,title,description,owner,executor,status,acknowledged_revision,refs,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(taskId, 'Legacy', 'Old words', 'old-owner', 'old-executor', 'todo', 1, '[]', '{}', at, at);
  db.prepare('INSERT INTO tasks(id,title,description,owner,executor,status,refs,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(secondId, 'Second', 'Assign later', 'other-owner', null, 'todo', '[]', '{}', at, at);
  db.prepare('INSERT INTO definitions(task_id,revision,description,reason,author,at) VALUES(?,?,?,?,?,?)')
    .run(taskId, 1, 'Old words', 'Initial definition', 'old-owner', at);
  db.prepare('INSERT INTO task_assignments(task_id,executor,author,at) VALUES(?,?,?,?)')
    .run(taskId, 'old-executor', 'old-owner', at);
  db.prepare('INSERT INTO subscriptions(id,task_id,owner,actor_session_id,statuses,state,created_at,event,delivery_status) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(subscriptionId, taskId, 'old-owner', 'old-executor', '["done"]', 'triggered', at,
      JSON.stringify({ task_id: taskId, status: 'done', actor_session_id: 'old-executor' }), 'pending');
  db.prepare('INSERT INTO operations(request_id,tool,fingerprint,input,status,result,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('assign-old', 'task_assign', 'legacy',
      JSON.stringify({ request_id: 'assign-old', task_id: taskId, executor: 'old-executor' }),
      'final', JSON.stringify({ operation: { request_id: 'assign-old', task_id: taskId, executor: 'old-executor' } }),
      null, at, at);
  db.close();

  store = new TaskStore(directory);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 9);
  const execution = store.read({ view: 'execution', task_id: taskId, actor: 'old-executor' });
  assert.equal(execution.orchestrator, 'old-owner');
  assert.equal(execution.assignee, 'old-executor');
  assert.equal(execution.actor_role, 'assignee');
  const subscription = store.read({ view: 'subscriptions', task_id: taskId }).items[0];
  assert.equal(subscription.orchestrator, 'old-owner');
  assert.equal(subscription.author, 'old-executor');
  assert.equal(subscription.event.actor, 'old-executor');
  assert.equal('actor_session_id' in subscription.event, false);
  const operation = store.read({ view: 'operation', request_id: 'assign-old' });
  assert.equal(operation.result.operation.assignee, 'old-executor');
  assert.equal('executor' in operation.result.operation, false);
  const rawOperation = store.db.prepare('SELECT * FROM operations WHERE request_id=?').get('assign-old');
  assert.equal(JSON.parse(rawOperation.input).assignee, 'old-executor');
  assert.equal('executor' in JSON.parse(rawOperation.input), false);
  assert.equal('invocation' in rawOperation, true);
  const second = store.task(secondId);
  const assign = {
    actor: 'other-owner', request_id: 'assign-second', task_id: secondId,
    assignee: 'old-executor', revision: 1, write_context: second.write_context,
  };
  store.reserveOperation('task_assign', assign);
  rejects(() => store.bindAssignment(assign), 'ASSIGNEE_OCCUPIED');
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});
