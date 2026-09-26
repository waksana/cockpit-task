const MAX_IDLE_RESOURCES = 128;

export function createReadCache(context, read) {
  const entries = new Map();
  const versions = new Map();
  let disposed = false;
  let trimScheduled = false;
  let connected = context.state?.host?.getSnapshot().connected !== false;
  const hostState = () => context.state?.host?.getSnapshot() ?? { visible: true, connected: true };
  const matches = (entry, taskId) => entry.input.view !== 'native' &&
    (entry.input.task_id === taskId || (entry.input.view === 'list' && entry.input.parent_task_id === taskId));
  const reconcile = (taskId, version, source) => {
    const related = [...entries.values()].filter(entry => matches(entry, taskId));
    if (!related.length) return;
    if (version && versions.get(taskId) === version) return;
    const previous = versions.get(taskId);
    if (version) versions.set(taskId, version);
    // The first successful read establishes a baseline, not a change event.
    if (source && !previous) return;
    for (const entry of related) if (entry !== source) entry.invalidate();
  };
  const trim = () => {
    const idle = [...entries].filter(([, entry]) => !entry.users && !entry.hasListeners());
    for (const [key, entry] of idle.slice(0, Math.max(0, idle.length - MAX_IDLE_RESOURCES))) {
      entry.dispose();
      entries.delete(key);
    }
    for (const taskId of versions.keys()) {
      if (![...entries.values()].some(entry => matches(entry, taskId))) versions.delete(taskId);
    }
  };
  const scheduleTrim = () => {
    if (trimScheduled) return;
    trimScheduled = true;
    queueMicrotask(() => {
      trimScheduled = false;
      if (!disposed) trim();
    });
  };
  const get = input => {
    const key = JSON.stringify(input, Object.keys(input).sort());
    if (entries.has(key)) return entries.get(key).resource;
    let snapshot = { phase: 'loading', data: null, error: null, refreshing: false };
    let dirty = true;
    let generation = 0;
    let controller;
    let pending;
    const listeners = new Set();
    const publish = next => {
      snapshot = next;
      for (const listener of listeners) listener();
    };
    const cancel = () => {
      generation++;
      controller?.abort();
      pending = null;
    };
    const refresh = () => {
      if (disposed || context.signal?.aborted) return Promise.resolve();
      if (pending) return pending;
      if (hostState().connected === false) {
        publish({ ...snapshot, phase: 'offline', refreshing: false });
        return Promise.resolve();
      }
      if (hostState().visible === false) {
        dirty = true;
        if (snapshot.refreshing) publish({ ...snapshot, refreshing: false });
        return Promise.resolve();
      }
      dirty = false;
      const requestGeneration = ++generation;
      controller = new AbortController();
      publish({ ...snapshot, phase: snapshot.data ? 'ready' : 'loading', error: null, refreshing: true });
      pending = (async () => {
        try {
          const data = await read(input, controller.signal);
          if (disposed || requestGeneration !== generation) return;
          const same = JSON.stringify(data) === JSON.stringify(snapshot.data);
          publish({ phase: 'ready', data: same ? snapshot.data : data, error: null, refreshing: false });
          if (input.task_id && data.data_version) reconcile(input.task_id, data.data_version, entry);
        } catch (failure) {
          if (disposed || requestGeneration !== generation) return;
          const error = failure instanceof Error ? failure : new Error('Task read failed.');
          publish({ phase: error.code === 'TASK_NOT_FOUND' ? 'missing' : 'error',
            data: snapshot.data, error, refreshing: false });
        } finally {
          if (requestGeneration === generation) pending = null;
        }
      })();
      return pending;
    };
    const current = () => {
      if (disposed) return entry;
      if (!entries.has(key)) {
        dirty = true;
        entries.set(key, entry);
      }
      return entries.get(key);
    };
    const entry = {
      input, users: 0,
      getSnapshot: () => snapshot,
      hasListeners: () => listeners.size > 0,
      subscribe(listener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); scheduleTrim(); };
      },
      refresh,
      start() {
        entry.users++;
        if (dirty) void refresh();
      },
      invalidate() {
        dirty = true;
        cancel();
        if (entry.users) void refresh();
        else publish({ ...snapshot, refreshing: false });
      },
      connectionChanged() {
        if (!connected) {
          cancel();
          dirty = true;
          publish({ ...snapshot, phase: 'offline', refreshing: false });
        } else if (entry.users && dirty) void refresh();
      },
      visible() { if (entry.users && dirty) void refresh(); },
      dispose() { cancel(); dirty = true; listeners.clear(); snapshot = { ...snapshot, refreshing: false }; },
      resource: {
        getSnapshot: () => current().getSnapshot(),
        subscribe: listener => current().subscribe(listener),
        refresh: () => current().refresh(),
        start() {
          if (disposed || context.signal?.aborted) return;
          // A retained React handle can resume after LRU eviction; if another
          // reference already recreated this key, both use that canonical entry.
          current().start();
        },
        stop() {
          if (disposed) return;
          const target = current();
          target.users = Math.max(0, target.users - 1);
          // React remounts share both the retained snapshot and an in-flight read.
          entries.delete(key);
          entries.set(key, target);
          scheduleTrim();
        },
      },
    };
    entries.set(key, entry);
    return entry.resource;
  };
  const cleanup = [];
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const unsubscribe of cleanup) unsubscribe();
    for (const entry of entries.values()) entry.dispose();
    entries.clear();
    versions.clear();
  };
  // Generic module invalidation is also caused by unrelated UI work. Only the
  // module's Task change payload is evidence that these resources are obsolete.
  if (context.onEvent) cleanup.push(context.onEvent(event => {
    if (event?.type !== 'task/changed' || typeof event.task_id !== 'string') return;
    reconcile(event.task_id, event.data_version);
  }));
  if (context.state?.host) cleanup.push(context.state.host.subscribe(() => {
    const next = hostState();
    if ((next.connected !== false) !== connected) {
      connected = next.connected !== false;
      // Events have no replay: reconnect must reconcile possible missed changes.
      for (const entry of entries.values()) entry.connectionChanged();
    } else if (next.visible !== false) {
      for (const entry of entries.values()) entry.visible();
    }
  }));
  context.signal?.addEventListener('abort', dispose, { once: true });
  cleanup.push(() => context.signal?.removeEventListener('abort', dispose));
  return { get, dispose };
}
