import { TaskError, parseInput } from './contracts.js';
import { assignExecutor, createExecutor } from './operations.js';
import { deliverNotification } from './notifications.js';

export class TaskService {
  constructor(store, host, { invalidate = () => {}, report = () => {} } = {}) {
    this.store = store;
    this.host = host;
    this.invalidate = invalidate;
    this.report = report;
    this.active = 0;
    this.closing = false;
    this.closed = false;
  }

  async execute(name, rawInput, { signal } = {}) {
    if (this.closing) return {
      result: null, error: { code: 'MODULE_CLOSING', message: 'Task is closing', status: 503 },
      definition_check: { status: 'unavailable', error: { code: 'MODULE_CLOSING', message: 'Task storage is closing' } },
    };
    this.active++;
    try {
      return await this.run(name, rawInput, signal);
    } finally {
      this.active--;
      this.finishClose();
    }
  }

  async run(name, rawInput, signal) {
    let input;
    let outcome;
    try {
      input = parseInput(name, rawInput);
      if (signal?.aborted) throw new TaskError('REQUEST_CANCELLED', 'Task request was cancelled before execution', 409);
      if (name === 'task_session_create' || name === 'task_assign') {
        const receipt = this.store.reserveOperation(name, input);
        if (receipt.replay) outcome = { result: receipt.result, error: receipt.error };
        else {
          const options = {
            input, signal,
            inspect: id => this.host.inspect(id),
            save: value => this.store.saveOperation(input.request_id, value),
          };
          outcome = name === 'task_session_create'
            ? await createExecutor({ ...options, create: cwd => this.host.create(cwd) })
            : await assignExecutor({
              ...options,
              bind: () => this.store.bindAssignment(input),
              recheck: () => this.store.dispatchPreflight(input),
              send: (id, text) => this.host.send(id, text),
            });
        }
      } else {
        outcome = { result: this.store.executeLocal(name, input), error: null };
      }
    } catch (error) {
      if (error instanceof TaskError) {
        outcome = {
          result: error.result,
          error: { code: error.code, message: error.message, status: error.status },
        };
      } else {
        this.report(error);
        outcome = {
          result: null,
          error: {
            code: 'OPERATION_UNCONFIRMED',
            message: 'Task operation failed unexpectedly; inspect the Task and durable operation receipt before retrying',
            status: 500,
          },
        };
      }
    }
    let notifications;
    let notification_error;
    if (outcome.result?.subscription_ids?.length) {
      notifications = [];
      for (const id of outcome.result.subscription_ids) {
        try {
          notifications.push(await this.deliver(id, signal));
        } catch (error) {
          this.report(error);
          notification_error = {
            code: 'NOTIFICATION_STORAGE_UNCONFIRMED',
            message: 'Task mutation was saved, but notification persistence could not be confirmed; inspect subscriptions before any manual action',
          };
        }
      }
      const incomplete = notifications.find(item => !['accepted', 'queued'].includes(item.notification.status));
      if (incomplete && !notification_error) notification_error = incomplete.notification.error ?? {
        code: 'NOTIFICATION_PENDING', message: 'Task mutation was saved; the known-unsent notification remains pending recovery',
      };
    }
    const target = input?.task_id ?? outcome.result?.task_id
      ?? outcome.result?.operation?.task_id ?? outcome.result?.result?.task_id
      ?? outcome.result?.result?.operation?.task_id;
    const context = {
      task_id: target ?? (typeof rawInput?.task_id === 'string' ? rawInput.task_id : undefined),
      actor_session_id: input?.actor_session_id
        ?? (typeof rawInput?.actor_session_id === 'string' ? rawInput.actor_session_id : undefined),
    };
    const definition_check = this.store.definitionCheck(context);
    if (name !== 'task_read' && outcome.result !== null) this.invalidate();
    return {
      ...outcome, definition_check,
      ...(notifications ? { notifications, notification_error: notification_error ?? null } : {}),
    };
  }

  deliver(id, signal) {
    return deliverNotification({
      store: this.store, host: this.host, id,
      stopped: () => this.closing || signal?.aborted,
    });
  }

  recoverNotifications({ signal } = {}) {
    if (this.closing || signal?.aborted) return Promise.resolve();
    if (this.recovery) return this.recovery;
    // A fixed high-water mark bounds this startup pass. New transitions deliver themselves.
    const through = this.store.pendingNotificationBoundary();
    if (!through) return Promise.resolve();
    this.active++;
    this.recovery = (async () => {
      let after = 0;
      while (!this.closing && !signal?.aborted) {
        const batch = this.store.pendingNotifications(after, through);
        if (!batch.length) break;
        for (const entry of batch) {
          if (this.closing || signal?.aborted) return;
          const subscription = await this.deliver(entry.id, signal);
          if (subscription.notification.error) this.report(new TaskError(
            subscription.notification.error.code, subscription.notification.error.message, 502, subscription,
          ));
          this.invalidate();
          after = entry.seq;
        }
      }
    })().catch(error => this.report(error)).finally(() => {
      this.recovery = null;
      this.active--;
      this.finishClose();
    });
    return this.recovery;
  }

  close() {
    this.closing = true;
    this.finishClose();
  }

  finishClose() {
    if (this.closing && !this.active && !this.closed) {
      this.closed = true;
      this.store.close();
    }
  }
}
