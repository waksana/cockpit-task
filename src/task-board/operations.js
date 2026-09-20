import { taskReference } from './reference.js';

function fault(code, message) {
  return { code, message };
}

function errorDetail(error, fallback) {
  return {
    code: typeof error?.code === 'string' ? error.code : fallback,
    message: error instanceof Error ? error.message : String(error),
  };
}

function cancellation(signal) {
  return signal?.aborted ? fault('REQUEST_CANCELLED', 'Request stopped before the next external action') : null;
}

export async function createExecutor({ input, create, inspect, save, signal }) {
  const operation = {
    request_id: input.request_id, status: 'running',
    creation: 'not_created', session_id: null, capability: 'unchecked',
  };
  const finish = (status, error = null) => {
    operation.status = status;
    const outcome = { result: { operation: { ...operation } }, error };
    save(outcome);
    return outcome;
  };
  const cancelled = cancellation(signal);
  if (cancelled) return finish('rejected', cancelled);
  operation.creation = 'unknown';
  save({ result: { operation: { ...operation } }, error: null });
  let created;
  try {
    created = await create(input.cwd);
  } catch (error) {
    if (typeof error?.sessionId === 'string') {
      operation.session_id = error.sessionId;
      operation.creation = 'created';
      operation.capability = 'unavailable';
      return finish('partially_applied', errorDetail(error, 'CAPABILITY_UNAVAILABLE'));
    }
    return finish('unconfirmed', errorDetail(error, 'OPERATION_UNCONFIRMED'));
  }
  if (typeof created?.sessionId !== 'string' || !created.sessionId) {
    return finish('unconfirmed', fault('OPERATION_UNCONFIRMED', 'Host creation returned no confirmed session ID'));
  }
  operation.session_id = created.sessionId;
  operation.creation = 'created';
  save({ result: { operation: { ...operation } }, error: null });
  let capability;
  try {
    capability = await inspect(created.sessionId);
  } catch (error) {
    operation.capability = 'unknown';
    return finish('partially_applied', errorDetail(error, 'CAPABILITY_UNAVAILABLE'));
  }
  operation.capability = capability.ready ? 'ready' : 'unavailable';
  if (!capability.ready) {
    operation.details = capability.details;
    return finish('partially_applied', fault('CAPABILITY_UNAVAILABLE', 'Session exists, but Executor capability is not ready'));
  }
  return finish('applied');
}

export async function assignExecutor({ input, inspect, bind, recheck, send, save, signal }) {
  const operation = {
    request_id: input.request_id, task_id: input.task_id, status: 'running', executor: input.executor,
    capability: 'unchecked', assignment: 'not_applied', message: 'not_sent',
  };
  const finish = (status, error = null) => {
    operation.status = status;
    const outcome = { result: { operation: { ...operation } }, error };
    save(outcome);
    return outcome;
  };
  const stopped = () => {
    const error = cancellation(signal);
    return error ? finish(operation.assignment === 'applied' ? 'partially_applied' : 'rejected', error) : null;
  };
  const initialStop = stopped();
  if (initialStop) return initialStop;
  let current;
  try {
    current = await inspect(input.executor);
  } catch (error) {
    return finish('rejected', errorDetail(error, 'CAPABILITY_UNAVAILABLE'));
  }
  operation.capability = current.ready ? 'ready' : 'unavailable';
  if (!current.ready) {
    operation.details = current.details;
    return finish('rejected', fault('CAPABILITY_UNAVAILABLE', 'Selected session lacks ready Executor capability'));
  }
  if (!current.idle) {
    return finish('rejected', fault('EXECUTOR_NOT_READY', 'Selected Executor is not idle and available; nothing sent'));
  }
  const beforeBind = stopped();
  if (beforeBind) return beforeBind;
  try {
    const task = bind();
    operation.assignment = 'applied';
    operation.write_context = task.write_context;
  } catch (error) {
    return finish('rejected', errorDetail(error, 'ASSIGNMENT_CONFLICT'));
  }
  save({ result: { operation: { ...operation } }, error: null });
  try {
    current = await inspect(input.executor);
    recheck();
  } catch (error) {
    return finish('partially_applied', errorDetail(error, 'EXECUTOR_NOT_READY'));
  }
  operation.capability = current.ready ? 'ready' : 'unavailable';
  if (!current.ready || !current.idle) {
    return finish('partially_applied', fault(
      current.ready ? 'EXECUTOR_NOT_READY' : 'CAPABILITY_UNAVAILABLE',
      'Assignment was saved, but the target cannot receive a dispatch; nothing sent',
    ));
  }
  const beforeSend = stopped();
  if (beforeSend) return beforeSend;
  // Persist uncertainty before crossing the host boundary. Restart must not resend.
  operation.message = 'unknown';
  save({ result: { operation: { ...operation } }, error: null });
  let result;
  try {
    result = await send(input.executor, taskReference(input.task_id));
  } catch (error) {
    return finish('unconfirmed', errorDetail(error, 'OPERATION_UNCONFIRMED'));
  }
  if (result?.queued === true) {
    operation.message = 'queued';
    return finish('partially_applied', fault('UNEXPECTED_QUEUE', 'Host queued the dispatch unexpectedly; do not send it again'));
  }
  if (result?.ok !== true) {
    return finish('unconfirmed', fault('OPERATION_UNCONFIRMED', 'Host did not confirm dispatch acceptance'));
  }
  operation.message = 'accepted';
  return finish('applied');
}
