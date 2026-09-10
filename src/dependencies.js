import { fail, now } from './store.js';

const stateSql = `CASE
  WHEN d.goal_version IS NULL THEN 'needs_confirmation'
  WHEN d.goal_version <> p.version THEN 'needs_confirmation'
  WHEN p.status='delivered' AND EXISTS (
    SELECT 1 FROM events e WHERE e.task_id=p.id AND e.version=d.goal_version AND e.kind='delivered'
  ) THEN 'satisfied'
  ELSE 'waiting' END`;

export function dependencySummary(store, taskId) {
  const counts = { satisfied: 0, waiting: 0, needsConfirmation: 0 };
  const rows = store.all(`SELECT ${stateSql} AS state, COUNT(*) AS n
    FROM dependencies d JOIN tasks p ON p.id=d.prerequisite_id
    WHERE d.task_id=? GROUP BY state`, taskId);
  for (const row of rows) counts[row.state === 'needs_confirmation' ? 'needsConfirmation' : row.state] = row.n;
  return { ready: counts.waiting === 0 && counts.needsConfirmation === 0,
    total: counts.satisfied + counts.waiting + counts.needsConfirmation, ...counts };
}

export function readDependencies(work, principal, task, input) {
  const rows = work.store.all(`SELECT d.*, p.title, p.caller, p.owner, p.id, p.version,
    ${stateSql} AS state FROM dependencies d JOIN tasks p ON p.id=d.prerequisite_id
    WHERE d.task_id=? AND d.seq<? ORDER BY d.seq DESC LIMIT ?`,
  task.id, input.before ?? Number.MAX_SAFE_INTEGER, input.limit + 1);
  return {
    conditions: dependencySummary(work.store, task.id),
    items: rows.slice(0, input.limit).map(row => ({
      prerequisiteId: row.prerequisite_id, prerequisiteGoalVersion: row.goal_version,
      state: row.state,
      reason: row.goal_version === null ? 'no_bound_goal' : row.goal_version !== row.version ? 'goal_changed' :
        row.state === 'satisfied' ? 'delivered' : 'not_delivered',
      note: row.note,
      ...(work.visible(principal, row) ? { title: row.title } : {}),
    })),
    nextBefore: rows.length > input.limit ? rows[input.limit - 1].seq : null,
  };
}

export function editDependency(work, principal, input) {
  const s = work.store, task = s.task(input.taskId);
  work.authorize(principal, 'caller', task);
  const prerequisite = s.task(input.prerequisiteId);
  work.authorize(principal, 'caller', prerequisite);
  work.recordCurrent(task, input.recordRevision);
  fail(task.id === prerequisite.id, 'SELF_DEPENDENCY', 'A task cannot depend on itself');
  const existing = s.get('SELECT * FROM dependencies WHERE task_id=? AND prerequisite_id=?', task.id, prerequisite.id);
  let version = existing?.goal_version;
  if (input.action === 'add') {
    fail(existing, 'DEPENDENCY_EXISTS', 'Dependency already exists; explicitly remove it before rebinding');
    if (input.prerequisiteGoalVersion !== undefined) work.current(prerequisite, input.prerequisiteGoalVersion);
    version = prerequisite.version || null;
    // Reachability is only a graph constraint, never recursive execution/readiness.
    const cycle = s.get(`WITH RECURSIVE reachable(id) AS (
      SELECT ? UNION SELECT d.prerequisite_id FROM dependencies d JOIN reachable r ON d.task_id=r.id
    ) SELECT 1 AS found FROM reachable WHERE id=?`, prerequisite.id, task.id);
    fail(cycle, 'DEPENDENCY_CYCLE', 'This relation would create a dependency cycle');
    s.run('INSERT INTO dependencies(task_id,prerequisite_id,goal_version,note) VALUES(?,?,?,?)',
      task.id, prerequisite.id, version, input.note ?? '');
  } else {
    fail(!existing, 'DEPENDENCY_NOT_FOUND', 'No such dependency exists');
    s.run('DELETE FROM dependencies WHERE task_id=? AND prerequisite_id=?', task.id, prerequisite.id);
  }
  s.run('UPDATE tasks SET record_revision=record_revision+1,updated=? WHERE id=?', now(), task.id);
  s.event(task, input.action === 'add' ? 'dependency_added' : 'dependency_removed',
    `${prerequisite.id} @ ${version === null ? 'unconfirmed' : `v${version}`}${(input.note ?? existing?.note) ? `: ${input.note ?? existing.note}` : ''}`);
  return { task: work.summary(s.task(task.id)), executionChanged: false, notification: 'not_sent', nativeCalls: 0 };
}
