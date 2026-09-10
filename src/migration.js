import { z } from 'zod';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { canonical, hash, fail, uid, now } from './store.js';

const reference = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/).nullable().default(null);
const entrySchema = z.object({
  sourceKey: z.string().min(1).max(300),
  workstream: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/).optional(),
  primary: z.boolean().default(true),
  title: z.string().min(1).max(240),
  ownerRef: reference, callerRef: reference,
  observedAt: z.string().min(1).max(100),
  observedState: z.enum(['backlog', 'working', 'blocked', 'decision', 'deferred', 'done', 'cancelled', 'unknown']),
  summary: z.string().min(1).max(2000), notes: z.string().max(8000).default(''),
  raw: z.unknown().refine(v => v !== undefined, 'Original source record required'),
  artifacts: z.array(z.string().min(1).max(2048)).max(50).default([]),
  supersedes: z.array(z.string().max(300)).max(50).default([]),
}).strict();
export const manifestSchema = z.object({
  namespace: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  files: z.array(z.object({
    path: z.string().refine(isAbsolute), sha256: z.string().regex(/^[a-f0-9]{64}$/), content: z.string().optional(),
  }).strict()).min(1).max(20),
  entries: z.array(entrySchema).min(1).max(5000),
  excluded: z.array(z.unknown()).default([]),
}).strict();
function boundedRead(path) {
  fail(statSync(path).size > 8 * 1024 * 1024, 'SOURCE_TOO_LARGE', 'Migration file exceeds 8 MiB');
  return readFileSync(path, 'utf8');
}
export function verifyFiles(manifest) {
  for (const file of manifest.files) {
    fail(hash(boundedRead(file.path)) !== file.sha256, 'SOURCE_CHANGED', `Source changed: ${file.path}; resnapshot and reconcile, never overwrite newer receipts`);
    if (file.content !== undefined) fail(hash(file.content) !== file.sha256, 'SNAPSHOT_MISMATCH', `Snapshot mismatch: ${file.path}`);
  }
}
export function stageManifest(directory, path) {
  const manifest = manifestSchema.parse(JSON.parse(boundedRead(path)));
  verifyFiles(manifest);
  for (const file of manifest.files) file.content = boundedRead(file.path);
  verifyFiles(manifest);
  const data = canonical(manifest), id = hash(data), staged = join(directory, 'import-staging');
  fail(Buffer.byteLength(data) > 8 * 1024 * 1024, 'MANIFEST_TOO_LARGE', 'Combined migration manifest exceeds 8 MiB; split explicit source batches');
  mkdirSync(staged, { recursive: true, mode: 0o700 });
  const destination = join(staged, `${id}.json`);
  try { writeFileSync(destination, data, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST' || hash(boundedRead(destination)) !== id) throw error;
  }
  return { manifestId: id, entries: manifest.entries.length, files: manifest.files.length, nativeCalls: 0 };
}
export function loadManifest(directory, id) {
  fail(!/^[a-f0-9]{64}$/.test(id), 'INVALID_MANIFEST', 'Expected staged manifest hash');
  const data = boundedRead(join(directory, 'import-staging', `${id}.json`));
  fail(hash(data) !== id, 'MANIFEST_CHANGED', 'Staged manifest has changed');
  return { ...manifestSchema.parse(JSON.parse(data)), id };
}
function groups(manifest) {
  const grouped = new Map(), keys = new Set();
  for (const entry of manifest.entries) {
    fail(keys.has(entry.sourceKey), 'DUPLICATE_SOURCE_KEY', entry.sourceKey); keys.add(entry.sourceKey);
    const stream = entry.workstream ?? `legacy-${hash(`${manifest.namespace}:${entry.sourceKey}`).slice(0, 24)}`;
    if (!grouped.has(stream)) grouped.set(stream, []);
    grouped.get(stream).push(entry);
  }
  for (const [stream, entries] of grouped) {
    fail(entries.filter(e => e.primary).length !== 1, 'AMBIGUOUS_PRIMARY', `${stream} must have exactly one primary observation; retain other records as secondary sources`);
  }
  return grouped;
}
export function planImport(store, manifest, manager) {
  verifyFiles(manifest);
  const actions = [], conflicts = [];
  for (const [workstream, entries] of groups(manifest)) {
    const task = store.get('SELECT * FROM tasks WHERE workstream=?', workstream);
    const legacy = task && store.get('SELECT * FROM legacy_records WHERE task_id=?', task.id);
    if (task && (!legacy || task.caller !== manager)) {
      conflicts.push({ workstream, reason: 'Existing native task or different management scope; never reset bindings/credentials' });
      continue;
    }
    for (const entry of entries) {
      const previous = store.get('SELECT * FROM legacy_sources WHERE namespace=? AND source_key=?', manifest.namespace, entry.sourceKey);
      const contentHash = hash(canonical(entry));
      const action = previous ? previous.content_hash === contentHash ? 'unchanged' : 'update' : 'insert';
      if (task && !previous && entry.primary) {
        conflicts.push({ workstream, sourceKey: entry.sourceKey, reason: 'New primary source cannot replace an existing observation implicitly' });
      }
      if (previous && (!task || previous.task_id !== task.id)) {
        conflicts.push({ workstream, sourceKey: entry.sourceKey, reason: 'Source key already belongs to another task; no implicit rebind' });
      } else if (previous && action === 'update' && (task.owner || task.active_op || task.record_revision !== previous.baseline_revision)) {
        conflicts.push({ workstream, sourceKey: entry.sourceKey, reason: 'Local observation/edit/execution changed since import; explicitly reconcile instead of overwriting' });
      }
      actions.push({ workstream, sourceKey: entry.sourceKey, action, taskId: task?.id ?? null,
        recordRevision: task?.record_revision ?? 0, contentHash, primary: entry.primary });
    }
  }
  const planHash = hash(canonical({ manifestId: manifest.id, manager, actions, conflicts }));
  return { manifestId: manifest.id, planHash, records: manifest.entries.length, tasks: groups(manifest).size,
    counts: Object.fromEntries(['insert', 'update', 'unchanged'].map(a => [a, actions.filter(v => v.action === a).length])),
    conflicts: conflicts.slice(0, 20), totalConflicts: conflicts.length,
    actions: actions.slice(0, 20), moreActions: Math.max(0, actions.length - 20), nativeCalls: 0 };
}
export function applyImport(store, manifest, manager, expectedPlanHash) {
  const plan = planImport(store, manifest, manager);
  fail(!expectedPlanHash || expectedPlanHash !== plan.planHash, 'PLAN_CHANGED', 'Run a fresh preview; the manifest or task record revisions changed');
  fail(plan.totalConflicts > 0, 'IMPORT_CONFLICT', JSON.stringify(plan.conflicts).slice(0, 2000));
  store.run('INSERT OR IGNORE INTO import_snapshots(id,namespace,files,created) VALUES(?,?,?,?)',
    manifest.id, manifest.namespace, JSON.stringify(manifest.files), now());
  const tasks = [];
  for (const [workstream, entries] of groups(manifest)) {
    const primary = entries.find(e => e.primary);
    let task = store.get('SELECT * FROM tasks WHERE workstream=?', workstream);
    const changed = entries.filter(entry => {
      const row = store.get('SELECT content_hash FROM legacy_sources WHERE namespace=? AND source_key=?', manifest.namespace, entry.sourceKey);
      return !row || row.content_hash !== hash(canonical(entry));
    });
    if (!task) {
      const id = uid();
      store.run(`INSERT INTO tasks(id,workstream,title,caller,version,status,summary,notes,artifacts,sources,created,updated)
        VALUES(?,?,?,?,0,'legacy',?,?,?,?,?,?)`,
      id, workstream, primary.title, manager, primary.summary, primary.notes, JSON.stringify(primary.artifacts),
      JSON.stringify(entries.map(e => `${manifest.namespace}:${e.sourceKey}`)), now(), now());
      store.run(`INSERT INTO legacy_records(task_id,owner_ref,caller_ref,observed_at,observed_state,summary,notes,supersedes)
        VALUES(?,?,?,?,?,?,?,?)`,
      id, primary.ownerRef, primary.callerRef, primary.observedAt, primary.observedState, primary.summary, primary.notes, JSON.stringify(primary.supersedes));
      task = store.task(id);
    } else if (changed.some(e => e.primary)) {
      store.run(`UPDATE legacy_records SET owner_ref=?,caller_ref=?,observed_at=?,observed_state=?,summary=?,notes=?,supersedes=? WHERE task_id=?`,
        primary.ownerRef, primary.callerRef, primary.observedAt, primary.observedState, primary.summary, primary.notes, JSON.stringify(primary.supersedes), task.id);
      store.run(`UPDATE tasks SET title=?,summary=?,notes=?,artifacts=?,record_revision=record_revision+1,updated=? WHERE id=?`,
        primary.title, primary.summary, primary.notes, JSON.stringify(primary.artifacts), now(), task.id);
      task = store.task(task.id);
    }
    for (const entry of changed) {
      store.run(`INSERT INTO legacy_sources(namespace,source_key,task_id,content_hash,baseline_revision,raw_record,snapshot_id)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(namespace,source_key) DO UPDATE SET content_hash=excluded.content_hash,
        baseline_revision=excluded.baseline_revision,raw_record=excluded.raw_record,snapshot_id=excluded.snapshot_id`,
      manifest.namespace, entry.sourceKey, task.id, hash(canonical(entry)), task.record_revision, JSON.stringify(entry.raw), manifest.id);
      store.event({ ...task, version: 0 }, 'legacy_import', `Historical record, not execution: ${manifest.namespace}:${entry.sourceKey}; snapshot=${manifest.id}`);
    }
    if (changed.some(e => e.primary)) store.run(`UPDATE legacy_sources SET baseline_revision=? WHERE task_id=? AND namespace=?`, task.record_revision, task.id, manifest.namespace);
    tasks.push({ taskId: task.id, workstream, recordRevision: task.record_revision });
  }
  return { manifestId: manifest.id, imported: plan.counts.insert, updated: plan.counts.update,
    unchanged: plan.counts.unchanged, tasks: tasks.slice(0, 20), totalTasks: tasks.length, nativeCalls: 0, notification: 'not_sent' };
}
