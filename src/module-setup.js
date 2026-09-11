#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Store, WorkError, canonical, fail, hash } from './store.js';

const input = z.object({
  operation: z.literal('config-initialize'),
  operationId: z.string().min(8).max(120).regex(/^[a-zA-Z0-9_.:-]+$/),
  dataDirectory: z.string().min(1).max(4096),
}).strict();
const recordName = '.module-setup.json';
const phases = ['claimed', 'store-creating', 'viewer-issuing', 'manager-issuing', 'store-closing', 'complete'];

function info(file) {
  try { return fs.lstatSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function privateDirectory(directory) {
  const stat = info(directory);
  fail(!stat || !stat.isDirectory() || stat.uid !== process.getuid()
    || (stat.mode & 0o777) !== 0o700 || fs.realpathSync(directory) !== directory,
  'UNSAFE_SETUP_DIRECTORY', 'Use an owned canonical private 0700 directory');
}

function privateFile(file) {
  const stat = info(file);
  fail(!stat || !stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()
    || (stat.mode & 0o077) !== 0 || fs.realpathSync(file) !== file,
  'UNSAFE_SETUP_FILE', 'Setup files must be owned private regular single-link files');
  return stat;
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeRecord(file, record) {
  privateFile(file);
  const temp = path.join(path.dirname(file), `.module-setup-${randomUUID()}.tmp`);
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  syncDirectory(path.dirname(file));
}

function resultFor(request) {
  const credentialDirectory = path.join(request.dataDirectory, 'credentials');
  return { ok: true, operationId: request.operationId, dataDirectory: request.dataDirectory,
    credentialDirectory, managerCredentialFile: path.join(credentialDirectory, 'module-manager.json'),
    viewerCredentialFile: path.join(credentialDirectory, 'module-viewer.json') };
}

function readback(file, request) {
  fail(privateFile(file).size > 32768, 'SETUP_OUTCOME_UNKNOWN', 'Setup record requires explicit reconciliation');
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) throw new WorkError('SETUP_OUTCOME_UNKNOWN', 'Incomplete setup record; never mint again');
    throw error;
  }
  fail(!record || record.schemaVersion !== 1 || record.operation !== request.operation
    || record.dataDirectory !== request.dataDirectory || typeof record.operationId !== 'string'
    || !phases.includes(record.phase), 'SETUP_OUTCOME_UNKNOWN', 'Setup record requires explicit reconciliation');
  fail(record.operationId !== request.operationId, 'SETUP_OPERATION_CONFLICT', 'Directory already claimed by another operation');
  fail(record.phase !== 'complete', 'SETUP_OUTCOME_UNKNOWN', 'Setup has an incomplete outcome; never mint again');
  const result = resultFor(request);
  fail(canonical(record.result) !== canonical(result), 'SETUP_OUTCOME_UNKNOWN', 'Setup result no longer matches its claim');
  privateDirectory(result.credentialDirectory);
  privateFile(path.join(request.dataDirectory, 'work.db'));
  for (const key of ['managerCredentialFile', 'viewerCredentialFile']) {
    const stat = privateFile(result[key]);
    fail(stat.size > 4096 || hash(fs.readFileSync(result[key])) !== record.credentialHashes?.[key],
      'SETUP_OUTCOME_UNKNOWN', 'Initialized credential changed; no replacement is issued');
  }
  return result;
}

export function initializeConfig(raw) {
  const parsed = input.safeParse(raw);
  fail(!parsed.success, 'INVALID_SETUP_REQUEST', 'Supply only operation, operationId and dataDirectory');
  const request = parsed.data;
  const directory = request.dataDirectory;
  fail(!path.isAbsolute(directory) || path.resolve(directory) !== directory || directory === '/'
    || /[\0\r\n]/.test(directory) || /[\r\n]/.test(request.operationId),
  'INVALID_SETUP_DIRECTORY', 'dataDirectory must be an explicit canonical absolute path');
  privateDirectory(path.dirname(directory));
  if (!info(directory)) {
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    syncDirectory(path.dirname(directory));
  }
  privateDirectory(directory);
  const file = path.join(directory, recordName);
  if (info(file)) return readback(file, request);
  const entries = fs.readdirSync(directory);
  if (entries.includes(recordName)) return readback(file, request);
  fail(entries.length !== 0, 'SETUP_DIRECTORY_NOT_EMPTY',
    'Only a new empty directory may be initialized; existing data is never adopted');

  const record = { schemaVersion: 1, ...request, phase: 'claimed' };
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') return readback(file, request);
    throw error;
  }
  let store;
  try {
    try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    syncDirectory(directory);
    fail(fs.readdirSync(directory).some(name => name !== recordName),
      'SETUP_DIRECTORY_CHANGED', 'Directory changed after the durable claim');
    const stage = phase => { record.phase = phase; writeRecord(file, record); };
    stage('store-creating');
    fs.mkdirSync(path.join(directory, 'credentials'), { mode: 0o700 });
    syncDirectory(directory);
    store = new Store(directory);
    stage('viewer-issuing');
    const viewerCredentialFile = store.credentialFile(store.issue('viewer'), 'module-viewer');
    stage('manager-issuing');
    const managerCredentialFile = store.credentialFile(randomBytes(32).toString('base64url'), 'module-manager');
    stage('store-closing');
    store.close(); store = null;
    const result = resultFor(request);
    fail(viewerCredentialFile !== result.viewerCredentialFile || managerCredentialFile !== result.managerCredentialFile,
      'SETUP_PATH_CHANGED', 'Credential paths do not match the fixed setup contract');
    record.result = result;
    record.credentialHashes = {
      viewerCredentialFile: hash(fs.readFileSync(viewerCredentialFile)),
      managerCredentialFile: hash(fs.readFileSync(managerCredentialFile)),
    };
    stage('complete');
    return result;
  } catch {
    // The durable pre-effect phase is retained, including any orphaned files/rows.
    throw new WorkError('SETUP_OUTCOME_UNKNOWN', 'Setup did not finish with a known result; never mint again');
  } finally { store?.close(); }
}

async function main() {
  process.umask(0o077);
  fail(process.argv.length !== 2, 'INVALID_SETUP_REQUEST', 'Setup accepts one JSON request on stdin, no arguments');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let request;
  try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) throw new WorkError('INVALID_SETUP_REQUEST', 'Invalid JSON request');
    throw error;
  }
  return initializeConfig(request);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.exitCode = 2;
    return { ok: false, error: { code: error instanceof WorkError ? error.code : 'SETUP_IO_FAILED' } };
  }).then(result => process.stdout.write(`${JSON.stringify(result)}\n`));
}
