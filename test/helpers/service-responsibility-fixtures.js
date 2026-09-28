import assert from 'node:assert/strict';

let sequence = 0;
export const responsibilityContext = task => ({
  task_id: task.task_id ?? task.id, revision: task.revision, write_context: task.write_context,
});

export function startResponsibility(store, taskId, actor, work_mode = 'execute') {
  const call = (name, fields) => store.executeLocal(name, {
    actor, request_id: `service-fixture-${++sequence}`,
    ...responsibilityContext(store.task(taskId)), ...fields,
  });
  call('task_ack');
  call('task_start', { work_mode });
  return store.task(taskId);
}

export function seedOrchestratingRoot(store, actor = 'orchestrator') {
  const existing = store.read({ view: 'list', assignee: actor, status: 'unfinished' }).items[0];
  if (existing) {
    assert.equal(existing.status, 'in_progress');
    assert.equal(existing.work_mode, 'orchestrate');
    return store.task(existing.id ?? existing.task_id);
  }
  const created = store.executeLocal('task_create', {
    actor: 'user', request_id: `service-fixture-${++sequence}`,
    title: `Responsibility for ${actor}`, description: 'Coordinate the synthetic integration work.',
  });
  store.executeLocal('task_claim', {
    actor, request_id: `service-fixture-${++sequence}`, ...responsibilityContext(created),
  });
  return startResponsibility(store, created.task_id, actor, 'orchestrate');
}
