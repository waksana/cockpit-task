import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const [taskId, callerCredential] = process.argv.slice(2);
if (!taskId || !callerCredential) throw new Error('Usage: fixture-check.js EXPLICIT_FIXTURE_TASK_ID CALLER_CREDENTIAL');
const db = new DatabaseSync(join(process.env.WORK_DATA_DIR ?? join(homedir(), '.local/state/work-commander'), 'work.db'), { readOnly: true });
const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
assert.ok(task?.workstream.startsWith('fixture-'), 'Only explicitly named fixture tasks may be exercised');
assert.equal(task.version, 2); assert.equal(task.status, 'delivered');
const op = db.prepare("SELECT request FROM operations WHERE task_id=? AND version=2 AND kind='notification'").get(taskId);
const notificationCount = () => db.prepare("SELECT count(*) n FROM events WHERE task_id=? AND kind='notification_accepted'").get(taskId).n;
const nativeCalls = () => db.prepare('SELECT metrics FROM operations WHERE task_id=?').all(taskId)
  .reduce((count, op) => count + JSON.parse(op.metrics).calls, 0);
const before = notificationCount();
const callsBefore = nativeCalls();
const client = new Client({ name: 'work-commander-fixture-verifier', version: '1.0.0' });
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL('../src/mcp.js', import.meta.url))], stderr: 'inherit',
  }));
  const finalInput = JSON.parse(op.request);
  const duplicate = await client.callTool({ name: 'work_deliver', arguments: { ...finalInput, credential: task.credential_path } });
  assert.equal(duplicate.isError, false); assert.equal(notificationCount(), before);
  const stale = await client.callTool({ name: 'work_deliver', arguments: {
    ...finalInput, credential: task.credential_path, goalVersion: 1, idempotencyKey: 'fixture-reject-stale-final-001',
  } });
  assert.equal(stale.isError, true); assert.equal(JSON.parse(stale.content[0].text).error, 'STALE_GOAL');
  const spoof = await client.callTool({ name: 'work_report', arguments: {
    credential: callerCredential, taskId, goalVersion: 2, kind: 'accepted', summary: 'forbidden fixture report', idempotencyKey: 'fixture-reject-caller-report-001',
  } });
  assert.equal(spoof.isError, true); assert.equal(JSON.parse(spoof.content[0].text).error, 'FORBIDDEN');
  const summary = await client.callTool({ name: 'work_read', arguments: { credential: callerCredential } });
  assert.equal(nativeCalls(), callsBefore);
  console.log(JSON.stringify({
    taskId, goalVersion: task.version, finalNotifications: notificationCount(), duplicateFinalSent: 0,
    staleGoal: 'rejected', callerImpersonation: 'rejected',
    summaryBytes: Buffer.byteLength(summary.content[0].text),
    additionalRecordedNativeCalls: nativeCalls() - callsBefore,
  }));
} finally { await client.close(); db.close(); }
