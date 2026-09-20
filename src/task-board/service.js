import { TaskError, parseInput } from './contracts.js';
import { assignExecutor, createExecutor } from './operations.js';

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
      result: null, error: { code: 'MODULE_CLOSING', message: 'Task Board is closing', status: 503 },
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
    return { ...outcome, definition_check };
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
