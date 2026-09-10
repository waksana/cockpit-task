import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { backup } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, readCredential, WorkError } from '../src/store.js';
import { Work } from '../src/work.js';
import { EffectUnknown } from '../src/cockpit.js';
import { createApp } from '../src/server.js';

const goal = { objective: 'Complete isolated fixture', scope: 'Fixture directory only', acceptance: 'Durable artifact and truthful outcome', authorization: 'Create fixture file; no external sends' };
class FakeCockpit {
  calls = []; sessions = new Map(); failure; gate;
  async call(name, body) {
    this.calls.push({ name, body });
    if (this.gate?.name === name) await this.gate.promise;
    if (this.failure?.name === name) throw this.failure.error;
    if (name === 'session/new' || name === 'session/fork') {
      const sessionId = `owner-${this.sessions.size + 1}`;
      this.sessions.set(sessionId, { loaded: true, status: 'idle', currentModelId: 'gpt-6-astra' });
      return { sessionId };
    }
    if (name === 'session/reload') this.sessions.get(body.sessionId).loaded = true;
    if (name === 'setModel') this.sessions.get(body.sessionId).currentModelId = body.modelId;
    return { ok: true, queued: true, status: 'connected' };
  }
  async meta(id) {
    this.calls.push({ name: 'session/get', body: { sessionId: id } });
    if (this.failure?.name === 'session/get') throw this.failure.error;
    const value = this.sessions.get(id);
    if (!value) throw new WorkError('SESSION_NOT_FOUND', 'Not found', 404);
    return { ...value };
  }
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'wc-test-')), s = new Store(dir), c = new FakeCockpit(), w = new Work(s, c);
  const caller = s.authenticate(s.issue('caller', 'caller-fixture'));
  t.after(() => { s.close(); rmSync(dir, { recursive: true }); });
  return { s, c, w, caller, dir,
    owner(id) { const task = s.task(id); return s.authenticate(readCredential(task.credential_path)); },
    dispatch(extra = {}) { return w.execute(caller, 'work_dispatch', { selection: 'new', cwd: dir, workstream: 'fixture', goal, idempotencyKey: 'dispatch-001', ...extra }); },
  };
}
test('one-call dispatch, owner reports, final single notification and compact read', async t => {
  const f = fixture(t), result = await f.dispatch(), id = result.task.taskId, owner = f.owner(id);
  assert.equal(result.operation.status, 'succeeded');
  assert.equal(result.task.status, 'dispatched');
  assert.deepEqual(f.c.calls.map(c => c.name), ['session/new', 'session/get', 'mcp/session-toggle', 'skills/session-toggle', 'prompt']);
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
  const f = fixture(t); f.c.failure = { name: 'session/get', error: new WorkError('READ_FAILED', 'offline', 502) };
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
  assert.equal(f.c.calls.filter(c => c.name === 'session/reload').length, 1);
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
  const login = await inject('/api/login', { token: viewer });
  assert.equal(login.statusCode, 200); assert.match(login.headers['set-cookie'], /HttpOnly; SameSite=Strict/);
  const cookie = login.headers['set-cookie'].split(';')[0];
  assert.equal((await inject('/api/read', {}, { cookie })).statusCode, 200);
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
