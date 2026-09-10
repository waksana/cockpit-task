import { readFileSync, mkdirSync, writeFileSync, renameSync, linkSync, unlinkSync, chmodSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { canonical, hash, fail, uid } from './store.js';
import { verifyFiles } from './migration.js';

export function cutoverLedger(store, manifest, sourcePath) {
  const file = manifest.files.find(f => f.path === sourcePath);
  fail(!file || basename(sourcePath) !== 'tasks.md', 'INVALID_LEDGER', 'Only the explicitly snapshotted tasks.md ledger can be replaced');
  for (const entry of manifest.entries) {
    const row = store.get('SELECT content_hash FROM legacy_sources WHERE namespace=? AND source_key=?', manifest.namespace, entry.sourceKey);
    fail(!row || row.content_hash !== hash(canonical(entry)), 'IMPORT_NOT_APPLIED', `Source record not imported: ${entry.sourceKey}`);
  }
  const current = readFileSync(sourcePath, 'utf8');
  if (current.includes(`<!-- work-commander-cutover:${manifest.id} -->`)) return { cutover: true, alreadyApplied: true, nativeCalls: 0 };
  verifyFiles(manifest);
  const archiveDir = join(dirname(sourcePath), 'archive');
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  const archive = join(archiveDir, `tasks-${file.sha256.slice(0, 16)}-${uid()}.md`);
  const temp = `${sourcePath}.cutover-${uid()}`;
  const pointer = `# 任务入口\n\n<!-- work-commander-cutover:${manifest.id} -->\n\n任务、待办、进展与完成历史统一由 Work Commander 管理；本文件不再维护任务状态，不双写。\n\n- 查询：\`work_read\`；按 workstream 精确查，默认未结束，\`includeClosed=true\` 查历史。\n- 登记/编辑：\`work_record\`；收到旧 owner 回执用 \`work_observe\` 带来源登记，不冒充 owner。\n- 导入只迁记录，未启动/停止任何旧工作，原 owner/caller 引用、暂停和成果都保留。\n- 工作页：http://127.0.0.1:8790/ （只读凭证登录）\n- 运行及迁移说明：\`/home/honglai/work-commander/README.md\`\n- 只读原账本：[归档](archive/${basename(archive)})；其他源快照保存在服务 import_snapshots。\n\n迁移清单：\`${manifest.id}\`；旧原文仅作来源，不作为第二份当前账本。\n`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, pointer); fsyncSync(fd); } finally { closeSync(fd); }
  const reserved = openSync(archive, 'wx', 0o600); closeSync(reserved);
  // Move the actual latest inode out of the way; never overwrite a concurrent
  // newly created ledger with the pointer. Both sides survive on conflict.
  renameSync(sourcePath, archive);
  const movedHash = hash(readFileSync(archive, 'utf8'));
  if (movedHash !== file.sha256) {
    try { linkSync(archive, sourcePath); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    unlinkSync(temp);
    fail(true, 'SOURCE_CHANGED', `Concurrent source preserved at ${archive}; reconcile before cutover`);
  }
  try { linkSync(temp, sourcePath); }
  catch (error) {
    unlinkSync(temp);
    fail(error.code === 'EEXIST', 'CUTOVER_CONFLICT', `Another writer recreated tasks.md; original retained at ${archive}, new file left untouched`);
    throw error;
  }
  unlinkSync(temp); chmodSync(archive, 0o400);
  const parent = openSync(dirname(sourcePath), 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
  const archiveParent = openSync(archiveDir, 'r');
  try { fsyncSync(archiveParent); } finally { closeSync(archiveParent); }
  fail(hash(readFileSync(sourcePath, 'utf8')) !== hash(pointer), 'CUTOVER_CONFLICT', 'Pointer changed after publication; inspect without overwriting it');
  return { cutover: true, sourcePath, archive, sourceHash: file.sha256, manifestId: manifest.id, nativeCalls: 0 };
}
