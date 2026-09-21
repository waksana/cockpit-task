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

const selectedResources = input => input.skills !== undefined || input.mcp_servers !== undefined;
const unsupportedPreparation = () => fault(
  'PREPARATION_UNSUPPORTED',
  'Host resource preparation v1 is required; no session or resource mutation was attempted',
);

async function prepareSelected({ input, operation, inspect, prepare, preflight, save, signal }) {
  const initialCancellation = cancellation(signal);
  if (initialCancellation) return initialCancellation;
  preflight(operation.session_id);
  const current = await inspect(operation.session_id);
  operation.capability = current.ready ? 'ready' : 'unavailable';
  if (current.details !== undefined) operation.details = current.details;
  if (!current.idle) return fault('EXECUTOR_NOT_READY', 'Preparation requires an already loaded idle Executor');
  if (!current.executor) return fault('EXECUTOR_ROLE_REQUIRED', 'The Executor role must already be applied without a pending role reload');
  const cancelled = cancellation(signal);
  if (cancelled) return cancelled;
  preflight(operation.session_id);
  operation.preparation = 'unknown';
  operation.capability = 'unchecked';
  // A lost host response must never replay native effects with this request ID.
  save({ result: { operation: { ...operation } }, error: null });
  const resources = await prepare(operation.session_id, input);
  if (resources?.sessionId !== operation.session_id || typeof resources.ok !== 'boolean'
    || !Array.isArray(resources.skills) || !Array.isArray(resources.mcpServers)
    || !['not_attempted', 'unchanged', 'initialized', 'unconfirmed'].includes(resources.tools)) {
    return fault('PREPARATION_UNCONFIRMED', 'Host returned no confirmed resource preparation receipt; inspect the session before further action');
  }
  operation.resources = resources;
  operation.preparation = resources.ok ? 'prepared' : 'unavailable';
  save({ result: { operation: { ...operation } }, error: null });
  if (!resources.ok) return fault('RESOURCE_PREPARATION_FAILED', resources.error || 'Selected resources were not confirmed; inspect per-step effects before any new request');
  const afterPreparationCancellation = cancellation(signal);
  if (afterPreparationCancellation) return afterPreparationCancellation;
  const after = await inspect(operation.session_id);
  operation.capability = after.ready ? 'ready' : 'unavailable';
  if (after.details !== undefined) operation.details = after.details;
  else delete operation.details;
  if (!after.ready) return fault('CAPABILITY_UNAVAILABLE', 'Resources were prepared, but Executor capability is not ready');
  if (!after.idle) return fault('EXECUTOR_NOT_READY', 'Resources were prepared, but the Executor is no longer idle');
  preflight(operation.session_id);
  delete operation.details;
  return null;
}

function preparationFailureStatus(operation) {
  if (operation.preparation === 'unknown'
    || operation.resources?.tools === 'unconfirmed'
    || [...(operation.resources?.skills ?? []), ...(operation.resources?.mcpServers ?? [])]
      .some(resource => resource.effect === 'unconfirmed')) return 'unconfirmed';
  if (operation.creation === 'created' || operation.preparation === 'prepared'
    || operation.resources?.tools === 'initialized'
    || [...(operation.resources?.skills ?? []), ...(operation.resources?.mcpServers ?? [])]
      .some(resource => resource.effect === 'enabled')) return 'partially_applied';
  return 'rejected';
}

async function runPreparation(options, finish) {
  options.save({ result: { operation: { ...options.operation } }, error: null });
  let error;
  try {
    error = await options.guard(options.operation.session_id, () => prepareSelected(options));
  } catch (cause) {
    error = errorDetail(cause, 'PREPARATION_UNCONFIRMED');
  }
  return error ? finish(preparationFailureStatus(options.operation), error) : finish('applied');
}

export async function prepareExecutor(options) {
  const { input, preparationSupported, save, signal } = options;
  const operation = {
    request_id: input.request_id, status: 'running', session_id: input.session_id,
    preparation: 'not_prepared', capability: 'unchecked',
  };
  const finish = (status, error = null) => {
    operation.status = status;
    const outcome = { result: { operation: { ...operation } }, error };
    save(outcome);
    return outcome;
  };
  const cancelled = cancellation(signal);
  if (cancelled) return finish('rejected', cancelled);
  if (!preparationSupported) return finish('rejected', unsupportedPreparation());
  return runPreparation({ ...options, operation }, finish);
}

export async function createExecutor(options) {
  const { input, create, inspect, save, signal, preparationSupported } = options;
  const operation = {
    request_id: input.request_id, status: 'running',
    creation: 'not_created', session_id: null, capability: 'unchecked',
    ...(selectedResources(input) ? { preparation: 'not_prepared' } : {}),
  };
  const finish = (status, error = null) => {
    operation.status = status;
    const outcome = { result: { operation: { ...operation } }, error };
    save(outcome);
    return outcome;
  };
  const cancelled = cancellation(signal);
  if (cancelled) return finish('rejected', cancelled);
  if (selectedResources(input) && !preparationSupported) return finish('rejected', unsupportedPreparation());
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
  if (selectedResources(input)) {
    return runPreparation({ ...options, operation }, finish);
  }
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
  const finish = (status, error = null, details) => {
    operation.status = status;
    if (details !== undefined) operation.details = details;
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
    return finish('rejected', fault('CAPABILITY_UNAVAILABLE', 'Selected session lacks ready Executor capability'), current.details);
  }
  if (!current.idle) {
    return finish('rejected', fault('EXECUTOR_NOT_READY', 'Selected Executor is not idle and available; nothing sent'), current.details);
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
    ), current.details);
  }
  const beforeSend = stopped();
  if (beforeSend) return beforeSend;
  // Persist uncertainty before crossing the host boundary. Restart must not resend.
  operation.message = 'unknown';
  save({ result: { operation: { ...operation } }, error: null });
  let result;
  try {
    result = await send(input.executor, taskReference(input.task_id, 'assigned'));
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
