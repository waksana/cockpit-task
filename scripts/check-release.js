import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPackage } from './verify-package.js';

export function checkTagTarget(tag, sha, refs) {
  assert.match(tag, /^v\d+\.\d+\.\d+$/);
  const targets = new Map(refs.trim().split('\n').filter(Boolean).map(line => {
    const [target, ref, extra] = line.trim().split(/\s+/);
    assert.match(target, /^[a-f0-9]{40}$/);
    assert.ok(!extra && [ `refs/tags/${tag}`, `refs/tags/${tag}^{}` ].includes(ref));
    return [ref, target];
  }));
  assert.ok(targets.has(`refs/tags/${tag}`), 'Version tag is missing');
  assert.equal(targets.get(`refs/tags/${tag}^{}`) ?? targets.get(`refs/tags/${tag}`), sha, 'Version tag moved');
}

export function checkRelease(root, tag, sha, directory) {
  assert.match(tag, /^v\d+\.\d+\.\d+$/, 'Release tags use vMAJOR.MINOR.PATCH');
  const version = tag.slice(1);
  const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(root, 'cockpit.module.json'), 'utf8'));
  assert.equal(metadata.version, version, 'Tag and package version differ');
  assert.equal(manifest.version, version, 'Tag and module version differ');
  const notes = readFileSync(join(root, 'docs/release-notes.md'), 'utf8');
  assert.match(notes.split(/\r?\n/)[0], new RegExp(`^# Cockpit Task ${version}(?: |$)`));
  const archive = `cockpit-task-${version}.tgz`;
  assert.deepEqual(readdirSync(directory).sort(), [archive, `${archive}.sha256`]);
  return verifyPackage(root, join(directory, archive), sha);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, sha, directory, ...extra] = process.argv.slice(2);
  if (!tag || !sha || !directory || extra.length) throw new Error('Usage: check-release.js TAG SOURCE_SHA ARTIFACT_DIRECTORY');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = checkRelease(root, tag, sha, resolve(directory));
  execFileSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], { cwd: root, stdio: 'pipe' });
  const refs = execFileSync('git', ['ls-remote', '--exit-code', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    { cwd: root, encoding: 'utf8', timeout: 30_000 });
  checkTagTarget(tag, sha, refs);
  console.log(JSON.stringify(result));
}
