import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TaskStore, SCHEMA_VERSION } from '../src/task-board/store.js';

// Build the declaration from the real initialized schema, never production data.
export function moduleProduct(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'cockpit.module.json'), 'utf8'));
  assert.equal(manifest.apiVersion, 1);
  const backend = readFileSync(join(root, 'src/task-board/module.js'), 'utf8');
  const frontend = readFileSync(join(root, 'web/task-board/index.js'), 'utf8');
  const host = readFileSync(join(root, 'src/task-board/host.js'), 'utf8');
  for (const [source, check] of [
    [backend, 'context.apiVersion !== 1'], [backend, 'context.serviceReadyVersion !== 1'],
    [frontend, 'context.apiVersion !== 2'], [frontend, 'context.uiVersion !== 1'],
    [frontend, 'context.uiSurfaceVersion !== 1'], [host, 'host.resourcePreparationVersion === 1'],
  ]) assert.ok(source.includes(check), `Review changed compatibility gate: ${check}`);
  const directory = join(root, 'dist', `schema-contract-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  let store;
  try {
    store = new TaskStore(directory);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const preserve = tables.map(({ name }) => {
      assert.match(name, /^[a-zA-Z_][a-zA-Z0-9_]*$/);
      return { table: name, columns: store.db.prepare(`PRAGMA table_info("${name}")`).all().map(column => column.name) };
    });
    return {
      kind: 'module', id: manifest.id, hostApi: { min: manifest.apiVersion, max: manifest.apiVersion },
      requiresCapabilities: ['module-api.v1', 'serviceReady.v1', 'frontend-api.v2', 'ui.v1', 'uiSurface.v1', 'resourcePreparation.v1'],
      requiredIntents: [...new Set([...host.matchAll(/host\.call\('([^']+)'/g)].map(match => match[1]))].sort(),
      databases: [{ path: 'task-board.sqlite', schema: SCHEMA_VERSION, preserve }],
      // Existing schema 11 needs no migration. Older schemas require separately reviewed plans.
      migrations: [],
    };
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

export function rollingIdentity(sequence, sourceSha, repository = 'waksana/cockpit-task') {
  assert.match(String(sequence), /^[1-9]\d*$/);
  assert.ok(Number.isSafeInteger(Number(sequence)));
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.equal(repository, 'waksana/cockpit-task');
  const version = `0.0.0-rolling.${sequence}`;
  return { format: 2, channel: 'rolling', repository, tag: `v${version}`, sourceSha,
    version, sequence: Number(sequence), archive: { name: `cockpit-task-${version}.tgz` } };
}
