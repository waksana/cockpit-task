export const summaryIcon = status => ({
  todo: 'sessionTodo', in_progress: 'progress', done: 'done', cancelled: 'sessionCancelled',
}[status] ?? 'unknown');

export function summaryNotice(state) {
  if (state.phase === 'offline') return 'Task offline';
  if (state.phase === 'error') return 'Unable to read Task';
  if (state.phase === 'loading' || state.refreshing) return state.data ? 'Task updating' : 'Loading Task';
  if (state.data?.selection === 'unknown') return 'Task assignment order unknown';
  return null;
}

export function createTaskMenu(summaries, signal) {
  let opened = null;
  let finish;
  const listeners = new Set();
  const notify = () => { for (const listener of listeners) listener(); };
  const close = () => {
    if (!opened) return;
    opened = null;
    const done = finish;
    finish = null;
    notify();
    done();
  };
  signal.addEventListener('abort', close);
  return {
    getSnapshot: () => opened,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close,
    getState(target) {
      const state = summaries.get(target.sessionId);
      const notice = summaryNotice(state);
      if (notice) return { label: state.phase === 'error' ? 'Retry reading Task' : notice,
        disabled: state.phase !== 'error' };
      return { label: state.data?.selection === 'recent' ? 'Recent Task' : 'Current Task',
        visible: Boolean(state.data?.task) };
    },
    onSelect(target, { signal: actionSignal }) {
      signal.throwIfAborted();
      actionSignal.throwIfAborted();
      const state = summaries.get(target.sessionId);
      if (state.phase === 'error') { summaries.retry(target.sessionId); return; }
      if (summaryNotice(state) || !state.data?.task) throw new Error('The session Task is not currently available.');
      if (opened) throw new Error('Close the current Task details before opening another.');
      return new Promise(resolve => {
        finish = () => { actionSignal.removeEventListener('abort', close); resolve(); };
        actionSignal.addEventListener('abort', close, { once: true });
        opened = { taskId: state.data.task.id, sessionId: target.sessionId };
        notify();
      });
    },
    dispose() {
      close();
      signal.removeEventListener('abort', close);
      listeners.clear();
    },
  };
}
