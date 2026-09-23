import test from 'node:test';
import assert from 'node:assert/strict';
import { assignExecutor, createExecutor } from '../src/task-board/operations.js';

const input = {
  request_id: 'dispatch-1', task_id: 'd10c0c92-3580-4cdd-85bf-d7fcf22ab3ff',
  executor: 'executor', cwd: '/synthetic',
};

function assignment(overrides = {}) {
  const saved = [];
  const sent = [];
  let bindings = 0;
  return {
    saved, sent, get bindings() { return bindings; },
    run: () => assignExecutor({
      input,
      inspect: async () => ({ ready: true, idle: true }),
      bind: () => { bindings++; return { write_context: 'bound-context' }; },
      recheck: () => {},
      send: async (id, text) => { sent.push({ id, text }); return { ok: true, queued: false }; },
      save: value => saved.push(structuredClone(value)),
      ...overrides,
    }),
  };
}

test('assignment records uncertainty before sending exactly one assigned event reference', async () => {
  const f = assignment();
  const outcome = await f.run();
  assert.equal(outcome.error, null);
  assert.equal(outcome.result.operation.message, 'accepted');
  assert.equal(f.bindings, 1);
  assert.deepEqual(f.sent, [{ id: 'executor', text: `[Task assigned to you](task:${input.task_id}?event=assigned)` }]);
  assert.equal(f.saved.at(-2).result.operation.message, 'unknown');
});

test('missing capability and busy sessions are rejected before binding', async () => {
  for (const current of [{ ready: false, idle: true }, { ready: true, idle: false }]) {
    const details = {
      reasons: current.ready ? [] : ['MCP unavailable'], loaded: true, status: 'idle',
      availability_reasons: current.idle ? [] : ['queued_messages'], observed_at: '2026-09-21T00:00:00.000Z',
    };
    const f = assignment({ inspect: async () => ({ ...current, details }) });
    const outcome = await f.run();
    assert.equal(outcome.error.code, current.ready ? 'EXECUTOR_NOT_READY' : 'CAPABILITY_UNAVAILABLE');
    assert.deepEqual(outcome.result.operation.details, details);
    assert.deepEqual(f.saved.at(-1), outcome);
    assert.equal(outcome.result.operation.assignment, 'not_applied');
    assert.equal(outcome.result.operation.message, 'not_sent');
    assert.equal(f.bindings, 0);
    assert.equal(f.sent.length, 0);
  }
});

test('readiness lost after binding retains the second observation and never sends', async () => {
  for (const ready of [true, false]) {
    let calls = 0;
    const details = {
      reasons: ready ? [] : ['MCP disconnected'], loaded: true, status: 'idle',
      availability_reasons: ready ? ['pending_user_question'] : [], observed_at: '2026-09-21T00:00:01.000Z',
    };
    const f = assignment({
      inspect: async () => ++calls === 1
        ? { ready: true, idle: true, details: { availability_reasons: [], observed_at: '2026-09-21T00:00:00.000Z' } }
        : { ready, idle: !ready, details },
    });
    const outcome = await f.run();
    assert.equal(outcome.error.code, ready ? 'EXECUTOR_NOT_READY' : 'CAPABILITY_UNAVAILABLE');
    assert.equal(outcome.result.operation.assignment, 'applied');
    assert.equal(outcome.result.operation.message, 'not_sent');
    assert.equal(outcome.result.operation.status, 'partially_applied');
    assert.deepEqual(outcome.result.operation.details, details);
    assert.deepEqual(f.saved.at(-1), outcome);
    assert.equal(f.sent.length, 0);
  }
});

test('Task revision recheck prevents dispatch after a concurrent edit', async () => {
  const f = assignment({
    recheck: () => { throw Object.assign(new Error('Definition changed'), { code: 'DESCRIPTION_UPDATED' }); },
  });
  const outcome = await f.run();
  assert.equal(outcome.error.code, 'DESCRIPTION_UPDATED');
  assert.equal(outcome.result.operation.assignment, 'applied');
  assert.equal(outcome.result.operation.message, 'not_sent');
  assert.equal(f.sent.length, 0);
});

test('unknown sends are preserved without retry and unexpected queue is not hidden', async () => {
  let calls = 0;
  const f = assignment({ send: async () => { calls++; throw new Error('Connection lost'); } });
  const unknown = await f.run();
  assert.equal(calls, 1);
  assert.equal(unknown.result.operation.status, 'unconfirmed');
  assert.equal(unknown.result.operation.message, 'unknown');
  const queued = await assignment({ send: async () => ({ ok: true, queued: true }) }).run();
  assert.equal(queued.error.code, 'UNEXPECTED_QUEUE');
  assert.equal(queued.result.operation.message, 'queued');
});

test('cancellation after binding does not send or pretend the binding disappeared', async () => {
  const controller = new AbortController();
  const f = assignment({
    signal: controller.signal,
    recheck: () => controller.abort(),
  });
  const outcome = await f.run();
  assert.equal(outcome.result.operation.assignment, 'applied');
  assert.equal(outcome.result.operation.message, 'not_sent');
  assert.equal(outcome.error.code, 'REQUEST_CANCELLED');
  assert.equal(f.sent.length, 0);
});

test('session creation retains a known ID when capability preparation failed', async () => {
  const saved = [];
  let inspected = false;
  const outcome = await createExecutor({
    input,
    create: async () => { throw Object.assign(new Error('MCP unavailable'), { sessionId: 'created-id' }); },
    inspect: async () => { inspected = true; return { ready: true }; },
    save: result => saved.push(result),
  });
  assert.equal(inspected, false);
  assert.equal(outcome.result.operation.creation, 'created');
  assert.equal(outcome.result.operation.session_id, 'created-id');
  assert.equal(outcome.result.operation.status, 'partially_applied');
  assert.equal(saved[0].result.operation.creation, 'unknown');
});

test('creation with an unknown result does not attempt readiness or another creation', async () => {
  let creates = 0;
  const outcome = await createExecutor({
    input,
    create: async () => { creates++; throw new Error('Transport interrupted'); },
    inspect: async () => assert.fail('No ID exists to inspect'),
    save: () => {},
  });
  assert.equal(creates, 1);
  assert.equal(outcome.result.operation.creation, 'unknown');
  assert.equal(outcome.result.operation.status, 'unconfirmed');
});

test('successful creation checks readiness separately without sending', async () => {
  const outcome = await createExecutor({
    input,
    create: async cwd => { assert.equal(cwd, '/synthetic'); return { sessionId: 'new-executor' }; },
    inspect: async id => { assert.equal(id, 'new-executor'); return { ready: true, idle: true }; },
    save: () => {},
  });
  assert.equal(outcome.error, null);
  assert.equal(outcome.result.operation.capability, 'ready');
  assert.equal(outcome.result.operation.creation, 'created');
  assert.equal(outcome.result.operation.status, 'applied');
});

test('title provenance failure is a separate failed step and the dispatch still proceeds', async () => {
  let renamed = 0;
  const f = assignment({
    bind: () => ({ write_context: 'bound-context', title: 'Synthetic' }),
    retitle: {
      nameState: async () => { throw new Error('session/get unavailable'); },
      previous: () => null,
      rename: async () => { renamed++; return { ok: true, title: 'Synthetic' }; },
    },
  });
  const outcome = await f.run();
  assert.equal(outcome.error, null);
  assert.equal(outcome.result.operation.status, 'applied');
  assert.equal(outcome.result.operation.message, 'accepted');
  assert.deepEqual(outcome.result.operation.session_title, {
    status: 'failed', error: { code: 'TITLE_PROVENANCE_UNAVAILABLE', message: 'session/get unavailable' },
  });
  assert.equal(renamed, 0);
  assert.equal(f.sent.length, 1);
});

test('rename uncertainty is persisted before the host call', async () => {
  let f;
  let observed;
  f = assignment({
    bind: () => ({ write_context: 'bound-context', title: 'Synthetic' }),
    retitle: {
      nameState: async () => ({ name: null, userSet: false }),
      previous: () => null,
      rename: async () => { observed = f.saved.at(-1).result.operation.session_title; return { ok: true, title: 'Synthetic' }; },
    },
  });
  const outcome = await f.run();
  assert.deepEqual(observed, { status: 'unknown' });
  assert.deepEqual(outcome.result.operation.session_title, { status: 'renamed', title: 'Synthetic' });
});
