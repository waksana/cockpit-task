const idPattern = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const taskId = new RegExp(`^${idPattern}$`);
// Card labels name the recipient's role for that Task; link targets stay unchanged.
export const TASK_EVENTS = Object.freeze({
  assigned: 'As Executor: Task assigned to you',
  updated: 'As Executor: Task updated',
  status_changed: 'As Owner: Task status updated',
  ready: 'As Owner: Task ready',
  blocker_cancelled: 'As Owner: Task blocker cancelled',
  child_done: 'As Owner: child Task done',
  child_blocked: 'As Owner: child Task blocked',
  child_cancelled: 'As Owner: child Task cancelled',
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
