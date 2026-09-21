import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Enforce a small YAML-safe release format, not a replacement YAML parser:
// kebab-case names and JSON-quoted descriptions (valid YAML double-quoted scalars).
function skillMetadata(source) {
  const header = /^---\r?\nname: ([a-z0-9]+(?:-[a-z0-9]+)*)\r?\ndescription: ("[^\r\n]*")\r?\n---(?:\r?\n|$)/.exec(source);
  assert.ok(header, 'Skill frontmatter requires a kebab-case name and a JSON-quoted description');
  const description = JSON.parse(header[2]);
  assert.equal(typeof description, 'string');
  assert.ok(description.trim(), 'Skill description must not be empty');
  return { name: header[1], description };
}

const root = fileURLToPath(new URL('../', import.meta.url));
const sharedReferences = ['reading-tasks.md', 'task-links.md', 'task-writes-and-recovery.md'];
const skillDirectory = role => `skills/cockpit-task-${role}/cockpit-task-${role}`;
const skillFiles = role => [
  'SKILL.md',
  ...[...sharedReferences, ...(role === 'owner' ? ['important-updates.md'] : [])]
    .map(name => `references/${name}`),
].sort();
const prose = source => source.replace(/\s+/g, ' ');
const localLinks = source => [...source.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)]
  .map(([, target]) => target)
  .filter(target => !/^(?:[a-z][a-z\d+.-]*:|#)/i.test(target));

function assertSkillClosure(directory, role) {
  const expected = skillFiles(role);
  assert.deepEqual(readdirSync(directory, { recursive: true }).sort(),
    [...expected, 'references'].sort(), 'Only the body and runtime references belong in a Skill');
  const pending = ['SKILL.md'];
  const visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const path = join(directory, file);
    assert.ok(lstatSync(path).isFile(), `${file} must not depend on a symlink`);
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /Discussion draft|not an installed Skill|skill-drafts|evaluation\/|\/home\//);
    for (const link of localLinks(source)) {
      const target = resolve(dirname(path), decodeURIComponent(link.split(/[?#]/)[0]));
      assert.ok(target.startsWith(`${directory}${sep}`), `${file}: ${link} escapes this Skill`);
      assert.ok(existsSync(target), `${file}: missing local reference ${link}`);
      pending.push(relative(directory, target));
    }
  }
  assert.deepEqual([...visited].sort(), expected, 'Every bundled reference must be reachable');
}

test('only the two current Task role Skills are discoverable, with YAML-safe frontmatter', () => {
  const files = readdirSync(join(root, 'skills'), { recursive: true })
    .filter(path => basename(path) === 'SKILL.md');
  assert.equal(files.length, 2);
  const names = new Set();
  for (const path of files) {
    const metadata = skillMetadata(readFileSync(join(root, 'skills', path), 'utf8'));
    assert.equal(metadata.name, basename(join(path, '..')), path);
    assert.ok(!names.has(metadata.name), `Duplicate skill name: ${metadata.name}`);
    names.add(metadata.name);
  }
  assert.deepEqual([...names].sort(), ['cockpit-task-executor', 'cockpit-task-owner']);
});

test('repository entrypoints describe only the current Task module', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'cockpit.module.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.name, manifest.id);
  assert.equal(pkg.version, manifest.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.deepEqual(Object.keys(pkg.scripts).sort(), ['package:module', 'test']);
  assert.deepEqual(readdirSync(join(root, 'src')), ['task-board']);
  assert.deepEqual(readdirSync(join(root, 'web')), ['task-board']);
  assert.deepEqual(readdirSync(join(root, 'roles')).sort(), ['task-executor.md', 'task-owner.md']);
  assert.deepEqual(readdirSync(join(root, 'scripts')), ['package-task-board.js']);
  assert.deepEqual(readdirSync(join(root, '.github/workflows')), ['task-board-ci.yml']);
  for (const path of ['module.json', 'service-delivery.json', 'BRIEF.md',
    'docs/legacy-skills', 'docs/skill-drafts', 'docs/task-feedback.md', 'docs/task-workstreams.md']) {
    assert.equal(existsSync(join(root, path)), false, `Retired repository content: ${path}`);
  }
});

test('each current Skill has an independent relative reference closure without research payloads', t => {
  const isolated = mkdtempSync(join(tmpdir(), 'task-skill-closure-'));
  t.after(() => rmSync(isolated, { recursive: true, force: true }));
  for (const role of ['owner', 'executor']) {
    const directory = join(isolated, role);
    cpSync(join(root, skillDirectory(role)), directory, { recursive: true });
    assertSkillClosure(directory, role);
    const source = readFileSync(join(directory, 'SKILL.md'), 'utf8');
    const metadata = skillMetadata(source);
    assert.equal(metadata.name, `cockpit-task-${role}`);
    assert.match(metadata.description, /first|reuse/i);
    assert.ok(source.split('\n').length < 150, 'The body should remain a concise principles guide');
    assert.match(source, /Load only the reference needed, not the whole set/);
    assert.match(source, /Reuse this Skill while it remains in context/);
    assert.match(source, /fresh Task/);
  }
  for (const reference of sharedReferences) {
    assert.equal(readFileSync(join(isolated, 'owner/references', reference), 'utf8'),
      readFileSync(join(isolated, 'executor/references', reference), 'utf8'),
      `${reference}: independent copies must retain the same shared protocol guidance`);
  }
});

test('role prompts stay short while the Skills preserve delegation, communication and synchronization boundaries', () => {
  for (const role of ['owner', 'executor']) {
    const prompt = prose(readFileSync(join(root, `roles/task-${role}.md`), 'utf8'));
    assert.ok(prompt.split(' ').length <= 200, `${role}: keep details in the Skill and references`);
    assert.ok(prompt.includes(`Load \`cockpit-task-${role}\` when first needed`));
    assert.match(prompt, /Reuse.*reload only when missing, changed or a rule is unclear/);
    assert.match(prompt, /not for each new message/);
    assert.match(prompt, /Stable Skill reuse never replaces fresh Task reads/);
  }
  const ownerPrompt = prose(readFileSync(join(root, 'roles/task-owner.md'), 'utf8'));
  assert.match(ownerPrompt, /independent Executor through Task, not your own tools or subagents/);
  assert.match(ownerPrompt, /explicit user request or an actual assignment as a capable Executor/);
  assert.match(ownerPrompt, /dual-role selection alone is neither/);
  assert.match(ownerPrompt, /Coordinate through Task, not chats with Executor/);
  assert.match(ownerPrompt, /do not monitor or schedule reminders/);
  const executorPrompt = prose(readFileSync(join(root, 'roles/task-executor.md'), 'utf8'));
  assert.match(executorPrompt, /one complete assigned Task at a time/);
  assert.match(executorPrompt, /directly of the user here; do not message Owner, directly or through other agents/);
  assert.match(executorPrompt, /exact revision.*every `definition_check`/);

  const owner = prose(readFileSync(join(root, skillDirectory('owner'), 'SKILL.md'), 'utf8'));
  assert.match(owner, /independent Executor, not your own tools or subagents/);
  assert.match(owner, /A result request is not permission for personal implementation, even for small work/);
  assert.match(owner, /Split independent outcomes, not tightly coupled stages, resources or specialties/);
  assert.match(owner, /Do not chat with Executor to ask for progress, clarify requirements, chase work or request confirmation/);
  assert.match(owner, /Executor-facing notices remain the initial assignment.*important-update handoff/);
  assert.match(owner, /Ordinary edits\/reports are silent without an explicit status subscription/);
  assert.doesNotMatch(owner, /only two cross-session notices|there are no reminders or service final notifications/);
  assert.match(owner, /`task_assign` sends the first assigned reference itself; do not send a duplicate/);
  assert.match(owner, /task_read\(view=list, owner=<your session ID>\)/);
  assert.match(owner, /view=overview/);
  for (const field of ['id', 'title', 'executor', 'status', 'activity', 'at', 'revision',
    'acknowledged_revision', 'outcome.available', 'outcome.current']) {
    assert.ok(owner.includes(`\`${field}\``), `Owner needs an explicit default focus on ${field}`);
  }
  assert.match(owner, /Read `definition` before editing requirements and `outcomes` when judging delivery/);
  assert.match(owner, /scan chats routinely or schedule monitoring/);

  const executor = prose(readFileSync(join(root, skillDirectory('executor'), 'SKILL.md'), 'utf8'));
  assert.match(executor, /task_read\(view=execution\)/);
  assert.match(executor, /At start, on resumption, between stages, before consequential actions and before delivery, read the latest Task/);
  assert.match(executor, /Inspect `definition_check` on every Task response, including errors and replays/);
  assert.match(executor, /later ACKs do not confirm skipped revisions/);
  assert.match(executor, /complete updated Task definition with reason\/source and the decision superseded/);
  assert.match(executor, /report `done` with a new outcome in the same request/);
  assert.match(executor, /not as a mandatory Owner acceptance gate/);
  assert.match(executor, /Do not send Owner questions, confirmations, progress, blockers or completion messages, directly or via subagents/);
});

test('explicit one-shot subscriptions preserve silent defaults, role boundaries and uncertain delivery guidance', () => {
  const owner = prose(readFileSync(join(root, skillDirectory('owner'), 'SKILL.md'), 'utf8'));
  assert.match(owner, /Owner may explicitly subscribe to specified Task states/);
  assert.match(owner, /first real matching transition ends the subscription/);
  assert.match(owner, /already matching at registration means failure, not an immediate notice/);
  assert.match(owner, /read the latest Task and reassess the planned follow-up/);
  assert.match(owner, /card is not proof of complete delivery or an Executor definition-ACK instruction/);
  assert.match(owner, /Do not automatically resubscribe, poll or hold this turn open waiting/);
  const ownerPrompt = prose(readFileSync(join(root, 'roles/task-owner.md'), 'utf8'));
  assert.match(ownerPrompt, /explicit one-shot status subscription permits a system notice to Task's Owner/);
  assert.match(ownerPrompt, /Read the latest Task on receipt; do not automatically resubscribe/);
  const executor = prose(readFileSync(join(root, skillDirectory('executor'), 'SKILL.md'), 'utf8'));
  assert.match(executor, /Only the system sends that one-shot notice/);
  assert.match(executor, /no subscription capability or permission to notify Owner/);
  assert.match(executor, /not an instruction to execute or ACK a notification/);
  const executorPrompt = prose(readFileSync(join(root, 'roles/task-executor.md'), 'utf8'));
  assert.match(executorPrompt, /only a system notice, not Executor messages, subscription capability or a notification ACK/);
  for (const role of ['owner', 'executor']) {
    const reference = name => prose(readFileSync(join(root, skillDirectory(role), 'references', name), 'utf8'));
    const writes = reference('task-writes-and-recovery.md');
    for (const name of ['task_subscribe', 'task_unsubscribe', 'task_read(view=subscriptions)']) {
      assert.ok(writes.includes(`\`${name}\``), `Missing subscription interface ${name}`);
    }
    assert.match(writes, /At most one subscription may be waiting per Task/);
    assert.match(writes, /recipient is derived from Task's `owner`, not an arbitrary addressee or the reported actor/);
    assert.match(writes, /no subscription capability to Executor/);
    assert.match(writes, /Only a real transition.*first match, after which the subscription ends/);
    assert.match(writes, /does not listen to activity, definition changes or native busy\/idle state/);
    assert.match(writes, /already has a selected status at registration, registration fails/);
    assert.match(writes, /no subscription is created and no notice sent/);
    assert.match(writes, /does not keep the subscribing turn suspended; host enqueue queues it when busy without interrupting/);
    assert.match(writes, /do not clear queues, interrupt work or request a notification ACK/);
    assert.match(writes, /Queued or accepted does not mean read/);
    assert.match(writes, /do not claim exactly-once delivery/);
    assert.match(writes, /unknown send does not authorize a blind resend, replacement Task or another subscription/);
    assert.match(writes, /neither restores default progress\/final notifications nor permits Executor-to-Owner messages/);
    assert.match(writes, /Unsubscribe cancels only a waiting subscription; it cannot retract a triggered notification/);
    assert.match(writes, /terminal status outside the selected targets, the waiting subscription expires without notification/);
    assert.match(writes, /original `result`, including `subscription_ids`, is retained alongside `notifications` and an independent `notification_error`/);
    assert.match(writes, /notification failure can set MCP `isError=true` while `error` remains null/);
    assert.match(writes, /saved Task status and outcome are not rolled back/);
    assert.match(writes, /Do not repeat a saved report, redo delivery or manually send a replacement notice to Owner because notification failed/);
    const reading = reference('reading-tasks.md');
    assert.match(reading, /`subscriptions` with `task_id`/);
    assert.match(reading, /do not poll while waiting/);
    const links = reference('task-links.md');
    assert.ok(links.includes('[Task status updated](task:<uuid>?event=status_changed)'));
    assert.match(links, /System notice to Task's Owner after an explicit status subscription matches/);
    assert.match(links, /not an Executor instruction or a request to ACK a notification/);
    assert.match(links, /distinct from `updated`, which asks Executor to read and ACK the current definition/);
    assert.match(links, /Only lowercase `assigned`, `updated` and `status_changed`/);
    assert.match(links, /A link alone neither creates a subscription nor authorizes editing or scheduling/);
  }
  const handoff = prose(readFileSync(join(root, skillDirectory('owner'), 'references/important-updates.md'), 'utf8'));
  assert.match(handoff, /`status_changed` subscription notice to Owner is separate/);
  assert.match(handoff, /does not trigger this Executor-directed `updated` handoff or queue intervention/);
});

test('subscription guidance requires necessary Owner follow-up without gating Executor work', () => {
  const owner = prose(readFileSync(join(root, skillDirectory('owner'), 'SKILL.md'), 'utf8'));
  assert.match(owner, /Default to no subscription/);
  assert.match(owner, /identify the concrete, necessary Owner action that a future Task state enables/);
  assert.match(owner, /Merely knowing progress or confirming completion is not a reason to subscribe/);
  assert.match(owner, /Judge the need yourself; the user need not explicitly request a subscription/);
  assert.match(owner, /Do not invent follow-up work, split a complete outcome or add an approval gate/);
  assert.match(owner, /Choose the fewest target states that enable it/);
  assert.match(owner, /withdraw a still-waiting subscription if the follow-up is no longer needed/);
  assert.match(owner, /act only if it is still needed and authorized/);
  const ownerPrompt = prose(readFileSync(join(root, 'roles/task-owner.md'), 'utf8'));
  assert.match(ownerPrompt, /Default to no subscription; register only for necessary Owner follow-up, not progress tracking/);
  const executor = prose(readFileSync(join(root, skillDirectory('executor'), 'SKILL.md'), 'utf8'));
  assert.match(executor, /Do not wait for Owner to subscribe or read a notice before continuing authorized work or delivering it/);
  const executorPrompt = prose(readFileSync(join(root, 'roles/task-executor.md'), 'utf8'));
  assert.match(executorPrompt, /Execution does not depend on Owner subscribing or reading a notice/);
  for (const role of ['owner', 'executor']) {
    const writes = prose(readFileSync(join(root, skillDirectory(role), 'references/task-writes-and-recovery.md'), 'utf8'));
    assert.match(writes, /Default to no subscription/);
    assert.match(writes, /concrete, necessary Owner follow-up, not simply to track progress or know completion/);
    assert.match(writes, /standalone delivery with no Owner action needs no wait/);
    assert.match(writes, /Owner judges this need without asking the user to name or approve the subscription/);
    assert.match(writes, /If that action is no longer needed, withdraw the still-waiting subscription/);
    assert.match(writes, /Executor's authorized work never waits for Owner to subscribe or read a notice/);
  }
});

test('public documentation links resolve to active resources rather than retired content', () => {
  const files = ['README.md', ...readdirSync(join(root, 'docs')).filter(file => file.endsWith('.md')).map(file => `docs/${file}`)];
  for (const file of files) {
    const path = join(root, file);
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /#exceptional-update-handoff|skills\/(?:task-owner|task-executor)\//);
    for (const link of localLinks(source)) {
      const target = resolve(dirname(path), decodeURIComponent(link.split(/[?#]/)[0]));
      assert.ok(target.startsWith(root), `${file}: ${link} escapes the repository`);
      assert.ok(existsSync(target), `${file}: missing local reference ${link}`);
    }
  }
});

test('module packaging carries both isolated Skills and no draft or evaluation resources', t => {
  const packaged = spawnSync('npm', ['run', 'package:module'], { cwd: root, encoding: 'utf8' });
  assert.equal(packaged.status, 0, packaged.error?.message ?? `${packaged.stdout}\n${packaged.stderr}`);
  const manifest = JSON.parse(readFileSync(join(root, 'cockpit.module.json'), 'utf8'));
  const archive = join(root, 'dist', `cockpit-task-${manifest.version}.tgz`);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  const expected = ['owner', 'executor']
    .flatMap(role => skillFiles(role).map(file => `./${skillDirectory(role)}/${file}`)).sort();
  assert.deepEqual(entries.filter(entry => entry.startsWith('./skills/') && !entry.endsWith('/')).sort(), expected);
  assert.ok(!entries.some(entry => /^\.\/docs\//.test(entry)), 'No design, evaluation or private coordination docs');
  const topLevel = [...new Set(entries.filter(entry => entry !== './').map(entry => entry.split('/')[1]))].sort();
  assert.deepEqual(topLevel, ['README.md', 'cockpit.module.json', 'node_modules', 'package.json', 'roles', 'skills', 'src', 'web']);
  for (const entry of entries.filter(entry => /^\.\/(?:src|web)\//.test(entry) && !entry.endsWith('/'))) {
    assert.match(entry, /^\.\/(?:src|web)\/task-board\//, `Only current module source is packaged: ${entry}`);
  }
  const packagedMetadata = JSON.parse(execFileSync('tar', ['-xOf', archive, './package.json'], { encoding: 'utf8' }));
  assert.equal(packagedMetadata.name, manifest.id);
  assert.equal(packagedMetadata.version, manifest.version);
  for (const entry of expected) {
    assert.equal(execFileSync('tar', ['-xOf', archive, entry], { encoding: 'utf8' }),
      readFileSync(join(root, entry), 'utf8'), `Archive must contain the current resource: ${entry}`);
  }
  const readme = execFileSync('tar', ['-xOf', archive, './README.md'], { encoding: 'utf8' });
  assert.doesNotMatch(readme, /#exceptional-update-handoff/);
  for (const link of localLinks(readme)) {
    assert.ok(entries.includes(`./${link.split('#')[0]}`), `Packaged README link: ${link}`);
  }
  t.diagnostic(`npm run package:module produced ${archive} with both bodies and seven runtime references`);
});

test('unquoted mapping separators in either role description fail release validation', () => {
  for (const role of ['owner', 'executor']) {
    const description = `Cockpit Task ${role} role: explicit authorized work.`;
    const source = `---\nname: cockpit-task-${role}\ndescription: ${description}\n---\n`;
    assert.throws(() => skillMetadata(source), /JSON-quoted description/);
    assert.deepEqual(skillMetadata(source.replace(`description: ${description}`, `description: ${JSON.stringify(description)}`)),
      { name: `cockpit-task-${role}`, description });
  }
  assert.throws(() => skillMetadata('---\nname: cockpit-task-owner\ndescription: "invalid \\q escape"\n---\n'), SyntaxError);
});
