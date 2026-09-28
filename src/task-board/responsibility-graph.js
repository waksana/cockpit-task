import { LIMITS, TaskError } from './contracts.js';

// Completion waits on children and own prerequisites. Unstarted work also waits
// on ancestor readiness; separate readiness nodes avoid expanding every lineage.
export function assertResponsibilityWaits(tasks) {
  if (tasks.length > LIMITS.treeNodes) {
    throw new TaskError('TREE_RESOURCE_LIMIT', 'Effective responsibility graph exceeds the bounded structural operation limit');
  }
  const allIndexes = new Map(tasks.map((task, index) => [task.id, index]));
  assertAcyclic(tasks.map(task => task.blockers.filter(id => allIndexes.has(id)).map(id => allIndexes.get(id))));
  const active = tasks.filter(task => !['done', 'cancelled'].includes(task.status));
  const indexes = new Map(active.map((task, index) => [task.id, index * 2]));
  const edges = Array.from({ length: active.length * 2 }, () => []);
  for (const task of active) {
    const completion = indexes.get(task.id), readiness = completion + 1;
    for (const id of task.blockers) {
      const blocker = indexes.get(id);
      if (blocker !== undefined) {
        edges[completion].push(blocker);
        edges[readiness].push(blocker);
      }
    }
    const parent = indexes.get(task.parent_task_id);
    if (parent !== undefined) {
      edges[parent].push(completion);
      edges[readiness].push(parent + 1);
    }
    if (task.status === 'todo') edges[completion].push(readiness);
  }
  assertAcyclic(edges);
}

function assertAcyclic(edges) {
  const state = new Uint8Array(edges.length);
  for (let node = 0; node < edges.length; node++) {
    if (state[node]) continue;
    state[node] = 1;
    const stack = [{ node, next: 0 }];
    while (stack.length) {
      const frame = stack.at(-1);
      if (frame.next === edges[frame.node].length) {
        state[frame.node] = 2;
        stack.pop();
        continue;
      }
      const next = edges[frame.node][frame.next++];
      if (state[next] === 1) {
        throw new TaskError('DEPENDENCY_CYCLE', 'Prerequisites, child completion and ancestor readiness would create a responsibility deadlock');
      }
      if (!state[next]) {
        state[next] = 1;
        stack.push({ node: next, next: 0 });
      }
    }
  }
}
