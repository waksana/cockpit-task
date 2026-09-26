import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGithub } from './release-write.js';

export const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export function identity(tag, sourceSha, repository = 'waksana/cockpit-task') {
  assert.match(tag, /^v0\.0\.0-rolling\.([1-9]\d*)$/);
  const sequence = Number(tag.split('.').at(-1));
  assert.ok(Number.isSafeInteger(sequence));
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.equal(repository, 'waksana/cockpit-task');
  const version = tag.slice(1);
  return { format: 2, channel: 'rolling', repository, tag, sourceSha, version, sequence,
    archive: { name: `cockpit-task-${version}.tgz` } };
}
export const assetNames = expected => [
  expected.archive.name, `${expected.archive.name}.sha256`,
  'cockpit-deployment.json', 'cockpit-deployment.json.sha256',
];
const sealMarker = '\n\n<!-- cockpit-rolling-publication\n';
function seal(snapshot) {
  const { body, ...immutable } = snapshot;
  return `${sealMarker}${JSON.stringify(immutable)}\n-->\n`;
}
function verifySeal(snapshot) {
  const start = snapshot.body.lastIndexOf(sealMarker);
  assert.ok(start >= 0, 'Original publication identity is missing');
  assert.equal(snapshot.body.slice(start), seal(snapshot), 'Original publication asset identity changed');
}
export function releaseSnapshot(release, expected) {
  assert.ok(Number.isSafeInteger(release.id) && release.id > 0);
  assert.equal(release.tag_name, expected.tag);
  assert.equal(release.target_commitish, expected.sourceSha);
  assert.equal(typeof release.name, 'string');
  assert.equal(typeof release.body, 'string');
  assert.deepEqual(release.assets.map(asset => asset.name).sort(), assetNames(expected).sort());
  const assets = release.assets.map(asset => {
    assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0);
    assert.equal(asset.state, 'uploaded');
    assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0);
    assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/);
    return { id: asset.id, name: asset.name, size: asset.size, digest: asset.digest };
  }).sort((a, b) => a.name.localeCompare(b.name));
  assert.equal(new Set(assets.map(asset => asset.id)).size, 4);
  return { id: release.id, tag: release.tag_name, sourceSha: release.target_commitish,
    name: release.name, body: release.body, assets };
}
export function verifyBytes(expected, bytes, directory) {
  for (const name of [expected.archive.name, 'cockpit-deployment.json']) {
    assert.equal(bytes[`${name}.sha256`].toString(), `${digest(bytes[name]).slice(7)}  ${name}\n`);
  }
  const descriptor = JSON.parse(bytes['cockpit-deployment.json']);
  const { product, ...actual } = descriptor;
  assert.deepEqual(actual, expected);
  assert.equal(product.kind, 'module');
  assert.equal(product.id, 'cockpit-task');
  assert.ok(Number.isSafeInteger(product.hostApi.min) && product.hostApi.min > 0);
  assert.ok(Number.isSafeInteger(product.hostApi.max) && product.hostApi.max >= product.hostApi.min);
  for (const key of ['requiresCapabilities', 'requiredIntents', 'databases', 'migrations']) assert.ok(Array.isArray(product[key]));
  mkdirSync(directory, { recursive: true });
  const archive = resolve(directory, expected.archive.name);
  writeFileSync(archive, bytes[expected.archive.name]);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim().split('\n');
  assert.equal(new Set(entries).size, entries.length);
  assert.ok(entries.every(name => !name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..')));
  const extract = name => execFileSync('tar', ['-xOzf', archive, `./${name}`], { maxBuffer: 32 * 1024 * 1024 });
  assert.deepEqual(extract('cockpit-deployment.json'), bytes['cockpit-deployment.json']);
  for (const name of ['package.json', 'cockpit.module.json', 'module-build.json']) {
    const data = JSON.parse(extract(name));
    assert.equal(data.version, expected.version);
    if (name === 'module-build.json') assert.equal(data.sourceSha, expected.sourceSha);
  }
  return descriptor;
}

export function createClient(repository, token = process.env.GH_TOKEN) {
  assert.equal(repository, 'waksana/cockpit-task');
  assert.ok(token, 'GH_TOKEN required');
  const base = `/repos/${repository}`;
  const read = async (path, binary = false) => {
    const response = await fetch(`https://api.github.com${base}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(120000),
    });
    if (response.status === 404 && !binary) return null;
    assert.ok(response.ok, `GitHub read failed: ${response.status}`);
    return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
  };
  return {
    read,
    async list(path) {
      const all = [];
      for (let page = 1; ; page++) {
        const batch = await read(`${path}?per_page=100&page=${page}`);
        assert.ok(Array.isArray(batch));
        all.push(...batch);
        if (batch.length < 100) return all;
      }
    },
    async write(path, data, method = 'POST', binary = false) {
      const bytes = binary ? data : Buffer.from(JSON.stringify(data));
      return JSON.parse(await writeGithub(binary ? 'uploads.github.com' : 'api.github.com',
        `${base}${path}`, bytes, binary ? 'application/octet-stream' : 'application/json', { token, method }));
    },
  };
}

async function tagSha(client, tag) {
  const ref = await client.read(`/git/ref/tags/${tag}`);
  if (!ref) return null;
  assert.equal(ref.object.type, 'commit', 'Rolling tags must remain immutable lightweight commit refs');
  return ref.object.sha;
}
async function find(client, tag) {
  const releases = (await client.list('/releases')).filter(release => release.tag_name === tag);
  assert.ok(releases.length <= 1, 'Duplicate exact-tag releases');
  return releases[0] ?? null;
}
async function readRelease(client, id) {
  const release = await client.read(`/releases/${id}`);
  assert.ok(release, 'Release disappeared');
  assert.equal(release.id, id, 'Release ID readback differs');
  return { ...release, assets: await client.list(`/releases/${id}/assets`) };
}
async function verifyRemote(client, id, expected, directory, pinned = null, sealed = true) {
  assert.equal(await tagSha(client, expected.tag), expected.sourceSha);
  const release = await readRelease(client, id);
  const snapshot = releaseSnapshot(release, expected);
  if (sealed) verifySeal(snapshot);
  if (pinned) assert.deepEqual(snapshot, pinned, 'Immutable release identity changed');
  const bytes = {};
  for (const asset of snapshot.assets) {
    bytes[asset.name] = await client.read(`/releases/assets/${asset.id}`, true);
    assert.equal(bytes[asset.name].length, asset.size);
    assert.equal(digest(bytes[asset.name]), asset.digest);
  }
  verifyBytes(expected, bytes, directory);
  assert.deepEqual(releaseSnapshot(await readRelease(client, id), expected), snapshot);
  return { release, snapshot, bytes };
}

// An uncertain write is observed once, then fails closed. Never continue another mutation.
async function mutate(client, path, data, method, binary, observe) {
  try { return await client.write(path, data, method, binary); }
  catch (error) {
    try { console.error('Write readback:', JSON.stringify(await observe())); }
    catch (readError) { console.error('Readback unavailable:', readError.message); }
    throw new Error(`Write outcome uncertain; no retry or further write: ${error.message}`);
  }
}
export async function publish(client, event, sequence, sourceSha, directory = 'dist') {
  const pr = event.pull_request;
  assert.equal(pr.merged, true);
  assert.equal(pr.base.ref, 'main');
  assert.equal(pr.base.repo.full_name, 'waksana/cockpit-task');
  assert.equal(pr.merge_commit_sha, sourceSha);
  const expected = identity(`v0.0.0-rolling.${sequence}`, sourceSha);
  const bytes = Object.fromEntries(assetNames(expected).map(name => [name, readFileSync(resolve(directory, name))]));
  verifyBytes(expected, bytes, resolve(directory, 'local-verification'));
  const notes = `${pr.title}\n\n${pr.body ?? ''}\n\n---\nPR: ${pr.html_url}\nSource: ${sourceSha}\nTag: ${expected.tag}\nVersion: ${expected.version}\nSequence: ${expected.sequence}\n\n${assetNames(expected).map(name => `- ${name}: ${digest(bytes[name])}`).join('\n')}\n`;
  const existingTag = await tagSha(client, expected.tag);
  if (existingTag) assert.equal(existingTag, sourceSha);
  else await mutate(client, '/git/refs', { ref: `refs/tags/${expected.tag}`, sha: sourceSha }, 'POST', false,
    () => tagSha(client, expected.tag));
  assert.equal(await tagSha(client, expected.tag), sourceSha);
  let release = await find(client, expected.tag);
  if (!release) {
    release = await mutate(client, '/releases', {
      tag_name: expected.tag, target_commitish: sourceSha, name: `Cockpit Task ${expected.tag}`,
      body: notes, draft: true, prerelease: true, make_latest: 'false',
    }, 'POST', false, () => find(client, expected.tag));
    assert.ok(Number.isSafeInteger(release.id) && release.id > 0);
    // Collection reads may omit a newly created draft. Its returned ID is authoritative.
    const discovered = await readRelease(client, release.id);
    assert.equal(discovered.tag_name, expected.tag);
    assert.equal(discovered.target_commitish, sourceSha);
    assert.equal(discovered.name, `Cockpit Task ${expected.tag}`);
    assert.equal(discovered.body, notes);
    assert.equal(discovered.draft, true);
    assert.equal(discovered.prerelease, true);
    assert.deepEqual(discovered.assets, []);
    for (const name of assetNames(expected)) {
      const current = await client.read(`/releases/${release.id}`);
      assert.equal(current.draft, true);
      await mutate(client, `/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, bytes[name], 'POST', true,
        () => client.list(`/releases/${release.id}/assets`));
    }
  }
  let verified = await verifyRemote(client, release.id, expected, resolve(directory, 'remote-verification'), null, false);
  // A rerun may reuse only the exact original bytes, including notes; no replacement uploads.
  assert.equal(verified.release.name, `Cockpit Task ${expected.tag}`);
  for (const name of assetNames(expected)) assert.deepEqual(verified.bytes[name], bytes[name]);
  const sealedNotes = notes + seal(verified.snapshot);
  if (verified.release.body === notes && verified.release.draft) {
    assert.equal(verified.release.prerelease, true);
    await mutate(client, `/releases/${release.id}`, { body: sealedNotes }, 'PATCH', false,
      () => readRelease(client, release.id));
    verified = await verifyRemote(client, release.id, expected, resolve(directory, 'sealed-verification'));
  }
  assert.equal(verified.release.body, sealedNotes, 'Original PR notes or publication identity changed');
  verifySeal(verified.snapshot);
  if (!verified.release.draft) return verified.snapshot;
  assert.equal(verified.release.prerelease, true);
  await mutate(client, `/releases/${release.id}`, { draft: false, prerelease: true, make_latest: 'false' }, 'PATCH', false,
    () => readRelease(client, release.id));
  const final = await verifyRemote(client, release.id, expected, resolve(directory, 'published-verification'), verified.snapshot);
  assert.equal(final.release.draft, false);
  assert.equal(final.release.prerelease, true);
  return final.snapshot;
}

export async function promote(client, tag, confirmation, directory = 'dist/milestone') {
  assert.equal(tag, confirmation, 'Repeat the selected tag to confirm');
  assert.match(tag, /^v0\.0\.0-rolling\.[1-9]\d*$/);
  const release = await find(client, tag);
  assert.ok(release && !release.draft && release.prerelease, 'Select an existing successful Rolling prerelease');
  const expected = identity(tag, await tagSha(client, tag));
  const before = await verifyRemote(client, release.id, expected, directory);
  assert.equal(before.release.draft, false);
  assert.equal(before.release.prerelease, true);
  const fresh = await verifyRemote(client, release.id, expected, directory, before.snapshot);
  assert.equal(fresh.release.draft, false);
  assert.equal(fresh.release.prerelease, true);
  await mutate(client, `/releases/${release.id}`, { prerelease: false, make_latest: 'true' }, 'PATCH', false,
    () => readRelease(client, release.id));
  const after = await verifyRemote(client, release.id, expected, directory, before.snapshot);
  assert.equal(after.release.draft, false);
  assert.equal(after.release.prerelease, false);
  assert.equal((await client.read('/releases/latest'))?.id, release.id);
  return after.snapshot;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const client = createClient(process.env.GITHUB_REPOSITORY);
  const command = process.argv[2];
  if (command === 'publish') {
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), process.env.SOURCE_SHA);
    execFileSync('git', ['merge-base', '--is-ancestor', process.env.SOURCE_SHA, 'origin/main']);
    console.log(JSON.stringify(await publish(client, JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH)),
      process.env.ROLLING_SEQUENCE, process.env.SOURCE_SHA)));
  } else if (command === 'promote') {
    console.log(JSON.stringify(await promote(client, process.env.RELEASE_TAG, process.env.CONFIRM_TAG)));
  } else throw new Error('Usage: rolling-release.js publish|promote');
}
