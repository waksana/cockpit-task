import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { TaskStore } from '../src/task-board/store.js';
import { TaskService } from '../src/task-board/service.js';
import { groupAlive } from '../src/task-board/automation-runner.js';
import { LOG_LIMIT } from '../src/task-board/automation-store.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message = 'Condition timed out') {
  for (let i = 0; i < 600; i++) {
    const value = predicate();
    if (value) return value;
    await delay(20);
  }
  assert.fail(message);
}
function fixture({ ready = true, platform } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'task-automation-'));
  let store = new TaskStore(directory, { platform }), service;
  let request = 0;
  const sent = [], errors = [];
  const open = () => {
    service = new TaskService(store, { ownerExists: async () => true, send: async (id, text) => { sent.push({ id, text }); return { ok: true, queued: false }; } },
      { report: error => errors.push(error) });
    if (ready) service.automation.recover();
  };
  open();
  const write = (name, input = {}) => service.execute(name, { actor_session_id: 'owner', request_id: `auto-${++request}`, ...input });
  const change = (name, id, input = {}) => write(name, {
    task_id: id, write_context: store.task(id).write_context,
    ...(['task_automation_start', 'task_edit', 'task_ack', 'task_report', 'task_assign'].includes(name) ? { revision: store.task(id).revision } : {}),
    ...input,
  });
  const f = {
    directory, sent, errors, write, change,
    get store() { return store; }, get service() { return service; },
    async register(script_id, code, parameters = []) {
      const path = join(directory, `${script_id}.mjs`);
      writeFileSync(path, code);
      const result = await write('task_script_register', {
        script_id, title: script_id, description: 'Synthetic trusted test script',
        executable: process.execPath, script_path: path, argv: [], parameters,
      });
      assert.equal(result.error, null, JSON.stringify(result));
      return path;
    },
    async create(script_id, parameters = {}) {
      const result = await write('task_create', {
        title: 'Automation test', description: 'Run only this synthetic script', owner: 'owner',
        automation: { script_id, parameters },
      });
      assert.equal(result.error, null, JSON.stringify(result));
      return result.result.task_id;
    },
    async start(id) {
      const result = await change('task_automation_start', id);
      assert.equal(result.error, null, JSON.stringify(result));
      return result;
    },
    async finished(id) {
      await until(() => !['created', 'queued', 'starting', 'running'].includes(store.automation.run(id).state));
      return store.task(id);
    },
    async restart(options = {}) {
      service.close();
      await until(() => service.closed);
      store = new TaskStore(directory, options);
      open();
    },
    async close() {
      service.close();
      await until(() => service.closed);
      rmSync(directory, { recursive: true, force: true });
    },
  };
  return f;
}

test('registration/create do not execute; typed literal argv, optional pre-subscription and service outcome close the loop', async () => {
  const f = fixture();
  try {
    const marker = join(f.directory, 'not-a-shell');
    const params = [
      { name: 'value', type: 'string', description: 'Literal text' },
      { name: 'count', type: 'integer', description: 'Number' },
      { name: 'enabled', type: 'boolean', description: 'Flag' },
    ];
    await f.register('literal', 'console.log(JSON.stringify(process.argv.slice(2))); console.error("stderr");', params);
    const values = { value: `; touch ${marker}; $(echo bad)\n"`, count: 7, enabled: false };
    const id = await f.create('literal', values);
    await delay(30);
    const task = f.store.task(id);
    assert.equal(task.kind, 'automation');
    assert.equal(task.executor, null);
    assert.equal(task.acknowledged_revision, null);
    assert.equal(task.automation.state, 'created');
    assert.deepEqual(task.automation.parameters, values);
    assert.equal(f.store.read({ view: 'subscriptions', task_id: id }).items.length, 0);
    assert.equal((await f.change('task_subscribe', id, { statuses: ['done', 'blocked'] })).error, null);
    const start = { request_id: 'stable-start', task_id: id, revision: 1, write_context: task.write_context };
    assert.equal((await f.write('task_automation_start', start)).error, null);
    const done = await f.finished(id);
    assert.equal(done.status, 'done');
    assert.deepEqual(done.retro, { status: 'not_applicable' });
    assert.equal(done.automation.state, 'succeeded');
    assert.equal(done.automation.barrier, false);
    assert.equal(existsSync(marker), false);
    assert.equal((await f.write('task_automation_start', start)).error, null);
    assert.equal((await f.change('task_automation_start', id)).error.code, 'AUTOMATION_ALREADY_STARTED');
    assert.equal((await f.change('task_subscribe', id, { statuses: ['done'] })).error.code, 'ALREADY_IN_TARGET_STATUS');
    const log = f.store.read({ view: 'automation_log', task_id: id });
    assert.ok(log.text.includes(JSON.stringify([values.value, '7', 'false'])));
    assert.match(log.text, /stderr/);
    const outcomes = f.store.read({ view: 'outcomes', task_id: id }).items;
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].executor, null);
    assert.equal(outcomes[0].source, 'automation');
    assert.deepEqual(outcomes[0].retro, { status: 'not_applicable' });
    assert.equal(outcomes[0].run_id, done.automation.run_id);
    await until(() => f.sent.length === 1);
    assert.equal(f.store.read({ view: 'subscriptions', task_id: id }).items[0].event.source, 'automation');
    assert.equal(f.store.read({ view: 'subscriptions', task_id: id }).items[0].event.actor_session_id, null);
    assert.equal(f.store.definitionCheck({ task_id: id }).tasks[0].needs_ack, false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('slow notification delivery cannot stall the execution queue or unrelated requests', async () => {
  const f = fixture();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  try {
    f.service.host.send = async () => { await pending; return { ok: true, queued: false }; };
    await f.register('notify', 'console.log("completed");');
    const first = await f.create('notify'), second = await f.create('notify');
    await f.change('task_subscribe', first, { statuses: ['done'] });
    await f.start(first);
    await f.start(second);
    assert.equal((await f.finished(first)).status, 'done');
    assert.equal((await f.finished(second)).status, 'done');
    assert.equal(f.store.read({ view: 'subscriptions', task_id: first }).items[0].notification.status, 'unknown');
    assert.equal((await f.service.execute('task_script_read', {})).result.items.length, 1);
    release();
    await until(() => f.store.read({ view: 'subscriptions', task_id: first }).items[0].notification.status === 'accepted');
  } finally { release(); await f.close(); }
});

test('strict script catalog and parameters reject changes, unknown fields and mismatches without creating Tasks', async () => {
  const f = fixture();
  try {
    const path = await f.register('catalog', 'console.log("ok")', [{ name: 'count', type: 'integer', description: 'Required integer' }]);
    const script = f.store.executeLocal('task_script_read', { script_id: 'catalog' });
    assert.equal(script.script_path, path);
    assert.match(script.sha256, /^[a-f0-9]{64}$/);
    assert.equal(f.store.executeLocal('task_script_read', {}).items.length, 1);
    const { sha256, registered_at, registered_by, ...definition } = script;
    assert.equal((await f.write('task_script_register', definition)).error.code, 'SCRIPT_EXISTS');
    for (const parameters of [{}, { count: '3' }, { count: 3, extra: true }]) {
      assert.equal((await f.write('task_create', {
        title: 'Bad', description: 'Bad', owner: 'owner', automation: { script_id: 'catalog', parameters },
      })).error.code, 'INVALID_PARAMETERS');
    }
    assert.equal(f.store.read({ view: 'list' }).items.length, 0);
    assert.equal((await f.write('task_script_register', { ...definition, script_id: 'relative', script_path: 'relative.mjs' })).error.code, 'INVALID_SCRIPT');
    const id = await f.create('catalog', { count: 1 });
    for (const name of ['task_ack', 'task_report', 'task_assign']) {
      const extra = name === 'task_report' ? { status: 'done', outcome: { summary: 'Forged' }, retro: null }
        : name === 'task_assign' ? { executor: 'fake' } : {};
      assert.equal((await f.change(name, id, extra)).error.code, 'AUTOMATION_MANAGED');
    }
    assert.equal((await f.change('task_edit', id, { reason: 'Clarify before start', description: 'Updated agreement' })).error, null);
    assert.equal(f.store.task(id).revision, 2);
    assert.equal(f.store.task(id).acknowledged_revision, null);
  } finally { await f.close(); }
});

test('non-Linux platforms reject registration, automation creation and start early without stored effects', async () => {
  const f = fixture();
  try {
    await f.register('existing', 'console.log("ok")');
    const existing = await f.create('existing');
    const counts = () => Object.fromEntries(['scripts', 'tasks', 'automation_runs', 'definitions']
      .map(table => [table, f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
    const path = join(f.directory, 'fresh.mjs');
    writeFileSync(path, 'console.log("fresh")');
    const definition = {
      script_id: 'fresh', title: 'fresh', description: 'Synthetic trusted test script',
      executable: process.execPath, script_path: path, argv: [], parameters: [],
    };
    for (const platform of ['win32', 'darwin']) {
      await f.restart({ platform });
      const before = counts();
      const expectRejected = result => {
        assert.equal(result.error.code, 'AUTOMATION_PLATFORM');
        assert.match(result.error.message, /Linux or WSL2/);
        assert.match(result.error.message, new RegExp(platform));
      };
      const register = { actor_session_id: 'owner', request_id: `register-${platform}`, ...definition };
      expectRejected(await f.service.execute('task_script_register', register));
      expectRejected(await f.service.execute('task_script_register', register));
      expectRejected(await f.service.execute('task_script_register', { ...register, request_id: `register-existing-${platform}`, script_id: 'existing' }));
      const create = {
        actor_session_id: 'owner', request_id: `create-${platform}`, title: 'Automation', description: 'Blocked', owner: 'owner',
        automation: { script_id: 'existing', parameters: {} },
      };
      expectRejected(await f.service.execute('task_create', create));
      expectRejected(await f.service.execute('task_create', create));
      expectRejected(await f.change('task_automation_start', existing));
      assert.deepEqual(counts(), before);
      assert.throws(() => f.store.executeLocal('task_script_read', { script_id: 'fresh' }), { code: 'SCRIPT_NOT_FOUND' });
      assert.equal(f.store.executeLocal('task_script_read', { script_id: 'existing' }).script_id, 'existing');
      assert.equal(f.store.task(existing).kind, 'automation');
      assert.equal(f.store.task(existing).status, 'todo');
      assert.equal(f.store.automation.run(existing).state, 'created');
      const agent = await f.write('task_create', { title: 'Agent', description: 'Ordinary work', owner: 'owner' });
      assert.equal(agent.error, null, JSON.stringify(agent));
      assert.equal(f.store.task(agent.result.task_id).kind, 'agent');
    }
    await f.restart({ platform: 'linux' });
    assert.equal((await f.service.execute('task_script_register', {
      actor_session_id: 'owner', request_id: 'register-linux', ...definition,
    })).error, null);
    const id = await f.create('fresh');
    await f.start(id);
    assert.equal((await f.finished(id)).status, 'done');
    assert.equal(f.store.automation.run(existing).state, 'created');
  } finally { await f.close(); }
});

test('nonzero, changed script and executable spawn failure block with bounded logs and no retry', async () => {
  const f = fixture();
  try {
    await f.register('failure', `process.stdout.write("x".repeat(${LOG_LIMIT + 10000})); process.stdout.write("\\u0000".repeat(9000)); process.stderr.write("failure"); process.exitCode=9;`);
    const id = await f.create('failure');
    await f.start(id);
    assert.equal((await f.finished(id)).status, 'blocked');
    assert.equal(f.store.automation.run(id).exit_code, 9);
    let output = '', offset = 0, page;
    do {
      page = f.store.read({ view: 'automation_log', task_id: id, offset, limit: 8192 });
      assert.ok(JSON.stringify(page).length <= 24000);
      output += page.text;
      offset = page.next_offset;
    } while (offset !== null);
    assert.equal(output.length, LOG_LIMIT);
    assert.ok(page.omitted_characters >= 19000);
    assert.match(f.store.read({ view: 'outcomes', task_id: id }).items[0].summary, /omitted: 19007/);
    const path = await f.register('changed', 'console.log("original");');
    const changed = await f.create('changed');
    writeFileSync(path, 'console.log("changed");');
    await f.start(changed);
    assert.equal((await f.finished(changed)).status, 'blocked');
    assert.match(f.store.automation.run(changed).error, /bytes changed/);
    const executable = join(f.directory, 'missing-executable');
    writeFileSync(executable, '#!/definitely/missing/interpreter\n', { mode: 0o700 });
    const registered = await f.write('task_script_register', {
      script_id: 'spawn-fail', title: 'Spawn fail', description: 'Synthetic ENOENT', executable,
      script_path: path, parameters: [],
    });
    assert.equal(registered.error, null);
    const spawnFail = await f.create('spawn-fail');
    await f.start(spawnFail);
    assert.equal((await f.finished(spawnFail)).status, 'blocked');
    assert.match(f.store.automation.run(spawnFail).error, /Spawn failed: ENOENT/);
    await f.restart();
    assert.equal(f.store.read({ view: 'outcomes', task_id: id }).items.length, 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('queue is serial, HTTP-style reads remain responsive, definitions freeze, and queued/running cancel persist', async () => {
  const f = fixture();
  try {
    await f.register('wait', 'console.log("started"); setInterval(()=>{},1000);');
    await f.register('quick', 'console.log("quick");');
    const first = await f.create('wait'), second = await f.create('quick'), third = await f.create('quick');
    await f.start(first);
    await until(() => f.store.automation.run(first).state === 'running');
    await f.start(second);
    await f.start(third);
    const read = await f.service.execute('task_read', { view: 'execution', task_id: first });
    assert.equal(read.error, null);
    assert.equal(f.store.automation.run(second).state, 'queued');
    for (const id of [first, second]) {
      assert.equal((await f.change('task_edit', id, { title: 'Changed', reason: 'Race' })).error.code, 'AUTOMATION_DEFINITION_LOCKED');
    }
    assert.equal((await f.change('task_cancel', second, { reason: 'Do not launch' })).error, null);
    assert.equal(f.store.task(second).automation.state, 'cancelled');
    assert.equal(f.store.task(second).automation.started_at, null);
    assert.equal((await f.change('task_cancel', first, { reason: 'Stop running synthetic script' })).error, null);
    const finished = await f.finished(first);
    assert.equal(finished.status, 'cancelled');
    assert.equal(finished.automation.barrier, false);
    assert.equal(groupAlive(finished.automation.process_group), false);
    assert.equal((await f.finished(third)).status, 'done');
    assert.ok(f.store.automation.run(third).started_at >= finished.automation.finished_at);
    assert.equal(f.store.read({ view: 'outcomes', task_id: first }).items.length, 1);
    assert.equal(f.store.read({ view: 'outcomes', task_id: second }).items.length, 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('graceful close escalates termination, preserves interrupted outcome and resumes only unstarted queue entries', async () => {
  const f = fixture();
  try {
    await f.register('stubborn', 'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000);');
    await f.register('next', 'console.log("next");');
    const first = await f.create('stubborn'), second = await f.create('next');
    await f.start(first);
    await until(() => f.store.automation.run(first).log.includes('ready'));
    await f.start(second);
    await f.restart();
    assert.equal(f.store.task(first).status, 'blocked');
    assert.equal(f.store.task(first).automation.state, 'interrupted');
    assert.equal(groupAlive(f.store.task(first).automation.process_group), false);
    assert.equal((await f.finished(second)).status, 'done');
    assert.equal(f.store.read({ view: 'outcomes', task_id: first }).items.length, 1);
  } finally { await f.close(); }
});

test('crashed service never replays effects; surviving group blocks queue until explicit proven reconciliation', async () => {
  const f = fixture({ ready: false });
  let host, group;
  try {
    const marker = join(f.directory, 'effect');
    await f.register('orphan', `import {appendFileSync} from "node:fs"; process.on("SIGTERM",()=>{}); appendFileSync(${JSON.stringify(marker)},"once\\n"); console.log("ready"); setInterval(()=>{},1000);`);
    await f.register('after-crash', 'console.log("after crash");');
    const id = await f.create('orphan'), next = await f.create('after-crash');
    await f.start(id);
    await f.start(next);
    const code = `
      import {TaskStore} from ${JSON.stringify(new URL('../src/task-board/store.js', import.meta.url).href)};
      import {TaskService} from ${JSON.stringify(new URL('../src/task-board/service.js', import.meta.url).href)};
      const store = new TaskStore(${JSON.stringify(f.directory)});
      const service = new TaskService(store, {}, {report: e=>console.error(e)});
      service.automation.recover();
      const timer=setInterval(()=>{
        const run=store.automation.run(${JSON.stringify(id)});
        if(run.log.includes("ready")) {clearInterval(timer);process.send({group:run.process_group});}
      },20);
    `;
    host = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    group = (await once(host, 'message'))[0].group;
    const exited = once(host, 'exit');
    host.kill('SIGKILL');
    await exited;
    await delay(100);
    assert.equal(groupAlive(group), true);
    f.service.automation.recover();
    assert.equal(f.store.task(id).automation.state, 'interrupted');
    assert.equal(f.store.task(id).status, 'blocked');
    assert.equal(f.store.task(id).automation.barrier, true);
    assert.equal(f.store.task(next).automation.state, 'queued');
    assert.equal((await f.change('task_automation_reconcile', id, { reason: 'Observe still-running process' })).error.code, 'PROCESS_GROUP_ACTIVE');
    process.kill(-group, 'SIGKILL');
    await until(() => !groupAlive(group));
    assert.equal((await f.change('task_automation_reconcile', id, { reason: 'Synthetic process group terminated; effects inspected' })).error, null);
    assert.equal((await f.finished(next)).status, 'done');
    assert.equal(f.store.task(id).status, 'blocked');
    assert.equal(readFileSync(marker, 'utf8'), 'once\n');
    assert.equal(f.store.read({ view: 'outcomes', task_id: id }).items.length, 1);
  } finally {
    if (host?.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
    if (group && groupAlive(group)) process.kill(-group, 'SIGKILL');
    await f.close();
  }
});

test('pre-handshake crash has no executable replay and explicit reconciliation unblocks the queue', async () => {
  const f = fixture({ ready: false });
  try {
    await f.register('handshake', 'console.log("only queued");');
    const id = await f.create('handshake'), next = await f.create('handshake');
    await f.start(id);
    f.store.automation.claim(id);
    await f.start(next);
    f.service.automation.recover();
    assert.equal(f.store.task(id).automation.pid, null);
    assert.equal(f.store.task(id).status, 'blocked');
    assert.equal((await f.change('task_automation_reconcile', id, { reason: 'No durable PID, therefore no go handshake' })).error, null);
    assert.equal((await f.finished(next)).status, 'done');
    assert.equal(f.store.read({ view: 'automation_log', task_id: id }).text, '');
  } finally { await f.close(); }
});

test('changing group membership cannot look absent while descendants fork and parents exit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'automation-group-race-'));
  const marker = join(directory, 'tail-ready');
  const source = `
    import {spawn} from 'node:child_process';
    import {writeFileSync} from 'node:fs';
    const count=Number(process.argv[1]);
    if(count) {
      const child=spawn(process.execPath,['--input-type=module','-e',process.env.AUTOMATION_CHAIN,String(count-1)],{stdio:'ignore'});
      child.once('spawn',()=>process.exit(0));
    } else {
      writeFileSync(${JSON.stringify(marker)},'ready');
      setInterval(()=>{},1000);
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, '12'], {
    detached: true, stdio: 'ignore', env: { ...process.env, AUTOMATION_CHAIN: source },
  });
  try {
    await once(child, 'spawn');
    for (let tries = 0; tries < 600 && !existsSync(marker); tries++) {
      assert.equal(groupAlive(child.pid), true, 'A continuously occupied group must retain its execution barrier');
      await delay(2);
    }
    assert.equal(existsSync(marker), true);
    assert.equal(groupAlive(child.pid), true);
  } finally {
    if (groupAlive(child.pid)) process.kill(-child.pid, 'SIGKILL');
    await until(() => !groupAlive(child.pid));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('v2 migration preserves Agent outcomes and defaults while allowing null-Executor service outcomes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'automation-migration-'));
  let store;
  try {
    store = new TaskStore(directory);
    const task = store.executeLocal('task_create', { owner: 'owner', actor_session_id: 'owner', request_id: 'old', title: 'Agent', description: 'Existing' });
    store.db.exec(`
      DROP TABLE automation_runs; DROP TABLE scripts;
      ALTER TABLE tasks DROP COLUMN kind;
      ALTER TABLE outcomes DROP COLUMN run_id;
      PRAGMA user_version=2;
    `);
    store.db.prepare('INSERT INTO outcomes(id,task_id,revision,executor,author,summary,refs,at) VALUES(?,?,?,?,?,?,?,?)')
      .run('old-outcome', task.task_id, 1, 'executor', 'executor', 'Legacy result', '[]', new Date().toISOString());
    store.close();
    store = new TaskStore(directory);
    assert.equal(store.task(task.task_id).kind, 'agent');
    assert.equal(store.task(task.task_id).automation, null);
    assert.equal(store.read({ view: 'outcomes', task_id: task.task_id }).items[0].summary, 'Legacy result');
    assert.equal(store.read({ view: 'outcomes', task_id: task.task_id }).items[0].source, 'reported');
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 7);
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('automation respects blocked_by: start waits for readiness and a finished blocker sends the ready notice', async () => {
  const f = fixture();
  try {
    await f.register('dependency', 'console.log("done");');
    const blocker = await f.create('dependency');
    const created = await f.write('task_create', {
      title: 'Dependent automation', description: 'Runs after the blocker', owner: 'owner',
      automation: { script_id: 'dependency', parameters: {} }, blocked_by: [blocker],
    });
    assert.equal(created.error, null, JSON.stringify(created));
    const dependent = created.result.task_id;
    assert.equal((await f.change('task_automation_start', dependent)).error.code, 'TASK_NOT_READY');
    assert.equal(f.store.automation.run(dependent).state, 'created');
    await f.start(blocker);
    assert.equal((await f.finished(blocker)).status, 'done');
    await until(() => f.sent.length === 1);
    assert.deepEqual(f.sent, [{ id: 'owner', text: `[As Owner: Task ready](task:${dependent}?event=ready)` }]);
    const [notice] = f.store.read({ view: 'dependency_notices', task_id: dependent }).items;
    assert.equal(notice.event.source, 'automation');
    assert.equal(f.store.task(dependent).status, 'todo', 'ready never starts automation');
    await f.start(dependent);
    assert.equal((await f.finished(dependent)).status, 'done');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('an automation child reaching done or blocked notifies the executing parent Owner once', async () => {
  const f = fixture();
  try {
    // Make 'owner' execute an Agent Task so its automation Tasks become children.
    const root = f.store.executeLocal('task_create', { actor_session_id: 'user', request_id: 'parent', owner: 'user', title: 'Parent', description: 'Coordinate' }).task_id;
    const assign = { actor_session_id: 'user', request_id: 'parent-assign', task_id: root, write_context: f.store.task(root).write_context, revision: 1, executor: 'owner' };
    f.store.reserveOperation('task_assign', assign);
    f.store.bindAssignment(assign);
    f.store.executeLocal('task_ack', { actor_session_id: 'owner', request_id: 'parent-ack', task_id: root, revision: 1, write_context: f.store.task(root).write_context });
    await f.register('ok', 'console.log("ok")');
    await f.register('bad', 'process.exit(3)');
    const cards = () => f.sent.filter(entry => entry.id === 'owner').map(entry => entry.text);
    const ok = await f.create('ok');
    assert.equal(f.store.task(ok).parent_task_id, root);
    await f.start(ok);
    assert.equal((await f.finished(ok)).status, 'done');
    await until(() => cards().length === 1);
    const bad = await f.create('bad');
    await f.start(bad);
    assert.equal((await f.finished(bad)).status, 'blocked');
    await until(() => cards().length === 2);
    assert.deepEqual(cards(), [
      `[As Owner: child Task done](task:${ok}?event=child_done)`,
      `[As Owner: child Task blocked](task:${bad}?event=child_blocked)`,
    ]);
    const [notice] = f.store.read({ view: 'child_notices', task_id: ok }).items;
    assert.equal(notice.event.source, 'automation');
    assert.equal(notice.event.actor_session_id, null);
    assert.equal(notice.parent_task_id, root);
    const queued = await f.create('ok');
    const cancelled = await f.write('task_cancel', { task_id: queued, write_context: f.store.task(queued).write_context, reason: 'Not needed' });
    assert.equal(cancelled.error, null);
    await until(() => cards().length === 3);
    assert.equal(cards()[2], `[As Owner: child Task cancelled](task:${queued}?event=child_cancelled)`);
    assert.equal(f.store.read({ view: 'child_notices', task_id: queued }).items.length, 1, 'Automation cancellation notifies once');
  } finally { await f.close(); }
});
