const taskId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function taskReference(id) {
  if (typeof id !== 'string' || !taskId.test(id)) throw new Error('Invalid Task ID');
  return `[Task](task:${id})`;
}
