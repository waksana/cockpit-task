import { parseTaskTarget, TASK_EVENTS } from '../../src/task-board/reference.js';

const STATUS_LABELS = {
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  in_review: 'In review',
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
  if (!object(data)) return false;
  if (input.view === 'overview' || input.view === 'execution') {
    if (data.id !== input.task_id || !text(data.title) || !text(data.owner) ||
        !(data.executor === null || text(data.executor)) || !text(data.status) ||
        !revision(data.revision) || !(data.acknowledged_revision === null || revision(data.acknowledged_revision))) return false;
    if (input.view === 'execution') return text(data.description) && references(data.references) && object(data.metadata);
    return data.activity === null || (entry(data.activity) && text(data.activity.text) && typeof data.activity.truncated === 'boolean');
  }
  if (input.view === 'changelog' && input.revision !== undefined) {
    return entry(data) && data.revision === input.revision && text(data.reason) && text(data.description);
  }
  if (!Array.isArray(data.items) || !(data.next_cursor === null || (text(data.next_cursor) && data.next_cursor.length > 0))) return false;
  return data.items.every((item) => entry(item) && (input.view === 'changelog' ? text(item.reason)
    : text(item.executor) && (input.view === 'activity' ? text(item.text) : text(item.summary) && references(item.references))));
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

// Each mounted view owns one bounded read. A superseded read can never publish,
// even when the transport ignores abort or completes after unmount.
export function createReadResource(context, input) {
  let snapshot = { phase: 'loading', data: null, error: null };
  let active = false;
  let generation = 0;
  let controller;
  let cleanup = [];
  const listeners = new Set();
  const host = context.state?.host;
  const hostState = () => host?.getSnapshot() ?? { visible: true, connected: true };
  let previousHost = hostState();
  const publish = (next) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const cancel = () => {
    generation += 1;
    controller?.abort();
  };
  const refresh = async () => {
    if (!active || context.signal.aborted) return;
    cancel();
    if (hostState().connected === false) {
      publish({ phase: 'offline', data: null, error: null });
      return;
    }
    if (hostState().visible === false) return;
    const requestGeneration = generation;
    controller = new AbortController();
    publish({ phase: 'loading', data: null, error: null });
    try {
      const data = input.view === 'native'
        ? await readNativeSession(context, input.task_id, controller.signal)
        : await readTask(context, input, controller.signal);
      if (active && generation === requestGeneration && !context.signal.aborted) {
        publish({ phase: 'ready', data, error: null });
      }
    } catch (failure) {
      const error = failure instanceof Error ? failure : new Error('Task read failed.');
      if (active && generation === requestGeneration && !context.signal.aborted) {
        publish({ phase: error.code === 'TASK_NOT_FOUND' ? 'missing' : 'error', data: null, error });
      }
    }
  };
  const stop = () => {
    active = false;
    cancel();
    for (const unsubscribe of cleanup.splice(0)) unsubscribe();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    start() {
      if (active || context.signal.aborted) return;
      active = true;
      previousHost = hostState();
      context.signal.addEventListener('abort', stop, { once: true });
      cleanup.push(
        () => context.signal.removeEventListener('abort', stop),
        context.onInvalidate(refresh),
        context.onEvent((event) => {
          if (event?.type === 'task/changed' && event.task_id === input.task_id) void refresh();
        }),
      );
      if (host) cleanup.push(host.subscribe(() => {
        const next = hostState();
        if (next.visible !== previousHost.visible || next.connected !== previousHost.connected) {
          previousHost = next;
          void refresh();
        }
      }));
      void refresh();
    },
    stop,
  };
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

  function ReadState({ state, children, subject = 'Task data' }) {
    const container = useRef(null);
    let content;
    if (state.phase === 'ready') content = children(state.data);
    else if (state.phase === 'loading') content = h('p', { role: 'status' }, `Loading ${subject}…`);
    else if (state.phase === 'offline') content = h('p', { role: 'status' }, `Disconnected. ${subject} will refresh when the host reconnects.`);
    else content = h('div', { className: 'tb-read-error' },
      h('p', { role: 'alert' }, state.phase === 'missing' ? 'This Task was not found.' : `Unable to read ${subject}: ${state.error.message}`),
      h('button', {
        type: 'button', className: 'ck-button',
        onClick: () => { container.current.focus(); void state.retry(); },
      }, 'Retry'));
    return h('div', { ref: container, tabIndex: -1, role: 'region', 'aria-label': 'Task read result', 'aria-busy': state.phase === 'loading' }, content);
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
          h('dt', null, 'Executor session'), h('dd', null, data.session_id ?? 'No Executor assigned'),
          h('dt', null, 'Native state'), h('dd', null, nativeStatusLabel(data)),
          h('dt', null, 'Observed at'), h('dd', null, formatTimestamp(data.observed_at))),
        data.error ? h('p', { role: 'alert', className: 'tb-read-error' },
          typeof data.error === 'string' ? data.error : (typeof data.error.message === 'string' ? data.error.message : 'The host returned an unspecified native-state error.')) : null,
        !data.available && data.session_id ? h('p', null, 'The host could not provide current native state. No running or idle state is inferred.') : null,
        data.available && !data.loaded ? h('p', null, 'The session is unloaded. It was not loaded by this read.') : null,
      )),
      state.phase === 'ready' ? h('button', {
        type: 'button', className: 'ck-button',
        onClick: () => { heading.current.focus(); void state.retry(); },
      }, 'Refresh native state') : null,
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
    return h('dl', { className: 'tb-facts' },
      h('dt', null, 'Task status'), h('dd', null, statusLabel(task.status)),
      h('dt', null, 'Owner'), h('dd', null, task.owner),
      h('dt', null, 'Executor'), h('dd', null, task.executor ?? 'Unassigned'),
      h('dt', null, 'Definition / ACK'), h('dd', null, acknowledgementLabel(task.revision, task.acknowledged_revision)),
    );
  }

  function Execution({ taskId }) {
    const state = useRead({ view: 'execution', task_id: taskId });
    return h(ReadState, { state }, (task) => h(React.Fragment, null,
      h('h3', null, task.title),
      h(TaskFacts, { task }),
      h('h3', null, 'Current definition'),
      h('p', { className: 'tb-preserve' }, task.description),
      h('h3', null, 'Current references'),
      h(References, { references: task.references }),
      h('h3', null, 'Metadata'),
      h('pre', { className: 'tb-preserve tb-metadata' }, JSON.stringify(task.metadata, null, 2)),
    ));
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
    const [open, setOpen] = useState(false);
    return h('details', { onToggle: event => setOpen(event.currentTarget.open) },
      h('summary', null, `Read full definition v${revision}`),
      open ? h(Revision, { taskId, revision }) : null);
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
        h('li', { key: entry.id ?? entry.revision ?? index },
          h('p', { className: 'ck-text-secondary' }, `Definition v${entry.revision} · Reported author: ${entry.author} · ${formatTimestamp(entry.at)}`),
          view === 'changelog'
            ? h(React.Fragment, null,
              h('p', { className: 'tb-preserve' }, entry.reason),
              h(RevisionDisclosure, { taskId, revision: entry.revision }))
            : h(React.Fragment, null,
              h('p', { className: 'tb-preserve' }, view === 'activity' ? entry.text : entry.summary),
              h('p', { className: 'ck-text-secondary' }, `Executor: ${entry.executor}`),
              view === 'outcomes' ? h(References, { references: entry.references }) : null),
        ))) : h('p', null, `No ${view === 'changelog' ? 'definition revisions' : view} recorded.`)),
      h('nav', { className: 'tb-page-controls', 'aria-label': `${view} pages` },
        h('button', { type: 'button', className: 'ck-button', disabled: cursors.length === 1, onClick: () => setCursors((current) => current.slice(0, -1)) }, 'Previous page'),
        h('span', { ref: pageLabel, tabIndex: -1, role: 'status' }, `Page ${cursors.length}`),
        h('button', { type: 'button', className: 'ck-button', disabled: state.phase !== 'ready' || !page.next_cursor, onClick: () => setCursors((current) => [...current, page.next_cursor]) }, 'Next page'),
      ),
    );
  }

  function Detail({ taskId, onClose }) {
    const dialog = useRef(null);
    const titleId = useId();
    const [section, setSection] = useState('execution');
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
      h('h2', { id: titleId, className: 'ck-heading' }, 'Task details'),
      h('button', { type: 'button', className: 'ck-button', onClick: () => dialog.current.close() }, 'Close'),
    ),
    h('p', { className: 'tb-task-id ck-text-secondary' }, taskId),
    h('p', { className: 'ck-text-secondary' }, 'Current Task read, not a message-time snapshot. Activity and ACK authorship are reported, not authenticated. Reading does not ACK.'),
    h('p', { className: 'ck-text-secondary' }, 'Reports do not establish what the session is doing now. Read a separate host observation in Native session.'),
    h('nav', { className: 'tb-sections', 'aria-label': 'Task detail sections' },
      [['execution', 'Definition'], ['activity', 'Reported activity'], ['native', 'Native session'], ['changelog', 'Definition revisions'], ['outcomes', 'Outcomes']].map(([view, label]) =>
        h('button', { key: view, type: 'button', className: 'ck-button', 'aria-pressed': section === view, onClick: () => setSection(view) }, label)),
    ),
    h('section', { className: 'tb-detail-content', 'aria-label': section },
      section === 'execution' ? h(Execution, { taskId }) : section === 'native' ? h(NativeSession, { taskId }) : h(History, { key: section, taskId, view: section })),
    h('footer', { className: 'ck-actions tb-dialog-footer' },
      h('button', { type: 'button', className: 'ck-button', onClick: () => dialog.current.close() }, 'Close Task details')),
    ), document.body);
  }

  function Card({ taskId, event }) {
    const state = useRead({ view: 'overview', task_id: taskId });
    const [open, setOpen] = useState(false);
    const task = state.data;
    const summary = state.phase === 'loading' ? 'Loading Task…'
      : state.phase === 'offline' ? 'Task · disconnected'
        : state.phase === 'missing' ? 'Task not found · open to retry'
          : state.phase === 'error' ? 'Task read failed · open to retry' : task.title;
    return h(React.Fragment, null,
      h('button', {
        type: 'button',
        className: 'ck-button tb-card',
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        onClick: () => setOpen(true),
      },
      event ? h('span', {
        className: 'tb-card-event',
        title: event === 'status_changed'
          ? 'An explicit Owner subscription matched a status change. This is not an Executor requirement update; current Task data is shown below.'
          : 'Why this message was sent; current Task data is shown below.',
      }, TASK_EVENTS[event]) : null,
      event === 'status_changed' ? h('span', { className: 'tb-card-meta' },
        'Owner subscription triggered · current state shown below') : null,
      h('span', { className: 'tb-card-title' }, summary),
      task ? h(React.Fragment, null,
        h('span', { className: 'tb-card-meta' }, `${statusLabel(task.status)} · Executor: ${task.executor ?? 'Unassigned'}`),
        h('span', { className: 'tb-card-meta' }, acknowledgementLabel(task.revision, task.acknowledged_revision)),
        h('span', { className: 'tb-card-activity' }, task.activity ? `Reported activity: ${task.activity.text}${task.activity.truncated ? ' (excerpt)' : ''}` : 'No reported activity.'),
        task.activity ? h('span', { className: 'tb-card-meta' }, `v${task.activity.revision} · ${formatTimestamp(task.activity.at)}`) : null,
      ) : null),
      open ? h(Detail, { taskId, onClose: () => { setOpen(false); void state.retry(); } }) : null,
    );
  }

  function TaskReference({ node, fallback }) {
    const reference = node?.kind === 'link' ? parseTaskTarget(node.target) : null;
    return reference ? h(Card, { key: `${reference.taskId}:${reference.event ?? ''}`, ...reference }) : fallback;
  }

  return {
    apiVersion: 2,
    markdown: [{ id: 'task-reference', matches: (node) => parseTaskReference(node) !== null, component: TaskReference }],
  };
}
