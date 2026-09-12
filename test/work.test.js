import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { backup } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, readCredential, WorkError, hash } from '../src/store.js';
import { stageManifest, loadManifest, planImport, applyImport } from '../src/migration.js';
import { cutoverLedger } from '../src/cutover.js';
import { Work } from '../src/work.js';
import { EffectUnknown } from '../src/cockpit.js';
import { createApp } from '../src/server.js';

const goal = { objective: 'Complete isolated fixture', scope: 'Fixture directory only', acceptance: 'Durable artifact and truthful outcome', authorization: 'Create fixture file; no external sends' };
const ownerInstruction = { reason: 'User requested a follow-up to this same goal',
  source: 'User in this owner session at 2026-09-12 15:56: amend this task and continue' };
class FakeCockpit {
  calls = []; sessions = new Map(); modules = new Map(); failure; gate; loseEmptyOnApply = false;
  async call(name, body, mutation = true) {
    this.calls.push({ name, body, mutation });
    if (this.gate?.name === name) await this.gate.promise;
    if (this.failure?.name === name) throw this.failure.error;
    if (name === 'session/new' || name === 'session/fork') {
      const sessionId = `owner-${this.sessions.size + 1}`;
      this.sessions.set(sessionId, { loaded: true, status: 'idle', currentModelId: 'gpt-6-astra' });
      this.modules.set(sessionId, body.modules ? { sessionId, selections: body.modules, phase: 'applied' } : null);
      return { sessionId };
    }
    if (name === 'session/load') {
      this.sessions.get(body.sessionId).loaded = true;
      return { ok: true, sessionId: body.sessionId };
    }
    if (name === 'setModel') this.sessions.get(body.sessionId).currentModelId = body.modelId;
    if (name === 'session/modules/get') return { modules: this.modules.get(body.sessionId) ?? null };
    if (name === 'session/modules/apply') {
      if (this.loseEmptyOnApply && !this.sessions.get(body.sessionId).hasMessage) {
        this.sessions.delete(body.sessionId);
        throw new EffectUnknown('Native module session working directory is unavailable');
      }
      const modules = { sessionId: body.sessionId, selections: body.selections,
        operationId: body.operationId, phase: 'applied' };
      this.modules.set(body.sessionId, modules);
      return { modules };
    }
    if (name === 'prompt') {
      const session = this.sessions.get(body.sessionId);
      if (session) session.hasMessage = true;
    }
    return { ok: true, queued: true, status: 'connected' };
  }
  async meta(id) {
    this.calls.push({ name: 'session/get', body: { sessionId: id } });
    if (this.failure?.name === 'session/get' && (!this.failure.sessionId || this.failure.sessionId === id)) throw this.failure.error;
    const value = this.sessions.get(id);
    if (!value) throw new WorkError('SESSION_NOT_FOUND', 'Not found', 404);
    return { ...value };
  }
}
function fixture(t, options) {
  const dir = mkdtempSync(join(tmpdir(), 'wc-test-')), s = new Store(dir), c = new FakeCockpit(), w = new Work(s, c, options);
  const caller = s.authenticate(s.issue('caller', 'caller-fixture'));
  c.sessions.set('caller-fixture', { loaded: false, status: 'unloaded' });
  t.after(() => { s.close(); rmSync(dir, { recursive: true }); });
  return { s, c, w, caller, dir,
    owner(id) { const task = s.task(id); return s.authenticate(readCredential(task.credential_path)); },
    dispatch(extra = {}) { return w.execute(caller, 'work_dispatch', { selection: 'new', cwd: dir, workstream: 'fixture', goal, idempotencyKey: 'dispatch-001', ...extra }); },
  };
}
test('HTTP dispatch accepts dotted models without relaxing other IDs or reserving invalid inputs', async t => {
  for (const modelId of ['gpt-4.1', 'gpt-5.5']) {
    const f = fixture(t), { app } = createApp({ store: f.s, cockpit: f.c });
    t.after(() => app.close());
    const token = f.s.issue('caller', 'model-caller');
    f.c.sessions.set('model-caller', { loaded: false, status: 'unloaded' });
    const input = { selection: 'new', cwd: f.dir, workstream: 'fixture', goal,
      modelId, idempotencyKey: 'dotted-model-001' };
    const dispatch = payload => app.inject({ method: 'POST', url: '/api/tools/work_dispatch', payload,
      headers: { host: '127.0.0.1:8790', authorization: `Bearer ${token}` } });
    const invalidModels = ['', 'x'.repeat(121), `${modelId}\n`, `${modelId}\r`, `${modelId}\t`,
      `${modelId}\0`, `${modelId}\u001b`, `${modelId}\u007f`, ` ${modelId}`, `${modelId} `,
      `../${modelId}`, `/models/${modelId}`, `models\\${modelId}`, `https://models/${modelId}`,
      `models%2f${modelId}`];
    const invalid = [
      ...invalidModels.map(value => ({ ...input, modelId: value })),
      ...['taskId', 'workstream', 'sourceSessionId', 'toEventId'].map(field => ({ ...input, [field]: 'invalid.id' })),
    ];
    const credentialCount = f.s.get('SELECT count(*) n FROM credentials').n;
    for (const payload of invalid) {
      const response = await dispatch(payload);
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
      assert.equal(response.json().error, 'INVALID_INPUT');
    }
    assert.equal(f.c.calls.length, 0);
    assert.equal(f.s.get('SELECT count(*) n FROM tasks').n, 0);
    assert.equal(f.s.get('SELECT count(*) n FROM operations').n, 0);
    assert.equal(f.s.get('SELECT count(*) n FROM credentials').n, credentialCount);
    const response = await dispatch(input);
    assert.equal(response.statusCode, 200);
    const result = response.json();
    assert.equal(result.operation.status, 'succeeded');
    assert.deepEqual(f.c.calls.find(call => call.name === 'setModel').body,
      { sessionId: result.task.ownerSessionId, modelId });
    const calls = f.c.calls.length;
    const repeated = await dispatch(input);
    assert.equal(repeated.json().task.taskId, result.task.taskId);
    assert.equal(f.c.calls.length, calls);
    assert.equal(f.c.calls.filter(call => call.name === 'session/new').length, 1);
    assert.equal(f.c.calls.filter(call => call.name === 'prompt').length, 1);
    assert.equal(f.s.get("SELECT count(*) n FROM credentials WHERE role='owner'").n, 1);
  }
});
test('dotted model dispatch still requires authoritative native model confirmation', async t => {
  const f = fixture(t);
  const call = f.c.call.bind(f.c);
  f.c.call = async (name, body) => {
    if (name === 'setModel') {
      f.c.calls.push({ name, body });
      return { acknowledged: true };
    }
    return call(name, body);
  };
  const result = await f.dispatch({ modelId: 'gpt-4.1' });
  assert.notEqual(result.operation.status, 'succeeded');
  assert.equal(f.c.calls.filter(call => call.name === 'setModel').length, 1);
  assert.equal(f.c.calls.some(call => call.name === 'prompt'), false);
  const calls = f.c.calls.length;
  await f.dispatch({ modelId: 'gpt-4.1' });
  assert.equal(f.c.calls.length, calls);
});
test('one-call dispatch, owner reports, final single notification and compact read', async t => {
  const f = fixture(t), result = await f.dispatch(), id = result.task.taskId, owner = f.owner(id);
  assert.equal(result.operation.status, 'succeeded');
  assert.equal(result.task.status, 'dispatched');
  assert.deepEqual(f.c.calls.map(c => c.name), ['session/get', 'session/new', 'session/get',
    'mcp/session-toggle', 'skills/session-toggle', 'session/get', 'prompt']);
  const prompt = f.c.calls.at(-1).body.text;
  assert.match(prompt, /Use skill work-commander-owner/);
  assert.match(prompt, /follow the target project engineering\/runtime rules/);
  assert.match(prompt, /binding neither provides engineering isolation nor grants extra authority/);
  assert.match(prompt, /Do NOT send any separate caller final\/ACK/);
  assert.doesNotMatch(prompt, /worktree|Use skill work-owner/);
  const report = (kind, key) => f.w.execute(owner, 'work_report', { taskId: id, goalVersion: 1, kind, summary: kind, idempotencyKey: key });
  await report('accepted', 'accept-001'); await report('progress', 'progress-001');
  await report('blocked', 'blocked-001'); await report('needs_decision', 'decision-001'); await report('result', 'result-001');
  assert.equal(f.c.calls.filter(c => c.name === 'prompt').length, 1);
  const delivery = { taskId: id, goalVersion: 1, outcome: 'delivered', summary: 'Done', artifacts: ['/tmp/result.txt'], idempotencyKey: 'delivery-001' };
  const final = await f.w.execute(owner, 'work_deliver', delivery);
  await f.w.execute(owner, 'work_deliver', delivery);
  assert.equal(final.task.status, 'delivered');
  assert.equal(f.c.calls.filter(c => c.name === 'prompt').length, 2);
  const last = f.c.calls.at(-1);
  assert.equal(last.body.sessionId, 'caller-fixture');
  const reads = f.c.calls.length;
  const summary = await f.w.execute(f.caller, 'work_read', {});
  assert.equal(f.c.calls.length, reads);
  assert.ok(JSON.stringify(summary).length < 650);
});
test('idempotent duplicate dispatch creates one session; changed input conflicts', async t => {
  const f = fixture(t);
  const [a, b] = await Promise.all([f.dispatch(), f.dispatch()]);
  assert.equal(a.task.taskId, b.task.taskId);
  assert.equal(f.c.calls.filter(c => c.name === 'session/new').length, 1);
  await assert.rejects(f.dispatch({ message: 'changed' }), { code: 'IDEMPOTENCY_CONFLICT' });
});
test('managed new and fork select owner explicitly without Assistant or legacy global toggles', async t => {
  for (const selection of ['new', 'fork']) {
    const f = fixture(t, { moduleVersion: '1.2.0' });
    if (selection === 'fork') f.c.sessions.set('source', { loaded: true, status: 'idle' });
    const call = f.c.call.bind(f.c);
    f.c.call = async (name, body, mutation) => {
      if (name === 'session/modules/apply') assert.equal(f.c.sessions.get(body.sessionId).loaded, true);
      const result = await call(name, body, mutation);
      if (name === 'session/fork') f.c.sessions.get(result.sessionId).loaded = false;
      return result;
    };
    const result = await f.w.execute(f.caller, 'work_dispatch', {
      selection, ...(selection === 'new' ? { cwd: f.dir } : { sourceSessionId: 'source' }),
      workstream: 'managed', goal, idempotencyKey: 'managed-dispatch',
    });
    assert.equal(result.operation.status, 'succeeded');
    const created = f.c.calls.find(c => c.name === `session/${selection}`);
    if (selection === 'new') assert.deepEqual(created.body, { cwd: f.dir, modules: f.w.ownerModules });
    else assert.deepEqual(created.body, { sessionId: 'source' });
    const role = f.c.calls.find(c => c.name === 'session/modules/apply');
    const inspected = f.c.calls.find(c => c.name === 'session/modules/get');
    assert.equal(inspected.mutation, false);
    if (selection === 'fork') {
      const resumed = f.c.calls.find(c => c.name === 'session/load');
      assert.deepEqual(resumed.body, { sessionId: result.task.ownerSessionId });
      assert.ok(f.c.calls.indexOf(created) < f.c.calls.indexOf(resumed));
      assert.ok(f.c.calls.indexOf(resumed) < f.c.calls.indexOf(role));
      assert.deepEqual(role.body, {
        sessionId: result.task.ownerSessionId, selections: f.w.ownerModules, operationId: result.operation.operationId,
      });
      assert.ok(f.c.calls.indexOf(inspected) < f.c.calls.indexOf(role));
    } else {
      assert.equal(role, undefined);
    }
    assert.equal(f.c.calls.some(c => /session-toggle/.test(c.name)), false);
    assert.ok(f.c.calls.indexOf(inspected) < f.c.calls.findIndex(c => c.name === 'prompt'));
    assert.match(f.c.calls.at(-1).body.text, /MCP cockpit-task credential=/);
    assert.match(f.c.calls.at(-1).body.text, /Use skill cockpit-task-owner/);
    assert.doesNotMatch(f.c.calls.at(-1).body.text, /Use skill work-commander-owner/);
    assert.equal(f.owner(result.task.taskId).role, 'owner');
    assert.equal(f.s.get("SELECT count(*) AS n FROM credentials WHERE role='caller'").n, 1);
    assert.equal(JSON.stringify(created.body).includes('assistant'), false);
  }
});
test('new owner survives a native fixture that loses never-prompted sessions on module apply', async t => {
  const control = new FakeCockpit();
  control.loseEmptyOnApply = true;
  const created = await control.call('session/new', { modules: [{ moduleId: 'task', roleId: 'owner', version: '1.2.5' }] });
  await assert.rejects(control.call('session/modules/apply', { sessionId: created.sessionId }),
    { code: 'EFFECT_UNKNOWN' });
  assert.equal(control.sessions.has(created.sessionId), false);

  const f = fixture(t, { moduleVersion: '1.2.5' });
  f.c.loseEmptyOnApply = true;
  const result = await f.dispatch();
  assert.equal(result.operation.status, 'succeeded');
  assert.equal(f.c.sessions.get(result.task.ownerSessionId).hasMessage, true);
  assert.equal(f.c.calls.filter(call => call.name === 'session/modules/get').length, 1);
  assert.equal(f.c.calls.some(call => call.name === 'session/modules/apply' || call.name === 'session/reload'), false);
  assert.equal(f.c.calls.filter(call => call.name === 'prompt').length, 1);
});
test('module GET failures and unconfirmed state never fall through to apply or prompt despite HTTP 200', async t => {
  for (const state of ['read-error', 'missing', 'null', 'native-absent', 'wrong-session', 'pending', 'unknown', 'wrong-version', 'assistant', 'extra']) {
    const f = fixture(t, { moduleVersion: '1.2.5' });
    const call = f.c.call.bind(f.c);
    f.c.call = async (name, body, mutation) => {
      const result = await call(name, body, mutation);
      if (name !== 'session/modules/get') return result;
      assert.equal(mutation, false);
      if (state === 'read-error') throw new WorkError('UPSTREAM_READ_FAILED', 'Fixture read failed', 502);
      if (state === 'missing') return { ok: true };
      if (state === 'null') return { modules: null };
      const modules = structuredClone(result.modules);
      if (state === 'native-absent') modules.nativePresent = false;
      if (state === 'wrong-session') modules.sessionId = 'other-session';
      if (state === 'pending' || state === 'unknown') modules.phase = state;
      if (state === 'wrong-version') modules.selections[0].version = '1.2.0';
      if (state === 'assistant') modules.selections = [{ moduleId: 'assistant', roleId: 'assistant', version: '1.0.0' }];
      if (state === 'extra') modules.selections.push({ moduleId: 'task', roleId: 'commander', version: '1.2.5' });
      return { ok: true, modules };
    };
    const { app } = createApp({ store: f.s, cockpit: f.c, moduleVersion: '1.2.5' });
    t.after(() => app.close());
    const token = f.s.issue('caller', 'read-failure-caller');
    f.c.sessions.set('read-failure-caller', { loaded: false, status: 'unloaded' });
    const input = { selection: 'new', cwd: f.dir, goal, workstream: 'fixture', idempotencyKey: 'module-read-001' };
    const dispatch = () => app.inject({ method: 'POST', url: '/api/tools/work_dispatch', payload: input,
      headers: { host: '127.0.0.1:8790', authorization: `Bearer ${token}` } });
    const response = await dispatch();
    assert.equal(response.statusCode, 200);
    assert.ok(['failed', 'unknown'].includes(response.json().operation.status), state);
    assert.equal(f.c.calls.some(call => call.name === 'session/modules/apply' || call.name === 'prompt'), false);
    const calls = f.c.calls.length;
    const repeated = await dispatch();
    assert.equal(repeated.json().task.ownerSessionId, response.json().task.ownerSessionId);
    assert.equal(f.c.calls.length, calls);
  }
});
test('continue preserves the sole applied owner version across service upgrade and cold load', async t => {
  for (const cold of [false, true]) {
    const f = fixture(t, { moduleVersion: '1.2.0' }), initial = await f.dispatch();
    const sessionId = initial.task.ownerSessionId;
    f.c.sessions.get(sessionId).loaded = !cold;
    const upgraded = new Work(f.s, f.c, { moduleVersion: '1.2.5' });
    const calls = f.c.calls.length;
    const result = await upgraded.execute(f.caller, 'work_dispatch', {
      selection: 'continue', taskId: initial.task.taskId, goalVersion: 1,
      message: 'Explicit continuation', idempotencyKey: 'preserve-owner-version',
    });
    assert.equal(result.operation.status, 'succeeded');
    assert.equal(result.task.ownerSessionId, sessionId);
    assert.deepEqual(f.c.modules.get(sessionId).selections, f.w.ownerModules);
    assert.equal(f.c.calls.slice(calls).some(call => call.name === 'session/modules/apply' || call.name === 'session/new'), false);
    assert.equal(f.c.calls.slice(calls).filter(call => call.name === 'session/load').length, Number(cold));
    assert.equal(f.s.get("SELECT count(*) n FROM credentials WHERE role='owner'").n, 1);
  }
});
test('explicit adopt preserves an existing sole owner version and applies only when owner is absent', async t => {
  for (const configured of [false, true]) {
    const f = fixture(t, { moduleVersion: '1.2.5' });
    const imported = importFixture(f, migrationFixture(f, [{}]));
    const sessionId = 'same-old-owner';
    f.c.sessions.set(sessionId, { loaded: true, status: 'idle', currentModelId: 'gpt-6-astra', hasMessage: true });
    const oldSelections = [{ moduleId: 'task', roleId: 'owner', version: '1.2.0' }];
    if (configured) f.c.modules.set(sessionId, { sessionId, phase: 'applied', selections: oldSelections });
    const result = await f.w.execute(f.caller, 'work_dispatch', {
      selection: 'adopt', taskId: imported.tasks[0].taskId, recordRevision: 1, goal, idempotencyKey: 'adopt-owner-version',
    });
    assert.equal(result.operation.status, 'succeeded');
    assert.equal(result.task.ownerSessionId, sessionId);
    assert.equal(f.c.calls.some(call => call.name === 'session/new' || call.name === 'session/fork'), false);
    assert.equal(f.c.calls.filter(call => call.name === 'session/modules/apply').length, Number(!configured));
    assert.deepEqual(f.c.modules.get(sessionId).selections, configured ? oldSelections : f.w.ownerModules);
    assert.equal(f.c.calls.filter(call => call.name === 'prompt').length, 1);
  }
});
test('adoption of a missing original owner retains imported identity and fails without issuing a replacement credential', async t => {
  const f = fixture(t, { moduleVersion: '1.2.6' });
  const imported = importFixture(f, migrationFixture(f, [{}]));
  const taskId = imported.tasks[0].taskId, history = f.s.get('SELECT * FROM legacy_records WHERE task_id=?', taskId);
  const credentials = f.s.all('SELECT * FROM credentials');
  const result = await f.w.execute(f.caller, 'work_dispatch', {
    selection: 'adopt', taskId, recordRevision: 1, goal, idempotencyKey: 'adopt-missing-owner',
  });
  assert.equal(result.operation.status, 'failed');
  assert.match(result.operation.error, /SESSION_NOT_FOUND/);
  assert.equal(result.task.ownerSessionId, history.owner_ref);
  assert.equal(result.task.callerSessionId, 'caller-fixture');
  assert.deepEqual(f.s.get('SELECT * FROM legacy_records WHERE task_id=?', taskId), history);
  assert.deepEqual(f.s.all('SELECT * FROM credentials'), credentials);
  assert.ok(f.c.calls.every(call => call.name === 'session/get'));
  assert.equal(f.s.task(taskId).credential_path, null);
});
test('explicit recovery of a new owner uses its recorded creation version after service upgrade', async t => {
  const f = fixture(t, { moduleVersion: '1.2.0' });
  f.c.failure = { name: 'session/modules/get', error: new WorkError('UPSTREAM_READ_FAILED', 'Fixture read failed', 502) };
  const initial = await f.dispatch();
  assert.equal(initial.operation.status, 'failed');
  f.c.failure = null;
  const upgraded = new Work(f.s, f.c, { moduleVersion: '1.2.5' });
  const result = await upgraded.execute(f.caller, 'work_recover', {
    operationId: initial.operation.operationId, idempotencyKey: 'recover-recorded-version',
  });
  assert.equal(result.operation.status, 'succeeded');
  assert.equal(result.task.ownerSessionId, initial.task.ownerSessionId);
  assert.equal(f.c.calls.filter(call => call.name === 'session/new').length, 1);
  assert.equal(f.c.calls.some(call => call.name === 'session/modules/apply'), false);
  assert.deepEqual(f.c.modules.get(initial.task.ownerSessionId).selections, f.w.ownerModules);
});
test('a completed apply checkpoint cannot hide changed native modules during explicit recovery', async t => {
  const f = fixture(t, { moduleVersion: '1.2.5' });
  f.c.sessions.set('source', { loaded: true, status: 'idle' });
  f.c.failure = { name: 'prompt', error: new WorkError('PROMPT_NOT_SENT', 'Fixture refused before sending') };
  const initial = await f.dispatch({ selection: 'fork', sourceSessionId: 'source', cwd: undefined });
  assert.equal(initial.operation.status, 'failed');
  const sessionId = initial.task.ownerSessionId;
  f.c.modules.set(sessionId, { sessionId, phase: 'applied',
    selections: [{ moduleId: 'assistant', roleId: 'assistant', version: '1.0.0' }] });
  f.c.failure = null;
  const calls = f.c.calls.length;
  const recovered = await f.w.execute(f.caller, 'work_recover', {
    operationId: initial.operation.operationId, idempotencyKey: 'recover-changed-modules',
  });
  assert.equal(recovered.operation.status, 'failed');
  assert.match(recovered.operation.error, /MODULE_NOT_CONFIRMED/);
  assert.equal(f.c.calls.slice(calls).some(call => call.name === 'session/modules/apply' || call.name === 'prompt'), false);
});
test('native schedule refusal during managed apply never cancels schedules or sends a prompt', async t => {
  const f = fixture(t, { moduleVersion: '1.2.0' });
  f.c.sessions.set('source', { loaded: true, status: 'idle' });
  f.c.failure = { name: 'session/modules/apply', error: new EffectUnknown('Session has active schedules') };
  const dispatch = () => f.dispatch({ selection: 'fork', sourceSessionId: 'source', cwd: undefined });
  const result = await dispatch();
  assert.equal(result.operation.status, 'unknown');
  assert.equal(result.operation.step, 'module');
  assert.equal(f.c.calls.some(c => c.name === 'prompt' || /schedule|cancel|stop/.test(c.name)), false);
  const calls = f.c.calls.length;
  await dispatch();
  assert.equal(f.c.calls.length, calls);
});
test('managed owner role failure preserves the same owner and does not send or automatically replay', async t => {
  const f = fixture(t, { moduleVersion: '1.2.0' });
  f.c.sessions.set('source', { loaded: true, status: 'idle' });
  f.c.failure = { name: 'session/modules/apply', error: new EffectUnknown('role result unknown') };
  const dispatch = () => f.dispatch({ selection: 'fork', sourceSessionId: 'source', cwd: undefined });
  const first = await dispatch();
  assert.equal(first.operation.status, 'unknown');
  assert.equal(first.operation.step, 'module');
  assert.equal(f.c.calls.some(c => c.name === 'prompt'), false);
  const calls = f.c.calls.length;
  const repeat = await dispatch();
  assert.equal(repeat.task.ownerSessionId, first.task.ownerSessionId);
  assert.equal(f.c.calls.length, calls);
});
test('unconfirmed or Assistant-inheriting module responses never send an owner prompt', async t => {
  for (const change of [
    modules => ({ ...modules, phase: 'failed' }),
    modules => ({ ...modules, nativePresent: false }),
    modules => ({ ...modules, sessionId: 'another-session' }),
    modules => ({ ...modules, selections: [...modules.selections, { moduleId: 'assistant', roleId: 'assistant', version: '1.0.0' }] }),
  ]) {
    const f = fixture(t, { moduleVersion: '1.2.0' });
    f.c.sessions.set('source', { loaded: true, status: 'idle' });
    const call = f.c.call.bind(f.c);
    f.c.call = async (name, body) => {
      const result = await call(name, body);
      return name === 'session/modules/apply' ? { modules: change(result.modules) } : result;
    };
    const result = await f.dispatch({ selection: 'fork', sourceSessionId: 'source', cwd: undefined });
    assert.equal(result.operation.status, 'unknown');
    assert.equal(result.operation.step, 'module');
    assert.equal(f.c.calls.some(c => c.name === 'prompt'), false);
  }
});
test('owner credentials cannot report other task; payload identity rejected', async t => {
  const f = fixture(t), a = await f.dispatch(), b = await f.dispatch({ workstream: 'second', idempotencyKey: 'dispatch-002' });
  await assert.rejects(f.w.execute(f.owner(a.task.taskId), 'work_report', {
    taskId: b.task.taskId, goalVersion: 1, kind: 'accepted', summary: 'spoof', idempotencyKey: 'spoof-001',
  }), { code: 'WRONG_OWNER' });
  await assert.rejects(f.w.execute(f.caller, 'work_report', {
    taskId: a.task.taskId, goalVersion: 1, kind: 'accepted', summary: 'spoof', idempotencyKey: 'spoof-002',
  }), { code: 'FORBIDDEN' });
  await assert.rejects(f.w.execute(f.owner(a.task.taskId), 'work_report', {
    taskId: a.task.taskId, goalVersion: 1, kind: 'accepted', summary: 'spoof', idempotencyKey: 'spoof-003', owner: 'caller-fixture',
  }));
});
test('owner explicitly reopens each terminal outcome in place, with durable history and one notification per version', async t => {
  for (const outcome of ['delivered', 'failed', 'cancelled']) {
    const f = fixture(t), initial = await f.dispatch(), taskId = initial.task.taskId, owner = f.owner(taskId);
    const execute = (name, input) => f.w.execute(owner, name, { taskId, ...input });
    await execute('work_report', { goalVersion: 1, kind: 'accepted', summary: 'Accept', idempotencyKey: 'owner-accept-v1' });
    const final = { goalVersion: 1, outcome, summary: 'Original outcome', artifacts: ['/fixture/v1'], idempotencyKey: 'owner-final-v1' };
    await execute('work_deliver', final);
    const original = f.s.task(taskId), credentials = f.s.all('SELECT * FROM credentials');
    const history = f.s.all('SELECT * FROM events WHERE task_id=?', taskId);
    const operations = f.s.all('SELECT * FROM operations WHERE task_id=?', taskId);
    const versions = f.s.all('SELECT * FROM versions WHERE task_id=?', taskId);
    const calls = f.c.calls.length;
    const edit = { action: 'update', recordRevision: 1, title: 'Follow-up label', notes: 'Still not reopened',
      sources: ['/fixture/request'], ...ownerInstruction, idempotencyKey: 'owner-metadata-v1' };
    const metadata = await execute('work_record', edit);
    assert.equal(metadata.task.goalVersion, 1);
    assert.equal(metadata.task.status, outcome);
    assert.equal(f.s.task(taskId).accepted_version, 1);
    assert.equal(f.s.task(taskId).artifacts, original.artifacts);
    assert.deepEqual(await execute('work_record', edit), metadata);
    await assert.rejects(execute('work_report', { goalVersion: 1, kind: 'progress', summary: 'Too late',
      idempotencyKey: 'owner-late-progress' }), { code: 'TERMINAL_GOAL' });
    const amendment = { goalVersion: 1, goal: { ...goal, objective: 'Follow up on fixture' },
      ...ownerInstruction, idempotencyKey: 'owner-amend-v2' };
    await assert.rejects(execute('work_amend', { ...amendment, source: undefined }), { code: 'USER_INSTRUCTION_REQUIRED' });
    const amended = await execute('work_amend', amendment);
    assert.deepEqual(await execute('work_amend', amendment), amended);
    await assert.rejects(execute('work_amend', { ...amendment, source: 'Different instruction' }),
      { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal(amended.task.goalVersion, 2);
    assert.equal(amended.task.recordRevision, 2);
    assert.equal(amended.task.title, 'Follow-up label');
    assert.equal(amended.task.status, 'recorded');
    assert.match(amended.task.summary, /owner must accept/);
    assert.equal(f.s.task(taskId).accepted_version, null);
    assert.equal(f.s.task(taskId).artifacts, '[]');
    for (const field of ['id', 'workstream', 'caller', 'owner', 'credential_path']) {
      assert.equal(f.s.task(taskId)[field], original[field], field);
    }
    assert.deepEqual(f.s.all('SELECT * FROM credentials'), credentials);
    assert.deepEqual(f.s.all('SELECT * FROM events WHERE task_id=? AND seq<=?', taskId, history.at(-1).seq), history);
    assert.deepEqual(f.s.all('SELECT * FROM operations WHERE task_id=?', taskId), operations);
    assert.deepEqual(f.s.all('SELECT * FROM versions WHERE task_id=? AND version=1', taskId), versions);
    const reopenedStore = new Store(f.dir);
    try {
      assert.equal(reopenedStore.task(taskId).version, 2);
      assert.equal(reopenedStore.authenticate(readCredential(original.credential_path)).digest, owner.digest);
      const storedReason = reopenedStore.get('SELECT reason FROM versions WHERE task_id=? AND version=2', taskId).reason;
      assert.ok(storedReason.includes(ownerInstruction.source));
      assert.ok(storedReason.includes(`Changed by: owner ${original.owner}`));
    } finally { reopenedStore.close(); }
    await assert.rejects(execute('work_amend', { ...amendment, idempotencyKey: 'owner-stale-amend' }), { code: 'STALE_GOAL' });
    await assert.rejects(execute('work_deliver', { ...final, idempotencyKey: 'owner-stale-final' }), { code: 'STALE_GOAL' });
    await assert.rejects(execute('work_report', { goalVersion: 2, kind: 'progress', summary: 'Not accepted',
      idempotencyKey: 'owner-unaccepted-progress' }), { code: 'NOT_ACCEPTED' });
    await execute('work_deliver', final); // Old-key replay cannot notify again or finish version 2.
    assert.equal(f.s.task(taskId).status, 'recorded');
    await execute('work_report', { goalVersion: 2, kind: 'accepted', summary: 'Accept new instruction', idempotencyKey: 'owner-accept-v2' });
    await execute('work_report', { goalVersion: 2, kind: 'progress', summary: 'Continue here', idempotencyKey: 'owner-progress-v2' });
    assert.equal(f.c.calls.length, calls, 'No Cockpit reads, dispatch, self-prompt or notification on amend/accept');
    const nextFinal = { ...final, goalVersion: 2, outcome: 'delivered', artifacts: ['/fixture/v2'], idempotencyKey: 'owner-final-v2' };
    await execute('work_deliver', nextFinal);
    await execute('work_deliver', nextFinal);
    const notifications = f.c.calls.filter(c => c.name === 'prompt' && c.body.sessionId === original.caller);
    assert.equal(notifications.length, 2);
    assert.match(notifications[0].body.text, /goalVersion=1;/);
    assert.match(notifications[1].body.text, /goalVersion=2; final=delivered/);
    assert.equal(f.c.calls.filter(c => c.name === 'session/new').length, 1);
    assert.equal(f.s.get('SELECT count(*) n FROM tasks').n, 1);
    const events = await execute('work_read', { view: 'events', limit: 50 });
    assert.deepEqual(events.items.find(e => e.goalVersion === 1 && e.kind === outcome).artifacts, ['/fixture/v1']);
    assert.deepEqual(events.items.find(e => e.goalVersion === 2 && e.kind === 'delivered').artifacts, ['/fixture/v2']);
  }
});

test('HTTP owner edits enforce task and session binding, instruction provenance and strict identity fields', async t => {
  const f = fixture(t), a = await f.dispatch(), b = await f.dispatch({ workstream: 'other', idempotencyKey: 'other-dispatch' });
  const taskId = a.task.taskId, token = readCredential(f.s.task(taskId).credential_path);
  const { app } = createApp({ store: f.s, cockpit: f.c });
  t.after(() => app.close());
  const request = (name, payload, bearer = token) => app.inject({ method: 'POST', url: `/api/tools/${name}`, payload,
    headers: { host: '127.0.0.1:8790', authorization: `Bearer ${bearer}` } });
  const amend = { taskId, goalVersion: 1, goal, ...ownerInstruction, idempotencyKey: 'http-owner-amend' };
  const edit = { taskId, action: 'update', recordRevision: 1, notes: 'Updated', ...ownerInstruction, idempotencyKey: 'http-owner-edit' };
  const credentials = [
    readCredential(f.s.task(b.task.taskId).credential_path),
    f.s.issue('owner', a.task.ownerSessionId, b.task.taskId),
    f.s.issue('owner', 'unbound-session', taskId),
    f.s.issue('viewer'), f.s.issue('admin'), f.s.issue('caller', 'unrelated-caller'),
  ];
  const before = f.s.all('SELECT * FROM tasks'), events = f.s.all('SELECT * FROM events');
  const mutations = f.s.get('SELECT count(*) n FROM mutations').n, calls = f.c.calls.length;
  for (const [name, input] of [['work_amend', amend], ['work_record', edit]]) {
    for (const credential of credentials) assert.equal((await request(name, input, credential)).statusCode, 403);
    assert.equal((await request(name, { ...input, taskId: b.task.taskId })).statusCode, 403);
    for (const field of ['owner', 'caller', 'ownerSessionId', 'callerSessionId', 'credential_path', 'status', 'accepted_version']) {
      assert.equal((await request(name, { ...input, [field]: 'forbidden' })).statusCode, 400, field);
    }
    for (const source of [undefined, '', ' ', 'x'.repeat(2001)]) {
      assert.equal((await request(name, { ...input, source })).statusCode, 400);
    }
  }
  assert.equal((await request('work_record', { ...edit, reason: undefined })).json().error, 'USER_INSTRUCTION_REQUIRED');
  assert.equal((await request('work_record', { ...edit, workstream: 'replacement' })).json().error, 'STABLE_WORKSTREAM');
  assert.equal((await request('work_record', { action: 'create', title: 'Unauthorized task', idempotencyKey: 'owner-no-create' })).statusCode, 403);
  assert.equal((await request('work_dispatch', { selection: 'continue', taskId, goalVersion: 1,
    message: 'Self-dispatch forbidden', idempotencyKey: 'owner-no-dispatch' })).statusCode, 403);
  assert.equal((await request('work_recover', { operationId: a.operation.operationId, idempotencyKey: 'owner-no-recover' })).statusCode, 403);
  assert.equal((await request('work_dependency', { action: 'add', taskId, prerequisiteId: b.task.taskId,
    recordRevision: 1, idempotencyKey: 'owner-no-dependency' })).statusCode, 403);
  assert.deepEqual(f.s.all('SELECT * FROM tasks'), before);
  assert.deepEqual(f.s.all('SELECT * FROM events'), events);
  assert.equal(f.s.get('SELECT count(*) n FROM mutations').n, mutations);
  assert.equal((await request('work_record', edit)).statusCode, 200);
  assert.equal((await request('work_amend', amend)).statusCode, 200);
  assert.equal(f.c.calls.length, calls);
});

test('caller-owner concurrency preserves both version domains and rejects stale competing writes', async t => {
  for (const ownerFirst of [true, false]) {
    const f = fixture(t), { task } = await f.dispatch(), taskId = task.taskId, owner = f.owner(taskId);
    const callerStore = new Store(f.dir), callerWork = new Work(callerStore, f.c);
    t.after(() => callerStore.close());
    const principals = ownerFirst ? [owner, f.caller] : [f.caller, owner];
    const execute = (principal, name, input) => (principal.role === 'caller' ? callerWork : f.w)
      .execute(principal, name, { taskId, ...ownerInstruction, ...input });
    await f.w.execute(owner, 'work_report', { taskId, goalVersion: 1, kind: 'accepted', summary: 'Accepted', idempotencyKey: 'race-accept' });
    const edits = await Promise.allSettled(principals.map((p, i) => execute(p, 'work_record', {
      action: 'update', recordRevision: 1, notes: `writer-${i}`, idempotencyKey: `race-edit-${i}`,
    })));
    assert.deepEqual(edits.map(r => r.status), ['fulfilled', 'rejected']);
    assert.equal(edits[1].reason.code, 'STALE_RECORD');
    assert.equal(f.s.task(taskId).notes, 'writer-0');
    assert.equal(f.s.task(taskId).version, 1);
    assert.equal(f.s.task(taskId).accepted_version, 1);
    const amended = await Promise.allSettled(principals.map((p, i) => execute(p, 'work_amend', {
      goalVersion: 1, goal: { ...goal, objective: `writer-${i}` }, idempotencyKey: `race-amend-${i}`,
    })));
    assert.deepEqual(amended.map(r => r.status), ['fulfilled', 'rejected']);
    assert.equal(amended[1].reason.code, 'STALE_GOAL');
    await Promise.all([
      execute(principals[0], 'work_amend', { goalVersion: 2, goal, idempotencyKey: 'race-independent-amend' }),
      execute(principals[1], 'work_record', { action: 'update', recordRevision: 2,
        notes: 'Latest metadata', idempotencyKey: 'race-independent-edit' }),
    ]);
    assert.equal(f.s.task(taskId).version, 3);
    assert.equal(f.s.task(taskId).record_revision, 3);
    assert.equal(f.s.task(taskId).notes, 'Latest metadata');
    assert.equal(f.s.task(taskId).accepted_version, null);
  }
});

test('owner amendment cannot bypass running, failed or unknown operations, or a deferred record', async t => {
  for (const state of ['running', 'failed', 'unknown']) {
    const f = fixture(t), { task } = await f.dispatch(), taskId = task.taskId, owner = f.owner(taskId);
    await f.w.execute(owner, 'work_report', { taskId, goalVersion: 1, kind: 'accepted', summary: 'Accepted', idempotencyKey: 'pending-accept' });
    const gate = Promise.withResolvers();
    if (state === 'running') f.c.gate = { name: 'prompt', promise: gate.promise };
    else f.c.failure = state === 'unknown' ? { name: 'prompt', error: new EffectUnknown('Unknown notification') } :
      { name: 'session/get', error: new WorkError('SESSION_NOT_FOUND', 'Missing caller', 404) };
    const delivery = f.w.execute(owner, 'work_deliver', { taskId, goalVersion: 1, outcome: 'delivered',
      summary: 'Done', artifacts: ['/fixture/result'], idempotencyKey: 'pending-final' });
    if (state === 'running') await new Promise(resolve => setImmediate(resolve));
    else await delivery;
    const operationId = f.s.task(taskId).active_op;
    assert.equal(f.s.get('SELECT status FROM operations WHERE id=?', operationId).status, state);
    const amend = { taskId, goalVersion: 1, goal, ...ownerInstruction, idempotencyKey: 'pending-amend' };
    const edit = { taskId, action: 'update', recordRevision: 1, notes: 'Cannot bypass', ...ownerInstruction, idempotencyKey: 'pending-edit' };
    try {
      await assert.rejects(f.w.execute(owner, 'work_amend', amend), { code: 'OPERATION_PENDING' });
      await assert.rejects(f.w.execute(owner, 'work_record', edit), { code: 'OPERATION_PENDING' });
      await assert.rejects(f.w.execute(f.caller, 'work_amend', amend), { code: 'OPERATION_PENDING' });
      assert.equal(f.s.task(taskId).version, 1);
      assert.equal(f.s.task(taskId).active_op, operationId);
    } finally { gate.resolve(); await delivery; }
  }
  const f = fixture(t), { task } = await f.dispatch(), taskId = task.taskId, owner = f.owner(taskId);
  const edit = { taskId, action: 'update', recordRevision: 1, disposition: 'deferred', ...ownerInstruction, idempotencyKey: 'pause-record' };
  await assert.rejects(f.w.execute(owner, 'work_record', edit), { code: 'EXECUTION_PROTECTED' });
  await f.w.execute(owner, 'work_report', { taskId, goalVersion: 1, kind: 'accepted', summary: 'Accepted', idempotencyKey: 'pause-accept' });
  await f.w.execute(owner, 'work_deliver', { taskId, goalVersion: 1, outcome: 'cancelled', summary: 'Paused by user', idempotencyKey: 'pause-final' });
  await f.w.execute(owner, 'work_record', edit);
  const amend = { taskId, goalVersion: 1, goal, ...ownerInstruction, idempotencyKey: 'pause-amend' };
  await assert.rejects(f.w.execute(owner, 'work_amend', amend), { code: 'RECORD_NOT_OPEN' });
  await assert.rejects(f.w.execute(f.caller, 'work_amend', amend), { code: 'RECORD_NOT_OPEN' });
  await f.w.execute(owner, 'work_record', { ...edit, recordRevision: 2, disposition: 'open', idempotencyKey: 'explicit-open' });
  assert.equal(f.s.task(taskId).status, 'cancelled');
  assert.equal(f.s.task(taskId).version, 1);
  await f.w.execute(owner, 'work_amend', amend);
  assert.equal(f.s.task(taskId).version, 2);
});

test('goal amendment prevents old stage/final receipt from completing new authorization', async t => {
  const f = fixture(t), a = await f.dispatch(), id = a.task.taskId, owner = f.owner(id);
  await f.w.execute(owner, 'work_report', { taskId: id, goalVersion: 1, kind: 'accepted', summary: 'research', idempotencyKey: 'accept-001' });
  await f.w.execute(owner, 'work_deliver', { taskId: id, goalVersion: 1, outcome: 'delivered', summary: 'research complete', artifacts: ['/tmp/research'], idempotencyKey: 'final-001' });
  await f.w.execute(f.caller, 'work_amend', { taskId: id, goalVersion: 1, goal: { ...goal, objective: 'Implement now' }, reason: 'Explicit implementation authorization', idempotencyKey: 'amend-001' });
  await assert.rejects(f.w.execute(owner, 'work_deliver', { taskId: id, goalVersion: 1, outcome: 'delivered', summary: 'late research receipt', artifacts: ['/tmp/research'], idempotencyKey: 'late-final' }), { code: 'STALE_GOAL' });
  assert.equal(f.s.task(id).status, 'recorded');
  assert.equal(f.s.task(id).version, 2);
  await assert.rejects(f.w.execute(owner, 'work_report', { taskId: id, goalVersion: 2, kind: 'progress', summary: 'unaccepted', idempotencyKey: 'progress-002' }), { code: 'NOT_ACCEPTED' });
  const next = await f.w.execute(f.caller, 'work_dispatch', { selection: 'continue', taskId: id, goalVersion: 2, message: 'Implement', idempotencyKey: 'continue-002' });
  assert.equal(next.task.ownerSessionId, a.task.ownerSessionId);
  assert.equal(f.c.calls.filter(c => c.name === 'session/new').length, 1);
});
test('unknown prompt persists owner and never auto-replays, including restart', async t => {
  const f = fixture(t); f.c.failure = { name: 'prompt', error: new EffectUnknown('connection lost after send') };
  const a = await f.dispatch();
  assert.equal(a.operation.status, 'unknown'); assert.ok(a.task.ownerSessionId);
  f.s.recoverInterrupted();
  await f.dispatch();
  assert.equal(f.c.calls.filter(c => c.name === 'prompt').length, 1);
  await assert.rejects(f.w.execute(f.caller, 'work_recover', { operationId: a.operation.operationId, idempotencyKey: 'recover-001' }), { code: 'RESOLUTION_REQUIRED' });
  f.c.failure = null;
  const recovered = await f.w.execute(f.caller, 'work_recover', {
    operationId: a.operation.operationId, idempotencyKey: 'recover-002',
    resolution: { outcome: 'applied', evidence: 'Inspected exact queued message with matching task marker' },
  });
  assert.equal(recovered.operation.status, 'succeeded');
  assert.equal(f.c.calls.filter(c => c.name === 'prompt').length, 1);
});
test('known failure after creation recovers same owner and completed steps', async t => {
  const f = fixture(t);
  f.c.failure = { name: 'session/get', sessionId: 'owner-2', error: new WorkError('READ_FAILED', 'offline', 502) };
  const a = await f.dispatch();
  assert.equal(a.operation.status, 'failed'); assert.ok(a.task.ownerSessionId);
  f.c.failure = null;
  const b = await f.w.execute(f.caller, 'work_recover', { operationId: a.operation.operationId, idempotencyKey: 'recover-001' });
  assert.equal(b.operation.status, 'succeeded');
  assert.equal(f.c.calls.filter(c => c.name === 'session/new').length, 1);
});
test('concurrent continuation is serialized; busy model mismatch sends nothing', async t => {
  const f = fixture(t), a = await f.dispatch(), id = a.task.taskId;
  f.c.sessions.get(a.task.ownerSessionId).status = 'running';
  const mismatch = await f.w.execute(f.caller, 'work_dispatch', {
    selection: 'continue', taskId: id, goalVersion: 1, modelId: 'different-model', message: 'continue', idempotencyKey: 'continue-001',
  });
  assert.equal(mismatch.operation.status, 'failed');
  assert.match(mismatch.operation.error, /BUSY_MODEL_MISMATCH/);
  assert.equal(f.c.calls.filter(c => c.name === 'setModel').length, 0);
  await assert.rejects(f.w.execute(f.caller, 'work_dispatch', {
    selection: 'continue', taskId: id, goalVersion: 1, message: 'competing', idempotencyKey: 'continue-002',
  }), { code: 'OPERATION_PENDING' });
});
test('unknown notification does not undo final result or send twice', async t => {
  const f = fixture(t), a = await f.dispatch(), id = a.task.taskId, owner = f.owner(id);
  await f.w.execute(owner, 'work_report', { taskId: id, goalVersion: 1, kind: 'accepted', summary: 'accepted', idempotencyKey: 'accept-001' });
  f.c.failure = { name: 'prompt', error: new EffectUnknown('notification timeout') };
  const args = { taskId: id, goalVersion: 1, outcome: 'delivered', summary: 'verified', artifacts: ['/tmp/result'], idempotencyKey: 'final-001' };
  const a1 = await f.w.execute(owner, 'work_deliver', args);
  assert.equal(a1.task.status, 'delivered'); assert.equal(a1.operation.status, 'unknown');
  await f.w.execute(owner, 'work_deliver', args);
  assert.equal(f.c.calls.filter(c => c.name === 'prompt').length, 2);
});
test('startup recovers persisted inflight effects as unknown without replay', async t => {
  const f = fixture(t), a = await f.dispatch();
  f.s.run("UPDATE operations SET status='running',step='prompt',inflight=1 WHERE id=?", a.operation.operationId);
  const second = new Store(f.dir);
  second.recoverInterrupted();
  assert.equal(second.get('SELECT status FROM operations WHERE id=?', a.operation.operationId).status, 'unknown');
  assert.equal(second.task(a.task.taskId).owner, a.task.ownerSessionId);
  second.close();
});
test('fork requires ready source and records a distinct owner', async t => {
  const f = fixture(t);
  f.c.sessions.set('source', { loaded: true, status: 'idle', currentModelId: 'gpt-6-astra' });
  const result = await f.w.execute(f.caller, 'work_dispatch', {
    selection: 'fork', sourceSessionId: 'source', workstream: 'forked', goal, idempotencyKey: 'fork-001',
  });
  assert.equal(result.operation.status, 'succeeded');
  assert.notEqual(result.task.ownerSessionId, 'source');
  assert.equal(f.c.calls.filter(c => c.name === 'session/fork').length, 1);
});
test('unknown creation must resolve real ID before any subsequent send', async t => {
  const f = fixture(t); f.c.failure = { name: 'session/new', error: new EffectUnknown('lost creation reply') };
  const result = await f.dispatch();
  assert.equal(result.task.ownerSessionId, null);
  await assert.rejects(f.w.execute(f.caller, 'work_recover', {
    operationId: result.operation.operationId, idempotencyKey: 'recover-001',
    resolution: { outcome: 'applied', evidence: 'Native creation confirmed but missing ID' },
  }), { code: 'SESSION_ID_REQUIRED' });
  f.c.failure = null;
  f.c.sessions.set('confirmed-owner', { loaded: true, status: 'idle', currentModelId: 'gpt-6-astra' });
  const recovered = await f.w.execute(f.caller, 'work_recover', {
    operationId: result.operation.operationId, idempotencyKey: 'recover-002',
    resolution: { outcome: 'applied', sessionId: 'confirmed-owner', evidence: 'Native returned this exact session ID for this request' },
  });
  assert.equal(recovered.task.ownerSessionId, 'confirmed-owner');
  assert.equal(f.c.calls.filter(c => c.name === 'session/new').length, 1);
});
test('unloaded owner recovery re-enables native defaults without creating a replacement', async t => {
  const f = fixture(t), a = await f.dispatch(), id = a.task.taskId;
  f.c.sessions.get(a.task.ownerSessionId).loaded = false;
  const result = await f.w.execute(f.caller, 'work_dispatch', {
    selection: 'continue', taskId: id, goalVersion: 1, message: 'Continue same goal', idempotencyKey: 'continue-001',
  });
  assert.equal(result.operation.status, 'succeeded');
  assert.equal(f.c.calls.filter(c => c.name === 'session/new').length, 1);
  assert.equal(f.c.calls.filter(c => c.name === 'session/load').length, 1);
  assert.equal(f.c.calls.filter(c => c.name === 'mcp/session-toggle').length, 2);
});
test('HTTP rejects anonymous tasks, forged roles, hostile origin and unknown input', async t => {
  const f = fixture(t), { app } = createApp({ store: f.s, cockpit: f.c });
  t.after(() => app.close());
  const inject = (url, payload, extra = {}) => app.inject({ method: 'POST', url, payload, headers: { host: '127.0.0.1:8790', ...extra } });
  assert.equal((await inject('/api/read', {})).statusCode, 401);
  const viewer = f.s.issue('viewer');
  assert.equal((await inject('/api/read', {}, { authorization: `Bearer ${viewer}`, origin: 'https://evil.invalid' })).statusCode, 403);
  assert.equal((await inject('/api/read', { madeUp: true }, { authorization: `Bearer ${viewer}` })).statusCode, 400);
  assert.equal((await inject('/api/tools/work_dispatch', { selection: 'new', cwd: f.dir, workstream: 'x', goal, idempotencyKey: 'http-001' }, { authorization: `Bearer ${viewer}` })).statusCode, 403);
  assert.equal((await inject('/api/login', { token: viewer })).statusCode, 404);
  assert.equal((await inject('/api/logout', {})).statusCode, 404);
  const cookie = `wc_view=${viewer}`;
  assert.equal((await inject('/api/read', {}, { cookie })).statusCode, 401);
  assert.equal((await inject('/api/read', {}, { authorization: `Bearer ${viewer}` })).statusCode, 200);
  assert.equal((await inject('/api/tools/work_read', {}, { cookie })).statusCode, 401);
});
test('dashboard has independent lane pagination and recent activity order', async t => {
  const f = fixture(t), first = await f.dispatch(), id = first.task.taskId;
  await f.dispatch({ workstream: 'second', idempotencyKey: 'dispatch-002' });
  const owner = f.owner(id);
  await f.w.execute(owner, 'work_report', { taskId: id, goalVersion: 1, kind: 'accepted', summary: 'active', idempotencyKey: 'accept-001' });
  const board = await f.w.execute(f.caller, 'work_read', { view: 'board', limit: 1 });
  assert.equal(board.groups.working.items[0].taskId, id);
  assert.ok(board.groups.working.nextBefore);
  assert.deepEqual(board.groups.closed.items, []);
  const older = await f.w.execute(f.caller, 'work_read', { group: 'working', before: board.groups.working.nextBefore, limit: 1 });
  assert.equal(older.items.length, 1);
  assert.notEqual(older.items[0].taskId, id);
  await f.w.execute(owner, 'work_report', { taskId: id, goalVersion: 1, kind: 'needs_decision', summary: 'fixture decision', idempotencyKey: 'decision-001' });
  const next = await f.w.execute(f.caller, 'work_read', { view: 'board' });
  assert.equal(next.groups.decision.items[0].taskId, id);
  assert.equal(next.groups.working.items.length, 1);
});
test('SSE invalidation and authenticated reads observe the same committed report', async t => {
  const f = fixture(t), a = await f.dispatch(), id = a.task.taskId;
  const { app, work } = createApp({ store: f.s, cockpit: f.c, port: 18793 });
  await app.listen({ host: '127.0.0.1', port: 18793 });
  const controller = new AbortController(), viewer = f.s.issue('viewer');
  t.after(async () => { controller.abort(); await app.close(); });
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/events`, {
    headers: { authorization: `Bearer ${viewer}` }, signal: controller.signal,
  });
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/);
  await work.execute(f.owner(id), 'work_report', {
    taskId: id, goalVersion: 1, kind: 'accepted', summary: 'Committed event', idempotencyKey: 'sse-accept-001',
  });
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: changed/);
  const value = await work.execute(f.s.authenticate(viewer), 'work_read', { taskId: id });
  assert.equal(value.status, 'active');
  assert.equal(value.summary, 'Committed event');
  await reader.cancel();
});
test('online backup restores versions, task ownership, credentials and idempotency', async t => {
  const f = fixture(t), a = await f.dispatch(), id = a.task.taskId, owner = f.owner(id);
  const input = { taskId: id, goalVersion: 1, kind: 'accepted', summary: 'Durable acceptance', idempotencyKey: 'backup-accept-001' };
  await f.w.execute(owner, 'work_report', input);
  const snapshot = join(f.dir, 'snapshot.db'), restoredDirectory = join(f.dir, 'restored');
  await backup(f.s.db, snapshot);
  mkdirSync(restoredDirectory); copyFileSync(snapshot, join(restoredDirectory, 'work.db'));
  const restored = new Store(restoredDirectory), work = new Work(restored, f.c);
  try {
    const principal = restored.authenticate(readCredential(f.s.task(id).credential_path));
    const before = restored.get('SELECT count(*) n FROM events').n;
    const response = await work.execute(principal, 'work_report', input);
    assert.equal(response.task.status, 'active');
    assert.equal(restored.task(id).owner, a.task.ownerSessionId);
    assert.equal(restored.get('SELECT count(*) n FROM events').n, before);
  } finally { restored.close(); }
});
test('one-line backlog registration, edits and dispositions have zero native effects', async t => {
  const f = fixture(t), input = { action: 'create', title: 'Maybe build this later', idempotencyKey: 'record-create-001' };
  const a = await f.w.execute(f.caller, 'work_record', input);
  const b = await f.w.execute(f.caller, 'work_record', input);
  assert.equal(a.task.taskId, b.task.taskId); assert.equal(a.task.goalVersion, 0);
  assert.equal(f.s.get('SELECT count(*) n FROM versions').n, 0);
  const updated = await f.w.execute(f.caller, 'work_record', {
    action: 'update', taskId: a.task.taskId, recordRevision: 1, title: 'Actually do Y later',
    disposition: 'deferred', reason: 'User chose later', idempotencyKey: 'record-update-001',
  });
  assert.equal(updated.task.goalVersion, 0); assert.equal(updated.task.recordRevision, 2);
  assert.equal((await f.w.execute(f.caller, 'work_read', { view: 'board' })).groups.deferred.items[0].taskId, a.task.taskId);
  await assert.rejects(f.w.execute(f.caller, 'work_record', {
    action: 'update', taskId: a.task.taskId, recordRevision: 1, title: 'Stale overwrite', idempotencyKey: 'record-stale-001',
  }), { code: 'STALE_RECORD' });
  await f.w.execute(f.caller, 'work_record', {
    action: 'update', taskId: a.task.taskId, recordRevision: 2, disposition: 'abandoned', reason: 'Not pursuing',
    idempotencyKey: 'record-abandon-001',
  });
  assert.equal((await f.w.execute(f.caller, 'work_read', {})).items.length, 0);
  assert.equal((await f.w.execute(f.caller, 'work_read', { includeClosed: true, query: 'Actually' })).items.length, 1);
  assert.equal(f.c.calls.length, 0); assert.equal(f.s.get('SELECT count(*) n FROM operations').n, 0);
});
test('starting a backlog preserves task ID, serializes retries and protects active authorization from metadata', async t => {
  const f = fixture(t);
  const a = await f.w.execute(f.caller, 'work_record', { action: 'create', title: 'One goal', idempotencyKey: 'record-create-001' });
  const input = { selection: 'new', taskId: a.task.taskId, recordRevision: 1, goal, cwd: f.dir, workstream: 'backlog-start', idempotencyKey: 'backlog-start-001' };
  const [first, second] = await Promise.all([f.w.execute(f.caller, 'work_dispatch', input), f.w.execute(f.caller, 'work_dispatch', input)]);
  assert.equal(first.task.taskId, a.task.taskId); assert.equal(second.task.taskId, a.task.taskId);
  assert.equal(first.task.goalVersion, 1); assert.equal(f.c.calls.filter(c => c.name === 'session/new').length, 1);
  const owner = f.owner(a.task.taskId);
  await f.w.execute(owner, 'work_report', { taskId: a.task.taskId, goalVersion: 1, kind: 'accepted', summary: 'Accepted', idempotencyKey: 'backlog-accept-001' });
  const metadata = await f.w.execute(f.caller, 'work_record', {
    action: 'update', taskId: a.task.taskId, recordRevision: first.task.recordRevision, title: 'Better label',
    notes: 'Only metadata, same goal', idempotencyKey: 'active-label-001',
  });
  assert.equal(metadata.task.goalVersion, 1); assert.equal(f.s.task(a.task.taskId).accepted_version, 1);
  await assert.rejects(f.w.execute(f.caller, 'work_record', {
    action: 'update', taskId: a.task.taskId, recordRevision: metadata.task.recordRevision,
    disposition: 'abandoned', reason: 'Try closing an active owner', idempotencyKey: 'active-close-001',
  }), { code: 'EXECUTION_PROTECTED' });
});
test('backlog lane is FIFO while the general list retains latest-activity ordering', async t => {
  const f = fixture(t);
  const first = await f.w.execute(f.caller, 'work_record', { action: 'create', title: 'First', idempotencyKey: 'fifo-first-001' });
  const second = await f.w.execute(f.caller, 'work_record', { action: 'create', title: 'Second', idempotencyKey: 'fifo-second-001' });
  assert.deepEqual((await f.w.execute(f.caller, 'work_read', { group: 'backlog' })).items.map(v => v.taskId),
    [first.task.taskId, second.task.taskId]);
  assert.deepEqual((await f.w.execute(f.caller, 'work_read', {})).items.map(v => v.taskId),
    [second.task.taskId, first.task.taskId]);
});
test('backlog dispatch unknown retains same task and owner and never becomes an editable unstarted record', async t => {
  const f = fixture(t), a = await f.w.execute(f.caller, 'work_record', { action: 'create', title: 'Later', idempotencyKey: 'record-create-001' });
  f.c.failure = { name: 'prompt', error: new EffectUnknown('after send') };
  const first = await f.w.execute(f.caller, 'work_dispatch', {
    selection: 'new', taskId: a.task.taskId, recordRevision: 1, goal, cwd: f.dir, idempotencyKey: 'backlog-start-001',
  });
  assert.equal(first.operation.status, 'unknown');
  assert.equal(first.task.taskId, a.task.taskId); assert.ok(first.task.ownerSessionId);
  await assert.rejects(f.w.execute(f.caller, 'work_record', {
    action: 'update', taskId: a.task.taskId, recordRevision: first.task.recordRevision, disposition: 'deferred', reason: 'Not a stop command',
    idempotencyKey: 'unknown-defer-001',
  }), { code: 'EXECUTION_PROTECTED' });
});
function migrationFixture(f, entries, filename = 'legacy-source.txt') {
  const source = join(f.dir, filename);
  writeFileSync(source, JSON.stringify(entries));
  const file = join(f.dir, 'manifest.json');
  writeFileSync(file, JSON.stringify({
    namespace: 'fixture-ledger', files: [{ path: source, sha256: hash(JSON.stringify(entries)) }],
    entries: entries.map((entry, i) => ({
      sourceKey: `row-${i}`, workstream: `legacy-${i}`, title: `Legacy ${i}`, ownerRef: 'same-old-owner',
      callerRef: 'historical-caller', observedAt: '2026-09-10 source observation', observedState: 'working',
      summary: 'Historical record, not fresh runtime state', notes: 'No deployment authorization',
      raw: { original: `complete original record ${i}` }, artifacts: [], supersedes: [], ...entry,
    })),
  }));
  const { manifestId } = stageManifest(f.dir, file);
  return loadManifest(f.dir, manifestId);
}
function importFixture(f, manifest) {
  const plan = planImport(f.s, manifest, f.caller.session_id);
  return f.s.tx(() => applyImport(f.s, manifest, f.caller.session_id, plan.planHash));
}
test('legacy import preserves repeated historical owners, original sources and credential state without execution', async t => {
  const f = fixture(t), beforeCredentials = f.s.get('SELECT count(*) n FROM credentials').n;
  const manifest = migrationFixture(f, [{ observedState: 'deferred' }, { observedState: 'done' }]);
  const first = importFixture(f, manifest), second = importFixture(f, manifest);
  assert.equal(first.totalTasks, 2); assert.equal(second.imported, 0); assert.equal(second.unchanged, 2);
  assert.equal(f.s.get('SELECT count(*) n FROM tasks WHERE owner IS NOT NULL').n, 0);
  assert.equal(f.s.get('SELECT count(*) n FROM credentials').n, beforeCredentials);
  assert.equal(f.s.get('SELECT count(*) n FROM versions').n, 0);
  assert.equal(f.s.get('SELECT count(*) n FROM operations').n, 0);
  assert.equal(f.c.calls.length, 0);
  const detail = await f.w.execute(f.caller, 'work_read', { workstream: 'legacy-0', view: 'detail' });
  assert.equal(detail.goal, null); assert.equal(detail.ownerSessionId, null);
  assert.equal(detail.legacy.ownerRef, 'same-old-owner');
  assert.equal(detail.callerSessionId, 'caller-fixture'); assert.equal(detail.legacy.callerRef, 'historical-caller');
  assert.equal((await f.w.execute(f.caller, 'work_read', { taskId: detail.taskId, view: 'sources' })).items[0].raw.original, 'complete original record 0');
  assert.equal((await f.w.execute(f.caller, 'work_read', { view: 'board' })).groups.deferred.items.length, 1);
  assert.equal((await f.w.execute(f.caller, 'work_read', { query: 'complete original record 1' })).items.length, 0);
  assert.equal((await f.w.execute(f.caller, 'work_read', { query: 'complete original record 1', includeClosed: true })).items[0].workstream, 'legacy-1');
});
test('import previews bound conflict output without hiding the total or allowing partial application', async t => {
  const f = fixture(t), entries = Array.from({ length: 25 }, (_, i) => ({ workstream: `legacy-${i}` }));
  for (const entry of entries) await f.w.execute(f.caller, 'work_record', {
    action: 'create', title: entry.workstream, workstream: entry.workstream, idempotencyKey: `existing-${entry.workstream}`,
  });
  const manifest = migrationFixture(f, entries), plan = planImport(f.s, manifest, f.caller.session_id);
  assert.equal(plan.conflicts.length, 20); assert.equal(plan.totalConflicts, 25);
  assert.throws(() => f.s.tx(() => applyImport(f.s, manifest, f.caller.session_id, plan.planHash)), { code: 'IMPORT_CONFLICT' });
  assert.equal(f.s.get('SELECT count(*) n FROM legacy_sources').n, 0);
  assert.equal(f.c.calls.length, 0);
});
test('staging rejects a combined snapshot that its bounded reader could not load', t => {
  const f = fixture(t);
  assert.throws(() => migrationFixture(f, [{ raw: 'x'.repeat(4 * 1024 * 1024) }]), { code: 'MANIFEST_TOO_LARGE' });
});
test('import source differences and local late receipts cannot be silently overwritten', async t => {
  const f = fixture(t), manifest = migrationFixture(f, [{}]), imported = importFixture(f, manifest);
  const id = imported.tasks[0].taskId;
  await f.w.execute(f.caller, 'work_observe', {
    taskId: id, recordRevision: 1, observedState: 'deferred', observedAt: '2026-09-10 22:20',
    summary: 'Code delivered, deployment explicitly paused', notes: 'Do not deploy', source: 'Caller received exact owner final receipt',
    updateCurrent: true, reason: 'Receipt is for the currently authorized code-only scope; publishing is still paused',
    idempotencyKey: 'legacy-receipt-001',
  });
  const changed = migrationFixture(f, [{ summary: 'Changed older source would overwrite receipt' }]);
  const plan = planImport(f.s, changed, f.caller.session_id);
  assert.equal(plan.conflicts.length, 1);
  assert.throws(() => f.s.tx(() => applyImport(f.s, changed, f.caller.session_id, plan.planHash)), { code: 'IMPORT_CONFLICT' });
  assert.equal(f.s.task(id).summary, 'Code delivered, deployment explicitly paused');
  assert.throws(() => planImport(f.s, manifest, f.caller.session_id), { code: 'SOURCE_CHANGED' });
  assert.equal(f.c.calls.length, 0);
});
test('legacy continuation explicitly adopts original owner; old receipts never overwrite adopted authorization', async t => {
  const f = fixture(t), manifest = migrationFixture(f, [{}]), imported = importFixture(f, manifest);
  const id = imported.tasks[0].taskId;
  await assert.rejects(f.w.execute(f.caller, 'work_dispatch', {
    selection: 'new', taskId: id, recordRevision: 1, goal, cwd: f.dir, idempotencyKey: 'legacy-replace-001',
  }), { code: 'ORIGINAL_OWNER_REQUIRED' });
  f.c.sessions.set('same-old-owner', { loaded: true, status: 'idle', currentModelId: 'gpt-6-astra' });
  const result = await f.w.execute(f.caller, 'work_dispatch', {
    selection: 'adopt', taskId: id, recordRevision: 1, goal, idempotencyKey: 'legacy-adopt-001',
  });
  assert.equal(result.operation.status, 'succeeded'); assert.equal(result.task.ownerSessionId, 'same-old-owner');
  assert.equal(f.c.calls.filter(c => c.name === 'session/new').length, 0);
  await f.w.execute(f.caller, 'work_observe', {
    taskId: id, recordRevision: result.task.recordRevision, observedState: 'done', observedAt: 'old source date',
    summary: 'Old research phase done', source: 'Late legacy receipt, not new execution outcome', idempotencyKey: 'legacy-late-receipt-001',
  });
  assert.equal(f.s.task(id).status, 'dispatched'); assert.equal(f.s.task(id).version, 1);
  assert.notEqual(f.s.task(id).summary, 'Old research phase done');
});
test('imported unassigned ideas start on the same ID but uncertain execution cannot invent an owner', async t => {
  const f = fixture(t), manifest = migrationFixture(f, [
    { ownerRef: null, observedState: 'backlog' }, { ownerRef: null, observedState: 'unknown' },
  ]);
  const imported = importFixture(f, manifest);
  await assert.rejects(f.w.execute(f.caller, 'work_dispatch', {
    selection: 'new', taskId: imported.tasks[1].taskId, recordRevision: 1, goal, cwd: f.dir, idempotencyKey: 'unknown-original-001',
  }), { code: 'NO_LEGACY_OWNER' });
  assert.equal(f.c.calls.length, 0);
  const result = await f.w.execute(f.caller, 'work_dispatch', {
    selection: 'new', taskId: imported.tasks[0].taskId, recordRevision: 1, goal, cwd: f.dir, idempotencyKey: 'imported-idea-001',
  });
  assert.equal(result.task.taskId, imported.tasks[0].taskId);
  assert.equal(result.task.goalVersion, 1);
  assert.equal(f.c.calls.filter(c => c.name === 'session/new').length, 1);
});
test('v1 upgrade preserves native IDs, credentials, owner binding and unknown-operation checkpoints', t => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-upgrade-'));
  let s = new Store(dir);
  t.after(() => { s.close(); rmSync(dir, { recursive: true }); });
  s.run(`INSERT INTO tasks(id,workstream,caller,owner,version,status,summary,active_op,created,updated)
    VALUES('old-task','old-stream','old-caller','old-owner',1,'active','existing','old-op',1,1)`);
  s.run(`INSERT INTO operations(id,task_id,version,kind,request,status,step,inflight,steps,created,updated)
    VALUES('old-op','old-task',1,'dispatch','{}','unknown','prompt',1,'{"create":{"sessionId":"old-owner"}}',1,1)`);
  const token = s.issue('owner', 'old-owner', 'old-task'), original = s.authenticate(token);
  s.db.exec(`DROP TABLE dependencies; DROP TABLE legacy_sources; DROP TABLE legacy_records; DROP TABLE import_snapshots;
    ALTER TABLE tasks DROP COLUMN title; ALTER TABLE tasks DROP COLUMN notes;
    ALTER TABLE tasks DROP COLUMN record_revision; ALTER TABLE tasks DROP COLUMN disposition;
    ALTER TABLE tasks DROP COLUMN sources; PRAGMA user_version=1;`);
  s.close(); s = new Store(dir);
  assert.equal(s.get('PRAGMA user_version').user_version, 3);
  assert.equal(s.task('old-task').owner, 'old-owner');
  assert.equal(s.task('old-task').active_op, 'old-op');
  assert.deepEqual(s.authenticate(token), original);
  assert.equal(s.get('SELECT status FROM operations WHERE id=?', 'old-op').status, 'unknown');
  assert.equal(s.task('old-task').title, 'old-stream');
});
test('default legacy receipt registration does not close newer implementation observations', async t => {
  const f = fixture(t), imported = importFixture(f, migrationFixture(f, [{}]));
  const id = imported.tasks[0].taskId;
  await f.w.execute(f.caller, 'work_observe', {
    taskId: id, recordRevision: 1, observedState: 'done', observedAt: 'older research receipt',
    summary: 'Research was complete', source: 'Historical stage reply', idempotencyKey: 'legacy-history-only-001',
  });
  const task = await f.w.execute(f.caller, 'work_read', { taskId: id });
  assert.equal(task.legacy.observedState, 'working');
  assert.equal(task.recordRevision, 2);
  assert.equal(f.c.calls.length, 0);
});
test('ledger cutover preserves original and publishes only a service pointer, with safe replay', t => {
  const f = fixture(t), manifest = migrationFixture(f, [{}], 'tasks.md');
  importFixture(f, manifest);
  const source = manifest.files[0].path, original = readFileSync(source, 'utf8');
  const result = cutoverLedger(f.s, manifest, source);
  assert.equal(readFileSync(result.archive, 'utf8'), original);
  assert.match(readFileSync(source, 'utf8'), /work-commander-cutover:/);
  assert.equal(cutoverLedger(f.s, manifest, source).alreadyApplied, true);
  assert.equal(f.c.calls.length, 0);
});
test('late source receipt aborts ledger cutover without overwriting the new file', t => {
  const f = fixture(t), manifest = migrationFixture(f, [{}], 'tasks.md');
  importFixture(f, manifest);
  const source = manifest.files[0].path;
  writeFileSync(source, 'New final receipt arrived while migration was being prepared');
  assert.throws(() => cutoverLedger(f.s, manifest, source), { code: 'SOURCE_CHANGED' });
  assert.equal(readFileSync(source, 'utf8'), 'New final receipt arrived while migration was being prepared');
});
