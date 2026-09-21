import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  const root = fileURLToPath(new URL('../', import.meta.url));
  const delivery = JSON.parse(readFileSync(join(root, 'service-delivery.json'), 'utf8'));
  assert.equal(delivery.build.artifactPaths.includes('skills'), false);
  assert.equal(delivery.build.artifactPaths.some(path => path === 'docs' || path.startsWith('docs/legacy-skills')), false);
  assert.ok(delivery.build.artifactPaths.includes('roles/commander.md'));
  assert.ok(delivery.build.artifactPaths.includes('roles/owner.md'));
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
  const archives = readdirSync(join(root, 'docs/legacy-skills'));
  assert.deepEqual(archives.sort(), ['cockpit-task-commander.md', 'cockpit-task-owner.md', 'work-commander-owner.md', 'work-commander.md']);
  for (const path of archives) assert.ok(!readFileSync(join(root, 'docs/legacy-skills', path), 'utf8').startsWith('---'));
  for (const path of ['src/work.js', 'roles/commander.md', 'roles/owner.md']) {
    assert.doesNotMatch(readFileSync(join(root, path), 'utf8'), /legacy-skills|Use skill |skills\/session-toggle/);
  }
  const installer = readFileSync(join(root, 'scripts/install.sh'), 'utf8');
  assert.match(installer, /--exclude='docs\/legacy-skills'/);
  assert.match(installer, /--exclude='skills'/);
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
  assert.match(owner, /read the latest Task and assess any follow-up/);
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

test('public Skill links resolve to active resources rather than obsolete handoff anchors', () => {
  for (const file of ['task-board.md', 'task-tools-skills.md', 'task-mcp-contract.md',
    'task-host-contract.md', 'task-implementation.md', 'task-design.md', 'task-schema.md']) {
    const source = readFileSync(join(root, 'docs', file), 'utf8');
    assert.doesNotMatch(source, /#exceptional-update-handoff|skills\/(?:task-owner|task-executor)\//);
    for (const link of localLinks(source).filter(link => link.startsWith('../skills/'))) {
      assert.ok(existsSync(resolve(root, 'docs', link.split('#')[0])), `${file}: ${link}`);
    }
  }
  for (const role of ['owner', 'executor']) {
    const source = readFileSync(join(root, `docs/skill-drafts/task-${role}.md`), 'utf8');
    assert.ok(!source.startsWith('---'), 'Historical pointers must not be discoverable Skills');
    assert.match(source, /historical design entry/);
    assert.ok(localLinks(source).includes(`../../${skillDirectory(role)}/SKILL.md`));
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

test('legacy explicit registration installs only its MCP and preserves unrelated resources', t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const home = mkdtempSync(join(root, '.legacy-registration-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const configRoot = join(home, '.copilot');
  mkdirSync(configRoot);
  const unrelated = { type: 'http', url: 'http://example.invalid/mcp', tools: ['read'] };
  writeFileSync(join(configRoot, 'mcp-config.json'), JSON.stringify({ mcpServers: { unrelated } }));
  const registration = spawnSync(process.execPath, [join(root, 'scripts/register.js'), root, '--confirm'], {
    cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8',
  });
  assert.equal(registration.status, 0, registration.stderr);
  const registered = JSON.parse(readFileSync(join(configRoot, 'mcp-config.json'), 'utf8'));
  assert.deepEqual(registered.mcpServers.unrelated, unrelated);
  assert.deepEqual(Object.keys(registered.mcpServers).sort(), ['unrelated', 'work-commander']);
  assert.deepEqual(registered.mcpServers['work-commander'].args, [join(root, 'src/mcp.js')]);
  assert.equal(existsSync(join(configRoot, 'skills')), false);
  assert.match(registration.stdout, /retired Skills are not installed/);
});

test('unquoted mapping separators in either role description fail release validation', () => {
  for (const role of ['commander', 'owner']) {
    const description = `Cockpit Task ${role} role: explicit authorized work.`;
    const source = `---\nname: cockpit-task-${role}\ndescription: ${description}\n---\n`;
    assert.throws(() => skillMetadata(source), /JSON-quoted description/);
    assert.deepEqual(skillMetadata(source.replace(`description: ${description}`, `description: ${JSON.stringify(description)}`)),
      { name: `cockpit-task-${role}`, description });
  }
  assert.throws(() => skillMetadata('---\nname: cockpit-task-owner\ndescription: "invalid \\q escape"\n---\n'), SyntaxError);
});
