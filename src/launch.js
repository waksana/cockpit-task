import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = process.env.WORK_DATA_DIR ?? join(homedir(), '.local/state/work-commander');
mkdirSync(directory, { recursive: true, mode: 0o700 });
process.umask(0o077);
const child = spawn('flock', ['-n', '-E', '73', '--no-fork', join(directory, 'service.lock'), process.execPath, fileURLToPath(new URL('./server.js', import.meta.url))], {
  stdio: 'inherit', env: { ...process.env, WORK_LOCK_HELD: '1' },
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  if (code === 73) console.error('Another Work Commander process owns this data directory');
  process.exitCode = code ?? (signal ? 1 : 0);
});
