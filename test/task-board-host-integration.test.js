import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hostWorktree = process.env.TASK_BOARD_HOST_WORKTREE;
const ownerTools = ['task_read', 'task_create', 'task_script_register', 'task_script_read', 'task_automation_start', 'task_automation_reconcile', 'task_session_create', 'task_session_prepare', 'task_assign', 'task_edit', 'task_cancel', 'task_subscribe', 'task_unsubscribe'];
const executorTools = ['task_read', 'task_edit', 'task_ack', 'task_reopen', 'task_report', 'task_cancel'];
const ownerOnlyTools = ownerTools.filter(name => !executorTools.includes(name));
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

test('packaged Task integrates with real isolated host roles, native SDK and HTTP MCP', {
  skip: !hostWorktree,
  timeout: 180_000,
}, async t => {
  const hostSource = resolve(hostWorktree);
  const archive = join(repository, 'dist', 'cockpit-task-0.1.12.tgz');
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
  const nativeTaskReads = new Map();
  const nativeTaskAcks = new Map();
  const nativeTaskReports = new Map();
  const nativeOwnerWorkflows = new Map();
  const nativeOwnerCalls = [];
  const nativePreparations = new Map();
  const expectedDefinitions = new Map();
  const isolatedSessionIds = new Set();
  const reports = [];
  const moduleRequests = [];
  let runtimeReady = false;
  let expectedStartupNotification;
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
      { OfficialRuntime }, { Engine }, { ModuleHost }, { ModuleRoles }, { installLocalModule, moduleDataRoot },
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
        const contentText = content => {
          if (typeof content === 'string') return content;
          assert.ok(Array.isArray(content), 'Expected native text content');
          return content.map(part => {
            assert.equal(part.type, 'text');
            return part.text;
          }).join('\n');
        };
        const latestUser = message.messages.findLast(item => item.role === 'user');
        const taskReference = latestUser && /\[(Task assigned to you|Task updated)\]\(task:([0-9a-f-]{36})\?event=(assigned|updated)\)/u.exec(contentText(latestUser.content));
        const ownerSubscription = latestUser && /Synthetic Owner subscription for task:([0-9a-f-]{36})\./u.exec(contentText(latestUser.content));
        const ownerNotice = latestUser && /\[Task status updated\]\(task:([0-9a-f-]{36})\?event=status_changed\)/u.exec(contentText(latestUser.content));
        const ownerPreparation = latestUser && /Synthetic Owner preparation for executor:([0-9a-f-]{36})\./u.exec(contentText(latestUser.content));
        let toolCall;
        if (taskReference) {
          const taskId = taskReference[2];
          const event = taskReference[3];
          assert.equal(taskReference[1], event === 'assigned' ? 'Task assigned to you' : 'Task updated');
          const eventKey = `${event}:${taskId}`;
          const actor = /Native session ID: ([0-9a-f-]{36})/u.exec(JSON.stringify(message.messages));
          assert.ok(actor, 'Role System Prompt must supply the actual actor session ID');
          const call = (name, action, input) => {
            const tools = message.tools.filter(tool => tool.type === 'function' && tool.function.name.endsWith(name));
            assert.equal(tools.length, 1, `Executor must have exactly one native ${name} tool`);
            return {
              id: `synthetic-${event}-${action}-${taskId}`, type: 'function',
              function: {
                name: tools[0].function.name,
                arguments: JSON.stringify({ task_id: taskId, actor_session_id: actor[1], ...input }),
              },
            };
          };
          const replyFor = action => message.messages.findLast(item =>
            item.role === 'tool' && item.tool_call_id === `synthetic-${event}-${action}-${taskId}`);
          const envelopeFor = reply => {
            const envelope = JSON.parse(contentText(reply.content));
            assert.equal(envelope.error, null, 'Native MCP business call must succeed');
            assert.ok(envelope.definition_check);
            return envelope;
          };
          const readReply = replyFor('read');
          if (!readReply) {
            toolCall = call('task_read', 'read', { view: 'execution' });
          } else {
            const execution = envelopeFor(readReply).result;
            assert.equal(execution.id, taskId);
            assert.equal(execution.description, expectedDefinitions.get(taskId),
              'Native tool execution must return the stored definition, not only advertise a tool');
            nativeTaskReads.set(eventKey, execution);
            const input = { revision: execution.revision, write_context: execution.write_context };
            const ackReply = replyFor('ack');
            if (!ackReply) {
              toolCall = call('task_ack', 'ack', { ...input, request_id: `native-ack-${event}-${taskId}` });
            } else {
              nativeTaskAcks.set(eventKey, envelopeFor(ackReply));
              const reportReply = replyFor('report');
              if (event === 'assigned' && !reportReply) {
                toolCall = call('task_report', 'report', {
                  ...input, request_id: `native-report-${taskId}`, status: 'in_progress',
                  activity: { text: 'Native Executor began the assigned Task.' },
                });
              } else if (reportReply) {
                nativeTaskReports.set(taskId, envelopeFor(reportReply));
              }
            }
          }
        }
        if (ownerSubscription || ownerNotice) {
          const taskId = (ownerSubscription ?? ownerNotice)[1];
          const phase = ownerSubscription ? 'subscribe' : 'status_changed';
          const key = `${phase}:${taskId}`;
          const actor = /Native session ID: ([0-9a-f-]{36})/u.exec(JSON.stringify(message.messages));
          assert.ok(actor, 'Owner uses its injected native session ID, not a guessed recipient');
          const evidence = {};
          const step = (name, action, input) => {
            const id = `synthetic-owner-${phase}-${action}-${taskId}`;
            const reply = message.messages.findLast(item => item.role === 'tool' && item.tool_call_id === id);
            if (reply) {
              const envelope = JSON.parse(contentText(reply.content));
              assert.equal(envelope.error, null, 'Owner must be able to execute the Skill-described MCP workflow');
              assert.ok(envelope.definition_check);
              evidence[action] = envelope.result;
              return envelope.result;
            }
            const tools = message.tools.filter(tool => tool.type === 'function' && tool.function.name.endsWith(name));
            assert.equal(tools.length, 1, `Owner must have exactly one native ${name} tool`);
            const args = { task_id: taskId, actor_session_id: actor[1], ...input };
            nativeOwnerCalls.push({ key, name, input: args });
            toolCall = { id, type: 'function', function: { name: tools[0].function.name, arguments: JSON.stringify(args) } };
            return null;
          };
          // Script the packaged Skill's workflow to exercise native tool wiring, not model judgment.
          const overview = step('task_read', 'overview', { view: 'overview' });
          if (overview) {
            assert.equal(overview.id, taskId);
            assert.equal(overview.owner, actor[1]);
            if (ownerSubscription) {
              step('task_subscribe', 'subscription', {
                write_context: overview.write_context, request_id: `native-subscribe-${taskId}`, statuses: ['done'],
              });
            } else if (!overview.outcome.available || step('task_read', 'outcomes', { view: 'outcomes' })) {
              step('task_read', 'subscriptions', { view: 'subscriptions' });
            }
          }
          if (!toolCall) nativeOwnerWorkflows.set(key, evidence);
        }
        if (ownerPreparation) {
          const sessionId = ownerPreparation[1];
          const callId = `synthetic-owner-prepare-${sessionId}`;
          const reply = message.messages.findLast(item => item.role === 'tool' && item.tool_call_id === callId);
          if (reply) {
            const envelope = JSON.parse(contentText(reply.content));
            assert.equal(envelope.error, null, JSON.stringify(envelope));
            nativePreparations.set(sessionId, envelope);
          } else {
            const actor = /Native session ID: ([0-9a-f-]{36})/u.exec(JSON.stringify(message.messages));
            assert.ok(actor);
            const tools = message.tools.filter(tool => tool.type === 'function' && tool.function.name.endsWith('task_session_prepare'));
            assert.equal(tools.length, 1);
            toolCall = { id: callId, type: 'function', function: {
              name: tools[0].function.name,
              arguments: JSON.stringify({
                actor_session_id: actor[1], request_id: callId, session_id: sessionId,
                skills: ['github-coding'], mcp_servers: [{ name: 'cockpit-task', tools: ['task_read', 'task_report'] }],
              }),
            } };
          }
        }
        const assistantMessage = toolCall
          ? { role: 'assistant', content: null, tool_calls: [toolCall] }
          : { role: 'assistant', content: 'Synthetic local acknowledgment. No external work.' };
        if (message.stream) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const choice of [
            { delta: toolCall ? { role: 'assistant', tool_calls: [{ index: 0, ...toolCall }] } : assistantMessage, finish_reason: null },
            { delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' },
          ]) response.write(`data: ${JSON.stringify({
            ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, ...choice }],
          })}\n\n`);
          response.end('data: [DONE]\n\n');
        } else {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            ...completion, object: 'chat.completion',
            choices: [{ index: 0, message: assistantMessage, finish_reason: toolCall ? 'tool_calls' : 'stop' }],
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
        availableTools: new ToolSet().addMcp('*').addBuiltIn('skill'),
      },
    });
    engine = new Engine({ runtime });
    const bridge = {
      resourcePreparationVersion: 1,
      async call(name, body) {
        bridgeCalls.push({ name, body: structuredClone(body) });
        if (name === 'session/new') {
          const sessionId = await engine.newSession(body.cwd, body.roles);
          isolatedSessionIds.add(sessionId);
          return { sessionId };
        }
        if (name === 'session/get') return { meta: await engine.getMeta(body.sessionId) };
        if (name === 'roles/readiness') return engine.roleReadiness(body.sessionId, body.roles);
        if (name === 'session/resources-prepare') return engine.prepareSessionResources(body);
        if (name === 'session/rename') return { ok: true, title: await engine.rename(body.sessionId, body.name) };
        if (name === 'prompt') {
          if (expectedStartupNotification) {
            assert.equal(runtimeReady, true, 'Cold recovery cannot send before native runtime startup');
            assert.equal(app.server.listening, true, 'Cold recovery cannot send before HTTP listen');
            assert.deepEqual(moduleRequests, [], 'Recovery must not depend on an inbound Task API/MCP request');
            assert.deepEqual(body, expectedStartupNotification);
          }
          return engine.prompt(body.sessionId, body.text, body.mode);
        }
        assert.fail(`Unexpected module host intent: ${name}`);
      },
    };

    stage = 'installing the real artifact and activating its backend';
    const installed = await installLocalModule(archive, { hostRoot: dirs.host, trustLocalCode: true, enable: true });
    assert.equal(installed.manifest.id, 'cockpit-task');
    assert.equal(installed.manifest.version, '0.1.12');
    assert.ok(installed.root.startsWith(`${dirs.host}/modules/installed/`));
    const startModule = async ({ listen = true, port = 0 } = {}) => {
      app = Fastify({ forceCloseConnections: true });
      moduleRequests.length = 0;
      app.addHook('onRequest', (request, _reply, done) => {
        if (request.url.includes('/api/')) moduleRequests.push(request.url);
        done();
      });
      moduleHost = new ModuleHost({
        hostRoot: dirs.host, observer: engine, host: bridge,
        onInvalidate: () => { invalidations++; },
        report: (id, error) => reports.push({ id, error }),
      });
      await moduleHost.register(app);
      if (listen) {
        await app.listen({ host: '127.0.0.1', port });
        return `http://127.0.0.1:${app.server.address().port}`;
      }
    };
    const origin = await startModule();
    const bootstrap = moduleHost.bootstrap();
    assert.deepEqual(bootstrap.errors, []);
    assert.deepEqual(bootstrap.active, [{ id: 'cockpit-task', version: '0.1.12', digest: installed.digest }]);
    const apiBase = bootstrap.modules[0].apiBase;
    const headers = { 'X-Cockpit-Module-Digest': installed.digest };
    assert.equal((await app.inject(bootstrap.modules[0].entry)).statusCode, 200);
    const sharedReferenceUrl = new URL('../../src/task-board/reference.js', `${origin}${bootstrap.modules[0].entry}`);
    const sharedReference = await app.inject(sharedReferenceUrl.pathname);
    assert.equal(sharedReference.statusCode, 200, 'The shared browser reference parser must be a declared packaged asset');
    assert.ok(sharedReference.body.includes('export const TASK_EVENTS'));
    const readPayload = { view: 'list' };
    for (const digest of [undefined, '', '0'.repeat(64)]) {
      const rejected = await app.inject({
        method: 'POST', url: `${apiBase}/read`, payload: readPayload,
        ...(digest === undefined ? {} : { headers: { 'X-Cockpit-Module-Digest': digest } }),
      });
      assert.equal(rejected.statusCode, 409, rejected.body);
      assert.equal(rejected.json().code, 'MODULE_VERSION_MISMATCH');
    }
    assert.equal((await app.inject({ method: 'POST', url: '/_modules/cockpit-task/api/read', headers, payload: readPayload })).statusCode, 404);
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
      moduleHost.bootstrap().active.some(module => module.id === 'cockpit-task') ? [installed] : []);
    const owner = { moduleId: 'cockpit-task', roleId: 'owner' };
    const executor = { moduleId: 'cockpit-task', roleId: 'executor' };
    assert.deepEqual(roles.list().map(role => role.roleId).sort(), ['executor', 'owner']);
    engine.setRoleProvider(roles);
    unsubscribe = engine.onNativeEvent(({ sessionId, event }) => {
      if (event.type === 'user.message') nativeMessages.push({ sessionId, content: event.data.content });
    });
    await engine.start();
    runtimeReady = true;
    moduleHost.ready();
    const ownerId = await engine.newSession(dirs.work, [owner]);
    isolatedSessionIds.add(ownerId);
    const unionId = await engine.newSession(dirs.work, [owner, executor]);
    isolatedSessionIds.add(unionId);
    assert.equal((await engine.roleReadiness(ownerId, [owner])).ready, true);
    assert.equal((await engine.roleReadiness(unionId, [owner, executor])).ready, true);
    const ownerMeta = await engine.getMeta(ownerId);
    assert.ok(ownerMeta);
    assert.deepEqual(ownerMeta.roles.map(role => role.roleId), ['owner']);
    assert.equal(Object.hasOwn(ownerMeta, 'roleReadiness'), false,
      'Ordinary session metadata must not project capability readiness');
    assert.equal(requests.length, 0, 'Role creation must not send a startup prompt');

    const verifyAssembly = async (sessionId, selected, expectedTools, expectedSkills) => {
      const skillNames = [...expectedSkills, 'github-coding'].sort();
      const assembly = await roles.assemble(sessionId, selected);
      assert.deepEqual(Object.keys(assembly.config.mcpServers), ['cockpit-task']);
      const server = assembly.config.mcpServers['cockpit-task'];
      assert.equal(server.url, `${origin}${apiBase}/mcp`);
      assert.deepEqual(server.headers, headers);
      assert.deepEqual(server.tools, [...expectedTools].sort());
      assert.deepEqual(assembly.skills.map(skill => skill.name).sort(), skillNames);
      for (const role of selected) {
        assert.ok(assembly.config.systemMessage.content.includes(`Module cockpit-task / role ${role.roleId}`));
        const source = await readFile(join(installed.root, `roles/task-${role.roleId}.md`), 'utf8');
        assert.ok(assembly.config.systemMessage.content.includes(source));
      }
      assert.ok(assembly.config.systemMessage.content.includes(`Native session ID: ${sessionId}`));
      const nativeSkills = await engine.getPanel(sessionId, 'skills');
      const taskSkills = nativeSkills.filter(skill => skill.label.startsWith('cockpit-task-') || skill.label === 'github-coding');
      assert.deepEqual(taskSkills.map(skill => skill.label).sort(), skillNames,
        'Owner, Executor and their union discover exactly one shared work Skill');
      for (const skill of taskSkills) assert.equal(skill.enabled, true);
      assert.ok(assembly.config.skillDirectories.includes(join(installed.root, 'skills/github-coding')));
      assert.equal(nativeSkills.some(skill => ['task-owner', 'task-executor', 'work-commander', 'work-commander-owner', 'cockpit-task-commander'].includes(skill.label)), false);
      const nativeMcp = await engine.getPanel(sessionId, 'mcpServers');
      assert.equal(nativeMcp.filter(server => server.label === 'cockpit-task').length, 1,
        'Exactly one declared Task MCP server must be present, including after cold resume');
      assert.equal(nativeMcp.some(server => /^(?:module_(?:task-board|cockpit-task)__|task$|work-commander$)/.test(server.label)), false,
        'No generated or legacy Task MCP server may accompany the declared server');
      return assembly;
    };
    await verifyAssembly(ownerId, [owner], ownerTools, ['cockpit-task-owner']);
    await verifyAssembly(unionId, [owner, executor], allTools, ['cockpit-task-executor', 'cockpit-task-owner']);
    const verifyNativePrompts = async (sessionId, captured) => {
      const capturedJson = JSON.stringify(captured);
      assert.ok(capturedJson.includes(`Native session ID: ${sessionId}`));
      const codingSource = await readFile(join(installed.root, 'skills/github-coding/github-coding/SKILL.md'), 'utf8');
      const codingDescription = JSON.parse(/^description: (".*")$/m.exec(codingSource)[1]);
      assert.ok(capturedJson.includes(JSON.stringify(codingDescription).slice(1, -1)),
        'The native provider must see the shared work Skill metadata, not only a role hint');
      for (const role of roles.read(sessionId)) {
        assert.ok(capturedJson.includes(`Module cockpit-task / role ${role.roleId}`));
        const source = await readFile(join(installed.root, `roles/task-${role.roleId}.md`), 'utf8');
        assert.ok(capturedJson.includes(JSON.stringify(source).slice(1, -1)),
          `The complete installed ${role.roleId} prompt must reach the native provider request`);
      }
    };
    const promptAndInspect = async (sessionId, text, expectedTools, unexpectedTools) => {
      const before = requests.length;
      await engine.prompt(sessionId, text);
      await waitFor(async () => requests.length > before && await engine.busyCount() === 0, 'synthetic native completion');
      assert.deepEqual(providerErrors, []);
      const captured = requests.slice(before);
      await verifyNativePrompts(sessionId, captured);
      for (const request of captured) {
        const offered = JSON.stringify(request.tools);
        for (const name of expectedTools) assert.equal(request.tools.filter(tool =>
          tool.type === 'function' && tool.function.name.endsWith(name)).length, 1,
        `Expected exactly one native ${name} tool`);
        for (const name of unexpectedTools) assert.ok(!offered.includes(name), `Unexpected native tool ${name}`);
      }
    };
    await promptAndInspect(ownerId, 'Synthetic Owner capability check; acknowledge without tools.', ownerTools, ['task_ack', 'task_report']);
    await promptAndInspect(unionId, 'Synthetic Owner and Executor union check; acknowledge without tools.', allTools, []);

    stage = 'preparing a reused idle Executor through an actual native Owner tool call';
    await engine.toggleSessionSkill(unionId, 'cockpit-task-owner', false);
    await engine.toggleSessionSkill(unionId, 'github-coding', false);
    assert.equal((await engine.roleReadiness(unionId, [executor])).ready, false);
    const beforePreparationMessages = nativeMessages.filter(message => message.sessionId === unionId).length;
    await engine.prompt(ownerId, `Synthetic Owner preparation for executor:${unionId}.`);
    await waitFor(async () => nativePreparations.has(unionId) && await engine.busyCount() === 0, 'native Owner preparation');
    const preparation = nativePreparations.get(unionId).result.operation;
    assert.equal(preparation.status, 'applied');
    assert.equal(preparation.preparation, 'prepared');
    assert.equal(preparation.capability, 'ready');
    assert.equal(preparation.resources.tools, 'initialized');
    assert.equal(preparation.resources.skills.find(skill => skill.name === 'github-coding').effect, 'enabled');
    assert.equal((await engine.listSessionSkills(unionId)).find(skill => skill.name === 'cockpit-task-owner').enabled, false,
      'Preparation must preserve unrelated temporary disabled choices');
    assert.equal(nativeMessages.filter(message => message.sessionId === unionId).length, beforePreparationMessages,
      'Preparation cannot send a prompt to the target');
    assert.equal((await engine.roleReadiness(unionId, [executor])).ready, true);

    stage = 'creating a real Executor through packaged task_session_create';
    const createInput = {
      request_id: 'integration-create-session', actor_session_id: ownerId, cwd: dirs.work,
      skills: ['github-coding'], mcp_servers: [{ name: 'cockpit-task', tools: ['task_read', 'task_report'] }],
    };
    const creation = await tool('task_session_create', createInput);
    const executorId = creation.result.operation.session_id;
    assert.equal(creation.result.operation.creation, 'created');
    assert.equal(creation.result.operation.capability, 'ready');
    assert.equal(creation.result.operation.preparation, 'prepared');
    assert.equal(creation.result.operation.resources.skills[0].effect, 'unchanged');
    assert.equal((await engine.roleReadiness(executorId, [executor])).ready, true);
    await verifyAssembly(executorId, [executor], executorTools, ['cockpit-task-executor']);
    assert.deepEqual((await tool('task_session_create', createInput)).result, creation.result);
    assert.equal(bridgeCalls.filter(call => call.name === 'session/new').length, 1, 'Creation replay cannot create a replacement');

    stage = 'rejecting unknown selections and genuinely filtered tools without hidden repair';
    for (const [suffix, selections] of [
      ['unknown', { skills: ['unknown-synthetic-work'] }],
      ['filtered', { mcp_servers: [{ name: 'cockpit-task', tools: ['task_create'] }] }],
    ]) {
      const failed = await mcp.callTool({ name: 'task_session_prepare', arguments: {
        request_id: `integration-prepare-${suffix}`, actor_session_id: ownerId, session_id: executorId, ...selections,
      } });
      assert.equal(failed.isError, true);
      assert.equal(failed.structuredContent.error.code, 'RESOURCE_PREPARATION_FAILED');
      assert.equal(failed.structuredContent.result.operation.session_id, executorId);
      assert.equal((await engine.roleReadiness(executorId, [executor])).ready, true,
        'Rejected preparation cannot alter the existing role subset');
    }

    stage = 'refreshing an initialized table after explicit MCP activation';
    await engine.toggleSessionMcp(executorId, 'cockpit-task', false);
    await engine.initializeSessionTools(executorId);
    const reconnected = await tool('task_session_prepare', {
      request_id: 'integration-prepare-mcp-activation', actor_session_id: ownerId, session_id: executorId,
      mcp_servers: [{ name: 'cockpit-task', tools: ['task_read', 'task_report'] }],
    });
    assert.equal(reconnected.result.operation.status, 'applied');
    assert.equal(reconnected.result.operation.resources.mcpServers[0].effect, 'enabled');
    assert.equal(reconnected.result.operation.resources.tools, 'initialized',
      'A confirmed configuration change refreshes even a non-null stale table without manual recovery');
    assert.equal((await engine.roleReadiness(executorId, [executor])).ready, true);

    stage = 'assigning exactly one native Task reference';
    const created = await tool('task_create', {
      request_id: 'integration-task-create', actor_session_id: ownerId, owner: ownerId,
      title: 'Synthetic packaged integration', description: 'Synthetic complete requirements. No external work.',
    });
    const taskId = created.result.task_id;
    expectedDefinitions.set(taskId, 'Synthetic complete requirements. No external work.');
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
    await verifyNativePrompts(executorId, dispatched);
    for (const request of dispatched) {
      const offered = JSON.stringify(request.tools);
      for (const name of executorTools) assert.ok(offered.includes(name), `Missing Executor tool ${name}`);
      for (const name of ownerOnlyTools) assert.ok(!offered.includes(name), `Unexpected Executor tool ${name}`);
    }
    const reference = `[Task assigned to you](task:${taskId}?event=assigned)`;
    assert.deepEqual(nativeMessages.filter(message => message.sessionId === executorId), [{ sessionId: executorId, content: reference }]);
    assert.equal(nativeTaskReads.size, 1, 'The native Executor must execute the advertised Task MCP tool');
    assert.ok(nativeTaskReads.has(`assigned:${taskId}`));
    assert.ok(nativeTaskAcks.has(`assigned:${taskId}`));
    assert.equal(nativeTaskReports.size, 1, 'The native Executor must ACK and report through its actual MCP tools');
    assert.ok(nativeTaskReports.has(taskId));
    const nativeStarted = (await tool('task_read', { view: 'execution', task_id: taskId })).result;
    assert.equal(nativeStarted.acknowledged_revision, 1);
    assert.equal(nativeStarted.status, 'in_progress');
    assert.deepEqual((await tool('task_assign', assignInput)).result, assigned.result);
    const renames = bridgeCalls.filter(call => call.name === 'session/rename');
    if (assigned.result.operation.session_title.error?.code === 'TITLE_PROVENANCE_UNAVAILABLE') {
      // Hosts predating name provenance keep the native title and are never asked to rename.
      assert.equal(assigned.result.operation.session_title.status, 'skipped');
      assert.deepEqual(renames, []);
    } else {
      assert.deepEqual(assigned.result.operation.session_title, { status: 'renamed', title: nativeStarted.title });
      assert.deepEqual(renames, [{ name: 'session/rename', body: { sessionId: executorId, name: nativeStarted.title } }]);
      const renamed = await engine.getMeta(executorId);
      assert.equal(renamed.title, nativeStarted.title);
      assert.equal(renamed.nativeNameUserSet, true);
    }
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
    assert.equal(updated.acknowledged_revision, 1, 'An Owner edit must not ACK the new revision on behalf of the Executor');
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

    stage = 'delivering an explicit updated notice without automatically sending on edit';
    expectedDefinitions.set(taskId, description);
    const notice = `Synthetic preserved pending context.\n\n[Task updated](task:${taskId}?event=updated)\nRead the current Task and acknowledge its latest revision before continuing.`;
    await engine.prompt(executorId, notice, 'enqueue');
    await waitFor(async () => nativeTaskAcks.has(`updated:${taskId}`) && await engine.busyCount() === 0,
      'explicit updated notice and native fresh read/ACK');
    assert.deepEqual(providerErrors, []);
    assert.equal(nativeTaskReads.get(`updated:${taskId}`).revision, 2);
    assert.equal(nativeTaskReads.get(`assigned:${taskId}`).revision, 1,
      'A later definition cannot relabel the earlier assigned event');
    assert.deepEqual(nativeMessages.filter(message => message.sessionId === executorId), [
      { sessionId: executorId, content: reference }, { sessionId: executorId, content: notice },
    ]);
    const afterNoticeModels = requests.length;

    stage = 'checking actual role cold resume and unloaded native observation';
    await engine.unload(executorId);
    assert.equal((await engine.roleReadiness(executorId, [executor])).loaded, false);
    const unloaded = (await app.inject({ url: `${apiBase}/tasks/${taskId}/native`, headers })).json();
    assert.equal(unloaded.loaded, false);
    assert.equal(unloaded.status, 'unloaded');
    assert.equal((await engine.roleReadiness(executorId, [executor])).loaded, false, 'Observation cannot load the Executor');
    await engine.load(executorId);
    assert.equal((await engine.roleReadiness(executorId, [executor])).ready, true);
    assert.equal(requests.length, afterNoticeModels, 'Cold resume must not send a startup prompt');
    await verifyAssembly(executorId, [executor], executorTools, ['cockpit-task-executor']);
    await promptAndInspect(executorId, 'Synthetic cold-resumed Executor capability check; acknowledge without tools.',
      executorTools, ownerOnlyTools);

    stage = 'explicitly subscribing and delivering one status-change card only to the isolated Owner';
    const beforeSubscriptionMessages = nativeMessages.length;
    const subscribedTask = (await tool('task_read', { view: 'execution', task_id: taskId })).result;
    const subscriptionInput = {
      actor_session_id: unionId, task_id: taskId, write_context: subscribedTask.write_context,
    };
    const already = await mcp.callTool({
      name: 'task_subscribe', arguments: { ...subscriptionInput, request_id: 'already-in-progress', statuses: ['in_progress'] },
    });
    assert.equal(already.isError, true);
    assert.equal(already.structuredContent.error.code, 'ALREADY_IN_TARGET_STATUS');
    assert.deepEqual((await tool('task_read', { view: 'subscriptions', task_id: taskId })).result.items, []);
    const waiting = await tool('task_subscribe', { ...subscriptionInput, request_id: 'subscribe-cancelled', statuses: ['cancelled'] });
    assert.equal(waiting.result.subscription.owner, ownerId, 'Recipient comes from the Task, not the actor');
    const unsubscriptionInput = {
      actor_session_id: ownerId, request_id: 'unsubscribe-cancelled', task_id: taskId,
      subscription_id: waiting.result.subscription.subscription_id,
    };
    const cancelledSubscription = await tool('task_unsubscribe', unsubscriptionInput);
    assert.equal(cancelledSubscription.result.subscription.state, 'cancelled');
    assert.deepEqual((await tool('task_unsubscribe', unsubscriptionInput)).result, cancelledSubscription.result);
    assert.equal(nativeMessages.length, beforeSubscriptionMessages, 'Registration and cancellation are silent');
    await promptAndInspect(ownerId, `Synthetic Owner subscription for task:${taskId}.`,
      ownerTools, ['task_ack', 'task_report']);
    const ownerRegistration = nativeOwnerWorkflows.get(`subscribe:${taskId}`);
    assert.ok(ownerRegistration, 'Native Owner must complete its read and subscription tool calls');
    assert.equal(ownerRegistration.subscription.subscription.state, 'waiting');
    assert.equal(ownerRegistration.subscription.subscription.owner, ownerId);
    assert.deepEqual(nativeOwnerCalls.filter(call => call.key === `subscribe:${taskId}`).map(call => call.name),
      ['task_read', 'task_subscribe']);
    const beforeStatusMessages = nativeMessages.length;
    const completeInput = {
      actor_session_id: executorId, request_id: 'integration-task-done', task_id: taskId,
      revision: subscribedTask.revision, write_context: subscribedTask.write_context,
      status: 'done', outcome: { summary: 'Synthetic isolated completion' }, retro: null,
    };
    const complete = await tool('task_report', completeInput);
    assert.equal(complete.notification_error, null);
    assert.equal(complete.result.task_status.value, 'done');
    assert.equal(complete.notifications[0].subscription_id, ownerRegistration.subscription.subscription.subscription_id);
    assert.ok(['accepted', 'queued'].includes(complete.notifications[0].notification.status));
    const statusCard = `[Task status updated](task:${taskId}?event=status_changed)`;
    await waitFor(async () => nativeMessages.some(message => message.sessionId === ownerId && message.content === statusCard)
      && nativeOwnerWorkflows.has(`status_changed:${taskId}`)
      && await engine.busyCount() === 0, 'one-shot Owner notification native completion');
    assert.deepEqual(nativeMessages.slice(beforeStatusMessages), [{ sessionId: ownerId, content: statusCard }]);
    const ownerEvidence = nativeOwnerWorkflows.get(`status_changed:${taskId}`);
    assert.equal(ownerEvidence.overview.status, 'done');
    assert.equal(ownerEvidence.outcomes.items[0].summary, 'Synthetic isolated completion');
    assert.equal(ownerEvidence.subscriptions.items[0].event.status, 'done');
    assert.deepEqual(nativeOwnerCalls.filter(call => call.key === `status_changed:${taskId}`)
      .map(call => [call.name, call.input.view]),
    [['task_read', 'overview'], ['task_read', 'outcomes'], ['task_read', 'subscriptions']],
    'A status notice uses current evidence, not ACK, another subscription, or a message to Executor');
    assert.deepEqual((await tool('task_report', completeInput)).result, complete.result);
    const subscriptions = (await tool('task_read', { view: 'subscriptions', task_id: taskId })).result.items;
    assert.equal(subscriptions[0].event.status, 'done');
    assert.equal(subscriptions[0].state, 'triggered');
    assert.equal(subscriptions[1].state, 'cancelled');
    assert.equal(bridgeCalls.filter(call => call.name === 'prompt' && call.body.sessionId === ownerId).length, 1);

    stage = 'seeding only isolated durable crash-gap evidence after closing the module';
    await mcp.close();
    mcp = undefined;
    await engine.stop();
    runtimeReady = false;
    moduleHost.close();
    await app.close();
    const { TaskStore: PackagedTaskStore } = await import(pathToFileURL(join(installed.root, 'src/task-board/store.js')).href);
    const dataRoot = await moduleDataRoot('cockpit-task', dirs.host);
    assert.ok(dataRoot.startsWith(`${dirs.host}/`), 'Crash-gap seed must stay inside this fresh isolated home');
    const seed = new PackagedTaskStore(dataRoot);
    const seedCrashGap = label => {
      const task = seed.executeLocal('task_create', {
        actor_session_id: unionId, request_id: `cold-create-${label}`, owner: ownerId,
        title: `Synthetic ${label} recovery`, description: 'Synthetic cold-recovery fixture only.',
      });
      const subscription = seed.executeLocal('task_subscribe', {
        actor_session_id: unionId, request_id: `cold-subscribe-${label}`, task_id: task.task_id,
        write_context: task.write_context, statuses: ['cancelled'],
      }).subscription;
      seed.executeLocal('task_cancel', {
        actor_session_id: unionId, request_id: `cold-cancel-${label}`, task_id: task.task_id,
        write_context: task.write_context, reason: 'Synthetic gap between durable transition and external send',
      });
      return subscription;
    };
    let pending, unknown;
    try {
      pending = seedCrashGap('pending');
      unknown = seedCrashGap('unknown');
      seed.claimNotification(unknown.subscription_id);
      assert.equal(seed.getSubscription(pending.subscription_id).notification.status, 'pending');
      assert.equal(seed.getSubscription(unknown.subscription_id).notification.status, 'unknown');
    } finally { seed.close(); }

    stage = 'cold service-ready recovery without inbound Task traffic';
    const port = Number(new URL(origin).port);
    const beforeColdMessages = nativeMessages.length;
    const beforeColdCalls = bridgeCalls.length;
    await startModule({ listen: false });
    assert.deepEqual(moduleHost.bootstrap().errors, []);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(bridgeCalls.length, beforeColdCalls, 'Activation cannot call the native host');
    await engine.start();
    runtimeReady = true;
    assert.equal(bridgeCalls.length, beforeColdCalls, 'Runtime up alone cannot recover before HTTP listen');
    await app.listen({ host: '127.0.0.1', port });
    assert.deepEqual(moduleRequests, []);
    const recoveredCard = `[Task status updated](task:${pending.task_id}?event=status_changed)`;
    expectedStartupNotification = { sessionId: ownerId, text: recoveredCard, mode: 'enqueue' };
    assert.equal(moduleHost.ready(), undefined, 'Service-ready dispatch must be nonblocking');
    moduleHost.ready();
    await waitFor(async () => nativeMessages.some(message => message.sessionId === ownerId && message.content === recoveredCard)
      && nativeOwnerWorkflows.has(`status_changed:${pending.task_id}`)
      && await engine.busyCount() === 0, 'cold-start pending notification to the native isolated Owner');
    expectedStartupNotification = undefined;
    assert.deepEqual(nativeMessages.slice(beforeColdMessages), [{ sessionId: ownerId, content: recoveredCard }]);
    assert.equal(nativeOwnerWorkflows.get(`status_changed:${pending.task_id}`).overview.status, 'cancelled');
    assert.deepEqual(nativeOwnerCalls.filter(call => call.key === `status_changed:${pending.task_id}`)
      .map(call => [call.name, call.input.view]), [['task_read', 'overview'], ['task_read', 'subscriptions']],
    'A recovered cancellation notice does not fabricate an outcome or attempt a terminal ACK');
    assert.deepEqual(bridgeCalls.slice(beforeColdCalls).filter(call => call.name === 'prompt'), [{
      name: 'prompt', body: { sessionId: ownerId, text: recoveredCard, mode: 'enqueue' },
    }]);
    const recovered = await app.inject({
      method: 'POST', url: `${apiBase}/read`, headers, payload: { view: 'subscriptions', task_id: pending.task_id },
    });
    assert.equal(recovered.json().result.items[0].notification.status, 'accepted');
    const uncertain = await app.inject({
      method: 'POST', url: `${apiBase}/read`, headers, payload: { view: 'subscriptions', task_id: unknown.task_id },
    });
    assert.equal(uncertain.json().result.items[0].notification.status, 'unknown');

    stage = 'second cold startup never resends accepted or unknown notification attempts';
    await engine.stop();
    runtimeReady = false;
    moduleHost.close();
    await app.close();
    const beforeRepeatCalls = bridgeCalls.length;
    const beforeRepeatMessages = nativeMessages.length;
    await startModule({ listen: false });
    await engine.start();
    runtimeReady = true;
    await app.listen({ host: '127.0.0.1', port });
    moduleHost.ready();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(bridgeCalls.length, beforeRepeatCalls, 'Accepted and unknown receipts cannot be recovery candidates');
    assert.equal(nativeMessages.length, beforeRepeatMessages);
    assert.deepEqual(moduleRequests, []);
    const fresh = await app.inject({ method: 'POST', url: `${apiBase}/read`, headers, payload: { view: 'execution', task_id: taskId } });
    assert.equal(fresh.statusCode, 200, fresh.body);
    assert.equal(fresh.json().result.description, description);
    assert.equal(fresh.json().result.executor, executorId);
    assert.equal(fresh.json().result.acknowledged_revision, 2);
    assert.equal(fresh.json().result.status, 'done');
    const savedSubscriptions = await app.inject({
      method: 'POST', url: `${apiBase}/read`, headers, payload: { view: 'subscriptions', task_id: taskId },
    });
    assert.deepEqual(savedSubscriptions.json().result.items, subscriptions);
    const persistedActivity = await app.inject({
      method: 'POST', url: `${apiBase}/read`, headers, payload: { view: 'activity', task_id: taskId, limit: 10 },
    });
    assert.equal(persistedActivity.json().result.items[0].text, latest.activity.text);
    assert.ok(reports.every(({ error }) => error.code === 'MODULE_VERSION_MISMATCH'), reports.map(({ error }) => String(error)).join('\n'));
    assert.deepEqual(providerErrors, []);
    t.diagnostic('Verified packaged Task, native role/Skill assembly, Owner MCP registration and current-evidence reads on status notices without ACK or resubscription, Executor read/ACK/report, service-ready recovery without inbound requests, and no accepted/unknown resend across a second cold startup. Synthetic provider proves wiring, not autonomous model judgment.');
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
