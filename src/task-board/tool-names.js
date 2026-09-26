export const TOOL_NAMES = Object.freeze([
  'task_read', 'task_create', 'task_script_register', 'task_script_read',
  'task_automation_start', 'task_automation_reconcile', 'task_session_create', 'task_session_prepare',
  'task_assign', 'task_edit', 'task_ack', 'task_reopen', 'task_report', 'task_cancel',
  'task_subscribe', 'task_unsubscribe', 'task_retro_handle',
]);

export function completeToolEntries(values, label) {
  const missing = TOOL_NAMES.filter(name => !Object.hasOwn(values, name));
  const unexpected = Object.keys(values).filter(name => !TOOL_NAMES.includes(name));
  if (missing.length || unexpected.length) {
    throw new Error(`${label} must match the published tool names; missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}`);
  }
  return TOOL_NAMES.map(name => [name, values[name]]);
}
