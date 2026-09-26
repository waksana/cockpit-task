import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'dist');
mkdirSync(output, { recursive: true });
const manifest = JSON.parse(readFileSync(join(root, 'cockpit.module.json'), 'utf8'));
if (manifest.id !== 'cockpit-task' || manifest.apiVersion !== 1) throw new Error('Unexpected module manifest');
const stage = mkdtempSync(join(output, 'cockpit-task-package-'));
const pending = `${stage}.tgz`;
try {
  for (const path of [
    'cockpit.module.json', 'src/task-board', 'web/task-board',
    'scripts/migrate-task-v10.js', 'scripts/migrate-task-v11.js',
    'roles/task-node.md',
    'skills/cockpit-task-tree', 'skills/github-coding', 'node_modules',
  ]) {
    cpSync(join(root, path), join(stage, path), {
      recursive: true,
      filter: source => source !== join(root, 'node_modules', '.bin'),
    });
  }
  writeFileSync(join(stage, 'package.json'), JSON.stringify({
    name: 'cockpit-task', version: manifest.version, private: true, type: 'module',
    engines: { node: '>=24.0.0' },
  }, null, 2) + '\n');
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const host = JSON.parse(readFileSync(join(root, 'tooling/host-compatibility.json'), 'utf8'));
  writeFileSync(join(stage, 'module-build.json'), JSON.stringify({
    format: 1,
    product: manifest.id,
    version: manifest.version,
    sourceSha,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    host,
  }, null, 2) + '\n');
  writeFileSync(join(stage, 'README.md'),
    readFileSync(join(root, 'docs/task-board.md'), 'utf8').replaceAll('../skills/', 'skills/'));
  const verifyFiles = directory => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isDirectory()) verifyFiles(path);
      else if (!stat.isFile()) throw new Error(`Module packages require regular files: ${path}`);
    }
  };
  verifyFiles(stage);
  const archive = join(output, `cockpit-task-${manifest.version}.tgz`);
  execFileSync('tar', [
    '--format=ustar', '--sort=name', '--mtime=@0',
    '--owner=0', '--group=0', '--numeric-owner', '--hard-dereference',
    '-czf', pending, '-C', stage, '.',
  ], { stdio: 'pipe' });
  if (statSync(pending).size > 32 * 1024 * 1024) throw new Error('Module archive exceeds host size limit');
  const digest = createHash('sha256').update(readFileSync(pending)).digest('hex');
  renameSync(pending, archive);
  writeFileSync(`${archive}.sha256`, `${digest}  cockpit-task-${manifest.version}.tgz\n`);
  console.log(archive);
} finally {
  rmSync(pending, { force: true });
  rmSync(stage, { recursive: true, force: true });
}
