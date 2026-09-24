import { TaskError, parseInput } from './contracts.js';
import { assignTask, createNodeSession, prepareNodeSession } from './operations.js';
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

  // actor is the calling session: the host-injected MCP invocation, or 'user' for the module HTTP API.
  // external marks untrusted MCP/HTTP input: identity then comes only from these options.
  async execute(name, rawInput, { signal, actor, invocation, external = false } = {}) {
    if (this.closing) return {
      result: null, error: { code: 'MODULE_CLOSING', message: 'Task is closing', status: 503 },
      definition_check: { status: 'unavailable', error: { code: 'MODULE_CLOSING', message: 'Task storage is closing' } },
    };
    this.active++;
    try {
      return await this.run(name, rawInput, signal, invocation?.sessionId ?? actor, invocation, external);
    } finally {
      this.active--;
      this.finishClose();
    }
  }

  async run(name, rawInput, signal, actor, invocation, external) {
    let input;
    let outcome;
    try {
      const { actor: inputActor, invocation: inputInvocation, ...publicInput } =
        rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {};
      if (external && (inputActor !== undefined || inputInvocation !== undefined)) {
        throw new TaskError('INVALID_INPUT', 'Caller identity comes only from host invocation metadata; actor and invocation are not tool arguments and nothing was done', 400);
      }
      const effectiveInvocation = external ? invocation : invocation ?? inputInvocation;
      const effectiveActor = external ? effectiveInvocation?.sessionId ?? actor : effectiveInvocation?.sessionId ?? actor ?? inputActor;
      if (typeof effectiveActor !== 'string' || !effectiveActor) {
        throw new TaskError('INVOCATION_REQUIRED', 'Task tools need the calling session from host MCP invocation metadata (_meta["cockpit/invocation"]); this host did not provide it and nothing was done', 400);
      }
      input = { ...parseInput(name, publicInput), actor: effectiveActor, ...(effectiveInvocation ? { invocation: effectiveInvocation } : {}) };
      if (signal?.aborted) throw new TaskError('REQUEST_CANCELLED', 'Task request was cancelled before execution', 409);
      if (name === 'task_assign') {
        const row = this.store.row(input.task_id);
        if (row.kind === 'automation') throw new TaskError('AUTOMATION_MANAGED', 'Automation Tasks cannot be assigned to an Agent');
        // Reject before reserving or inspecting the assignee, so a busy target cannot mask role
        // confusion as unavailability; binding rechecks inside its transaction.
        if (!this.store.receipt(name, input)) this.store.authorize(row, input.actor, ['orchestrator']);
        if (!input.resume_request_id && !this.store.receipt(name, input)) {
          this.store.assertAssignable(row, input.assignee);
          this.store.assertReady(row);
        }
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
            outcome = await createNodeSession({ ...options, create: cwd => this.host.create(cwd) });
          } else if (name === 'task_session_prepare') {
            outcome = await prepareNodeSession(options);
          } else {
            try {
              outcome = await this.withSessionOperation(input.assignee, () => assignTask({
                ...options,
                bind: () => this.store.bindAssignment(input),
                recheck: () => this.store.dispatchPreflight(input),
                send: (id, text) => this.host.send(id, text),
                ...(typeof this.host.nameState === 'function' && typeof this.host.rename === 'function' ? { retitle: {
                  nameState: id => this.host.nameState(id),
                  rename: (id, name) => this.host.rename(id, name),
                  previous: () => this.store.moduleSessionTitle(input.assignee, input.request_id),
                } } : {}),
              }));
            } catch (error) {
              if (!(error instanceof TaskError) || error.code !== 'SESSION_OPERATION_IN_PROGRESS') throw error;
              outcome = {
                result: { operation: {
                  request_id: input.request_id, task_id: input.task_id, assignee: input.assignee,
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
            const candidate = this.store.reopenCandidate(input);
            // Whoever reopens, the original assignee continues the work and needs Node capability.
            const capability = await this.host.inspect(candidate.assignee);
            if (!capability.ready || !capability.node) {
              throw new TaskError('CAPABILITY_UNAVAILABLE', 'The original assignee must have loaded, ready Node capability');
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
    const notificationIds = [...(outcome.result?.subscription_ids ?? []), ...(outcome.result?.notice_ids ?? [])];
    if (notificationIds.length) {
      notifications = [];
      for (const id of notificationIds) {
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
      actor: typeof input?.actor === 'string' ? input.actor : typeof actor === 'string' ? actor : undefined,
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
      throw new TaskError('SESSION_OPERATION_IN_PROGRESS', 'Another preparation or assignment is using this session; nothing attempted');
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
    // Fixed high-water marks bound this startup pass. New transitions deliver themselves.
    // Immediate assignee notices are only meaningful during their request; one left pending by
    // a restart is recorded as not sent rather than interrupting the assignee later.
    for (let seq = 0, through = this.store.pendingNotificationBoundary('assignee_notices'); through;) {
      const batch = this.store.pendingNotifications(seq, through, 20, 'assignee_notices');
      if (!batch.length) break;
      for (const entry of batch) {
        this.store.finishNotification(entry.id, 'pending', 'not_sent', {
          code: 'ASSIGNEE_NOTICE_EXPIRED', message: 'The module restarted before this assignee notice was sent; it was not sent. The assignee still meets the change through definition_check or the Task status at its next read',
        });
        seq = entry.seq;
      }
    }
    const sources = ['subscriptions', 'dependency_notices', 'child_notices']
      .map(table => ({ table, through: this.store.pendingNotificationBoundary(table) })).filter(source => source.through);
    if (!sources.length) return Promise.resolve();
    this.active++;
    this.recovery = (async () => {
      for (const { table, through } of sources) {
        let after = 0;
        while (!this.closing && !signal?.aborted) {
          const batch = this.store.pendingNotifications(after, through, 20, table);
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
