import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export const responsibilityInput = (store, task, actor, fields = {}) => {
  const current = store.task(typeof task === 'string' ? task : task.task_id);
  return {
    actor, request_id: randomUUID(), task_id: current.task_id,
    revision: current.revision, write_context: current.write_context, ...fields,
  };
};

export function orchestratingRoot(store, actor = 'orchestrator') {
  const existing = store.read({ view: 'list', assignee: actor }).items[0];
  if (existing) {
    assert.equal(existing.status, 'in_progress');
    assert.equal(existing.work_mode, 'orchestrate');
    return existing;
  }
  const root = store.executeLocal('task_create', {
    actor, request_id: randomUUID(), title: 'Synthetic root responsibility',
    description: 'Coordinate the synthetic child scenarios.',
  });
  store.executeLocal('task_claim', responsibilityInput(store, root, actor));
  store.executeLocal('task_ack', responsibilityInput(store, root, actor));
  return store.executeLocal('task_start', responsibilityInput(store, root, actor, { work_mode: 'orchestrate' }));
}

export async function serviceOrchestratingRoot(service, store, actor = 'orchestrator') {
  const existing = store.read({ view: 'list', assignee: actor }).items[0];
  if (existing) {
    assert.equal(existing.status, 'in_progress');
    assert.equal(existing.work_mode, 'orchestrate');
    return existing;
  }
  const created = await service.execute('task_create', {
    actor, request_id: randomUUID(), title: 'Synthetic root responsibility',
    description: 'Coordinate the synthetic child scenarios.',
  });
  assert.equal(created.error, null, JSON.stringify(created.error));
  for (const [name, fields] of [
    ['task_claim', {}], ['task_ack', {}], ['task_start', { work_mode: 'orchestrate' }],
  ]) {
    const result = await service.execute(name, responsibilityInput(store, created.result, actor, fields));
    assert.equal(result.error, null, JSON.stringify(result.error));
  }
  return store.task(created.result.task_id);
}

export function startExecution(store, task, actor = 'assignee', work_mode = 'execute') {
  return store.executeLocal('task_start', responsibilityInput(store, task, actor, { work_mode }));
}

export function finalizeCancellation(store, task, actor, summary = 'Stopped; no remaining work or resources.') {
  return store.executeLocal('task_cancel_finalize', responsibilityInput(store, task, actor, { summary }));
}
