import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { identity, digest, assetNames, publish, promote } from '../scripts/rolling-release.js';
import { moduleProduct, rollingIdentity } from '../scripts/deployment-manifest.js';
import { developmentVersion } from '../src/task-board/version.js';

const root = resolve(import.meta.dirname, '..');
const sha = 'a'.repeat(40);
const event = { pull_request: { merged: true, base: { ref: 'main', repo: { full_name: 'waksana/cockpit-task' } },
  merge_commit_sha: sha, title: 'docs: full title', body: 'Entire body\n\nIncluding details.',
  html_url: 'https://github.com/waksana/cockpit-task/pull/115' } };
function fixture(t, sequence = 1) {
  const directory = resolve(root, 'dist', `rolling-test-${randomUUID()}`);
  mkdirSync(resolve(directory, 'stage'), { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const expected = identity(`v0.0.0-rolling.${sequence}`, sha);
  const descriptor = { ...expected, product: {
    kind: 'module', id: 'cockpit-task', hostApi: { min: 1, max: 1 }, requiresCapabilities: [],
    requiredIntents: [], databases: [{ path: 'task-board.sqlite', schema: 11, preserve: [] }], migrations: [],
  } };
  const sidecar = JSON.stringify(descriptor);
  writeFileSync(resolve(directory, 'stage/cockpit-deployment.json'), sidecar);
  for (const name of ['package.json', 'cockpit.module.json', 'module-build.json']) {
    writeFileSync(resolve(directory, 'stage', name), JSON.stringify({ version: expected.version, sourceSha: sha }));
  }
  execFileSync('tar', ['-czf', resolve(directory, expected.archive.name), '-C', resolve(directory, 'stage'), '.']);
  writeFileSync(resolve(directory, 'cockpit-deployment.json'), sidecar);
  for (const name of [expected.archive.name, 'cockpit-deployment.json']) {
    writeFileSync(resolve(directory, `${name}.sha256`), `${digest(readFileSync(resolve(directory, name))).slice(7)}  ${name}\n`);
  }
  return { directory, expected };
}
function fake() {
  let nextId = 1;
  const releases = [], tags = new Map(), blobs = new Map(), writes = [];
  let latest = null;
  const client = {
    writes, releases, tags, blobs, fail: null, onRead: null,
    async list(path) {
      if (path === '/releases') return structuredClone(releases);
      const id = Number(path.split('/')[2]);
      return structuredClone(releases.find(release => release.id === id).assets);
    },
    async read(path, binary) {
      client.onRead?.(path);
      if (path.startsWith('/git/ref/tags/')) {
        const tag = path.slice('/git/ref/tags/'.length);
        return tags.has(tag) ? { object: { type: 'commit', sha: tags.get(tag) } } : null;
      }
      if (binary) return blobs.get(Number(path.split('/').at(-1)));
      if (path === '/releases/latest') return releases.find(release => release.id === latest);
      return structuredClone(releases.find(release => release.id === Number(path.split('/')[2])) ?? null);
    },
    async write(path, data, method, binary) {
      writes.push({ path, data, method, binary });
      if (client.fail?.(path)) throw new Error('lost acknowledgement');
      if (path === '/git/refs') { tags.set(data.ref.slice('refs/tags/'.length), data.sha); return {}; }
      if (path === '/releases') {
        const release = { ...data, id: nextId++, assets: [] };
        releases.push(release); return structuredClone(release);
      }
      const release = releases.find(value => value.id === Number(path.split('/')[2]));
      if (binary) {
        const asset = { id: nextId++, name: decodeURIComponent(path.split('?name=')[1]), size: data.length, digest: digest(data), state: 'uploaded' };
        release.assets.push(asset); blobs.set(asset.id, data); return asset;
      }
      // Observed GitHub behavior: editing only a draft body loses its selected tag.
      if (release.draft && data.body !== undefined && data.draft !== false) {
        release.tag_name = 'untagged-synthetic-draft';
      }
      Object.assign(release, data);
      if (data.make_latest === 'true') latest = release.id;
      return structuredClone(release);
    },
  };
  return client;
}
test('main remains dev, runtime displays source SHA, descriptor derives complete schema 11', () => {
  for (const file of ['package.json', 'cockpit.module.json', 'package-lock.json']) {
    assert.equal(JSON.parse(readFileSync(resolve(root, file))).version, '0.0.0-dev');
  }
  assert.match(developmentVersion(), /^dev\+[a-f0-9]{7}$/);
  const product = moduleProduct(root);
  assert.equal(product.databases[0].schema, 11);
  assert.deepEqual(product.migrations, []);
  assert.ok(product.databases[0].preserve.find(item => item.table === 'tasks').columns.includes('description'));
  assert.ok(product.databases[0].preserve.find(item => item.table === 'operations').columns.includes('fingerprint'));
  assert.ok(product.databases[0].preserve.find(item => item.table === 'migration_v10_items'));
  assert.ok(product.requiredIntents.includes('session/resources-prepare'));
  assert.deepEqual(rollingIdentity(12, sha), identity('v0.0.0-rolling.12', sha));
});
test('consecutive docs/chore/feature merges publish independently; ordering uses sequence not completion', async t => {
  const client = fake();
  for (const sequence of [3, 1, 2]) {
    const { directory } = fixture(t, sequence);
    await publish(client, event, sequence, sha, directory);
  }
  assert.equal(client.releases.length, 3);
  assert.deepEqual(client.releases.map(release => release.tag_name), ['v0.0.0-rolling.3', 'v0.0.0-rolling.1', 'v0.0.0-rolling.2']);
  assert.ok(client.releases.every(release => !release.draft && release.prerelease && release.make_latest === 'false'));
  assert.equal(Math.max(...client.releases.map(release => Number(release.tag_name.split('.').at(-1)))), 3);
  assert.ok(client.releases[0].body.includes(`${event.pull_request.title}\n\n${event.pull_request.body}`));
});
test('failed attempt does not block next sequence; unknown write stops immediately without retry', async t => {
  const client = fake();
  client.fail = path => path === '/releases';
  const first = fixture(t);
  await assert.rejects(publish(client, event, 1, sha, first.directory), /uncertain/);
  assert.equal(client.writes.filter(write => write.path === '/releases').length, 1);
  client.fail = null;
  const next = fixture(t, 2);
  await publish(client, event, 2, sha, next.directory);
  assert.equal(client.releases[0].tag_name, next.expected.tag);
});
test('known draft ID is read directly when collection listing omits newly created drafts', async t => {
  const client = fake();
  const { directory } = fixture(t);
  const original = client.list;
  let collectionReads = 0;
  client.list = async path => {
    if (path === '/releases') {
      collectionReads++;
      return (await original(path)).filter(release => !release.draft);
    }
    return original(path);
  };
  await publish(client, event, 1, sha, directory);
  assert.equal(collectionReads, 1, 'After creation, read by ID rather than rediscovering through a collection');
  assert.equal(client.writes.filter(write => write.path === '/releases').length, 1);
  assert.equal(client.releases[0].draft, false);
});
test('publication seals original identity atomically without a tag-resetting draft-body edit', async t => {
  const client = fake();
  const { directory, expected } = fixture(t);
  const published = await publish(client, event, 1, sha, directory);
  const patches = client.writes.filter(write => write.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].data, {
    body: published.body, draft: false, prerelease: true, make_latest: 'false',
  });
  assert.ok(published.body.includes('<!-- cockpit-rolling-publication'));
  assert.equal(client.releases[0].tag_name, expected.tag);
  assert.equal(client.tags.get(expected.tag), sha);
});
test('post-publication identity changes fail closed without a compensating mutation', async t => {
  const client = fake();
  const { directory, expected } = fixture(t);
  const original = client.write;
  client.write = async (path, data, method, binary) => {
    const result = await original(path, data, method, binary);
    if (method === 'PATCH') client.releases[0].tag_name = 'untagged-unexpected-server-change';
    return result;
  };
  await assert.rejects(publish(client, event, 1, sha, directory));
  assert.equal(client.writes.filter(write => write.method === 'PATCH').length, 1);
  assert.equal(client.tags.get(expected.tag), sha);
});
for (const field of ['id', 'tag_name', 'target_commitish']) {
  test(`direct draft readback rejects changed ${field} before upload`, async t => {
    const client = fake();
    const { directory } = fixture(t);
    const original = client.read;
    client.read = async (path, binary) => {
      const value = await original(path, binary);
      if (/^\/releases\/\d+$/.test(path)) value[field] = field === 'id' ? 999 : 'conflicting';
      return value;
    };
    await assert.rejects(publish(client, event, 1, sha, directory));
    assert.equal(client.writes.length, 2, 'Only tag and draft creation were attempted');
  });
}
test('rerun retains tag/version/assets and completed release; complete draft reuse does not upload', async t => {
  const client = fake();
  const { directory } = fixture(t);
  const before = await publish(client, event, 1, sha, directory);
  const count = client.writes.length;
  assert.deepEqual(await publish(client, event, 1, sha, directory), before);
  assert.equal(client.writes.length, count);
  client.releases[0].draft = true;
  await publish(client, event, 1, sha, directory);
  assert.equal(client.writes.length, count + 1);
  assert.equal(client.writes.at(-1).method, 'PATCH');
  client.tags.set('v0.0.0-rolling.1', 'b'.repeat(40));
  await assert.rejects(publish(client, event, 1, sha, directory));
  assert.equal(client.writes.length, count + 1);
});
test('Milestone is exactly one status-only patch preserving source, tag, notes and all bytes', async t => {
  const client = fake();
  const { directory, expected } = fixture(t);
  const before = await publish(client, event, 1, sha, directory);
  const count = client.writes.length;
  const after = await promote(client, expected.tag, expected.tag, resolve(directory, 'promotion'));
  assert.deepEqual(after, before);
  assert.equal(client.writes.length, count + 1);
  assert.deepEqual(client.writes.at(-1).data, { prerelease: false, make_latest: 'true' });
});
test('promotion rejects non-Rolling, missing assets, changed bytes and changed IDs without writing', async t => {
  const client = fake();
  const { directory, expected } = fixture(t);
  await publish(client, event, 1, sha, directory);
  const count = client.writes.length;
  await assert.rejects(promote(client, 'v0.3.2', 'v0.3.2', directory));
  await assert.rejects(promote(client, expected.tag, 'other', directory));
  const asset = client.releases[0].assets.pop();
  await assert.rejects(promote(client, expected.tag, expected.tag, directory));
  client.releases[0].assets.push(asset);
  const original = client.blobs.get(asset.id);
  client.blobs.set(asset.id, Buffer.from('changed'));
  await assert.rejects(promote(client, expected.tag, expected.tag, directory));
  client.blobs.set(asset.id, original);
  let readCount = 0;
  client.onRead = path => {
    if (path === `/releases/${client.releases[0].id}` && ++readCount === 3) asset.id++;
  };
  await assert.rejects(promote(client, expected.tag, expected.tag, directory));
  assert.equal(client.writes.length, count);
});
test('promotion rejects assets replaced before invocation even when replacement checksums agree', async t => {
  const client = fake();
  const { directory, expected } = fixture(t);
  await publish(client, event, 1, sha, directory);
  const count = client.writes.length;
  // Replacing identical bytes still changes immutable GitHub asset identity.
  const asset = client.releases[0].assets[0];
  const prior = asset.id;
  asset.id = 900;
  client.blobs.set(asset.id, client.blobs.get(prior));
  await assert.rejects(promote(client, expected.tag, expected.tag, directory), /Original publication asset identity changed/);
  assert.equal(client.writes.length, count);
});
for (const failure of ['tag', 'create', 'upload', 'publish']) {
  test(`unknown accepted ${failure} write is not retried and no later mutation follows`, async t => {
    const client = fake();
    const { directory } = fixture(t);
    const original = client.write;
    let failedIndex;
    client.write = async (path, data, method, binary) => {
      const result = await original(path, data, method, binary);
      if ((failure === 'tag' && path === '/git/refs') ||
          (failure === 'create' && path === '/releases') ||
          (failure === 'upload' && binary) ||
          (failure === 'publish' && method === 'PATCH' && data.draft === false)) {
        failedIndex = client.writes.length;
        throw new Error('accepted but response lost');
      }
      return result;
    };
    await assert.rejects(publish(client, event, 1, sha, directory), /uncertain/);
    assert.equal(client.writes.length, failedIndex);
  });
}
test('workflow has exact merged source and stable run number, no filtering or concurrency cancellation', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/rolling.yml'), 'utf8');
  for (const required of ['pull_request_target:', 'types: [closed]', 'branches: [main]', 'github.event.pull_request.merged == true',
    'github.event.pull_request.merge_commit_sha', 'github.run_number']) assert.ok(workflow.includes(required));
  assert.doesNotMatch(workflow, /paths:|labels:|concurrency:|cancel-in-progress:|git push|run_attempt/);
  const milestone = readFileSync(resolve(root, '.github/workflows/milestone.yml'), 'utf8');
  assert.doesNotMatch(milestone, /npm run|package:module|npm ci/);
  assert.equal(assetNames(identity('v0.0.0-rolling.1', sha)).length, 4);
});
