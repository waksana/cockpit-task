import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS } from '../src/task-board/contracts.js';
import { assertResponsibilityWaits } from '../src/task-board/responsibility-graph.js';

test('effective waits stay iterative at the structural limit and reject oversized input', () => {
  const tasks = Array.from({ length: LIMITS.treeNodes }, (_, index) => ({
    id: String(index), parent_task_id: index ? String(index - 1) : null,
    status: index === LIMITS.treeNodes - 1 ? 'todo' : 'in_progress', blockers: [],
  }));
  assert.doesNotThrow(() => assertResponsibilityWaits(tasks));
  tasks[0].blockers = [tasks.at(-1).id];
  assert.throws(() => assertResponsibilityWaits(tasks), { code: 'DEPENDENCY_CYCLE' });
  tasks.push({ id: 'too-many', parent_task_id: null, status: 'todo', blockers: [] });
  assert.throws(() => assertResponsibilityWaits(tasks), { code: 'TREE_RESOURCE_LIMIT' });
});

test('already started children can close under blocked ancestors without a false readiness cycle', () => {
  const tasks = [
    { id: 'p', parent_task_id: null, status: 'in_progress', blockers: ['d'] },
    { id: 'q', parent_task_id: null, status: 'in_progress', blockers: ['c'] },
    { id: 'c', parent_task_id: 'p', status: 'in_progress', blockers: [] },
    { id: 'd', parent_task_id: 'q', status: 'in_progress', blockers: [] },
  ];
  assert.doesNotThrow(() => assertResponsibilityWaits(tasks));
  tasks[2].status = 'todo';
  tasks[3].status = 'todo';
  assert.throws(() => assertResponsibilityWaits(tasks), { code: 'DEPENDENCY_CYCLE' });
});

test('terminal historical records do not make contradictory active prerequisite cycles valid', () => {
  assert.throws(() => assertResponsibilityWaits([
    { id: 'a', parent_task_id: null, status: 'cancelled', blockers: ['b'] },
    { id: 'b', parent_task_id: null, status: 'cancelled', blockers: ['a'] },
  ]), { code: 'DEPENDENCY_CYCLE' });
});
