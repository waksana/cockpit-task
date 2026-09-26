import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyPackage(root, archive, sourceSha) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/, 'Package source must be an exact commit');
  assert.ok(statSync(archive).size <= 32 * 1024 * 1024, 'Module archive exceeds host size limit');
  const name = basename(archive);
  const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
  assert.equal(readFileSync(`${archive}.sha256`, 'utf8').trim(), `${sha256}  ${name}`);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
    .trim().split('\n').filter(Boolean);
  assert.equal(new Set(entries).size, entries.length, 'Duplicate archive entries');
  assert.ok(entries.every(entry => !entry.startsWith('/') && !entry.includes('\\') &&
    entry.split('/').every(part => part !== '..')), 'Unsafe archive path');
  const read = path => execFileSync('tar', ['-xOzf', archive, `./${path}`], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const manifest = JSON.parse(read('cockpit.module.json'));
  const metadata = JSON.parse(read('package.json'));
  const build = JSON.parse(read('module-build.json'));
  const sourceManifest = JSON.parse(readFileSync(join(root, 'cockpit.module.json'), 'utf8'));
  const sourceMetadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const host = JSON.parse(readFileSync(join(root, 'tooling/host-compatibility.json'), 'utf8'));
  assert.deepEqual(manifest, sourceManifest);
  assert.equal(metadata.name, 'cockpit-task');
  assert.equal(metadata.version, sourceMetadata.version);
  assert.equal(manifest.version, metadata.version);
  assert.equal(name, `cockpit-task-${manifest.version}.tgz`);
  assert.equal(build.format, 1);
  assert.equal(build.product, manifest.id);
  assert.equal(build.version, manifest.version);
  assert.equal(build.sourceSha, sourceSha);
  assert.equal(build.node, process.versions.node);
  assert.equal(build.platform, 'linux');
  assert.equal(build.arch, 'x64');
  assert.deepEqual(build.host, host);
  assert.equal(host.repository, 'waksana/cockpit');
  for (const key of ['uiCommit', 'backendCommit']) assert.match(host[key], /^[a-f0-9]{40}$/);
  return { version: manifest.version, sourceSha, sha256, host };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [archive, sourceSha, ...extra] = process.argv.slice(2);
  if (!archive || !sourceSha || extra.length) throw new Error('Usage: verify-package.js ARCHIVE SOURCE_SHA');
  const root = fileURLToPath(new URL('..', import.meta.url));
  console.log(JSON.stringify(verifyPackage(root, resolve(archive), sourceSha)));
}
