import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { fail, hash, now, readCredential } from './store.js';

export function dataDirectory(env = process.env) {
  return env.WORK_DATA_DIR ?? (env.WORK_COCKPIT_MODULE_VERSION
    ? join(env.COCKPIT_USER_ROOT ?? join(homedir(), '.cockpit'), 'data/task')
    : join(homedir(), '.local/state/work-commander'));
}

export function normalizeBasePath(value = '') {
  if (value === '') return '';
  if (!/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(value)) {
    throw new Error('basePath must be empty or an absolute path without a trailing slash');
  }
  return value;
}

const provisionInput = z.object({
  requestId: z.string().min(8).max(120).regex(/^[a-zA-Z0-9_.:-]+$/),
  sessionId: z.string().min(1).max(120).regex(/^[a-zA-Z0-9_-]+$/),
}).strict();

export class ModuleManager {
  constructor(store, cockpit) { this.store = store; this.cockpit = cockpit; }

  existing({ requestId, sessionId }) {
    const row = this.store.get('SELECT * FROM module_provisions WHERE request_id=?', requestId);
    if (!row) return null;
    fail(row.session_id !== sessionId, 'IDEMPOTENCY_CONFLICT', 'requestId is already bound to another session');
    fail(!row.credential_path, 'MODULE_PROVISION_INCOMPLETE', 'Provisioning has an uncertain local result; operator reconciliation required, never issue a replacement automatically');
    const principal = this.store.authenticate(readCredential(row.credential_path));
    fail(principal.role !== 'caller' || principal.session_id !== sessionId,
      'MODULE_CREDENTIAL_MISMATCH', 'Provisioned credential no longer matches the binding', 403);
    return { credentialFile: row.credential_path };
  }

  async provision(body) {
    const input = provisionInput.parse(body);
    const previous = this.existing(input);
    if (previous) return previous;
    // The trusted manager selects a real native session, not a payload-claimed role.
    await this.cockpit.meta(input.sessionId);
    const concurrent = this.existing(input);
    if (concurrent) return concurrent;
    this.store.run('INSERT INTO module_provisions(request_id,session_id,created) VALUES(?,?,?)',
      input.requestId, input.sessionId, now());
    // Reserve before issuing. A crash can leave an unresolved reservation or orphan
    // file, but cannot cause a same-request retry to mint another caller identity.
    return this.store.tx(() => {
      const token = this.store.issue('caller', input.sessionId);
      const credentialFile = this.store.credentialFile(token, `module-caller-${hash(input.requestId)}`);
      this.store.run('UPDATE module_provisions SET credential_path=? WHERE request_id=?',
        credentialFile, input.requestId);
      return { credentialFile };
    });
  }
}
