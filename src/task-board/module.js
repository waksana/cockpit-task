import { toolSchemas } from './contracts.js';
import { createHostAdapter } from './host.js';
import { createMcpRoutes } from './mcp.js';
import { TaskService } from './service.js';
import { TaskStore } from './store.js';

export function activate(context) {
  if (context.apiVersion !== 1 || context.moduleId !== 'cockpit-task') {
    throw new Error('Task requires Cockpit Module API v1 and module ID cockpit-task; task-board requires explicit offline migration');
  }
  const host = createHostAdapter(context.host);
  const store = new TaskStore(context.dataRoot);
  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal]);
  const service = new TaskService(store, host, { invalidate: context.invalidate, report: context.report });
  const execute = (name, input, options) => service.execute(name, input, options);
  const mcp = createMcpRoutes({ execute, schemas: toolSchemas, signal, report: context.report });
  const json = async (name, request) => {
    const body = await execute(name, request.body, {
      signal: AbortSignal.any([request.signal, signal]),
    });
    return { status: body.error?.status ?? (body.error ? 409 : 200), body };
  };
  return {
    routes: [
      { method: 'POST', path: '/read', body: 'json', bodyLimit: 262144, handler: request => json('task_read', request) },
      { method: 'POST', path: '/tools/:name', body: 'json', bodyLimit: 262144, handler: request => json(request.params.name, request) },
      {
        method: 'GET', path: '/tasks/:id/native',
        async handler(request) {
          const task = await execute('task_read', { view: 'overview', task_id: request.params.id }, {
            signal: AbortSignal.any([request.signal, signal]),
          });
          const unavailable = (sessionId, error) => ({
            source: 'native', session_id: sessionId, loaded: null, available: false,
            observed_at: new Date().toISOString(), error,
          });
          if (task.error) return { status: task.error.status ?? 400, body: unavailable(null, task.error) };
          const executor = task.result.executor;
          if (!executor) return {
            body: unavailable(null, { code: 'NO_EXECUTOR', message: 'This Task has no assigned Executor' }),
          };
          try { return { body: await host.observe(executor) }; }
          catch (error) {
            context.report(error);
            return {
              body: unavailable(executor, { code: 'NATIVE_UNAVAILABLE', message: 'The host could not confirm the current session state' }),
            };
          }
        },
      },
      ...mcp.routes,
    ],
    dispose() {
      controller.abort(new Error('Task stopped'));
      mcp.close();
      service.close();
    },
  };
}
