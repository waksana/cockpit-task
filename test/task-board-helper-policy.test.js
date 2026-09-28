import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseInput, invocationFromMeta } from '../src/task-board/contracts.js';
import { TOOL_NAMES, READ_ONLY_TOOL_NAMES } from '../src/task-board/tool-names.js';
import { TaskService } from '../src/task-board/service.js';
import { TaskStore } from '../src/task-board/store.js';
import { seedOrchestratingRoot, responsibilityContext } from './helpers/service-responsibility-fixtures.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'task-helper-policy-'));
  const store = new TaskStore(directory);
  const hostCalls = [], errors = [];
  let invalidations = 0;
  const host = Object.fromEntries(['create', 'inspect', 'prepare', 'send', 'nameState', 'rename'].map(name => [
    name, () => { hostCalls.push(name); throw new Error(`Unexpected host call: ${name}`); },
  ]));
  const service = new TaskService(store, host, {
    invalidate: () => { invalidations++; }, report: error => errors.push(error),
  });
  t.after(() => { service.close(); rmSync(directory, { recursive: true, force: true }); });
  const main = { sessionId: 'main', runtimeSessionId: 'main', subagent: false };
  const helper = { ...main, runtimeSessionId: 'helper', subagent: true };
  const call = (name, input, invocation = helper) => service.execute(name, input, { invocation, external: true });
  return { store, service, main, helper, call, hostCalls, errors, invalidations: () => invalidations };
}

test('every maintenance tool rejects helpers before receipts, Task changes, invalidation or host work', async t => {
  const f = fixture(t);
  seedOrchestratingRoot(f.store, 'main');
  const task = f.store.read({ view: 'list', assignee: 'main' }).items[0];
  const current = responsibilityContext(task);
  const existing = { task_id: task.task_id, write_context: task.write_context };
  const mutations = {
    task_create: { title: 'Never created', description: 'No helper maintenance' },
    task_script_register: {
      script_id: 'never-read', title: 'No registration', description: 'No filesystem effects',
      executable: process.execPath, script_path: '/never-opened.mjs', argv: [], parameters: [],
    },
    task_automation_start: current,
    task_automation_reconcile: { ...existing, reason: 'Do not reconcile' },
    task_session_create: { cwd: '/never-created', skills: ['existing-skill'] },
    task_session_prepare: { session_id: 'main', skills: ['existing-skill'] },
    task_assign: { ...current, assignee: 'worker' },
    task_claim: current,
    task_start: { ...current, work_mode: 'execute' },
    task_convert: { ...current, reason: 'No', completed: 'None', remaining: 'All' },
    task_attach: { ...current, parent_task_id: randomUUID(), parent_write_context: 'unused', reason: 'No' },
    task_resolve_condition: { ...current, dependency_id: randomUUID(), evidence: 'No' },
    task_cancel_finalize: { ...current, summary: 'No closure' },
    task_edit: { ...current, title: 'Never edited', reason: 'No' },
    task_ack: current,
    task_reopen: { ...current, description: 'No rework', reason: 'No' },
    task_report: { ...current, activity: { text: 'Even activity-only writes are forbidden' } },
    task_cancel: { ...existing, reason: 'No cancellation' },
    task_subscribe: { ...existing, statuses: ['done'] },
    task_unsubscribe: { task_id: task.task_id, subscription_id: randomUUID() },
    task_retro_handle: { task_id: task.task_id, outcome_id: randomUUID(), status: 'fixed', note: 'No' },
  };
  assert.deepEqual(Object.keys(mutations).sort(), TOOL_NAMES.filter(name => !READ_ONLY_TOOL_NAMES.includes(name)).sort());
  f.service.automation.kick = () => assert.fail('Helper must not wake automation');
  f.service.automation.cancel = () => assert.fail('Helper must not cancel automation');
  const before = f.store.db.prepare('SELECT total_changes() AS n').get().n;
  for (const [name, fields] of Object.entries(mutations)) {
    const input = { request_id: `helper-${name}`, ...fields };
    parseInput(name, input);
    const result = await f.call(name, input);
    assert.equal(result.error?.code, 'SUBAGENT_WRITE_FORBIDDEN', name);
    assert.equal(result.error.status, 403, name);
    assert.equal(result.result, null, name);
  }
  for (const fields of [
    { status: 'in_progress' },
    { activity: { text: 'Partial result' }, status: 'done', outcome: { summary: 'Not integrated' }, retro: null },
    { outcome: { summary: 'No standalone outcome either' } },
  ]) {
    const result = await f.call('task_report', { request_id: randomUUID(), ...current, ...fields });
    assert.equal(result.error.code, 'SUBAGENT_WRITE_FORBIDDEN');
  }
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, before);
  assert.deepEqual(f.hostCalls, []);
  assert.deepEqual(f.errors, []);
  assert.equal(f.invalidations(), 0);
});

test('helpers read their session context and receipts without ACK or separate responsibility', async t => {
  const f = fixture(t);
  const input = { request_id: 'create', title: 'Main result', description: 'Owned by the session' };
  const created = await f.call('task_create', input, f.main);
  assert.equal(created.error, null);
  const before = f.store.db.prepare('SELECT total_changes() AS n').get().n;
  for (const view of ['overview', 'execution', 'definition', 'activity', 'outcomes']) {
    assert.equal((await f.call('task_read', { view, task_id: created.result.task_id })).error, null);
  }
  const operation = await f.call('task_read', { view: 'operation', request_id: input.request_id });
  assert.equal(operation.result.actor, 'main');
  assert.deepEqual(operation.result.invocation, f.main);
  assert.equal((await f.call('task_script_read', {})).error, null);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, before);
});

test('missing or inconsistent main provenance cannot authorize maintenance', async t => {
  const f = fixture(t);
  const input = { request_id: 'bad-source', cwd: '/must-not-create' };
  for (const fields of [
    {}, { subagent: false }, { runtimeSessionId: 'main' },
    { subagent: 'false', runtimeSessionId: 'main' },
    { subagent: 0, runtimeSessionId: 'main' },
    { subagent: false, runtimeSessionId: 'helper' },
    { subagent: false, runtimeSessionId: null },
    { subagent: false, runtimeSessionId: 'main'.repeat(60) },
  ]) {
    const invocation = invocationFromMeta({ 'cockpit/invocation': { sessionId: 'main', ...fields } });
    assert.equal((await f.call('task_session_create', input, invocation)).error.code, 'INVOCATION_REQUIRED');
    assert.equal((await f.call('task_read', { view: 'list' }, invocation)).error, null);
  }
  assert.equal((await f.service.execute('task_session_create', input, { external: true, actor: 'main' })).error.code, 'INVOCATION_REQUIRED');
  for (const fields of [{ actor: 'main' }, { invocation: f.main }]) {
    assert.equal((await f.call('task_session_create', { ...input, ...fields })).error.code, 'INVALID_INPUT');
  }
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM operations').get().n, 0);
  assert.deepEqual(f.hostCalls, []);
});

test('a formal child primary agent retains lifecycle authority while its helper is read-only', async t => {
  const f = fixture(t);
  seedOrchestratingRoot(f.store, 'main');
  const created = await f.call('task_create', {
    request_id: 'child', title: 'Independent child', description: 'Separate responsibility',
  }, f.main);
  assert.equal(created.error, null);
  const assignment = { ...responsibilityContext(created.result), actor: 'main', request_id: 'assign', assignee: 'child' };
  f.store.reserveOperation('task_assign', assignment);
  f.store.bindAssignment(assignment);
  const child = { sessionId: 'child', runtimeSessionId: 'child', subagent: false };
  const childHelper = { ...child, runtimeSessionId: 'child-helper', subagent: true };
  const context = () => responsibilityContext(f.store.task(created.result.task_id));
  const ack = { request_id: 'ack', ...context() };
  assert.equal((await f.call('task_ack', ack, childHelper)).error.code, 'SUBAGENT_WRITE_FORBIDDEN');
  assert.equal((await f.call('task_ack', ack, child)).error, null);
  assert.equal((await f.call('task_start', { request_id: 'start', ...context(), work_mode: 'execute' }, child)).error, null);
  assert.equal((await f.call('task_report', {
    request_id: 'done', ...context(), status: 'done', outcome: { summary: 'Integrated result' }, retro: null,
  }, f.main)).error.code, 'ASSIGNEE_REQUIRED');
  // Delivering the child card is a valid host effect, unlike any rejected helper call.
  f.service.host.sessionExists = async () => true;
  f.service.host.send = async () => ({ ok: true });
  assert.equal((await f.call('task_report', {
    request_id: 'done', ...context(), status: 'done', outcome: { summary: 'Integrated result' }, retro: null,
  }, child)).error, null);
  const web = await f.service.execute('task_create', {
    request_id: 'web', title: 'Web root', description: 'No native invocation',
  }, { actor: 'user', external: true });
  assert.equal(web.error, null);
});
