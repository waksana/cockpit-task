import { parseTaskTarget, TASK_EVENTS } from '../../src/task-board/reference.js';
import { createReadCache } from './read-resource.js';
import { ICONS } from './icons.js';

const STATUS_LABELS = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
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
  if (input.view === 'list') {
    return Array.isArray(data.items) && (data.next_cursor === null || (text(data.next_cursor) && data.next_cursor.length > 0)) &&
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
    if (data.id !== input.task_id || !text(data.title) || !text(data.orchestrator) ||
        !(data.assignee === null || text(data.assignee)) || !text(data.status) ||
        !revision(data.revision) || !(data.acknowledged_revision === null || revision(data.acknowledged_revision))) return false;
    if (data.kind !== undefined && !['agent', 'automation'].includes(data.kind)) return false;
    if (data.activity_count !== undefined && data.activity_count !== null && !nonnegative(data.activity_count)) return false;
    if (data.data_version !== undefined && (!text(data.data_version) || !/^[a-f0-9]{64}$/.test(data.data_version))) return false;
    if (data.sessions !== undefined && (!object(data.sessions) || !['assignee', 'orchestrator'].every(key => {
      const session = data.sessions[key];
      return data[key] === 'user' || (key === 'assignee' && data.assignee === null) ? session === null
        : object(session) && session.session_id === data[key] &&
          (session.title === null || text(session.title)) && typeof session.available === 'boolean';
    }))) return false;
    if (data.outcome?.summary !== undefined && !text(data.outcome.summary)) return false;
    if (!dependencies(data) || !lineage(data)) return false;
    if (!retro(data.retro, input.view === 'execution')) return false;
    if (data.kind === 'automation') {
      if (data.assignee !== null || data.acknowledged_revision !== null ||
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
    return data.activity === null || (entry(data.activity) && text(data.activity.text) && typeof data.activity.truncated === 'boolean');
  }
  if (input.view === 'changelog' && input.revision !== undefined) {
    return entry(data) && data.revision === input.revision && text(data.reason) && text(data.description);
  }
  if (!Array.isArray(data.items) || !(data.next_cursor === null || (text(data.next_cursor) && data.next_cursor.length > 0))) return false;
  if (input.view === 'dependencies') {
    return data.task_id === input.task_id && data.items.every(item => object(item)
      && text(item.dependency_id) && item.task_id === input.task_id && text(item.author) && text(item.created_at)
      && ((item.kind === 'task' && text(item.blocker_id) && item.condition === undefined)
        || (item.kind === 'condition' && text(item.condition) && item.blocker_id === undefined))
      && typeof item.active === 'boolean'
      && (item.active
        ? item.resolved_at === null && item.resolved_by === null && item.resolution === null
        : text(item.resolved_at) && text(item.resolved_by) && ['done', 'removed'].includes(item.resolution)));
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
  if (state.data) return state.data.ready === false && !['done', 'cancelled'].includes(state.data.status) ? 'blocked'
    : ({ todo: 'todo', in_progress: 'progress', done: 'done', cancelled: 'cancelled' }[state.data.status] ?? 'unknown');
  if (state.phase === 'offline') return 'offline';
  if (state.phase === 'error') return 'error';
  return state.phase === 'loading' ? 'refresh' : 'unknown';
}

export function cardSummary(task) {
  if (task.status === 'cancelled' && typeof task.cancellation?.reason === 'string') return task.cancellation.reason;
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
  const React = context.react;
  const h = React.createElement;
  const { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, useId } = React;

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
      h('dt', null, 'Assignee'), h('dd', null, automated ? 'Automation service'
        : h(SessionName, { id: task.assignee, title: task.sessions?.assignee?.title })),
      h('dt', null, 'Orchestrator'), h('dd', null, h(SessionName, { id: task.orchestrator, title: task.sessions?.orchestrator?.title })),
      h('dt', null, automated ? 'Definition' : 'Definition / ACK'),
      h('dd', null, automated ? `Definition v${task.revision}` : acknowledgementLabel(task.revision, task.acknowledged_revision)),
      h('dt', null, 'Prerequisites'), h('dd', null, dependency ?? 'No unmet prerequisites'),
    );
  }

  function LazyTask({ taskId, title = taskId }) {
    return h(Disclosure, { title }, h(Card, { taskId }));
  }

  function ChildTaskList({ taskId }) {
    const [cursors, setCursors] = useState([null]);
    const cursor = cursors.at(-1);
    const state = useRead({ view: 'list', parent_task_id: taskId, status: 'all', limit: 50, ...(cursor ? { cursor } : {}) });
    return h(React.Fragment, null,
      h(ReadState, { state, subject: 'Subtasks' }, (page) => page.items.length
        ? h('ul', { className: 'tb-references' }, page.items.map((child) =>
          h('li', { key: child.task_id }, h(LazyTask, { taskId: child.task_id, title: child.title }),
            h('span', { className: 'ck-text-secondary tb-history-author' }, statusLabel(child.status), ' · Assignee: ',
              h(SessionName, { id: child.assignee, title: child.sessions?.assignee?.title })))))
        : h('p', null, 'No Subtasks recorded.')),
      h('nav', { className: 'tb-page-controls', 'aria-label': 'Subtask pages' },
        h('button', { type: 'button', className: 'ck-button', disabled: cursors.length === 1,
          onClick: () => setCursors(current => current.slice(0, -1)) }, 'Previous page'),
        h('span', { role: 'status' }, `Page ${cursors.length}`),
        h('button', { type: 'button', className: 'ck-button', disabled: state.phase !== 'ready' || !state.data?.next_cursor || state.refreshing,
          onClick: () => setCursors(current => [...current, state.data.next_cursor]) }, 'Next page'),
        h(Refresh, { state, label: 'Refresh Subtasks' })));
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
            h('h3', null, task.status === 'cancelled' ? 'Cancellation' : task.ready === false ? 'Unmet prerequisites'
              : task.outcome?.current ? 'Latest outcome' : summaryTask.activity?.current === false ? 'Earlier reported activity' : 'Current progress'),
            h('p', { className: 'tb-preserve' }, task.status !== 'cancelled' && task.outcome?.current ? task.outcome.summary : cardSummary(summaryTask)),
            task.status !== 'cancelled' && task.outcome?.current ? h(References, { references: task.outcome.references ?? [] }) : null),
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
            h('p', { className: 'tb-preserve' }, `Orchestrator: ${task.sessions?.orchestrator?.title ?? task.orchestrator}`),
            h('p', { className: 'tb-preserve' }, `Orchestrator ID: ${task.orchestrator}`),
            ['assignee', 'orchestrator'].map(key => task.sessions?.[key]?.error
              ? h('p', { key, className: 'ck-text-secondary' }, `${key} title unavailable: ${task.sessions[key].error.message ?? task.sessions[key].error}`) : null)),
          task.kind !== 'automation' && task.assignee
            ? h(Disclosure, { title: 'Session observation' }, h(NativeSession, { taskId: task.id })) : null)),
      h(Disclosure, { title: 'Technical information' },
        h('p', { className: 'tb-preserve' }, `Task ID: ${task.id}`),
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
        h(LazyTask, { taskId: task.parent_task_id })) : null,
      task.kind !== 'automation' ? h(ChildTasks, { taskId: task.id }) : null,
      h(Disclosure, { title: 'Prerequisite history' }, h(History, { taskId: task.id, view: 'dependencies' })));
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
            view === 'dependencies' ? 'Author: ' : `Definition v${entry.revision} · Reported author: `,
            h(SessionName, { id: entry.author })),
          h('p', { className: 'ck-text-secondary' }, formatTimestamp(entry.created_at ?? entry.at)),
          view === 'dependencies'
            ? h(React.Fragment, null,
              entry.kind === 'task' ? h(LazyTask, { taskId: entry.blocker_id }) : h('p', { className: 'tb-preserve' }, entry.condition),
              h('p', { className: 'ck-text-secondary' }, entry.active ? 'Active prerequisite'
                : `Resolved: ${entry.resolution} · ${entry.resolved_by} · ${formatTimestamp(entry.resolved_at)}`))
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
      ['relations', 'Relations'], ['history', 'History']];
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
            : h(React.Fragment, null,
              h('p', { className: 'ck-text-secondary' }, 'Historical records are separate from the current definition and outcome.'),
              h(Disclosure, { title: 'Definition versions' }, h(History, { taskId, view: 'changelog' })),
              h(Disclosure, { title: 'Outcomes and retrospectives' }, h(History, { taskId, view: 'outcomes' })),
              h(Disclosure, { title: 'Current retrospective' }, h(Retro, { retro: data.retro })),
              event && TASK_EVENTS[event] ? h(Disclosure, { title: 'Message context' },
                h('p', null, `${TASK_EVENTS[event]}. This link records a past event, not the current Task state.`)) : null))),
    ), document.body);
  }

  function Card({ taskId, event }) {
    const state = useRead({ view: 'overview', task_id: taskId });
    const [open, setOpen] = useState(false);
    const task = state.data;
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
          'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-label': `Open Task: ${task?.title ?? taskId}` }),
        h('span', { className: 'tb-card-top' },
          h(Icon, { name: taskStateIcon(state) }),
          h('span', { className: 'tb-card-title', title: task?.title ?? taskId }, task?.title ?? label),
          h('span', { className: 'tb-card-status' }, task ? statusLabel(task.status) : 'Task')),
        h('span', { className: 'tb-card-summary', title: summary }, summary),
        h('span', { className: 'tb-card-meta' },
          h('span', { className: 'tb-card-owner', title: owner },
            h(Icon, { name: !task ? 'unknown' : task.kind === 'automation' ? 'automation' : task.assignee ? 'owner' : 'unassigned' }),
            h(SessionName, { title: task ? owner : 'Unknown' })),
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
    markdown: [{ id: 'task-reference', matches: (node) => parseTaskReference(node) !== null, component: TaskReference }],
  };
}
