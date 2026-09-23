import { TaskError } from './contracts.js';

const executorRoles = [{ moduleId: 'cockpit-task', roleId: 'executor' }];

function availabilityReasons(meta) {
  if (meta === null) return ['session_not_found'];
  return [
    [!meta.loaded, 'session_not_loaded'],
    [meta.status !== 'idle', 'session_not_idle'],
    [meta.nativeProcessing !== false, meta.nativeProcessing === true ? 'native_processing' : 'native_processing_unconfirmed'],
    [meta.activeOperations !== 0, meta.activeOperations > 0 ? 'active_operations' : 'active_operations_unconfirmed'],
    [!Array.isArray(meta.queue), 'queue_unconfirmed'],
    [Array.isArray(meta.queue) && meta.queue.length > 0, 'queued_messages'],
    [meta.loading, 'loading'],
    [meta.closing, 'closing'],
    [meta.cancelling, 'cancelling'],
    [meta.ask, 'pending_user_question'],
    [meta.planRequest, 'pending_plan'],
    [meta.elicitation, 'pending_elicitation'],
    [meta.activeSubagents > 0, 'active_subagents'],
    [meta.activeMcpOperations > 0, 'active_mcp_operations'],
  ].filter(([blocked]) => blocked).map(([, reason]) => reason);
}

export function createHostAdapter(host) {
  if (typeof host?.call !== 'function') {
    throw new Error('Task requires the Cockpit module host intents and session roles contract');
  }
  const get = async sessionId => {
    const result = await host.call('session/get', { sessionId });
    if (!result || !Object.hasOwn(result, 'meta')) throw new Error('Host returned no session observation');
    const meta = result.meta;
    if (meta !== null && (meta.sessionId !== sessionId || typeof meta.loaded !== 'boolean'
      || !['idle', 'running', 'unloaded', 'error'].includes(meta.status))) {
      throw new Error('Host returned an invalid session observation');
    }
    return meta;
  };
  return {
    ownerExists: async sessionId => (await get(sessionId)) !== null,
    create: cwd => host.call('session/new', { cwd, roles: executorRoles }),
    preparationSupported: host.resourcePreparationVersion === 1,
    prepare: (sessionId, { skills, mcp_servers }) => host.call('session/resources-prepare', {
      sessionId, ...(skills !== undefined ? { skills } : {}),
      ...(mcp_servers !== undefined ? { mcpServers: mcp_servers } : {}),
    }),
    async inspect(sessionId) {
      const capability = await host.call('roles/readiness', { sessionId, roles: executorRoles });
      if (capability?.sessionId !== sessionId || typeof capability.ready !== 'boolean'
        || typeof capability.loaded !== 'boolean' || !Array.isArray(capability.reasons)) {
        throw new TaskError('CAPABILITY_UNAVAILABLE', 'Host returned no confirmed Executor readiness');
      }
      const meta = await get(sessionId);
      const availability_reasons = availabilityReasons(meta);
      return {
        ready: capability.ready && capability.loaded && meta?.loaded === true,
        idle: availability_reasons.length === 0,
        executor: capability.rolesNeedReload === false && Array.isArray(capability.appliedRoles)
          && capability.appliedRoles.some(role => role.moduleId === 'cockpit-task' && role.roleId === 'executor'),
        details: {
          reasons: capability.reasons, loaded: meta?.loaded ?? null, status: meta?.status ?? null,
          availability_reasons, observed_at: new Date().toISOString(),
        },
      };
    },
    send: (sessionId, text) => host.call('prompt', { sessionId, text, mode: 'enqueue' }),
    async nameState(sessionId) {
      const meta = await get(sessionId);
      if (meta === null) throw new TaskError('SESSION_NOT_FOUND', 'The Executor session is no longer known to the host');
      // Older hosts omit provenance; omission is unknown, never an auto-generated title.
      if (!Object.hasOwn(meta, 'nativeName') || typeof meta.nativeNameUserSet !== 'boolean'
        || (meta.nativeName !== null && typeof meta.nativeName !== 'string')) return null;
      return { name: meta.nativeName, userSet: meta.nativeNameUserSet };
    },
    rename: (sessionId, name) => host.call('session/rename', { sessionId, name }),
    async observe(sessionId) {
      const meta = await get(sessionId);
      if (!meta) return {
        source: 'native', session_id: sessionId, loaded: null, available: false,
        observed_at: new Date().toISOString(),
        error: { code: 'SESSION_NOT_FOUND', message: 'The Executor session is no longer known to the host' },
      };
      return {
        source: 'native', session_id: sessionId, loaded: meta.loaded, status: meta.status,
        observed_at: new Date().toISOString(), available: true,
      };
    },
  };
}
