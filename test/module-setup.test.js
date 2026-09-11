import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { readCredential } from '../src/store.js';

const root = path.resolve(import.meta.dirname, '..');
const setupFile = path.join(root, 'src/module-setup.js');
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('Task release explicitly declares setup and keeps package, lock, manifest and MCP versions aligned', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'module.json')));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
  assert.deepEqual(manifest.configLifecycle, { initialize: { entry: 'src/module-setup.js' } });
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.ok(fs.readFileSync(path.join(root, 'src/mcp.js'), 'utf8').includes(`version: '${pkg.version}'`));
});

function fixture(t) {
  const directory = path.join(root, `.module-setup-test-${randomUUID()}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  const cleanup = [];
  t.after(async () => {
    for (const action of cleanup.toReversed()) await action();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, data: path.join(directory, 'data'),
    env: { PATH: process.env.PATH, HOME: directory }, cleanup };
}

function track(child) {
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  return { child, exit: once(child, 'exit').then(([code, signal]) => ({ code, signal, stdout, stderr })) };
}

function setup(f, request = { operation: 'config-initialize', operationId: 'fixture-initialize', dataDirectory: f.data },
  preload) {
  const running = track(spawn(process.execPath, [...(preload ? ['--import', preload] : []), setupFile], {
    cwd: root, env: f.env, stdio: ['pipe', 'pipe', 'pipe'],
  }));
  running.child.stdin.end(typeof request === 'string' ? request : JSON.stringify(request));
  return running.exit;
}

function inspect(data) {
  const db = new DatabaseSync(path.join(data, 'work.db'), { readOnly: true });
  try {
    return { principals: db.prepare('SELECT role,session_id,task_id FROM credentials').all().map(row => ({ ...row })),
      tasks: db.prepare('SELECT count(*) AS n FROM tasks').get().n,
      provisions: db.prepare('SELECT count(*) AS n FROM module_provisions').get().n,
      operations: db.prepare('SELECT count(*) AS n FROM operations').get().n };
  } finally { db.close(); }
}

function files(directory) {
  const result = {};
  const visit = dir => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      result[path.relative(directory, file)] = { mode: stat.mode,
        hash: stat.isDirectory() ? null : stat.isSymbolicLink() ? fs.readlinkSync(file) : digest(file) };
      if (stat.isDirectory()) visit(file);
    }
  };
  visit(directory);
  return result;
}

test('fresh empty directory initializes only viewer plus independent manager and returns protected paths', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.data, { mode: 0o700 });
  const output = await setup(f);
  assert.equal(output.code, 0, output.stderr + output.stdout);
  assert.equal(output.stdout.trim().split('\n').length, 1);
  const result = JSON.parse(output.stdout);
  assert.deepEqual(result, { ok: true, operationId: 'fixture-initialize', dataDirectory: f.data,
    credentialDirectory: path.join(f.data, 'credentials'),
    managerCredentialFile: path.join(f.data, 'credentials/module-manager.json'),
    viewerCredentialFile: path.join(f.data, 'credentials/module-viewer.json') });
  const viewer = readCredential(result.viewerCredentialFile), manager = readCredential(result.managerCredentialFile);
  assert.notEqual(viewer, manager);
  assert.equal(viewer.length, 43);
  assert.equal(manager.length, 43);
  assert.ok(!output.stdout.includes(viewer) && !output.stdout.includes(manager));
  assert.ok(!output.stderr.includes(viewer) && !output.stderr.includes(manager));
  assert.deepEqual(inspect(f.data), { principals: [{ role: 'viewer', session_id: null, task_id: null }],
    tasks: 0, provisions: 0, operations: 0 });
  for (const directory of [f.data, result.credentialDirectory]) {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  }
  for (const file of [result.managerCredentialFile, result.viewerCredentialFile,
    path.join(f.data, '.module-setup.json'), path.join(f.data, 'work.db')]) {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(file).uid, process.getuid());
  }
  const record = fs.readFileSync(path.join(f.data, '.module-setup.json'), 'utf8');
  assert.ok(!record.includes(viewer) && !record.includes(manager));
  const before = files(f.directory);
  assert.deepEqual(JSON.parse((await setup(f)).stdout), result);
  assert.deepEqual(files(f.directory), before);
  const conflict = await setup(f, { operation: 'config-initialize', operationId: 'different-operation', dataDirectory: f.data });
  assert.equal(JSON.parse(conflict.stdout).error.code, 'SETUP_OPERATION_CONFLICT');
  assert.deepEqual(files(f.directory), before);
});

test('missing final directory is created only beneath an already private canonical parent', async t => {
  const f = fixture(t);
  assert.equal((await setup(f)).code, 0);
  assert.equal(fs.statSync(f.data).mode & 0o777, 0o700);
});

test('preexisting business files, database, credentials or lock are refused without even creating Store', async t => {
  const f = fixture(t);
  for (const name of ['work.db', 'credentials', 'service.lock', 'notes.txt']) {
    const dataDirectory = path.join(f.directory, name.replaceAll('.', '-') + '-data');
    fs.mkdirSync(dataDirectory, { mode: 0o700 });
    fs.writeFileSync(path.join(dataDirectory, name), 'PRIVATE_EXISTING_DATA', { mode: 0o600 });
    const before = files(f.directory);
    const result = await setup(f, { operation: 'config-initialize', operationId: 'fixture-initialize', dataDirectory });
    assert.equal(result.code, 2);
    assert.equal(JSON.parse(result.stdout).error.code, 'SETUP_DIRECTORY_NOT_EMPTY');
    assert.deepEqual(files(f.directory), before);
    assert.ok(!result.stdout.includes('PRIVATE_EXISTING_DATA'));
  }
});

test('unsafe/noncanonical paths, public permissions and symlinks are never repaired or followed', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.data, { mode: 0o755 });
  fs.chmodSync(f.data, 0o755);
  fs.symlinkSync(f.data, path.join(f.directory, 'alias'));
  const before = files(f.directory);
  for (const dataDirectory of ['relative', `${f.data}/`, path.join(f.directory, 'x') + '/../data',
    path.join(f.directory, 'alias'), f.data, path.join(f.directory, 'missing-parent/data')]) {
    const result = await setup(f, { operation: 'config-initialize', operationId: 'fixture-initialize', dataDirectory });
    assert.equal(result.code, 2, result.stdout);
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.deepEqual(files(f.directory), before);
  }
  for (const request of ['not-json', {}, { operation: 'config-initialize', operationId: 'fixture-initialize',
    dataDirectory: f.data, token: 'DO_NOT_ACCEPT' }]) {
    assert.equal((await setup(f, request)).code, 2);
  }
});

test('concurrent same or different operation processes cannot issue duplicate viewer identities', async t => {
  const f = fixture(t);
  const results = await Promise.all(Array.from({ length: 4 }, (_, index) => setup(f,
    { operation: 'config-initialize', operationId: index < 3 ? 'fixture-initialize' : 'other-operation',
      dataDirectory: f.data })));
  const successful = results.filter(result => result.code === 0).map(result => JSON.parse(result.stdout));
  assert.ok(successful.length >= 1);
  for (const result of successful) assert.deepEqual(result, successful[0]);
  for (const result of results.filter(result => result.code !== 0)) {
    assert.ok(['SETUP_OUTCOME_UNKNOWN', 'SETUP_OPERATION_CONFLICT'].includes(JSON.parse(result.stdout).error.code),
      result.stdout);
  }
  assert.equal(inspect(f.data).principals.length, 1);
});

for (const fault of ['viewer-issuing', 'viewer-crash', 'manager-issuing']) {
  test(`failure during ${fault} retains durable claim/partial state and every replay refuses to mint`, async t => {
    const f = fixture(t);
    const preload = path.join(f.directory, 'fault.mjs');
    fs.writeFileSync(preload, `
      import { Store } from ${JSON.stringify(pathToFileURL(path.join(root, 'src/store.js')).href)};
      const issue = Store.prototype.issue;
      const credentialFile = Store.prototype.credentialFile;
      Store.prototype.issue = function(...args) {
        const token = issue.apply(this, args);
        if (${JSON.stringify(fault)} === 'viewer-crash') process.exit(73);
        if (${JSON.stringify(fault)} === 'viewer-issuing') throw new Error('FAULT_AFTER_VIEWER_MINT');
        return token;
      };
      Store.prototype.credentialFile = function(token, name) {
        if (${JSON.stringify(fault)} === 'manager-issuing' && name === 'module-manager') {
          throw new Error('FAULT_BEFORE_MANAGER_FILE');
        }
        return credentialFile.call(this, token, name);
      };
    `, { mode: 0o600 });
    const failed = await setup(f, undefined, preload);
    assert.equal(failed.code, fault === 'viewer-crash' ? 73 : 2);
    if (fault !== 'viewer-crash') assert.equal(JSON.parse(failed.stdout).error.code, 'SETUP_OUTCOME_UNKNOWN');
    const record = JSON.parse(fs.readFileSync(path.join(f.data, '.module-setup.json'), 'utf8'));
    assert.equal(record.phase, fault === 'viewer-crash' ? 'viewer-issuing' : fault);
    assert.equal(inspect(f.data).principals.length, 1);
    const before = files(f.directory);
    const repeated = await setup(f);
    assert.equal(JSON.parse(repeated.stdout).error.code, 'SETUP_OUTCOME_UNKNOWN');
    assert.equal(JSON.parse((await setup(f, { operation: 'config-initialize',
      operationId: 'replacement-operation', dataDirectory: f.data })).stdout).error.code, 'SETUP_OPERATION_CONFLICT');
    assert.deepEqual(files(f.directory), before);
  });
}

test('incomplete claim and modified completed credentials never cause repair or reissue', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.data, { mode: 0o700 });
  fs.writeFileSync(path.join(f.data, '.module-setup.json'), '', { mode: 0o600 });
  assert.equal(JSON.parse((await setup(f)).stdout).error.code, 'SETUP_OUTCOME_UNKNOWN');
  assert.deepEqual(fs.readdirSync(f.data), ['.module-setup.json']);
  const clean = { ...f, data: path.join(f.directory, 'other-data') };
  const result = JSON.parse((await setup(clean)).stdout);
  fs.writeFileSync(result.managerCredentialFile, JSON.stringify({ token: 'CHANGED_NOT_REISSUED' }));
  const before = files(f.directory);
  assert.equal(JSON.parse((await setup(clean)).stdout).error.code, 'SETUP_OUTCOME_UNKNOWN');
  assert.deepEqual(files(f.directory), before);
});

test('readback rejects public or symlinked setup/credential files without permission repair', async t => {
  const f = fixture(t);
  const result = JSON.parse((await setup(f)).stdout);
  for (const file of [path.join(f.data, '.module-setup.json'), result.viewerCredentialFile, result.managerCredentialFile]) {
    fs.chmodSync(file, 0o644);
    const before = files(f.directory);
    assert.equal(JSON.parse((await setup(f)).stdout).error.code, 'UNSAFE_SETUP_FILE');
    assert.deepEqual(files(f.directory), before);
    fs.chmodSync(file, 0o600);
  }
  fs.renameSync(result.viewerCredentialFile, `${result.viewerCredentialFile}.retained`);
  fs.symlinkSync(`${result.viewerCredentialFile}.retained`, result.viewerCredentialFile);
  const before = files(f.directory);
  assert.equal(JSON.parse((await setup(f)).stdout).error.code, 'UNSAFE_SETUP_FILE');
  assert.deepEqual(files(f.directory), before);
});

function request(port, route, body, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route,
      method: body === undefined ? 'GET' : 'POST', headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      } }, res => {
      const chunks = [];
      res.on('data', data => chunks.push(data));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('initialized data starts real Task launcher, viewer can read not write, manager can safely drain', async t => {
  const f = fixture(t);
  const initialized = await setup(f);
  assert.equal(initialized.code, 0, initialized.stdout);
  const result = JSON.parse(initialized.stdout);
  const viewer = readCredential(result.viewerCredentialFile), manager = readCredential(result.managerCredentialFile);
  const reserved = net.createServer();
  await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve));
  const port = reserved.address().port;
  await new Promise(resolve => reserved.close(resolve));
  const noNetwork = path.join(f.directory, 'no-outbound.mjs');
  fs.writeFileSync(noNetwork, `
    globalThis.fetch = () => { throw new Error('Fixture forbids outbound requests'); };
  `, { mode: 0o600 });
  const actualVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
  const instanceId = randomUUID();
  const runtime = track(spawn(process.execPath, ['src/launch.js'], {
    cwd: root, env: { ...f.env, NODE_OPTIONS: `--import=${noNetwork}`,
      WORK_DATA_DIR: result.dataDirectory, WORK_PORT: String(port),
      WORK_MODULE_MANAGER_CREDENTIAL: result.managerCredentialFile,
      COCKPIT_MODULE_ID: 'task', COCKPIT_MODULE_VERSION: actualVersion,
      COCKPIT_MODULE_DIGEST: 'e'.repeat(64), COCKPIT_MODULE_INSTANCE: instanceId,
      WORK_COCKPIT_MODULE_VERSION: actualVersion,
    }, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  f.cleanup.push(async () => {
    if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
      runtime.child.kill('SIGTERM');
      await runtime.exit;
    }
  });
  let version;
  const until = Date.now() + 10000;
  while (Date.now() < until && runtime.child.exitCode === null) {
    try { version = await request(port, '/version'); break; }
    catch (error) { if (error.code !== 'ECONNREFUSED') throw error; }
    await delay(20);
  }
  assert.ok(version, runtime.child.exitCode === null ? 'Task did not start' : JSON.stringify(await runtime.exit));
  assert.equal(version.status, 200);
  assert.equal(version.body.moduleVersion, actualVersion);
  assert.equal(version.body.instanceId, instanceId);
  const health = await request(port, '/health');
  assert.equal(health.body.ok, true);
  assert.equal(health.body.instanceId, instanceId);
  const viewerRead = await request(port, '/api/read', {}, viewer);
  const managerRead = await request(port, '/api/read', {}, manager);
  const viewerWrite = await request(port, '/api/tools/work_record',
    { action: 'create', title: 'must not exist', idempotencyKey: 'fixture-forbidden' }, viewer);
  assert.equal(viewerRead.status, 200);
  assert.equal(managerRead.status, 401);
  assert.equal(viewerWrite.status, 403);
  assert.equal((await request(port, '/drain', { pending: true }, viewer)).status, 401);
  const drained = await request(port, '/drain', { pending: true }, manager);
  assert.equal(drained.status, 200);
  assert.equal(drained.body.instanceId, instanceId);
  const stopped = await runtime.exit;
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(stopped.signal, null);
  assert.deepEqual(inspect(f.data), { principals: [{ role: 'viewer', session_id: null, task_id: null }],
    tasks: 0, provisions: 0, operations: 0 });
  console.log(JSON.stringify({ moduleVersion: version.body.moduleVersion, instanceId,
    health: health.body.ok, viewerReadStatus: viewerRead.status, viewerWriteStatus: viewerWrite.status,
    managerAsViewerStatus: managerRead.status, managerDrainStatus: drained.status,
    exitCode: stopped.code, exitSignal: stopped.signal, principals: ['viewer'], tasks: 0, nativeSessionsCreated: 0 }));
});
