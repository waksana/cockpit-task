const EMPTY = Object.freeze({ phase: 'loading', data: null, error: null, refreshing: false });
const OFFLINE = Object.freeze({ ...EMPTY, phase: 'offline' });
const STATUS = new Set(['todo', 'in_progress', 'done', 'cancelled']);
const POSITION = new Set(['Root', 'Branch', 'Leaf']);

export async function readSessionSummaries(context, ids, signal) {
  const response = await context.request('/session-summaries', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_ids: ids }), signal,
  });
  let body;
  try { body = await response.json(); }
  catch { throw new Error(`Task summaries returned invalid JSON (HTTP ${response.status}).`); }
  if (!response.ok || body?.error) throw new Error(body?.error?.message ?? `Task summaries failed (HTTP ${response.status}).`);
  const items = body?.result?.items;
  if (body?.error !== null || !Array.isArray(items) || items.length !== ids.length ||
      items.some((item, index) => !item || item.session_id !== ids[index] ||
        !['current', 'recent', 'none', 'unknown'].includes(item.selection) ||
        (['none', 'unknown'].includes(item.selection) ? item.task !== null
          : !item.task || !/^[a-f0-9-]{36}$/i.test(item.task.id) ||
            typeof item.task.title !== 'string' || !item.task.title ||
            !STATUS.has(item.task.status) || !POSITION.has(item.task.position) ||
            (item.selection === 'current') !== !['done', 'cancelled'].includes(item.task.status)))) {
    throw new Error('Task summaries returned an invalid result.');
  }
  return items;
}

// Row subscriptions and the active header share one bounded, event-driven batch queue.
export function createSessionSummaries(context) {
  context.signal.throwIfAborted();
  const entries = new Map();
  const listeners = new Set();
  let stopped = false, queued = false, running = null, generation = 0;
  let host = context.state.host.getSnapshot();
  let active = host.sessionId;
  const notify = () => { for (const listener of listeners) listener(); };
  const interested = (id, entry) => entry.users > 0 || id === active;
  const trim = () => {
    const idle = [...entries].filter(([key, value]) => !interested(key, value));
    for (const [key] of idle.slice(0, Math.max(0, idle.length - 100))) entries.delete(key);
  };
  const ensure = id => {
    if (!entries.has(id)) entries.set(id, { users: 0, dirty: true, snapshot: host.connected ? EMPTY : OFFLINE });
    return entries.get(id);
  };
  const cancel = () => { generation++; running?.abort(); running = null; };
  const schedule = () => {
    if (queued || stopped) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      void flush();
    });
  };
  const flush = async () => {
    if (stopped || running || !host.connected || !host.visible) return;
    const batch = [...entries].filter(([id, entry]) => interested(id, entry) && entry.dirty).slice(0, 100);
    if (!batch.length) return;
    const controller = new AbortController();
    running = controller;
    const version = ++generation;
    for (const [, entry] of batch) {
      entry.dirty = false;
      entry.snapshot = { ...entry.snapshot, refreshing: true };
    }
    notify();
    try {
      const items = await readSessionSummaries(context, batch.map(([id]) => id), controller.signal);
      if (stopped || version !== generation) return;
      batch.forEach(([, entry], index) => {
        entry.snapshot = { phase: 'ready', data: items[index], error: null, refreshing: false };
      });
    } catch (failure) {
      if (stopped || version !== generation) return;
      const error = failure instanceof Error ? failure : new Error('Unable to read Task summaries.');
      for (const [, entry] of batch) entry.snapshot = { ...entry.snapshot, phase: 'error', error, refreshing: false };
    } finally {
      if (!stopped && version === generation) {
        running = null;
        notify();
        schedule();
      }
    }
  };
  const invalidate = () => {
    cancel();
    for (const entry of entries.values()) {
      entry.dirty = true;
      entry.snapshot = { ...entry.snapshot, refreshing: true };
    }
    notify();
    schedule();
  };
  const cleanup = [
    context.onEvent(event => {
      // New assignments have unknown task IDs; filtering only cached IDs loses them.
      if (event?.type === 'task/changed') invalidate();
    }),
    context.state.host.subscribe(() => {
      const next = context.state.host.getSnapshot();
      const connectionChanged = next.connected !== host.connected;
      const becameVisible = next.visible && !host.visible;
      host = next;
      active = next.sessionId;
      if (active) ensure(active);
      trim();
      if (connectionChanged || becameVisible) invalidate();
      if (!next.connected) {
        for (const entry of entries.values()) entry.snapshot = { ...entry.snapshot, phase: 'offline', refreshing: false };
        notify();
      }
      schedule();
    }),
  ];
  if (active) ensure(active);
  schedule();
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    cancel();
    for (const unsubscribe of cleanup) unsubscribe();
    context.signal.removeEventListener('abort', dispose);
    listeners.clear();
    entries.clear();
  };
  context.signal.addEventListener('abort', dispose, { once: true });
  return {
    get: id => entries.get(id)?.snapshot ?? (host.connected ? EMPTY : OFFLINE),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    watch(id, listener) {
      const entry = ensure(id);
      entry.users++;
      listeners.add(listener);
      if (!host.connected) entry.snapshot = { ...entry.snapshot, phase: 'offline', refreshing: false };
      schedule();
      return () => {
        entry.users--;
        listeners.delete(listener);
        // Retain only a bounded idle cache, not a replica of all native sessions.
        trim();
      };
    },
    retry(id) {
      const entry = ensure(id);
      entry.dirty = true;
      entry.snapshot = { ...entry.snapshot, refreshing: true };
      notify();
      schedule();
    },
    dispose,
  };
}
