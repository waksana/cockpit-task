import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { selectRelease, verifyRelease } from '../scripts/release-state.js';

const tag = 'v1.2.3';
const archive = 'cockpit-task-1.2.3.tgz';
const archiveAsset = {
  id: 21,
  name: archive,
  state: 'uploaded',
  size: 123,
  digest: `sha256:${'a'.repeat(64)}`,
};
const checksumAsset = {
  id: 22,
  name: `${archive}.sha256`,
  state: 'uploaded',
  size: 89,
  digest: `sha256:${'b'.repeat(64)}`,
};
const draft = {
  id: 12,
  tag_name: tag,
  draft: true,
  prerelease: false,
  assets: [checksumAsset, archiveAsset],
};

test('selectRelease distinguishes absent, unique and duplicate exact tags', () => {
  assert.equal(selectRelease([[], [{ ...draft, tag_name: 'v1.2.2' }]], tag), null);
  assert.equal(selectRelease([[draft]], tag), draft);
  assert.throws(() => selectRelease([[draft], [{ ...draft, id: 13 }]], tag), /Multiple Releases/);
});

test('verifyRelease binds draft and asset identity', () => {
  const identity = verifyRelease(draft, 'draft', tag, archive);
  assert.deepEqual(identity, {
    releaseId: '12',
    archiveAssetId: '21',
    archiveDigest: archiveAsset.digest,
    checksumAssetId: '22',
    checksumDigest: checksumAsset.digest,
  });
  assert.deepEqual(verifyRelease(draft, 'draft', tag, archive, identity), identity);
  assert.throws(
    () => verifyRelease(draft, 'draft', tag, archive, { ...identity, archiveAssetId: '99' }),
    /archiveAssetId differs/,
  );
});

test('verifyRelease rejects conflicts and incomplete assets', () => {
  assert.throws(() => verifyRelease({ ...draft, draft: false }, 'draft', tag, archive), /not draft/);
  assert.throws(() => verifyRelease({ ...draft, prerelease: true }, 'draft', tag, archive), /prerelease/);
  assert.throws(
    () => verifyRelease({ ...draft, assets: [{ ...archiveAsset, size: 0 }, checksumAsset] }, 'draft', tag, archive),
    /empty/,
  );
  assert.throws(
    () => verifyRelease({ ...draft, assets: [archiveAsset, { ...checksumAsset, digest: null }] }, 'draft', tag, archive),
    /digest is invalid/,
  );
});

test('release workflow recovers drafts without tag-based draft reads or asset replacement', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  for (const text of [
    'workflow_dispatch:',
    'gh api --paginate --slurp',
    'release-state.js select',
    'releases/assets/$ARCHIVE_ID',
    'releases/assets/$ARCHIVE_ASSET_ID',
    'gh api --method PATCH',
    'authoritative readback proves it completed',
    'node-version: ${{ steps.recovery.outputs.node_version }}',
  ]) {
    assert.match(workflow, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(workflow, /gh release (download|edit)/);
  assert.doesNotMatch(workflow, /--clobber|release delete/);
});
