const idPattern = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const taskId = new RegExp(`^${idPattern}$`);
// Card labels name the relation, not a role or pronoun: the session's own Task, a Subtask it
// orchestrates, or a Task it subscribed to. Link targets and event keys stay unchanged, so earlier cards still parse.
export const TASK_EVENTS = Object.freeze({
  assigned: 'Task assigned',
  updated: 'Task updated',
  cancelled: 'Task cancelled',
  status_changed: 'Subscribed Task status changed',
  ready: 'Subtask ready',
  blocker_cancelled: 'Subtask blocker cancelled',
  child_done: 'Subtask done',
  child_blocked: 'Subtask blocked',
  child_cancelled: 'Subtask cancelled',
});
const taskTarget = new RegExp(`^task:(${idPattern})(?:\\?event=(${Object.keys(TASK_EVENTS).join('|')}))?$`);

export function taskReference(id, event) {
  if (typeof id !== 'string' || !taskId.test(id)) throw new Error('Invalid Task ID');
  if (event !== undefined && (typeof event !== 'string' || !Object.hasOwn(TASK_EVENTS, event))) {
    throw new Error('Invalid Task event');
  }
  return `[${event === undefined ? 'Task' : TASK_EVENTS[event]}](task:${id}${event === undefined ? '' : `?event=${event}`})`;
}

export function parseTaskTarget(target) {
  if (typeof target !== 'string') return null;
  const match = taskTarget.exec(target);
  return match ? { taskId: match[1].toLowerCase(), event: match[2] ?? null } : null;
}
