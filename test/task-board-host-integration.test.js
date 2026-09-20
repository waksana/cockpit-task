import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hostWorktree = process.env.TASK_BOARD_HOST_WORKTREE;
const ownerTools = ['task_read', 'task_create', 'task_session_create', 'task_assign', 'task_edit', 'task_cancel'];
const executorTools = ['task_read', 'task_edit', 'task_ack', 'task_report', 'task_cancel'];
const allTools = [...new Set([...ownerTools, ...executorTools])].sort();

async function removeIsolatedTree(root) {
  async function writable(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return;
    await chmod(path, info.isDirectory() ? 0o700 : 0o600);
    if (info.isDirectory()) for (const name of await readdir(path)) await writable(join(path, name));
  }
  await writable(root);
  await rm(root, { recursive: true, force: true });
}

test('packaged Task Board integrates with real isolated host roles, native SDK and HTTP MCP', {
  skip: !hostWorktree,
  timeout: 180_000,
}, async t => {
  const hostSource = resolve(hostWorktree);
  const archive = join(repository, 'dist', 'task-board-0.1.0.tgz');
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  const root = await mkdtemp(join(repository, '.task-board-host-integration-'));
  const dirs = Object.fromEntries(await Promise.all(
    ['home', 'state', 'work', 'scratch', 'config', 'cache', 'run', 'host'].map(async name => {
      const path = join(root, name);
      await mkdir(path);
      return [name, path];
    }),
  ));
  const env = {
    HOME: dirs.home, USERPROFILE: dirs.home, COCKPIT_HOME: dirs.host,
    XDG_CONFIG_HOME: dirs.config, XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state,
    XDG_RUNTIME_DIR: dirs.run, TMPDIR: dirs.scratch, TMP: dirs.scratch, TEMP: dirs.scratch,
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', COPILOT_DISABLE_KEYTAR: '1',
    COPILOT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dirs.config, 'gitconfig'),
  };
  const requests = [];
  const providerErrors = [];
  const bridgeCalls = [];
  const nativeMessages = [];
  const isolatedSessionIds = new Set();
  const reports = [];
  let invalidations = 0;
  let runtime;
  let engine;
  let app;
  let moduleHost;
  let mcp;
  let provider;
  let unsubscribe;
  let failed = false;
  let stage = 'isolating the environment';
  const importHost = path => import(pathToFileURL(join(hostSource, path)).href);
  const waitFor = async (predicate, description) => {
    const deadline = Date.now() + 25_000;
    while (!await predicate()) {
      assert.ok(Date.now() < deadline, `Timed out: ${description}`);
      await delay(20);
    }
  };
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    process.chdir(dirs.work);
    assert.deepEqual(Object.keys(process.env).sort(), Object.keys(env).sort());
    assert.deepEqual(await readdir(dirs.home), []);
    assert.deepEqual(await readdir(dirs.config), []);
    assert.deepEqual(await readdir(dirs.state), []);
    assert.deepEqual(await readdir(dirs.host), []);

    stage = 'importing the actual host and official SDKs';
    const sdkRoot = join(hostSource, 'packages/core/node_modules/@github/copilot-sdk');
    const sdkPackage = JSON.parse(await readFile(join(sdkRoot, 'package.json'), 'utf8'));
    // Match the host's ESM export: mixing require/import builds breaks ToolSet identity.
    const { RuntimeConnection, ToolSet } = await import(pathToFileURL(resolve(sdkRoot, sdkPackage.exports['.'].import.default)).href);
    const [
      { OfficialRuntime }, { Engine }, { ModuleHost }, { ModuleRoles }, { installLocalModule },
      { default: Fastify }, { Client }, { StreamableHTTPClientTransport },
    ] = await Promise.all([
      importHost('packages/core/src/runtime.ts'),
      importHost('packages/core/src/engine.ts'),
      importHost('apps/server/src/module-host.ts'),
      importHost('apps/server/src/module-roles.ts'),
      importHost('apps/server/src/module-install.ts'),
      import('fastify'),
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    ]);

    stage = 'starting the synthetic loopback model provider';
    provider = createServer(async (request, response) => {
      try {
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/v1/chat/completions');
        // The native OpenAI adapter may emit a bare "Bearer" with no API key.
        assert.ok(request.headers.authorization === undefined || request.headers.authorization.trim() === 'Bearer',
          'Synthetic provider must never receive credentials');
        let text = '';
        for await (const chunk of request) text += chunk;
        const message = JSON.parse(text);
        requests.push(message);
        const completion = { id: 'synthetic-task-integration', created: 1, model: message.model };
        if (message.stream) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const choice of [
            { delta: { role: 'assistant', content: 'Synthetic local acknowledgment. No tools or external work.' }, finish_reason: null },
            { delta: {}, finish_reason: 'stop' },
          ]) response.write(`data: ${JSON.stringify({
            ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, ...choice }],
          })}\n\n`);
          response.end('data: [DONE]\n\n');
        } else {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            ...completion, object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic local acknowledgment.' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }));
        }
      } catch (error) {
        providerErrors.push(error);
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Synthetic provider assertion failed' } }));
      }
    });
    await new Promise((resolve, reject) => {
      provider.once('error', reject);
      provider.listen(0, '127.0.0.1', resolve);
    });
    const providerUrl = `http://127.0.0.1:${provider.address().port}`;
    runtime = new OfficialRuntime({
      clientOptions: {
        connection: RuntimeConnection.forStdio({ env }), mode: 'empty', baseDirectory: dirs.state,
        workingDirectory: dirs.work, builtinPluginDirectories: [], useLoggedInUser: false,
        enableRemoteSessions: false, logLevel: 'error', onListModels: () => [],
      },
      sessionConfig: {
        model: 'gpt-4.1',
        provider: { type: 'openai', wireApi: 'completions', baseUrl: `${providerUrl}/v1`, modelId: 'gpt-4.1' },
        configDirectory: dirs.state, enableFileHooks: false, enableHostGitOperations: false,
        enableSessionStore: false, enableSkills: true, pluginDirectories: [], instructionDirectories: [], customAgents: [],
        enableManagedSettings: false, skipEmbeddingRetrieval: true, embeddingCacheStorage: 'in-memory',
        enableSessionTelemetry: false, remoteSession: 'off', enableExperimentalMode: true,
        availableTools: new ToolSet().addMcp('*'),
      },
    });
    engine = new Engine({ runtime });
    const bridge = {
      async call(name, body) {
        bridgeCalls.push({ name, body: structuredClone(body) });
        if (name === 'session/new') {
          const sessionId = await engine.newSession(body.cwd, body.roles);
          isolatedSessionIds.add(sessionId);
          return { sessionId };
        }
        if (name === 'session/get') return { meta: await engine.getMeta(body.sessionId) };
        if (name === 'roles/readiness') return engine.roleReadiness(body.sessionId, body.roles);
        if (name === 'prompt') return engine.prompt(body.sessionId, body.text, body.mode);
        assert.fail(`Unexpected module host intent: ${name}`);
      },
    };

    stage = 'installing the real artifact and activating its backend';
    const installed = await installLocalModule(archive, { hostRoot: dirs.host, trustLocalCode: true, enable: true });
    assert.equal(installed.manifest.id, 'task-board');
    assert.equal(installed.manifest.version, '0.1.0');
    assert.ok(installed.root.startsWith(`${dirs.host}/modules/installed/`));
    const startModule = async () => {
      app = Fastify({ forceCloseConnections: true });
      moduleHost = new ModuleHost({
        hostRoot: dirs.host, observer: engine, host: bridge,
        onInvalidate: () => { invalidations++; },
        report: (id, error) => reports.push({ id, error }),
      });
      await moduleHost.register(app);
      await app.listen({ host: '127.0.0.1', port: 0 });
      return `http://127.0.0.1:${app.server.address().port}`;
    };
    const origin = await startModule();
    const bootstrap = moduleHost.bootstrap();
    assert.deepEqual(bootstrap.errors, []);
    assert.deepEqual(bootstrap.active, [{ id: 'task-board', version: '0.1.0', digest: installed.digest }]);
    const apiBase = bootstrap.modules[0].apiBase;
    const headers = { 'X-Cockpit-Module-Digest': installed.digest };
    assert.equal((await app.inject(bootstrap.modules[0].entry)).statusCode, 200);
    const readPayload = { view: 'list' };
    for (const digest of [undefined, '', '0'.repeat(64)]) {
      const rejected = await app.inject({
        method: 'POST', url: `${apiBase}/read`, payload: readPayload,
        ...(digest === undefined ? {} : { headers: { 'X-Cockpit-Module-Digest': digest } }),
      });
      assert.equal(rejected.statusCode, 409, rejected.body);
      assert.equal(rejected.json().code, 'MODULE_VERSION_MISMATCH');
    }
    assert.equal((await app.inject({ method: 'POST', url: '/_modules/task-board/api/read', headers, payload: readPayload })).statusCode, 404);
    assert.equal((await app.inject({
      method: 'POST', url: `${apiBase.replace(installed.digest, '1'.repeat(64))}/read`, headers, payload: readPayload,
    })).statusCode, 404);
    const initialRead = await app.inject({ method: 'POST', url: `${apiBase}/read`, headers, payload: readPayload });
    assert.equal(initialRead.statusCode, 200, initialRead.body);
    assert.deepEqual(initialRead.json().result, { items: [], next_cursor: null });

    stage = 'connecting the official HTTP MCP client';
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}${apiBase}/mcp`), {
      requestInit: { headers },
    });
    mcp = new Client({ name: 'synthetic-task-host-integration', version: '1.0.0' });
    await mcp.connect(transport);
    assert.equal(typeof transport.sessionId, 'string');
    assert.deepEqual((await mcp.listTools()).tools.map(tool => tool.name).sort(), allTools);
    const tool = async (name, input) => {
      const response = await mcp.callTool({ name, arguments: input });
      const envelope = response.structuredContent;
      assert.ok(envelope, JSON.stringify(response));
      assert.deepEqual(JSON.parse(response.content[0].text), envelope);
      assert.equal(envelope.error, null, JSON.stringify(envelope));
      assert.notEqual(response.isError, true, JSON.stringify(response));
      assert.ok(envelope.definition_check);
      return envelope;
    };

    stage = 'starting the actual native runtime with packaged ModuleRoles';
    const roles = new ModuleRoles(dirs.host, origin, () =>
      moduleHost.bootstrap().active.some(module => module.id === 'task-board') ? [installed] : []);
    const owner = { moduleId: 'task-board', roleId: 'owner' };
    const executor = { moduleId: 'task-board', roleId: 'executor' };
    assert.deepEqual(roles.list().map(role => role.roleId).sort(), ['executor', 'owner']);
    engine.setRoleProvider(roles);
    unsubscribe = engine.onNativeEvent(({ sessionId, event }) => {
      if (event.type === 'user.message') nativeMessages.push({ sessionId, content: event.data.content });
    });
    await engine.start();
    const ownerId = await engine.newSession(dirs.work, [owner]);
    isolatedSessionIds.add(ownerId);
    const unionId = await engine.newSession(dirs.work, [owner, executor]);
    isolatedSessionIds.add(unionId);
    assert.equal((await engine.roleReadiness(ownerId, [owner])).ready, true);
    assert.equal((await engine.roleReadiness(unionId, [owner, executor])).ready, true);
    assert.equal(requests.length, 0, 'Role creation must not send a startup prompt');

    const verifyAssembly = async (sessionId, selected, expectedTools, expectedSkills) => {
      const assembly = await roles.assemble(sessionId, selected);
      assert.deepEqual(Object.keys(assembly.config.mcpServers), ['module_task-board__task']);
      const server = assembly.config.mcpServers['module_task-board__task'];
      assert.equal(server.url, `${origin}${apiBase}/mcp`);
      assert.deepEqual(server.headers, headers);
      assert.deepEqual(server.tools, [...expectedTools].sort());
      assert.deepEqual(assembly.skills.map(skill => skill.name).sort(), [...expectedSkills].sort());
      for (const role of selected) {
        assert.ok(assembly.config.systemMessage.content.includes(`Module task-board / role ${role.roleId}`));
        const source = await readFile(join(installed.root, `roles/task-${role.roleId}.md`), 'utf8');
        assert.ok(assembly.config.systemMessage.content.includes(source));
      }
      assert.ok(assembly.config.systemMessage.content.includes(`Native session ID: ${sessionId}`));
      const nativeSkills = await engine.getPanel(sessionId, 'skills');
      assert.deepEqual(nativeSkills.filter(skill => skill.label.startsWith('task-')).map(skill => skill.label).sort(), [...expectedSkills].sort());
      for (const skill of nativeSkills.filter(skill => skill.label.startsWith('task-'))) assert.equal(skill.enabled, true);
      return assembly;
    };
    await verifyAssembly(ownerId, [owner], ownerTools, ['task-owner']);
    await verifyAssembly(unionId, [owner, executor], allTools, ['task-executor', 'task-owner']);
    const promptAndInspect = async (sessionId, text, expectedTools, unexpectedTools) => {
      const before = requests.length;
      await engine.prompt(sessionId, text);
      await waitFor(async () => requests.length > before && await engine.busyCount() === 0, 'synthetic native completion');
      assert.deepEqual(providerErrors, []);
      const captured = requests.slice(before);
      assert.ok(JSON.stringify(captured).includes(`Native session ID: ${sessionId}`));
      for (const role of roles.read(sessionId)) {
        assert.ok(JSON.stringify(captured).includes(`Module task-board / role ${role.roleId}`));
        assert.ok(JSON.stringify(captured).includes(`Use the task-${role.roleId} Skill`));
      }
      for (const request of captured) {
        const offered = JSON.stringify(request.tools);
        for (const name of expectedTools) assert.ok(offered.includes(name), `Missing native tool ${name}`);
        for (const name of unexpectedTools) assert.ok(!offered.includes(name), `Unexpected native tool ${name}`);
      }
    };
    await promptAndInspect(ownerId, 'Synthetic Owner capability check; acknowledge without tools.', ownerTools, ['task_ack', 'task_report']);
    await promptAndInspect(unionId, 'Synthetic Owner and Executor union check; acknowledge without tools.', allTools, []);

    stage = 'creating a real Executor through packaged task_session_create';
    const createInput = { request_id: 'integration-create-session', actor_session_id: ownerId, cwd: dirs.work };
    const creation = await tool('task_session_create', createInput);
    const executorId = creation.result.operation.session_id;
    assert.equal(creation.result.operation.creation, 'created');
    assert.equal(creation.result.operation.capability, 'ready');
    assert.equal((await engine.roleReadiness(executorId, [executor])).ready, true);
    await verifyAssembly(executorId, [executor], executorTools, ['task-executor']);
    assert.deepEqual((await tool('task_session_create', createInput)).result, creation.result);
    assert.equal(bridgeCalls.filter(call => call.name === 'session/new').length, 1, 'Creation replay cannot create a replacement');

    stage = 'assigning exactly one native Task reference';
    const created = await tool('task_create', {
      request_id: 'integration-task-create', actor_session_id: ownerId, owner: ownerId,
      title: 'Synthetic packaged integration', description: 'Synthetic complete requirements. No external work.',
    });
    const taskId = created.result.task_id;
    const initial = (await tool('task_read', { view: 'execution', task_id: taskId })).result;
    const assignInput = {
      request_id: 'integration-task-assign', actor_session_id: ownerId, task_id: taskId,
      executor: executorId, revision: initial.revision, write_context: initial.write_context,
    };
    const beforeDispatch = requests.length;
    const assigned = await tool('task_assign', assignInput);
    assert.equal(assigned.result.operation.assignment, 'applied');
    assert.equal(assigned.result.operation.message, 'accepted');
    await waitFor(async () => requests.length > beforeDispatch && await engine.busyCount() === 0, 'Task dispatch native completion');
    assert.deepEqual(providerErrors, []);
    const dispatched = requests.slice(beforeDispatch);
    assert.ok(JSON.stringify(dispatched).includes(`Native session ID: ${executorId}`));
    assert.ok(JSON.stringify(dispatched).includes('Module task-board / role executor'));
    assert.ok(JSON.stringify(dispatched).includes('Use the task-executor Skill'));
    for (const request of dispatched) {
      const offered = JSON.stringify(request.tools);
      for (const name of executorTools) assert.ok(offered.includes(name), `Missing Executor tool ${name}`);
      for (const name of ['task_create', 'task_session_create', 'task_assign']) assert.ok(!offered.includes(name), `Unexpected Executor tool ${name}`);
    }
    const reference = `[Task](task:${taskId})`;
    assert.deepEqual(nativeMessages.filter(message => message.sessionId === executorId), [{ sessionId: executorId, content: reference }]);
    assert.deepEqual((await tool('task_assign', assignInput)).result, assigned.result);
    assert.deepEqual(bridgeCalls.filter(call => call.name === 'prompt'), [
      { name: 'prompt', body: { sessionId: executorId, text: reference, mode: 'enqueue' } },
    ]);

    stage = 'editing, acknowledging, reporting and observing without chat messages';
    const messageCount = nativeMessages.length;
    const modelCount = requests.length;
    const current = (await tool('task_read', { view: 'execution', task_id: taskId })).result;
    const description = 'Updated complete synthetic requirements.\nNo deployment, credentials, or external work.';
    await tool('task_edit', {
      request_id: 'integration-task-edit', actor_session_id: ownerId, task_id: taskId,
      revision: current.revision, write_context: current.write_context, description, reason: 'Synthetic integration revision',
    });
    const updated = (await tool('task_read', { view: 'execution', task_id: taskId })).result;
    assert.equal(updated.description, description);
    assert.equal(updated.revision, 2);
    assert.equal(updated.acknowledged_revision, null);
    const invalidReport = await mcp.callTool({
      name: 'task_report',
      arguments: {
        request_id: 'integration-invalid-report', actor_session_id: executorId, task_id: taskId,
        revision: 1, write_context: updated.write_context, status: 'invented-status',
      },
    });
    assert.equal(invalidReport.isError, true);
    assert.equal(invalidReport.structuredContent.error.code, 'INVALID_INPUT');
    assert.equal(invalidReport.structuredContent.definition_check.tasks[0].needs_ack, true);
    await tool('task_ack', {
      request_id: 'integration-task-ack', actor_session_id: executorId, task_id: taskId,
      revision: updated.revision, write_context: updated.write_context,
    });
    await tool('task_report', {
      request_id: 'integration-task-report', actor_session_id: executorId, task_id: taskId,
      revision: updated.revision, write_context: updated.write_context,
      activity: { text: 'Synthetic persisted progress, not native activity.' }, status: 'in_progress',
    });
    assert.equal(nativeMessages.length, messageCount, 'Ordinary edits, ACK and reports never message a session');
    assert.equal(requests.length, modelCount, 'Ordinary changes never invoke a model');
    const latest = (await tool('task_read', { view: 'overview', task_id: taskId })).result;
    assert.equal(latest.activity.text, 'Synthetic persisted progress, not native activity.');
    assert.equal(latest.activity.source, 'reported');
    const revisions = (await tool('task_read', { view: 'changelog', task_id: taskId, limit: 1 })).result;
    assert.equal(revisions.items.length, 1);
    assert.equal(revisions.items[0].revision, 2);
    assert.equal(Object.hasOwn(revisions.items[0], 'description'), false);
    assert.equal(typeof revisions.next_cursor, 'string');
    const earlier = (await tool('task_read', {
      view: 'changelog', task_id: taskId, limit: 1, cursor: revisions.next_cursor,
    })).result;
    assert.equal(earlier.items[0].revision, 1);
    const fullRevision = (await tool('task_read', { view: 'changelog', task_id: taskId, revision: 2 })).result;
    assert.equal(fullRevision.description, description);
    const native = await app.inject({ url: `${apiBase}/tasks/${taskId}/native`, headers });
    assert.equal(native.statusCode, 200, native.body);
    assert.equal(native.json().source, 'native');
    assert.equal(native.json().session_id, executorId);
    assert.equal(native.json().status, 'idle');
    assert.equal(native.json().available, true);
    assert.ok(invalidations >= 5);

    stage = 'checking actual role cold resume and unloaded native observation';
    await engine.unload(executorId);
    assert.equal((await engine.roleReadiness(executorId, [executor])).loaded, false);
    const unloaded = (await app.inject({ url: `${apiBase}/tasks/${taskId}/native`, headers })).json();
    assert.equal(unloaded.loaded, false);
    assert.equal(unloaded.status, 'unloaded');
    assert.equal((await engine.roleReadiness(executorId, [executor])).loaded, false, 'Observation cannot load the Executor');
    await engine.load(executorId);
    assert.equal((await engine.roleReadiness(executorId, [executor])).ready, true);
    assert.equal(requests.length, modelCount, 'Cold resume must not send a startup prompt');

    stage = 'cold-restarting the packaged module and reading persisted state';
    await mcp.close();
    mcp = undefined;
    await engine.stop();
    moduleHost.close();
    await app.close();
    await startModule();
    assert.deepEqual(moduleHost.bootstrap().errors, []);
    const fresh = await app.inject({ method: 'POST', url: `${apiBase}/read`, headers, payload: { view: 'execution', task_id: taskId } });
    assert.equal(fresh.statusCode, 200, fresh.body);
    assert.equal(fresh.json().result.description, description);
    assert.equal(fresh.json().result.executor, executorId);
    assert.equal(fresh.json().result.acknowledged_revision, 2);
    const persistedActivity = await app.inject({
      method: 'POST', url: `${apiBase}/read`, headers, payload: { view: 'activity', task_id: taskId, limit: 10 },
    });
    assert.equal(persistedActivity.json().result.items[0].text, latest.activity.text);
    assert.ok(reports.every(({ error }) => error.code === 'MODULE_VERSION_MISMATCH'), reports.map(({ error }) => String(error)).join('\n'));
    assert.deepEqual(providerErrors, []);
    t.diagnostic('Verified real artifact install/activation, digest guards, official HTTP MCP, native Owner/Executor/union roles, once-only dispatch, no edit messages, cold resume and persistent module restart.');
  } catch (error) {
    failed = true;
    t.diagnostic(`Integration failed while ${stage}.`);
    for (const providerError of providerErrors) t.diagnostic(`Synthetic provider: ${providerError.message}`);
    throw error;
  } finally {
    const cleanupErrors = [];
    const cleanup = async work => { try { await work(); } catch (error) { cleanupErrors.push(error); } };
    await cleanup(async () => { await mcp?.close(); });
    await cleanup(async () => {
      if (!engine) return;
      if (await engine.busyCount()) {
        for (const id of isolatedSessionIds) await engine.cancel(id);
        await waitFor(async () => await engine.busyCount() === 0, 'isolated native cleanup');
      }
      await engine.stop();
    });
    await cleanup(async () => { await runtime?.stop(); });
    unsubscribe?.();
    moduleHost?.close();
    await cleanup(async () => { await app?.close(); });
    if (provider) {
      provider.closeAllConnections();
      await cleanup(() => new Promise(resolve => provider.close(resolve)));
    }
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    await cleanup(() => removeIsolatedTree(root));
    for (const error of cleanupErrors) t.diagnostic(`Isolation cleanup: ${error.message}`);
    if (!failed && cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Isolated integration cleanup failed');
  }
});
