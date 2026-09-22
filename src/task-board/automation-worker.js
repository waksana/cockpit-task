import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { scriptArguments, scriptDigest } from './automation-store.js';

let launched = false;
process.once('disconnect', () => {
  if (!launched) process.exit(0);
  else process.kill(-process.pid, 'SIGTERM');
});
process.once('message', ({ script, parameters }) => {
  launched = true;
  try {
    if (scriptDigest(script.script_path) !== script.sha256) throw new Error('Registered script bytes changed; register a new script version');
    const child = spawn(script.executable, scriptArguments(script, parameters), {
      cwd: dirname(script.script_path), shell: false, stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.once('spawn', () => process.send?.({ event: 'running' }));
    child.once('error', error => {
      process.send?.({ event: 'result', exit_code: null, signal: null, error: `Spawn failed: ${error.code ?? error.message}` },
        () => process.exit(1));
    });
    child.once('exit', (exit_code, signal) => {
      process.send?.({ event: 'result', exit_code, signal, error: null }, () => process.exit(exit_code === 0 ? 0 : 1));
    });
  } catch (error) {
    process.send?.({ event: 'result', exit_code: null, signal: null, error: error.message }, () => process.exit(1));
  }
});
