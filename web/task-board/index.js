import { parseTaskTarget, TASK_EVENTS } from '../../src/task-board/reference.js';
import { createReadCache } from './read-resource.js';
import { ICONS } from './icons.js';
import { createSessionSummaries } from './session-summaries.js';
import { createTaskMenu, summaryIcon, summaryNotice, summaryBadgeNotice } from './session-entry.js';

const STATUS_LABELS = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

const NOTICE_ICONS = {
  assigned: 'assigned',
  updated: 'updated',
  cancelled: 'cancelled',
  cancellation_requested: 'cancelled',
  status_changed: 'activity',
  blocked: 'blocked',
  ready: 'ready',
  blocker_cancelled: 'cancelled',
  child_done: 'done',
  child_blocked: 'blocked',
  child_cancelled: 'cancelled',
};

export function parseTaskReference(node) {
  return node?.kind === 'link' ? parseTaskTarget(node.target)?.taskId ?? null : null;
}

export function safeReferenceHref(target) {
  if (typeof target !== 'string' || /[\u0000-\u0020\u007f]/u.test(target)) return null;
  try {
    const url = new URL(target);
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function statusLabel(status) {
  return Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status] : `Unknown status (${String(status)})`;
}

export function acknowledgementLabel(revision, acknowledgedRevision) {
  if (acknowledgedRevision === null) return `Definition v${revision} · not ACKed`;
  return `Definition v${revision} · ACK v${acknowledgedRevision}${acknowledgedRevision === revision ? '' : ' · current definition not ACKed'}`;
}

export function dependencyLabel(blockedBy, ready) {
  if (!Array.isArray(blockedBy) || !blockedBy.length) return null;
  const tasks = blockedBy.filter((entry) => entry.task_id).length;
  const conditions = blockedBy.length - tasks;
  const cancelled = blockedBy.filter((entry) => entry.status === 'cancelled').length;
  const kinds = [tasks ? `${tasks} Task${tasks === 1 ? '' : 's'}` : null,
    conditions ? `${conditions} condition${conditions === 1 ? '' : 's'}` : null].filter(Boolean).join(' + ');
  return `Blocked by ${blockedBy.length} unmet prerequisite${blockedBy.length === 1 ? '' : 's'} (${kinds})`
    + `${cancelled ? ` · ${cancelled} cancelled Task${cancelled === 1 ? ' needs' : 's need'} replanning` : ''}`;
}

export function delegationLabel(parentTaskId, depth) {
  if (typeof parentTaskId !== 'string' || !parentTaskId) return null;
  return `Subtask · delegation level ${Number.isSafeInteger(depth) ? depth : 'unknown'}`;
}

export function workModeLabel(task) {
  if (task.kind === 'automation') return 'Service-managed · no Agent work mode';
  if (task.work_mode === null) return task.legacy ? 'Legacy · work mode not recorded' : 'Work mode unavailable';
  const labels = { undecided: 'Undecided', execute: 'Execute', orchestrate: 'Orchestrate' };
  return Object.hasOwn(labels, task.work_mode) ? labels[task.work_mode] : 'Work mode unavailable';
}

export function terminalGateLabel(task) {
  const count = task.children?.nonterminal;
  return Number.isSafeInteger(count) && count >= 0
    ? count ? `${count} unfinished direct child${count === 1 ? '' : 'ren'} prevent both Done and Cancelled.`
      : 'All direct children are terminal (Done or Cancelled). This does not prove the overall goal succeeded.'
    : 'Both Done and Cancelled require every direct child to be Done or Cancelled; child completion is not overall success.';
}

export function webActionUnavailable(task, action) {
  if (['task_start', 'task_convert', 'task_claim', 'task_ack', 'task_report'].includes(action)) {
    return 'Assignee session only. Web requests act as the signed-in user, never as the viewed session. The responsible session must read and ACK the Task, then start or convert its own responsibility.';
  }
  if (action === 'task_reopen') {
    if (task.kind === 'automation' || task.status !== 'done') return 'Only a Done Agent Task can reopen; cancelled and automation Tasks cannot reopen.';
    if (!task.assignee) return 'Reopening requires the original bound assignee.';
    if (!['execute', 'orchestrate'].includes(task.work_mode)) return 'Legacy work mode is unknown; explicit migration review is required before reopening.';
    if (task.cancellation_request) return 'Cancellation intent prevents reopening.';
    return null;
  }
  if (action === 'task_automation_reconcile') {
    return task.kind === 'automation' && task.automation?.barrier &&
      ['succeeded', 'failed', 'interrupted', 'cancelled'].includes(task.automation.state) ? null
      : 'Only a finished or interrupted automation run with a launch barrier can be reconciled; running processes must not be bypassed.';
  }
  if (['done', 'cancelled'].includes(task.status)) return 'This Task is terminal.';
  if (action === 'task_cancel_finalize') {
    if (task.kind === 'automation') return 'Automation cancellation is service-managed.';
    if (!task.cancellation_request) return 'Record a cancellation request before finalizing.';
    if (task.assignee) return 'Only the bound assignee can finalize cancellation after arranging child closure and residual handling.';
    if (task.children?.nonterminal > 0) return terminalGateLabel(task);
  }
  if (task.cancellation_request && ['task_assign', 'task_attach', 'task_create', 'task_automation_start'].includes(action)) {
    return 'Cancellation is requested. Do not advance the abandoned goal; arrange closure instead.';
  }
  if (action === 'task_cancel' && task.cancellation_request) return 'Cancellation already requested; this is not terminal Cancelled.';
  if (action === 'task_assign' && (task.kind === 'automation' || task.assignee)) return 'Only an unbound Agent Task can be assigned.';
  if (action === 'task_attach' && task.parent_task_id) return 'Only an existing root can be attached; reparenting is not supported.';
  if (action === 'task_create' && (task.kind === 'automation' || !task.assignee || task.status !== 'in_progress' || task.work_mode !== 'orchestrate')) {
    return 'Creating a child requires a bound, active orchestrating parent.';
  }
  if (action === 'task_create' && (task.ready !== true || task.acknowledged_revision !== task.revision)) {
    return 'Creating a child requires current parent prerequisites to be satisfied and the exact definition to be ACKed.';
  }
  if (['task_edit', 'task_resolve_condition'].includes(action) && task.kind === 'automation' && task.automation?.state !== 'created') {
    return 'Started automation definitions and prerequisites are immutable.';
  }
  if (action === 'task_automation_start') {
    if (task.kind !== 'automation' || task.status !== 'todo' || task.automation?.state !== 'created') {
      return 'Only a created, unstarted automation Task can be queued once.';
    }
    if (task.ready !== true) return 'Satisfy every current prerequisite before starting automation.';
  }
  return null;
}

const WEB_ACTION_FIELDS = {
  task_create: ['title', 'description', 'parent_task_id', 'automation'],
  task_edit: ['title', 'description', 'references', 'metadata', 'blocked_by', 'reason'],
  task_reopen: ['description', 'reason'],
  task_automation_start: [],
  task_automation_reconcile: ['reason'],
  task_assign: ['assignee'],
  task_attach: ['parent_task_id', 'parent_write_context', 'reason'],
  task_resolve_condition: ['dependency_id', 'evidence', 'references'],
  task_cancel: ['reason'],
  task_cancel_finalize: ['summary'],
  task_subscribe: ['subscriber', 'statuses'],
};

export function webMutationInput(action, task, values, requestId, { current = true, parent } = {}) {
  const fields = WEB_ACTION_FIELDS[action];
  if (!fields) throw new Error('This action cannot be performed as the Web user.');
  if (!current) throw new Error('Read current Task facts before writing; stale or disconnected data cannot authorize an action.');
  if (action === 'task_create' && values.parent_task_id?.trim()) {
    const candidate = parent ?? (values.parent_task_id.trim() === task.id ? task : null);
    if (!candidate || candidate.id !== values.parent_task_id.trim() || !candidate.write_context) {
      throw new Error('Read the current prospective parent before creating a child.');
    }
    const unavailable = webActionUnavailable(candidate, 'task_create');
    if (unavailable) throw new Error(unavailable);
  }
  if (action !== 'task_create') {
    const unavailable = webActionUnavailable(task, action);
    if (unavailable) throw new Error(unavailable);
    if (!task.write_context) throw new Error('Read current Task facts before writing.');
  }
  const input = { request_id: requestId };
  if (action !== 'task_create') {
    Object.assign(input, { task_id: task.id, write_context: task.write_context });
    if (!['task_cancel', 'task_subscribe', 'task_automation_reconcile'].includes(action)) input.revision = task.revision;
  }
  for (const field of fields) if (values[field] !== undefined && values[field] !== '') {
    input[field] = ['assignee', 'subscriber', 'parent_task_id'].includes(field) ? values[field].trim() : values[field];
  }
  if (action === 'task_subscribe' && !input.subscriber?.trim()) throw new Error('Select an explicit subscriber session; creation history is not a recipient.');
  return input;
}

export async function writeTask(context, action, input) {
  if (!Object.hasOwn(WEB_ACTION_FIELDS, action) || Object.keys(input).some(key => ['actor', 'invocation', 'caller', 'session_id'].includes(key))) {
    throw new Error('Web actions cannot supply or impersonate a caller.');
  }
  const response = await context.request(`/tools/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: context.signal,
  });
  let envelope;
  try { envelope = await response.json(); } catch {
    throw new Error('Write acknowledgement is unknown. Read the original operation by request ID before another action; do not retry.');
  }
  if (!envelope || typeof envelope !== 'object' || !Object.hasOwn(envelope, 'result') || !Object.hasOwn(envelope, 'error')) {
    throw new Error('Write acknowledgement is invalid. Inspect the original operation before another action; do not retry.');
  }
  return { http_status: response.status, ...envelope };
}

export function formatTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return 'Time unavailable';
  return new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC');
}

function responseError(error, fallback) {
  const failure = new Error(typeof error?.message === 'string' ? error.message : fallback);
  failure.code = typeof error?.code === 'string' ? error.code : 'READ_FAILED';
  return failure;
}

function validResult(input, data) {
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = (value) => typeof value === 'string';
  const revision = (value) => Number.isSafeInteger(value) && value > 0;
  const references = (value) => Array.isArray(value) && value.every((ref) => object(ref) && text(ref.label) && text(ref.target));
  const entry = (value) => object(value) && revision(value.revision) && text(value.author) && text(value.at);
  const retro = (value, full) => value === undefined || (object(value) && (
    ['not_recorded', 'not_applicable'].includes(value.status) ||
    (value.status === 'recorded' && entry(value) && text(value.assignee) &&
      text(value.outcome_id) && value.source === 'reported' && typeof value.current === 'boolean' &&
      typeof value.has_findings === 'boolean' && (!full ||
        (value.has_findings ? text(value.text) && value.text.trim().length > 0 && value.text.length <= 2000 : value.text === null)))
  ));
  const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
  const automation = (value) => object(value) && text(value.run_id) && text(value.script_id) && text(value.state);
  const dependencies = (value) => value.blocked_by === undefined || (Array.isArray(value.blocked_by) &&
    value.blocked_by.every((entry) => object(entry) &&
      ((text(entry.task_id) && text(entry.status) && entry.condition === undefined)
        || (text(entry.condition) && entry.task_id === undefined && entry.status === undefined)))
    && typeof value.ready === 'boolean' && value.ready === (value.blocked_by.length === 0));
  const lineage = (value) => (value.parent_task_id === undefined || value.parent_task_id === null || text(value.parent_task_id)) &&
    (value.depth === undefined || (Number.isSafeInteger(value.depth) && value.depth > 0));
  if (!object(data)) return false;
  if (input.view === 'operation') return true;
  if (input.view === 'list' || input.view === 'ancestors') {
    return Array.isArray(data.items) && data.items.length <= (input.limit ?? 50) &&
      (data.next_cursor === null || (text(data.next_cursor) && data.next_cursor.length > 0)) &&
      data.items.every((item) => object(item) && text(item.task_id) && text(item.title) && text(item.status) && lineage(item) &&
        (input.parent_task_id === undefined || item.parent_task_id === input.parent_task_id));
  }
  if (input.view === 'automation_log') {
    return data.task_id === input.task_id && text(data.run_id) && nonnegative(data.offset) &&
      data.offset === (input.offset ?? 0) && text(data.text) && data.text.length <= (input.limit ?? 4096) &&
      (data.next_offset === null || (nonnegative(data.next_offset) && data.next_offset > data.offset)) &&
      nonnegative(data.retained_characters) && nonnegative(data.omitted_characters) && typeof data.complete === 'boolean';
  }
  if (input.view === 'overview' || input.view === 'execution') {
    if (data.id !== input.task_id || !text(data.title) || !text(data.created_by) ||
        !(data.parent_assignee === null || text(data.parent_assignee)) ||
        !(data.work_mode === null || ['undecided', 'execute', 'orchestrate'].includes(data.work_mode)) ||
        !(data.assignee === null || text(data.assignee)) || !text(data.status) ||
        !revision(data.revision) || !(data.acknowledged_revision === null || revision(data.acknowledged_revision))) return false;
    if (data.kind !== undefined && !['agent', 'automation'].includes(data.kind)) return false;
    if (data.children !== undefined && (!object(data.children) || !nonnegative(data.children.total) ||
        !nonnegative(data.children.nonterminal) || data.children.nonterminal > data.children.total)) return false;
    if (data.cancellation_request !== undefined && data.cancellation_request !== null &&
        (!object(data.cancellation_request) || !text(data.cancellation_request.reason))) return false;
    if (data.activity_count !== undefined && data.activity_count !== null && !nonnegative(data.activity_count)) return false;
    if (data.data_version !== undefined && (!text(data.data_version) || !/^[a-f0-9]{64}$/.test(data.data_version))) return false;
    if (data.sessions !== undefined && (!object(data.sessions) || !['assignee', 'parent_assignee'].every(key => {
      const session = data.sessions[key];
      return data[key] === 'user' || data[key] === null ? session === null
        : object(session) && session.session_id === data[key] &&
          (session.title === null || text(session.title)) && typeof session.available === 'boolean';
    }))) return false;
    if (data.outcome?.summary !== undefined && !text(data.outcome.summary)) return false;
    if (!dependencies(data) || !lineage(data)) return false;
    if (!retro(data.retro, input.view === 'execution')) return false;
    if (data.kind === 'automation') {
      if (data.assignee !== null || data.work_mode !== null || data.acknowledged_revision !== null ||
          !(data.automation === null || automation(data.automation))) return false;
      if (input.view === 'execution' && data.automation !== null) {
        const { script, parameters } = data.automation;
        if (!object(script) || !text(script.script_id) || !text(script.title) || !text(script.description) ||
            !text(script.executable) || !text(script.script_path) || !text(script.sha256) ||
            !Array.isArray(script.argv) || !script.argv.every(text) ||
            !Array.isArray(script.parameters) || !script.parameters.every((parameter) =>
              object(parameter) && text(parameter.name) && ['string', 'integer', 'boolean'].includes(parameter.type) && text(parameter.description)) ||
            !object(parameters) || !Object.values(parameters).every((value) =>
              text(value) || typeof value === 'boolean' || Number.isSafeInteger(value))) return false;
      }
    }
    if (input.view === 'execution') return text(data.description) && references(data.references) && object(data.metadata);
    if (input.include?.length === 1 && input.include[0] === 'context') return true;
    return data.activity === null || (entry(data.activity) && text(data.activity.text) && typeof data.activity.truncated === 'boolean');
  }
  if (input.view === 'changelog' && input.revision !== undefined) {
    return entry(data) && data.revision === input.revision && text(data.reason) && text(data.description);
  }
  if (!Array.isArray(data.items) || data.items.length > (input.limit ?? 10) ||
      !(data.next_cursor === null || (text(data.next_cursor) && data.next_cursor.length > 0))) return false;
  if (input.view === 'responsibility_events') return data.task_id === input.task_id && data.items.every(item =>
    object(item) && item.task_id === input.task_id && text(item.kind) && text(item.author) && text(item.at) && object(item.details));
  if (input.view === 'dependencies') {
    return data.task_id === input.task_id && data.items.every(item => object(item)
      && text(item.dependency_id) && item.task_id === input.task_id && text(item.author) && text(item.created_at)
      && ((item.kind === 'task' && text(item.blocker_id) && item.condition === undefined)
        || (item.kind === 'condition' && text(item.condition) && item.blocker_id === undefined))
      && typeof item.active === 'boolean'
      && (item.active
        ? item.resolved_at === null && item.resolved_by === null && item.resolution === null
        : text(item.resolved_at) && text(item.resolved_by) && ['done', 'removed', 'evidence'].includes(item.resolution)));
  }
  return data.items.every((item) => entry(item) && (input.view === 'changelog' ? text(item.reason)
    : (text(item.assignee) || (input.view === 'outcomes' && item.assignee === null &&
        item.source === 'automation' && text(item.run_id) && item.author === `automation:${item.run_id}`)) &&
      (input.view === 'activity' ? text(item.text) : text(item.summary) && references(item.references) && retro(item.retro, true))));
}

export async function readTask(context, input, signal) {
  const response = await context.request('/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
  let envelope;
  try {
    envelope = await response.json();
  } catch {
    throw responseError(null, `Task read returned an invalid response (HTTP ${response.status}).`);
  }
  if (envelope?.error) throw responseError(envelope.error, 'Task read failed.');
  if (!response.ok) throw responseError(null, `Task read failed (HTTP ${response.status}).`);
  if (!envelope || envelope.error !== null || !validResult(input, envelope.result)) {
    throw responseError(null, 'Task read returned an invalid result.');
  }
  return envelope.result;
}

export function nativeStatusLabel(data) {
  if (!data.available) return 'Unavailable';
  if (data.loaded === false) return 'Unloaded';
  return data.status?.trim() || 'Unknown (not provided by host)';
}

export async function readNativeSession(context, taskId, signal) {
  const response = await context.request(`/tasks/${encodeURIComponent(taskId)}/native`, { method: 'GET', signal });
  let data;
  try {
    data = await response.json();
  } catch {
    throw responseError(null, `Native session read returned an invalid response (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    throw responseError(data?.error, `Native session state is unavailable (HTTP ${response.status}).`);
  }
  if (!data || data.source !== 'native' || typeof data.available !== 'boolean' ||
      !(data.session_id === null || typeof data.session_id === 'string') ||
      !(typeof data.loaded === 'boolean' || (!data.available && data.loaded === null)) ||
      (data.status !== undefined && typeof data.status !== 'string') ||
      typeof data.observed_at !== 'string') {
    throw responseError(null, 'Native session read returned an invalid result.');
  }
  return data;
}

const readCaches = new WeakMap();

export function createReadResource(context, input) {
  if (!readCaches.has(context)) readCaches.set(context, createReadCache(context, (query, signal) =>
    query.view === 'native' ? readNativeSession(context, query.task_id, signal) : readTask(context, query, signal)));
  return readCaches.get(context).get(input);
}

export function taskStateIcon(state) {
  if (state.data) return summaryIcon(state.data.status);
  if (state.phase === 'offline') return 'offline';
  if (state.phase === 'error') return 'error';
  return state.phase === 'loading' ? 'refresh' : 'unknown';
}

export function cardSummary(task) {
  if (task.status === 'cancelled' && typeof task.cancellation?.reason === 'string') return task.cancellation.reason;
  if (task.cancellation_request && !['done', 'cancelled'].includes(task.status)) return `Cancellation requested · ${task.cancellation_request.reason ?? 'Arrange closure before finalizing.'}`;
  if (task.kind === 'automation') return `Automation · ${task.automation?.state ?? 'Run state unavailable'}${task.automation?.exit_code == null ? '' : ` · exit ${task.automation.exit_code}`}`;
  if (task.ready === false) return dependencyLabel(task.blocked_by, task.ready);
  if (task.outcome?.current && typeof task.outcome.summary === 'string') return task.outcome.summary;
  if (task.activity?.current === false) return `Earlier activity · v${task.activity.revision}: ${task.activity.text}`;
  return task.activity?.text ?? (task.activity === undefined ? 'Reported activity unavailable in this read.' : 'No reported activity.');
}

export function activate(context) {
  if (context.apiVersion !== 2 || context.uiVersion !== 1) {
    throw new Error('Task requires Cockpit Web API v2 and Module UI v1.');
  }
  if (context.uiSurfaceVersion !== 1) {
    throw new Error('Task requires Cockpit uiSurfaceVersion v1; upgrade the paired host first.');
  }
  if (typeof context.createPortal !== 'function') {
    throw new Error('Task requires the host createPortal capability.');
  }
  if (context.sessionListItemVersion !== 1 || context.globalComponentVersion !== 1 || context.menuVersion !== 1) {
    throw new Error('Task requires sessionListItemVersion v1, globalComponentVersion v1 and menuVersion v1; upgrade the paired host first.');
  }
  const React = context.react;
  const h = React.createElement;
  const { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, useId, useCallback } = React;
  const summaries = createSessionSummaries(context);
  const taskMenu = createTaskMenu(summaries, context.signal);

  function useSessionSummary(sessionId) {
    const subscribe = useCallback(listener => summaries.watch(sessionId, listener), [sessionId]);
    const snapshot = useCallback(() => summaries.get(sessionId), [sessionId]);
    return useSyncExternalStore(subscribe, snapshot, snapshot);
  }

  function SessionSummary({ state }) {
    const task = state.data?.task;
    const notice = summaryBadgeNotice(state);
    if (!notice && !task) return null;
    const label = [notice, task && `Task: ${statusLabel(task.status)}; ${task.position}; ${task.title}`,
      task && notice && 'Last-read data; current state unconfirmed'].filter(Boolean).join(' · ');
    return h('span', { className: 'ck-badge tb-session-summary', role: 'img', title: label, 'aria-label': label,
      'data-status': task?.status, 'data-unconfirmed': Boolean(notice) || undefined },
    task ? h('span', { className: 'tb-session-state' }, h(Icon, { name: summaryIcon(task.status) })) : null,
    task ? h('span', { className: 'tb-session-position' }, task.position) : null,
    notice ? h('span', { className: 'tb-session-notice' }, `${task ? '· ' : ''}${notice}`) : null);
  }

  function SessionTaskDialog() {
    const opened = useSyncExternalStore(taskMenu.subscribe, taskMenu.getSnapshot, taskMenu.getSnapshot);
    return opened ? h(Detail, { key: opened.taskId, taskId: opened.taskId, onClose: taskMenu.close }) : null;
  }

  function useRead(input) {
    const key = JSON.stringify(input);
    const resource = useMemo(() => createReadResource(context, JSON.parse(key)), [key]);
    const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot);
    useEffect(() => {
      resource.start();
      return resource.stop;
    }, [resource]);
    return { ...state, retry: resource.refresh };
  }

  function Icon({ name }) {
    return h('svg', { className: 'ck-icon ck-icon-sm', viewBox: '0 0 24 24', 'aria-hidden': true, focusable: false },
      ICONS[name].map(([tag, attrs], index) => h(tag, { key: index, ...attrs })));
  }

  function Refresh({ state, label = 'Refresh Task', onClick }) {
    return h('button', { type: 'button', className: 'ck-icon-button tb-refresh', title: label,
      'aria-label': label, 'aria-busy': Boolean(state.refreshing),
      disabled: state.refreshing || state.phase === 'loading' || state.phase === 'offline',
      onClick: onClick ?? state.retry }, h(Icon, { name: 'refresh' }));
  }

  function Disclosure({ title, children }) {
    const [open, setOpen] = useState(false);
    const id = useId();
    return h('section', { className: 'tb-disclosure' },
      h('button', { type: 'button', className: 'ck-button tb-disclosure-toggle',
        'aria-expanded': open, 'aria-controls': id, onClick: () => setOpen(value => !value) },
      h(Icon, { name: 'chevron' }), title),
      h('div', { id, hidden: !open }, open ? children : null));
  }

  function SessionName({ id, title }) {
    return h('span', { className: 'tb-session-name', title: title || id || 'Unassigned' }, title || id || 'Unassigned');
  }

  function ReadState({ state, children, subject = 'Task data' }) {
    const container = useRef(null);
    let notice = null;
    if (state.phase === 'loading' && !state.data) notice = h('p', { role: 'status' }, `Loading ${subject}…`);
    else if (state.phase === 'offline') notice = h('p', { role: 'status' }, state.data
      ? 'Disconnected. Showing last-read data; current state is unconfirmed.'
      : `Disconnected. No cached ${subject}.`);
    else if (state.error) notice = h('div', { className: 'tb-read-error' },
      h('p', { role: 'alert' }, state.phase === 'missing'
        ? `This Task was not found.${state.data ? ' Retained data is historical, not current.' : ''}`
        : `Unable to read ${subject}: ${state.error.message}${state.data ? ' Showing last-read data.' : ''}`),
      h('button', {
        type: 'button', className: 'ck-button',
        onClick: () => { container.current.focus(); void state.retry(); },
      }, 'Retry'));
    return h('div', { ref: container, tabIndex: -1, role: 'region', 'aria-label': subject, 'aria-busy': Boolean(state.refreshing) },
      notice, state.data ? children(state.data) : null);
  }

  function NativeSession({ taskId }) {
    const state = useRead({ view: 'native', task_id: taskId });
    const heading = useRef(null);
    return h(React.Fragment, null,
      h('h3', { ref: heading, tabIndex: -1 }, 'Native session observation'),
      h('p', { className: 'ck-text-secondary' }, 'A host observation, separate from reported Task activity. This read does not load the session or poll for updates; native status does not establish Task progress.'),
      h(ReadState, { state, subject: 'native session state' }, (data) => h(React.Fragment, null,
        h('dl', { className: 'tb-facts' },
          h('dt', null, 'Source'), h('dd', null, 'Native host'),
          h('dt', null, 'Assignee session'), h('dd', null, data.session_id ?? 'No assignee'),
          h('dt', null, 'Native state'), h('dd', null, nativeStatusLabel(data)),
          h('dt', null, 'Observed at'), h('dd', null, formatTimestamp(data.observed_at))),
        data.error ? h('p', { role: 'alert', className: 'tb-read-error' },
          typeof data.error === 'string' ? data.error : (typeof data.error.message === 'string' ? data.error.message : 'The host returned an unspecified native-state error.')) : null,
        !data.available && data.session_id ? h('p', null, 'The host could not provide current native state. No running or idle state is inferred.') : null,
        data.available && !data.loaded ? h('p', null, 'The session is unloaded. It was not loaded by this read.') : null,
      )),
      h(Refresh, { state, label: 'Refresh session observation' }),
    );
  }

  function References({ references }) {
    if (!references.length) return h('p', { className: 'ck-text-secondary' }, 'No references.');
    return h('ul', { className: 'tb-references' }, references.map((reference, index) => {
      const href = safeReferenceHref(reference.target);
      return h('li', { key: index }, href
        ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, reference.label)
        : h('span', null, reference.label, ' — ', reference.target, ' (non-navigable reference)'));
    }));
  }

  function TaskFacts({ task }) {
    const automated = task.kind === 'automation';
    const dependency = dependencyLabel(task.blocked_by, task.ready);
    return h('dl', { className: 'tb-facts' },
      h('dt', null, automated ? 'Execution' : 'Assignee'), h('dd', null, automated ? 'Automation service · no Agent assignee'
        : h(SessionName, { id: task.assignee, title: task.sessions?.assignee?.title })),
      h('dt', null, 'Parent assignee'), h('dd', null, task.parent_assignee
        ? h(SessionName, { id: task.parent_assignee, title: task.sessions?.parent_assignee?.title })
        : task.parent_task_id ? 'Parent is unbound; creator is not a substitute' : 'None · ordinary root'),
      h('dt', null, 'Work mode'), h('dd', null, workModeLabel(task)),
      h('dt', null, 'Created by (historical)'), h('dd', null, task.created_by),
      h('dt', null, automated ? 'Definition' : 'Definition / ACK'),
      h('dd', null, automated ? `Definition v${task.revision}` : acknowledgementLabel(task.revision, task.acknowledged_revision)),
      h('dt', null, 'Prerequisites'), h('dd', null, dependency ?? 'No unmet prerequisites'),
      h('dt', null, 'Child termination gate'), h('dd', null, terminalGateLabel(task)),
    );
  }

  function LazyTask({ taskId, title = taskId }) {
    return h(Disclosure, { title }, h(Card, { taskId }));
  }

  function ChildTaskList({ taskId, ancestors = false, filters = null }) {
    const [cursors, setCursors] = useState([null]);
    const cursor = cursors.at(-1);
    const state = useRead({ ...(ancestors ? { view: 'ancestors', task_id: taskId }
      : { view: 'list', ...(filters ?? { parent_task_id: taskId, status: 'all' }) }),
      limit: 50, ...(cursor ? { cursor } : {}) });
    const subject = ancestors ? 'Ancestors' : filters ? 'Tasks' : 'Subtasks';
    const pageLabel = useRef(null);
    const previousCursor = useRef(cursor);
    useEffect(() => {
      if (previousCursor.current !== cursor) {
        previousCursor.current = cursor;
        pageLabel.current?.focus();
      }
    }, [cursor]);
    return h(React.Fragment, null,
      h(ReadState, { state, subject }, (page) => page.items.length
        ? h('ul', { className: 'tb-references' }, page.items.map((child) =>
          h('li', { key: child.task_id }, h(LazyTask, { taskId: child.task_id, title: child.title }),
            h('span', { className: 'ck-text-secondary tb-history-author' }, statusLabel(child.status),
              child.cancellation_request && !['done', 'cancelled'].includes(child.status)
                ? ' · Cancellation requested (not terminal)' : '', ' · ', workModeLabel(child),
              child.kind === 'automation' ? ` · Run: ${child.automation?.state ?? 'unavailable'}` : h(React.Fragment, null, ' · Assignee: ',
                h(SessionName, { id: child.assignee, title: child.sessions?.assignee?.title }))))))
        : h('p', null, `No ${subject} recorded.`)),
      h('nav', { className: 'tb-page-controls', 'aria-label': ancestors ? 'Ancestor pages' : filters ? 'Task pages' : 'Subtask pages' },
        h('button', { type: 'button', className: 'ck-button', disabled: cursors.length === 1,
          onClick: () => setCursors(current => current.slice(0, -1)) }, 'Previous page'),
        h('span', { ref: pageLabel, tabIndex: -1, role: 'status' }, `Page ${cursors.length}`),
        h('button', { type: 'button', className: 'ck-button', disabled: state.phase !== 'ready' || !state.data?.next_cursor || state.refreshing,
          onClick: () => setCursors(current => [...current, state.data.next_cursor]) }, 'Next page'),
        h(Refresh, { state, label: `Refresh ${subject}` })));
  }

  function ChildTasks({ taskId }) {
    return h(Disclosure, { title: 'Subtasks delegated from this Task' }, h(ChildTaskList, { taskId }));
  }

  function Retro({ retro }) {
    return h('section', { 'aria-label': 'Completion retro' },
      h('h3', null, 'Completion retro'),
      retro?.status === 'recorded' ? h(React.Fragment, null,
        h('p', { className: 'ck-text-secondary' },
          `Definition v${retro.revision} · Assignee: ${retro.assignee} · Reported author: ${retro.author} · ${formatTimestamp(retro.at)}`),
        !retro.current ? h('p', { className: 'ck-text-secondary' }, 'Historical retro; not a retrospective on the current definition.') : null,
        h('p', { className: 'tb-preserve' }, retro.has_findings ? retro.text : 'Explicitly reported no findings.'),
      ) : h('p', { className: 'ck-text-secondary' }, retro?.status === 'not_applicable'
        ? 'Not applicable to script automation; no Agent retrospective required.'
        : 'No retro recorded. This does not establish that reflection occurred.'),
    );
  }

  function Automation({ automation }) {
    if (!automation) return h('p', null, 'Automation execution facts unavailable.');
    const { script, parameters } = automation;
    const facts = [
      ['Run ID', automation.run_id], ['Script ID', automation.script_id], ['Run state', automation.state],
      ['Execution definition', automation.revision === null ? 'Not captured' : `v${automation.revision}`],
      ['Queued at', formatTimestamp(automation.queued_at)], ['Started at', formatTimestamp(automation.started_at)],
      ['Finished at', formatTimestamp(automation.finished_at)], ['Exit code', automation.exit_code ?? 'Not available'],
      ['Signal', automation.signal ?? 'None recorded'], ['Error', automation.error ?? 'None recorded'],
      ['Cancellation requested', automation.cancel_requested ? 'Yes' : 'No'],
      ['Process ID', automation.pid ?? 'Not available'], ['Process group', automation.process_group ?? 'Not available'],
      ['Launch barrier', automation.barrier ? 'Set' : 'Not set'],
    ];
    return h(React.Fragment, null,
      h('h3', null, 'Automation execution'),
      h('dl', { className: 'tb-facts' }, facts.map(([label, value]) =>
        h(React.Fragment, { key: label }, h('dt', null, label), h('dd', null, String(value))))),
      h(Disclosure, { title: 'Immutable script and parameter snapshot' },
      h('h3', null, 'Immutable script snapshot'),
      h('p', null, script.title),
      h('p', { className: 'tb-preserve' }, script.description),
      h('dl', { className: 'tb-facts' },
        h('dt', null, 'Executable'), h('dd', null, script.executable),
        h('dt', null, 'Script path'), h('dd', null, script.script_path),
        h('dt', null, 'Arguments'), h('dd', { className: 'tb-preserve' }, JSON.stringify(script.argv)),
        h('dt', null, 'SHA-256'), h('dd', null, script.sha256)),
      h('h3', null, 'Immutable parameter snapshot'),
      h('pre', { className: 'tb-preserve tb-metadata' }, JSON.stringify(parameters, null, 2)),
      script.parameters.length ? h('dl', { className: 'tb-facts' }, script.parameters.map((parameter) =>
        h(React.Fragment, { key: parameter.name },
          h('dt', null, `${parameter.name} (${parameter.type})`), h('dd', null, parameter.description)))) : null),
    );
  }

  function Execution({ task, overview }) {
    const summaryTask = task.activity === undefined && task.data_version === overview?.data_version
      ? { ...task, activity: overview?.activity } : task;
    return h(React.Fragment, null,
      h('div', { className: 'tb-detail-grid' },
        h('div', { className: 'tb-detail-main' },
          h('section', { className: 'tb-current' },
            h('h3', null, task.status === 'cancelled' ? 'Cancellation' : task.cancellation_request ? 'Cancellation requested · not terminal' : task.ready === false ? 'Unmet prerequisites'
              : task.outcome?.current ? 'Latest outcome' : summaryTask.activity?.current === false ? 'Earlier reported activity' : 'Current progress'),
            h('p', { className: 'tb-preserve' }, task.status !== 'cancelled' && !task.cancellation_request && task.outcome?.current ? task.outcome.summary : cardSummary(summaryTask)),
            task.status === 'cancelled' && task.cancellation?.summary
              ? h('p', { className: 'tb-preserve' }, `Final disposition: ${task.cancellation.summary}`) : null,
            task.status !== 'cancelled' && !task.cancellation_request && task.outcome?.current ? h(References, { references: task.outcome.references ?? [] }) : null),
          task.kind === 'automation' ? h(React.Fragment, null,
            h('p', { className: 'ck-text-secondary' }, 'Task completion does not mean script success. Cancellation does not prove process exit or rollback.'),
            h(Automation, { automation: task.automation }), h(Disclosure, { title: 'Execution log' }, h(AutomationLogs, { taskId: task.id }))) : null,
          h('h3', null, 'Task description'), h('p', { className: 'tb-preserve' }, task.description),
          task.references.length ? h(React.Fragment, null, h('h3', null, 'References'), h(References, { references: task.references })) : null),
        h('aside', { className: 'tb-detail-aside' },
          h('h3', null, 'Responsibility and definition'), h(TaskFacts, { task }),
          h(Disclosure, { title: 'Full session names and IDs' },
            h('p', { className: 'tb-preserve' }, `Assignee: ${task.sessions?.assignee?.title ?? task.assignee ?? 'Unassigned'}`),
            h('p', { className: 'tb-preserve' }, `Assignee ID: ${task.assignee ?? 'None'}`),
            h('p', { className: 'tb-preserve' }, `Parent assignee: ${task.sessions?.parent_assignee?.title ?? task.parent_assignee ?? 'None'}`),
            h('p', { className: 'tb-preserve' }, `Parent assignee ID: ${task.parent_assignee ?? 'None'}`),
            ['assignee', 'parent_assignee'].map(key => task.sessions?.[key]?.error
              ? h('p', { key, className: 'ck-text-secondary' }, `${key} title unavailable: ${task.sessions[key].error.message ?? task.sessions[key].error}`) : null)),
          task.kind !== 'automation' && task.assignee
            ? h(Disclosure, { title: 'Session observation' }, h(NativeSession, { taskId: task.id })) : null)),
      h(Disclosure, { title: 'Technical information' },
        h('p', { className: 'tb-preserve' }, `Task ID: ${task.id}`),
        h('p', null, `Created by (historical): ${task.created_by}. Creation history grants no current authority.`),
        h('p', null, `Created: ${formatTimestamp(task.created_at)} · Updated: ${formatTimestamp(task.updated_at)}`),
        h('p', null, 'Current data, not a message-time snapshot. Reading does not ACK. Reports do not prove live session activity.'),
        h('pre', { className: 'tb-preserve tb-metadata' }, JSON.stringify(task.metadata, null, 2))),
    );
  }

  function Relations({ task }) {
    return h(React.Fragment, null,
      h('h3', null, 'Unmet prerequisites'),
      task.blocked_by?.length ? h('ul', { className: 'tb-references' }, task.blocked_by.map((entry, index) =>
        h('li', { key: entry.task_id ?? index }, entry.task_id
          ? h(React.Fragment, null, statusLabel(entry.status), h(LazyTask, { taskId: entry.task_id }))
          : h('p', { className: 'tb-preserve' }, entry.condition)))) : h('p', null, 'No unmet prerequisites. This does not establish session availability.'),
      task.parent_task_id ? h(React.Fragment, null, h('h3', null, 'Parent Task'), h('p', null, delegationLabel(task.parent_task_id, task.depth)),
        h(LazyTask, { taskId: task.parent_task_id }),
        h(Disclosure, { title: 'Paged ancestors' }, h(ChildTaskList, { taskId: task.id, ancestors: true }))) : h('p', null, 'Ordinary root · no parent'),
      task.kind !== 'automation' ? h(ChildTasks, { taskId: task.id }) : null,
      h(Disclosure, { title: 'Find Tasks by responsibility' }, h(TaskBrowser)),
      h(Disclosure, { title: 'Prerequisite history' }, h(History, { taskId: task.id, view: 'dependencies' })));
  }

  function TaskBrowser() {
    const [filters, setFilters] = useState({ status: 'unfinished' });
    const [draft, setDraft] = useState({ status: 'unfinished', root: '', work_mode: '', parent_task_id: '', parent_assignee: '', assignee: '' });
    return h(React.Fragment, null,
      h('form', { className: 'tb-form', onSubmit: event => {
        event.preventDefault();
        setFilters(Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== '')
          .map(([key, value]) => [key, key === 'root' ? value === 'true' : value.trim()])));
      } },
      [['status', 'Status', ['unfinished', 'all', 'todo', 'in_progress', 'done', 'cancelled']],
        ['root', 'Position', ['', 'true', 'false']], ['work_mode', 'Work mode', ['', 'undecided', 'execute', 'orchestrate']],
        ['parent_task_id', 'Parent Task ID'], ['parent_assignee', 'Parent assignee session'], ['assignee', 'Assignee session']].map(([name, label, options]) =>
        h('label', { key: name }, label, options ? h('select', { name, value: draft[name],
          onChange: event => setDraft(current => ({ ...current, [name]: event.target.value })) }, options.map(value =>
          h('option', { key: value, value }, name === 'root' ? ({ '': 'Any position', true: 'Ordinary roots', false: 'Children' })[value]
            : value || 'Any mode (including automation / legacy)')))
          : h('input', { name, value: draft[name], maxLength: name === 'parent_task_id' ? 36 : 200,
            onChange: event => setDraft(current => ({ ...current, [name]: event.target.value })) }))),
      h('button', { type: 'submit', className: 'ck-button' }, 'Apply filters')),
      h(ChildTaskList, { key: JSON.stringify(filters), filters }));
  }

  function OperationReceipt({ requestId }) {
    const state = useRead({ view: 'operation', request_id: requestId });
    return h(React.Fragment, null,
      h(ReadState, { state, subject: 'original operation receipt' }, data =>
        h('pre', { className: 'tb-preserve tb-metadata' }, JSON.stringify(data, null, 2))),
      h(Refresh, { state, label: 'Refresh original operation receipt' }));
  }

  function MutationForm({ task, action, label, fields, initial = {}, fixed = {}, current, refresh, explanation }) {
    const [values, setValues] = useState(initial);
    const [receipt, setReceipt] = useState(null);
    const [error, setError] = useState(null);
    const [pending, setPending] = useState(false);
    const requestId = useRef(null);
    const submitted = useRef(false);
    const openedTask = useRef({ id: task.id, revision: task.revision, write_context: task.write_context });
    const staleDraft = openedTask.current.id !== task.id || openedTask.current.revision !== task.revision ||
      openedTask.current.write_context !== task.write_context;
    const unavailable = action === 'task_create' ? null : webActionUnavailable(task, action);
    const disabled = !current || staleDraft || Boolean(unavailable) || pending || submitted.current;
    return h('form', { className: 'tb-form', 'aria-label': label, 'aria-busy': pending, onSubmit: async event => {
      event.preventDefault();
      if (disabled || submitted.current) return;
      let sent = false;
      submitted.current = true;
      setPending(true);
      setError(null);
      try {
        const fields = { ...values, ...fixed };
        let parent;
        if (action === 'task_attach' || (action === 'task_create' && fields.parent_task_id?.trim())) {
          parent = action === 'task_create' && fields.parent_task_id.trim() === task.id ? task
            : await readTask(context, { view: 'overview', task_id: fields.parent_task_id.trim(), include: ['context'] }, context.signal);
          const reason = webActionUnavailable(parent, 'task_create');
          if (reason) throw new Error(`Prospective parent: ${reason}`);
          if (!parent.write_context) throw new Error('Prospective parent write context is unavailable.');
          if (action === 'task_attach') fields.parent_write_context = parent.write_context;
        }
        for (const key of ['references', 'metadata', 'blocked_by', 'parameters']) {
          if (typeof fields[key] === 'string') fields[key] = fields[key].trim() ? JSON.parse(fields[key]) : undefined;
        }
        if (fields.script_id?.trim()) fields.automation = { script_id: fields.script_id.trim(), parameters: fields.parameters ?? {} };
        if (action === 'task_subscribe') fields.statuses = [fields.status];
        requestId.current = crypto.randomUUID();
        const input = webMutationInput(action, task, fields, requestId.current, { current, parent });
        sent = true;
        setReceipt(await writeTask(context, action, input));
        refresh();
      } catch (failure) {
        setError(`${failure.message}${sent ? ' Effects may have been saved. Inspect the original operation; do not resubmit blindly.' : ''}`);
        if (!sent) submitted.current = false;
      } finally { setPending(false); }
    } },
    explanation ? h('p', { className: 'ck-text-secondary' }, explanation) : null,
    unavailable ? h('p', { role: 'status' }, unavailable) : null,
    !current ? h('p', { role: 'status' }, 'Refresh current Task facts before writing; cached or disconnected data cannot authorize an action.') : null,
    staleDraft && !submitted.current ? h('p', { role: 'alert' },
      'Task facts changed while this form was open. Preserve your draft, review current facts, then close and reopen this action before submitting.') : null,
    fields.map(({ name, title, maxLength, optional, multiline, options }) => h('label', { key: name }, title,
      h(options ? 'select' : multiline ? 'textarea' : 'input', {
        name, value: values[name] ?? '', required: !optional, maxLength, disabled,
        onChange: event => setValues(previous => ({ ...previous, [name]: event.target.value })),
      }, options ? options.map(value => h('option', { key: value, value }, statusLabel(value))) : undefined))),
    h('button', { type: 'submit', className: 'ck-button', disabled }, pending ? 'Submitting…' : label),
    error ? h('p', { role: 'alert', className: 'tb-read-error' }, error) : null,
    receipt ? h(React.Fragment, null,
      h('p', { role: receipt.error || receipt.notification_error ? 'alert' : 'status' },
        receipt.error ? `Action rejected or partially applied: ${receipt.error.message ?? receipt.error.code}. Inspect saved effects.`
          : receipt.notification_error ? 'Saved effects and notification failure are separate. Inspect the receipt; do not repeat the action.'
            : 'Response received. Inspect recorded effects; acceptance does not prove dispatch, execution or delivery.'),
      h(Disclosure, { title: 'Full action receipt' }, h('pre', { className: 'tb-preserve tb-metadata' }, JSON.stringify(receipt, null, 2))),
      receipt.result?.task_id || receipt.result?.id ? h(LazyTask, { taskId: receipt.result.task_id ?? receipt.result.id, title: 'Read resulting Task' }) : null) : null,
    requestId.current ? h(React.Fragment, null,
      h('p', { className: 'tb-preserve' }, `Request ID: ${requestId.current}`),
      h(Disclosure, { title: 'Inspect original operation' }, h(OperationReceipt, { requestId: requestId.current }))) : null);
  }

  function TaskActions({ task, current, refresh }) {
    const form = (action, label, fields, extra = {}) => h(Disclosure, { title: label },
      h(MutationForm, { task, action, label, fields, current, refresh, ...extra }));
    const reason = { name: 'reason', title: 'Authorized reason', multiline: true, maxLength: 2000 };
    const createFields = [
      { name: 'title', title: 'Task title', maxLength: 240 },
      { name: 'description', title: 'Complete responsibility and authorization', multiline: true, maxLength: 24000 },
      { name: 'parent_task_id', title: 'Parent Task ID (optional; blank creates an ordinary root)', optional: true, maxLength: 36 },
    ];
    const cannotCreateChild = webActionUnavailable(task, 'task_create');
    return h(React.Fragment, null,
      h('h3', null, 'User actions'),
      h('p', { className: 'ck-text-secondary' }, 'These requests act as the signed-in user. The viewed session and historical creator grant no authority. The service rechecks current prerequisites, ancestors, bindings and read context.'),
      task.kind === 'automation' ? h('p', null, 'Automation is service-managed: no Agent assignee, ACK or work mode. Inspect actual execution results and the launch barrier.')
        : h(React.Fragment, null,
          h('p', null, 'Start / convert: ', webActionUnavailable(task, 'task_start')),
          task.assignee ? h('p', { className: 'tb-preserve' }, `Responsible session: ${task.assignee}`)
            : h('p', null, task.parent_task_id ? 'Unbound child: assign a capable session here. Binding is not ACK or start.'
              : 'Unbound root: assign a capable session here, or let that Node claim it through task_claim. Claiming is not ACK or start.')),
      form('task_create', 'Create ordinary root or child', createFields, {
        explanation: 'Creation registers responsibility, not permission to begin. A new Agent Task is unbound, To do and Undecided. An explicit parent must be active, bound and Orchestrate.',
      }),
      form('task_create', 'Create registered automation', [
        ...createFields, { name: 'script_id', title: 'Existing registered script ID', maxLength: 64 },
        { name: 'parameters', title: 'Typed script parameters (JSON object)', multiline: true, maxLength: 8000 },
      ], { initial: { parameters: '{}' },
        explanation: 'Use an existing trusted registered script within authorization. This creates a service-managed Task, not an Agent binding or execution. Queue it separately after reviewing its immutable snapshot.' }),
      !cannotCreateChild ? form('task_create', 'Create child of this Task', createFields.slice(0, 2), {
        fixed: { parent_task_id: task.id }, explanation: 'This child belongs to the current orchestrating responsibility; no new creator privilege is established.',
      }) : h('p', { className: 'ck-text-secondary' }, `Create child of this Task: ${cannotCreateChild}`),
      task.kind !== 'automation' ? form('task_assign', 'Assign a session', [
        { name: 'assignee', title: 'Capable assignee session ID', maxLength: 200 },
      ], { explanation: 'Binding an ordinary root or child is separate from ACK and atomic start. Dispatch receipts do not prove the message was read.' }) : null,
      form('task_edit', 'Edit current definition and requirements', [
        ...createFields.slice(0, 2),
        { name: 'references', title: 'Complete references (JSON array)', multiline: true, maxLength: 8000 },
        { name: 'metadata', title: 'Complete metadata (JSON object)', multiline: true, maxLength: 8000 },
        { name: 'blocked_by', title: 'Complete active prerequisites (JSON array of task_id or condition)', multiline: true, maxLength: 44000 },
        reason,
      ], { initial: {
        title: task.title, description: task.description, references: JSON.stringify(task.references ?? [], null, 2),
        metadata: JSON.stringify(task.metadata ?? {}, null, 2),
        blocked_by: JSON.stringify((task.blocked_by ?? []).map(entry => entry.task_id
          ? { task_id: entry.task_id } : { condition: entry.condition }), null, 2),
      }, explanation: 'Replace the current agreed fields with an authorized reason. The complete prerequisite array replans requirements; record satisfaction evidence through Resolve condition instead. Editing does not ACK, start, finish, or change work mode.' }),
      task.kind !== 'automation' ? form('task_reopen', 'Reopen completed responsibility', [
        createFields[1], reason,
      ], { initial: { description: task.description },
        explanation: 'Explicitly authorized rework only. Preserve the original assignee and work mode; the service checks assignment history, retained workspace, session readiness and active ancestors. No ancestor is automatically reopened.' }) : h(React.Fragment, null,
        form('task_automation_start', 'Queue automation once', [], {
          explanation: 'Run the registered immutable script and parameters once within authorization. Queue acceptance is not execution or success; inspect actual run facts and outcome. No automatic retry.',
        }),
        form('task_automation_reconcile', 'Reconcile automation launch barrier', [reason], {
          explanation: 'Inspect effects first. The service must prove the recorded Linux process group absent before clearing the barrier. This does not kill a recovered process, rerun the script, change Task status or claim success.',
        })),
      form('task_attach', 'Attach this root under a parent', [
        { name: 'parent_task_id', title: 'Authorized new parent Task ID', maxLength: 36 }, reason,
      ], { explanation: 'Only an authorized root attachment is supported. Preserve its session, subtree and history. The parent must be bound to another session and actively Orchestrate; its current write context is read once before submission.' }),
      task.blocked_by?.filter(entry => entry.condition && entry.dependency_id).map(entry =>
        h(Disclosure, { key: entry.dependency_id, title: `Resolve condition: ${entry.condition}` },
          h(MutationForm, { task, action: 'task_resolve_condition', label: 'Record satisfaction evidence', current, refresh,
            fixed: { dependency_id: entry.dependency_id }, fields: [
              { name: 'evidence', title: 'Evidence or recorded user answer satisfying this exact condition', multiline: true, maxLength: 4000 },
              { name: 'references', title: 'Evidence references (optional JSON array of label / target)', optional: true, multiline: true, maxLength: 8000 },
            ], explanation: 'This records satisfaction, not a change to the condition or scope. Task-ID dependencies cannot be resolved through this action.' }))),
      form('task_cancel', task.kind === 'automation' ? 'Cancel automation' : 'Request cancellation', [reason], {
        explanation: task.kind === 'automation' ? 'Service-managed cancellation does not prove process exit or rollback. Read actual run facts and the launch barrier.'
          : 'Records intent only, even for a leaf. No cascading termination. The bound assignee arranges child closure and residual handling before finalizing.',
      }),
      task.kind !== 'automation' ? form('task_cancel_finalize', 'Finalize unbound cancellation', [
        { name: 'summary', title: 'Cancellation disposition and residual handling', multiline: true, maxLength: 8000 },
      ], { explanation: terminalGateLabel(task) + ' Cancellation need not satisfy abandoned execution prerequisites.' }) : null,
      form('task_subscribe', 'Subscribe a session to a future status', [
        { name: 'subscriber', title: 'Explicit subscriber session ID', maxLength: 200 },
        { name: 'status', title: 'Future status enabling necessary follow-up', options: ['done', 'cancelled', 'in_progress', 'todo'] },
      ], { initial: { status: 'done' }, explanation: 'Optional one-shot wait only for necessary follow-up, not progress tracking. No recipient is inferred from the creator or parent.' }),
    );
  }

  function AutomationLogs({ taskId }) {
    const [offsets, setOffsets] = useState([0]);
    const offset = offsets.at(-1);
    const state = useRead({ view: 'automation_log', task_id: taskId, offset, limit: 4096 });
    const pageLabel = useRef(null);
    const previousOffset = useRef(offset);
    useEffect(() => {
      if (previousOffset.current !== offset) {
        previousOffset.current = offset;
        pageLabel.current.focus();
      }
    }, [offset]);
    return h(React.Fragment, null,
      h('p', { className: 'ck-text-secondary' }, 'Bounded automation output, not a native session transcript. No polling; refresh to read current output.'),
      h(ReadState, { state, subject: 'automation log' }, (page) => h(React.Fragment, null,
        h('p', { className: 'ck-text-secondary' }, `Run: ${page.run_id} · ${page.retained_characters} retained characters · ${page.omitted_characters} omitted characters · ${page.complete ? 'Complete' : 'Incomplete'}`),
        h('pre', { className: 'tb-preserve tb-automation-log' }, page.text || 'No output in this page.'))),
      h('nav', { className: 'tb-page-controls', 'aria-label': 'Automation log pages' },
        h('button', { type: 'button', className: 'ck-button', disabled: offsets.length === 1, onClick: () => setOffsets((current) => current.slice(0, -1)) }, 'Previous page'),
        h('span', { ref: pageLabel, tabIndex: -1, role: 'status' }, `Page ${offsets.length} · Offset ${offset}`),
        h('button', { type: 'button', className: 'ck-button', disabled: state.phase !== 'ready' || state.data.next_offset === null,
          onClick: () => setOffsets((current) => [...current, state.data.next_offset]) }, 'Next page'),
        h(Refresh, { state, label: 'Refresh log' })),
    );
  }

  function Revision({ taskId, revision }) {
    const state = useRead({ view: 'changelog', task_id: taskId, revision });
    return h('section', null,
      h('h3', null, `Definition v${revision}`),
      h(ReadState, { state }, (entry) => h(React.Fragment, null,
        h('p', { className: 'ck-text-secondary' }, `Reported author: ${entry.author} · ${formatTimestamp(entry.at)}`),
        h('p', { className: 'tb-preserve' }, entry.reason),
        h('p', { className: 'tb-preserve' }, entry.description),
      )),
    );
  }

  function History({ taskId, view }) {
    const [cursors, setCursors] = useState([null]);
    return h(HistoryPage, { taskId, view, cursors, setCursors });
  }

  function RevisionDisclosure({ taskId, revision }) {
    return h(Disclosure, { title: `Read full definition v${revision}` }, h(Revision, { taskId, revision }));
  }

  function HistoryPage({ taskId, view, cursors, setCursors }) {
    const cursor = cursors.at(-1);
    const state = useRead({ view, task_id: taskId, limit: 10, ...(cursor ? { cursor } : {}) });
    const pageLabel = useRef(null);
    const previousCursor = useRef(cursor);
    useEffect(() => {
      if (previousCursor.current !== cursor) {
        previousCursor.current = cursor;
        pageLabel.current.focus();
      }
    }, [cursor]);
    const page = state.data;
    return h(React.Fragment, null,
      view === 'outcomes' ? h('p', { className: 'ck-text-secondary' }, 'Each outcome belongs to its recorded definition version. Older outcomes do not establish delivery of a newer definition.') : null,
      h(ReadState, { state }, (page) =>
      page.items.length ? h('ol', { className: 'tb-history' }, page.items.map((entry, index) =>
        h('li', { key: entry.dependency_id ?? entry.id ?? entry.revision ?? index },
          h('p', { className: 'ck-text-secondary tb-history-author' },
            ['dependencies', 'responsibility_events'].includes(view) ? 'Author: ' : `Definition v${entry.revision} · Reported author: `,
            h(SessionName, { id: entry.author })),
          h('p', { className: 'ck-text-secondary' }, formatTimestamp(entry.created_at ?? entry.at)),
          view === 'responsibility_events'
            ? h('pre', { className: 'tb-preserve tb-metadata' }, JSON.stringify(entry, null, 2))
            : view === 'dependencies'
            ? h(React.Fragment, null,
              entry.kind === 'task' ? h(LazyTask, { taskId: entry.blocker_id }) : h('p', { className: 'tb-preserve' }, entry.condition),
              h('p', { className: 'ck-text-secondary' }, entry.active ? 'Active prerequisite'
                : `Resolved: ${entry.resolution} · ${entry.resolved_by} · ${formatTimestamp(entry.resolved_at)}`),
              entry.evidence ? h('p', { className: 'tb-preserve' }, `Evidence: ${entry.evidence}`) : null,
              entry.references?.length ? h(References, { references: entry.references }) : null)
            : view === 'changelog'
            ? h(React.Fragment, null,
              h('p', { className: 'tb-preserve' }, entry.reason),
              h(RevisionDisclosure, { taskId, revision: entry.revision }))
            : h(React.Fragment, null,
              h('p', { className: 'tb-preserve' }, view === 'activity' ? entry.text : entry.summary),
              h('p', { className: 'ck-text-secondary' }, entry.source === 'automation'
                ? `Source: Automation · Run: ${entry.run_id} · No native assignee`
                : `Assignee: ${entry.assignee}`),
              view === 'outcomes' ? h(React.Fragment, null,
                h(References, { references: entry.references }),
                h(Retro, { retro: entry.retro })) : null),
        ))) : h('p', null, `No ${view === 'changelog' ? 'definition revisions' : view} recorded.`)),
      h('nav', { className: 'tb-page-controls', 'aria-label': `${view} pages` },
        h('button', { type: 'button', className: 'ck-button', disabled: cursors.length === 1, onClick: () => setCursors((current) => current.slice(0, -1)) }, 'Previous page'),
        h('span', { ref: pageLabel, tabIndex: -1, role: 'status' }, `Page ${cursors.length}`),
        h('button', { type: 'button', className: 'ck-button', disabled: state.phase !== 'ready' || !page.next_cursor, onClick: () => setCursors((current) => [...current, page.next_cursor]) }, 'Next page'),
        h(Refresh, { state, label: 'Refresh current page' }),
      ),
    );
  }

  function Detail({ taskId, event, onClose }) {
    const dialog = useRef(null);
    const titleId = useId();
    const [section, setSection] = useState('overview');
    const state = useRead({ view: 'execution', task_id: taskId });
    const overview = useRead({ view: 'overview', task_id: taskId });
    const task = overview.data ?? state.data;
    const sections = [['overview', 'Overview'], ['activity', `Activity · ${task?.activity_count ?? '—'}`],
      ['relations', 'Relations'], ['history', 'History'], ['actions', 'Actions']];
    useLayoutEffect(() => {
      const element = dialog.current;
      element.showModal();
      return () => {
        if (element.open) element.close();
      };
    }, []);
    return context.createPortal(h('dialog', {
      ref: dialog,
      className: 'ck-surface ck-modal tb-dialog',
      'aria-labelledby': titleId,
      onClose: () => { if (!dialog.current?.open) onClose(); },
    },
    h('header', { className: 'ck-actions tb-dialog-header' },
      h('div', { className: 'tb-dialog-heading' },
        h('span', { className: 'tb-detail-status' }, h(Icon, { name: taskStateIcon(overview) }), task ? statusLabel(task.status) : 'Task'),
        h('h2', { id: titleId, className: 'ck-heading' }, task?.title ?? 'Task details')),
      h(Refresh, { state: { ...state, refreshing: state.refreshing || overview.refreshing },
        onClick: () => { void state.retry(); void overview.retry(); } }),
      h('button', { type: 'button', className: 'ck-icon-button', 'aria-label': 'Close Task details',
        onClick: () => dialog.current.close() }, h(Icon, { name: 'close' })),
    ),
    h('nav', { className: 'tb-sections', 'aria-label': 'Task detail sections' }, sections.map(([view, label]) =>
      h('button', { key: view, type: 'button', className: 'ck-button', 'aria-pressed': section === view, onClick: () => setSection(view) }, label))),
    h('section', { className: 'tb-detail-content', 'aria-label': section },
      section === 'activity' ? h(History, { taskId, view: 'activity' })
        : h(ReadState, { state }, data => section === 'overview' ? h(Execution, { task: data, overview: overview.data })
          : section === 'relations' ? h(Relations, { task: data })
            : section === 'actions' ? h(TaskActions, { task: data, current: state.phase === 'ready' && !state.refreshing,
              refresh: () => { void state.retry(); void overview.retry(); } })
            : h(React.Fragment, null,
              h('p', { className: 'ck-text-secondary' }, 'Historical records are separate from the current definition and outcome.'),
              h(Disclosure, { title: 'Definition versions' }, h(History, { taskId, view: 'changelog' })),
              h(Disclosure, { title: 'Outcomes and retrospectives' }, h(History, { taskId, view: 'outcomes' })),
              h(Disclosure, { title: 'Current retrospective' }, h(Retro, { retro: data.retro })),
              h(Disclosure, { title: 'Responsibility history' }, h(History, { taskId, view: 'responsibility_events' })),
              event && TASK_EVENTS[event] ? h(Disclosure, { title: 'Message context' },
                h('p', null, `${TASK_EVENTS[event]}. This link records a past event, not the current Task state.`)) : null))),
    ), document.body);
  }

  function Card({ taskId, event }) {
    const state = useRead({ view: 'overview', task_id: taskId });
    const [open, setOpen] = useState(false);
    const task = state.data;
    const notice = Object.hasOwn(TASK_EVENTS, event) ? TASK_EVENTS[event] : null;
    const stateIcon = taskStateIcon(state);
    const label = { loading: 'Loading Task…', missing: 'Task not found', offline: 'Disconnected', error: 'Unable to read Task' }[state.phase];
    const owner = task?.kind === 'automation' ? 'Automation service' : task?.sessions?.assignee?.title ?? task?.assignee ?? 'Unassigned';
    const summary = state.phase === 'ready' ? cardSummary(task)
      : task ? `${label} · Last-read data; current state unconfirmed` : state.error?.message ?? 'No cached Task data.';
    const version = task ? `v${task.revision} · ${task.kind === 'automation' ? 'ACK n/a'
      : task.acknowledged_revision == null ? 'No ACK' : `ACK v${task.acknowledged_revision}`}` : 'v— · ACK —';
    return h('span', { className: 'tb-card-container' },
      h('span', { className: 'tb-card', 'data-status': task?.status ?? state.phase },
        h('button', { type: 'button', className: 'tb-card-open', onClick: () => setOpen(true),
          title: `${task?.title ?? taskId}\n${owner}\n${summary}`,
          'aria-haspopup': 'dialog', 'aria-expanded': open,
          'aria-label': `${notice ? `Message: ${notice}. ` : ''}Open Task: ${task?.title ?? taskId}` }),
        notice ? h('span', { className: 'tb-card-event',
          title: 'Message context: a past event, not the current Task state.' },
          h(Icon, { name: NOTICE_ICONS[event] }), h('span', null, notice)) : null,
        h('span', { className: 'tb-card-top' },
          h('span', { className: 'tb-card-title', title: task?.title ?? taskId }, task?.title ?? label),
          h('span', { className: 'tb-card-status', title: 'Current Task state' },
            h(Icon, { name: stateIcon }), task ? task.cancellation_request && !['done', 'cancelled'].includes(task.status)
              ? `${statusLabel(task.status)} · Cancellation requested`
              : task.ready === false && !['done', 'cancelled'].includes(task.status)
                ? `${statusLabel(task.status)} · Blocked` : statusLabel(task.status) : 'Task')),
        h('span', { className: 'tb-card-summary', title: summary }, summary),
        h('span', { className: 'tb-card-meta' },
          h('span', { className: 'tb-card-owner', title: owner },
            h(Icon, { name: !task ? 'unknown' : task.kind === 'automation' ? 'automation' : task.assignee ? 'owner' : 'unassigned' }),
            h(SessionName, { title: task ? owner : 'Unknown' })),
          task?.kind !== 'automation' ? h('span', { className: 'tb-card-mode', title: 'Responsibility mode, not native session mode' }, task ? workModeLabel(task) : '—') : null,
          h('span', { className: 'tb-card-count', title: 'Reported activity records', 'aria-label': `Activity count: ${task?.activity_count ?? 'unknown'}` },
            h(Icon, { name: 'activity' }), task?.activity_count ?? '—'),
          h('span', { className: 'tb-card-version', title: version }, version),
          h(Refresh, { state }))),
      open ? h(Detail, { taskId, event, onClose: () => setOpen(false) }) : null,
    );
  }

  function TaskReference({ node, fallback }) {
    const reference = node?.kind === 'link' ? parseTaskTarget(node.target) : null;
    return reference ? h(Card, { key: reference.taskId, ...reference }) : fallback;
  }

  return {
    apiVersion: 2,
    components: [{ id: 'session-task', boundary: 'sessionListItem', wrap: Base => function SessionTask(props) {
      const state = useSessionSummary(props.sessionId);
      return h(Base, { ...props, details: !summaryNotice(state) && !state.data?.task ? props.details
        : h(React.Fragment, null, h(SessionSummary, { state }), props.details) });
    } }],
    globalComponents: [{ id: 'session-task-detail', component: SessionTaskDialog }],
    menus: [{ id: 'session-task-menu', menu: 'session', getState: taskMenu.getState,
      subscribe: summaries.subscribe, onSelect: taskMenu.onSelect }],
    markdown: [{ id: 'task-reference', matches: (node) => parseTaskReference(node) !== null, component: TaskReference }],
    dispose() { taskMenu.dispose(); summaries.dispose(); readCaches.get(context)?.dispose(); },
  };
}
