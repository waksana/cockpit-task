const idPattern = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const taskId = new RegExp(`^${idPattern}$`);
export const TASK_EVENTS = Object.freeze({
  assigned: 'Task assigned to you',
  updated: 'Task updated',
  status_changed: 'Task status updated',
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
