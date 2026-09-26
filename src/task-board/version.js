import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = new URL('../../', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
export function developmentVersion() {
  if (version !== '0.0.0-dev') return version;
  let source;
  try { source = JSON.parse(readFileSync(new URL('module-build.json', root), 'utf8')).sourceSha; }
  catch { source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); }
  return `dev+${source.slice(0, 7)}`;
}
