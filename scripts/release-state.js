import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function releasePages(value) {
  assert.ok(Array.isArray(value), 'Release list response must be an array');
  return value.flatMap(page => Array.isArray(page) ? page : [page]);
}

export function selectRelease(value, tag) {
  const matches = releasePages(value).filter(release => release?.tag_name === tag);
  assert.ok(matches.length <= 1, `Multiple Releases use tag ${tag}`);
  return matches[0] ?? null;
}

function expectedIdentity(args) {
  if (args.length === 0) return {};
  assert.equal(args.length, 5, 'Expected release ID, two asset IDs and two asset digests');
  const [releaseId, archiveAssetId, archiveDigest, checksumAssetId, checksumDigest] = args;
  return { releaseId, archiveAssetId, archiveDigest, checksumAssetId, checksumDigest };
}

export function verifyRelease(release, state, tag, archive, expected = {}) {
  assert.ok(release && typeof release === 'object' && !Array.isArray(release), 'Release response must be an object');
  assert.ok(['draft', 'published'].includes(state), 'Release state must be draft or published');
  assert.equal(release.tag_name, tag, 'Release tag differs');
  assert.equal(release.draft, state === 'draft', `Release is not ${state}`);
  assert.equal(release.prerelease, false, 'Release must not be a prerelease');
  assert.ok(Number.isSafeInteger(release.id) && release.id > 0, 'Release ID is invalid');
  assert.ok(Array.isArray(release.assets), 'Release assets are missing');
  const names = [archive, `${archive}.sha256`];
  assert.deepEqual(release.assets.map(asset => asset.name).sort(), names.slice().sort(), 'Release asset set differs');

  const assets = new Map(release.assets.map(asset => {
    assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0, `Asset ${asset.name} ID is invalid`);
    assert.equal(asset.state, 'uploaded', `Asset ${asset.name} is not uploaded`);
    assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0, `Asset ${asset.name} is empty`);
    assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/, `Asset ${asset.name} digest is invalid`);
    return [asset.name, asset];
  }));
  const archiveAsset = assets.get(archive);
  const checksumAsset = assets.get(`${archive}.sha256`);
  const identity = {
    releaseId: String(release.id),
    archiveAssetId: String(archiveAsset.id),
    archiveDigest: archiveAsset.digest,
    checksumAssetId: String(checksumAsset.id),
    checksumDigest: checksumAsset.digest,
  };
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(identity[key], value, `${key} differs`);
  }
  return identity;
}

function usage() {
  throw new Error(
    'Usage: release-state.js select RELEASES_JSON TAG OUTPUT_JSON | ' +
    'verify RELEASE_JSON STATE TAG ARCHIVE [RELEASE_ID ARCHIVE_ASSET_ID ARCHIVE_DIGEST CHECKSUM_ASSET_ID CHECKSUM_DIGEST]',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'select') {
    const [input, tag, output, ...extra] = args;
    if (!input || !tag || !output || extra.length) usage();
    const release = selectRelease(JSON.parse(readFileSync(input, 'utf8')), tag);
    if (!release) {
      console.log('absent');
    } else {
      writeFileSync(output, `${JSON.stringify(release)}\n`);
      console.log(release.draft ? 'draft' : 'published');
    }
  } else if (command === 'verify') {
    const [input, state, tag, archive, ...identity] = args;
    if (!input || !state || !tag || !archive) usage();
    const release = JSON.parse(readFileSync(input, 'utf8'));
    console.log(JSON.stringify(verifyRelease(release, state, tag, archive, expectedIdentity(identity))));
  } else {
    usage();
  }
}
