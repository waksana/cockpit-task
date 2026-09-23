import { TaskError, parseInput } from './contracts.js';
import { assignExecutor, createExecutor, prepareExecutor } from './operations.js';
import { deliverNotification } from './notifications.js';
import { AutomationRunner } from './automation-runner.js';

export class TaskService {
  constructor(store, host, { invalidate = () => {}, report = () => {} } = {}) {
    this.store = store;
    this.host = host;
    this.invalidate = invalidate;
    this.report = report;
    this.active = 0;
    this.closing = false;
    this.closed = false;
    this.sessionOperations = new Set();
    this.automation = new AutomationRunner(this);
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
      if (name === 'task_assign' && this.store.row(input.task_id).kind === 'automation') {
        throw new TaskError('AUTOMATION_MANAGED', 'Automation Tasks cannot be assigned to an Agent');
      }
      if (['task_session_create', 'task_session_prepare', 'task_assign'].includes(name)) {
        const receipt = this.store.reserveOperation(name, input);
        if (receipt.replay) outcome = { result: receipt.result, error: receipt.error };
        else {
          const options = {
            input, signal,
            inspect: id => this.host.inspect(id),
            save: value => this.store.saveOperation(input.request_id, value),
            preparationSupported: this.host.preparationSupported === true,
            prepare: (id, resources) => this.host.prepare(id, resources),
            preflight: id => this.store.preparationPreflight(id),
            guard: (id, work) => this.withSessionOperation(id, work),
          };
          if (name === 'task_session_create') {
            outcome = await createExecutor({ ...options, create: cwd => this.host.create(cwd) });
          } else if (name === 'task_session_prepare') {
            outcome = await prepareExecutor(options);
          } else {
            try {
              outcome = await this.withSessionOperation(input.executor, () => assignExecutor({
                ...options,
                bind: () => this.store.bindAssignment(input),
                recheck: () => this.store.dispatchPreflight(input),
                send: (id, text) => this.host.send(id, text),
              }));
            } catch (error) {
              if (!(error instanceof TaskError) || error.code !== 'EXECUTOR_OPERATION_IN_PROGRESS') throw error;
              outcome = {
                result: { operation: {
                  request_id: input.request_id, task_id: input.task_id, executor: input.executor,
                  status: 'rejected', capability: 'unchecked', assignment: 'not_applied', message: 'not_sent',
                } },
                error: { code: error.code, message: error.message },
              };
              options.save(outcome);
            }
          }
        }
      } else {
        let validationError;
        if (name === 'task_reopen' && !this.store.receipt(name, input)) {
          try {
            this.store.reopenCandidate(input);
            const capability = await this.host.inspect(input.actor_session_id);
            // Self-continuation is performed by a running Executor, not an idle dispatch target.
            if (!capability.ready || !capability.executor) {
              throw new TaskError('CAPABILITY_UNAVAILABLE', 'The original Executor must have loaded, ready Executor capability');
            }
            if (signal?.aborted) throw new TaskError('REQUEST_CANCELLED', 'Task request was cancelled before reopening');
          } catch (error) {
            if (!(error instanceof TaskError)) throw error;
            validationError = error;
          }
        }
        outcome = { result: this.store.executeLocal(name, input, {
          validate: () => { if (validationError) throw validationError; },
        }), error: null };
        if (name === 'task_cancel') this.automation.cancel(input.task_id);
        if (['task_automation_start', 'task_automation_reconcile'].includes(name)) this.automation.kick();
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
    if (!['task_read', 'task_script_read'].includes(name) && outcome.result !== null) this.invalidate();
    return {
      ...outcome, definition_check,
      ...(notifications ? { notifications, notification_error: notification_error ?? null } : {}),
    };
  }

  async withSessionOperation(sessionId, work) {
    if (this.sessionOperations.has(sessionId)) {
      throw new TaskError('EXECUTOR_OPERATION_IN_PROGRESS', 'Another preparation or assignment is using this Executor; nothing attempted');
    }
    this.sessionOperations.add(sessionId);
    try { return await work(); }
    finally { this.sessionOperations.delete(sessionId); }
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
    this.automation.close();
    this.finishClose();
  }

  finishClose() {
    if (this.closing && !this.active && !this.closed) {
      this.closed = true;
      this.store.close();
    }
  }
}
