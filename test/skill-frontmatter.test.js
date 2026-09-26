import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASK_EVENTS } from '../src/task-board/reference.js';
import { formatQuotaReport, markdownBody, readMarkdownQuotas } from '../scripts/prompt-quotas.js';

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
const treeDirectory = 'skills/cockpit-task-tree/cockpit-task-tree';
const codingDirectory = 'skills/github-coding/github-coding';
const treeFiles = ['SKILL.md', 'references/automation.md'].sort();
const deletedReferences = [
  'own-task.md', 'subtasks.md', 'important-updates.md', 'reading-tasks.md',
  'task-links.md', 'task-writes-and-recovery.md',
];
const read = (...path) => readFileSync(join(root, ...path), 'utf8');
const prose = source => markdownBody(source, true).replace(/\s+/g, ' ');
const localLinks = source => [...source.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)]
  .map(([, target]) => target)
  .filter(target => !/^(?:[a-z][a-z\d+.-]*:|#|task:)/i.test(target));

function assertSkillClosure(directory, expected) {
  const directories = [...new Set(expected.map(file => dirname(file)).filter(path => path !== '.'))];
  assert.deepEqual(readdirSync(directory, { recursive: true }).sort(),
    [...expected, ...directories].sort(), 'Only the Skill body and runtime references belong in a Skill');
  const pending = ['SKILL.md'];
  const visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const path = join(directory, file);
    assert.ok(lstatSync(path).isFile(), `${file} must be a regular file`);
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

function tableRows(source, heading) {
  const section = source.split(`## ${heading}`)[1]?.split('\n## ')[0];
  assert.ok(section, `Missing section ${heading}`);
  return section.split('\n')
    .filter(line => /^\|.*\|$/.test(line) && !/^\|\s*-/.test(line))
    .slice(1)
    .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
}

function regexInOrder(source, patterns) {
  let at = 0;
  for (const pattern of patterns) {
    const match = pattern.exec(source.slice(at));
    assert.ok(match, `Missing ordered pattern: ${pattern}`);
    at += match.index + match[0].length;
  }
}

function assertSectionContains(source, title, patterns) {
  const match = new RegExp(`\\*\\*${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\*\\*([\\s\\S]*?)(?=\\n\\*\\*R\\d|\\n## )`).exec(source);
  assert.ok(match, `Missing rule heading ${title}`);
  const text = prose(match[1]);
  for (const pattern of patterns) assert.match(text, pattern, `${title}: ${pattern}`);
}

function assertNoDirectAgentMessaging(source, label) {
  assert.doesNotMatch(source, /cockpit_send_prompt|notify_assignee|write_agent/, label);
  assert.doesNotMatch(prose(source), /\b(?:send|message) the (?:assignee|orchestrator)\b/i, label);
}

test('one Task tree Skill and one shared coding Skill have unique YAML-safe metadata', () => {
  const files = readdirSync(join(root, 'skills'), { recursive: true })
    .filter(path => basename(path) === 'SKILL.md');
  assert.equal(files.length, 2);
  const names = new Set();
  for (const path of files) {
    const metadata = skillMetadata(read('skills', path));
    assert.equal(metadata.name, basename(join(path, '..')), path);
    assert.ok(!names.has(metadata.name), `Duplicate skill name: ${metadata.name}`);
    names.add(metadata.name);
  }
  assert.deepEqual([...names].sort(), ['cockpit-task-tree', 'github-coding']);
});

test('repository entrypoints describe the current Task module', () => {
  const manifest = JSON.parse(read('cockpit.module.json'));
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.name, manifest.id);
  assert.equal(pkg.version, manifest.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.deepEqual(Object.keys(pkg.scripts).sort(), ['package:module', 'quotas', 'test']);
  assert.deepEqual(readdirSync(join(root, 'src')), ['task-board']);
  assert.deepEqual(readdirSync(join(root, 'web')), ['task-board']);
  assert.deepEqual(readdirSync(join(root, 'roles')).sort(), ['task-node.md']);
  assert.deepEqual(readdirSync(join(root, 'scripts')), ['check-release.js', 'migrate-task-v10.js', 'migrate-task-v11.js', 'package-task-board.js', 'prompt-quotas.js', 'quotas.js', 'release-state.js', 'release-write.js', 'verify-package.js']);
  assert.deepEqual(readdirSync(join(root, '.github/workflows')).sort(), ['release.yml', 'task-board-ci.yml']);
  assert.deepEqual(manifest.roles.map(role => role.id), ['node']);
  assert.deepEqual(manifest.roles[0].skillDirectories.sort(), ['skills/cockpit-task-tree', 'skills/github-coding']);
});

test('each current Skill has an independent relative reference closure', () => {
  assertSkillClosure(join(root, treeDirectory), treeFiles);
  assertSkillClosure(join(root, codingDirectory), ['SKILL.md']);
  assert.equal(skillMetadata(read(treeDirectory, 'SKILL.md')).name, 'cockpit-task-tree');
  assert.equal(skillMetadata(read(codingDirectory, 'SKILL.md')).name, 'github-coding');
});

test('Task tree Skill states the core idea and rules R1-R6 in order', () => {
  const skill = read(treeDirectory, 'SKILL.md');
  const normalized = prose(skill);
  assert.match(normalized, /Task is the only channel between formal Task nodes/);
  assert.match(normalized, /Every session is a node/);
  assert.match(normalized, /service sends every notice/);
  assert.match(normalized, /Decisions come from the user/);
  regexInOrder(skill, [
    /\*\*R1 Coordinate Task nodes through Task\.\*\*/,
    /\*\*R2 Do your Task by the current agreement\.\*\*/,
    /\*\*R3 Choose how to do the work\.\*\*/,
    /\*\*R4 Report work outside your Task upward\.\*\*/,
    /\*\*R5 Authorization comes from the user\.\*\*/,
    /\*\*R6 Act on Task facts; when unsure, read first\.\*\*/,
  ]);
  assertSectionContains(skill, 'R1 Coordinate Task nodes through Task', [
    /Do not message another Task node, even with a Task link or through a helper/,
    /description to work-specific goals, decisions, boundaries and completion requirements/,
    /Reference external material instead of copying common knowledge, existing rules, procedures, unnecessary implementation detail or history/,
    /important changes in activity.*actual delivery, remaining work and evidence links in the outcome/,
    /Do not ask a question someone is already asking/,
    /Keep secrets out of Tasks/,
  ]);
  assertSectionContains(skill, 'R2 Do your Task by the current agreement', [
    /Before starting, resuming, taking a consequential action and delivering/,
    /read the full current Task.*ACK its exact revision/,
    /github-coding.*changing repository files/,
    /revise your own Task/,
    /notice or ready prerequisite is not permission to resume work the user paused/,
    /Report status truthfully/,
    /delivery state is not live session or tool activity/,
    /Mark done with a new outcome.*retro.*null/,
  ]);
  assertSectionContains(skill, 'R3 Choose how to do the work', [
    /Work directly when the relevant context is already in hand/,
    /internal subagents for parallel work, context separation or independent judgment/,
    /integrate their results yourself/,
    /Independent review need not create a Task or session/,
    /independent owner to keep it moving, deliver separately or coordinate dependencies/,
    /work-specific requirements and references.*do not take over assigned work/,
    /not a fixed priority or per-use approval gate/,
    /suitable existing or new session.*neither new sessions nor fewer Tasks are goals/,
    /check all unfinished Tasks.*conflicting work/,
    /blocked_by/,
    /revise, reorder or cancel obsolete Subtasks/,
    /Verify each result/,
    /fold Subtask retros into your own before completing your Task/,
  ]);
  assertSectionContains(skill, 'R4 Report work outside your Task upward', [/\{condition\}.*state what is missing/, /put it in your outcome/, /reports it upward/]);
  assertSectionContains(skill, 'R5 Authorization comes from the user', [/Discussion, research and records do not authorize/, /Choosing a helper or Task does not widen authorization or transfer an existing assignment/, /explicit consent/]);
  assertSectionContains(skill, 'R6 Act on Task facts; when unsure, read first', [/read the Task or operation/, /safe recovery/, /Read only what the current decision needs/, /Never poll/, /Subscribe only when a future status unlocks/]);
});

test('relations table matches source authorization checks', () => {
  const rows = tableRows(read(treeDirectory, 'SKILL.md'), 'Relations');
  const mapping = Object.fromEntries(rows.filter(row => row[0] !== 'Anyone').map(([relation, tools]) => [
    relation.toLowerCase()
      .replace(/^only the /, '')
      .replace(/ or /, '-or-')
      .replace(/^orchestrator-or-assignee$/, 'orchestrator-or-assignee'),
    [...tools.matchAll(/`([^`]+)`/g)].map(([, tool]) => tool),
  ]));
  assert.deepEqual(mapping, {
    assignee: ['task_ack', 'task_report'],
    'orchestrator-or-assignee': ['task_edit', 'task_cancel', 'task_reopen'],
    orchestrator: ['task_assign', 'task_automation_start', 'task_automation_reconcile'],
  });

  const store = read('src/task-board/store.js');
  const automation = read('src/task-board/automation-store.js');
  const sourceChecks = {
    task_assign: /bindAssignment\([\s\S]*?authorize\(row, input\.actor, \['orchestrator'\]\)/,
    task_edit: /edit\(input\) \{[\s\S]*?authorize\(row, input\.actor, \['orchestrator', 'assignee'\]\)/,
    task_reopen: /reopenCandidate\(input\) \{[\s\S]*?authorize\(row, input\.actor, \['orchestrator', 'assignee'\]\)/,
    task_ack: /ack\(input\) \{[\s\S]*?authorize\(row, input\.actor, \['assignee'\]\)/,
    task_report: /report\(input\) \{[\s\S]*?authorize\(row, input\.actor, \['assignee'\]\)/,
    task_cancel: /cancel\(input\) \{[\s\S]*?authorize\(row, input\.actor, \['orchestrator', 'assignee'\]\)/,
  };
  for (const [tool, pattern] of Object.entries(sourceChecks)) assert.match(store, pattern, tool);
  assert.match(automation, /start\(input\) \{[\s\S]*?authorize\(task, input\.actor, \['orchestrator'\]\)/, 'task_automation_start');
  assert.match(automation, /reconcile\(input, groupAlive\) \{[\s\S]*?authorize\(task, input\.actor, \['orchestrator'\]\)/, 'task_automation_reconcile');
  const authorizedTools = new Set([...store.matchAll(/authorize\([^\n]+/g), ...automation.matchAll(/authorize\([^\n]+/g)]
    .map(match => match[0]).length ? Object.values(mapping).flat() : []);
  assert.deepEqual([...authorizedTools].sort(), Object.values(mapping).flat().sort());
});

test('notices table matches TASK_EVENTS and assignee card scope', () => {
  const rows = tableRows(read(treeDirectory, 'SKILL.md'), 'Notices');
  const labels = rows.flatMap(([cards]) => [...cards.matchAll(/`\[([^\]]+)\]`/g)].map(([, label]) => label));
  assert.deepEqual(labels.sort(), Object.values(TASK_EVENTS).sort());
  const assigneeLabels = rows
    .filter(([, receivedBy]) => /^assignee/.test(receivedBy))
    .flatMap(([cards]) => [...cards.matchAll(/`\[([^\]]+)\]`/g)].map(([, label]) => label));
  assert.deepEqual(assigneeLabels.sort(), ['Task assigned', 'Task cancelled', 'Task updated']);
});

test('ready, legacy blocked and rework guidance routes actions through the shared rules', () => {
  const skill = prose(read(treeDirectory, 'SKILL.md'));
  const situations = skill.split('**F5 Dependency/Subtask cards.**')[1].split('**F6')[0];
  assert.match(situations, /orchestrator reads current facts and dispatches an unassigned Task when authorized/);
  assert.match(situations, /assigned Task, its assignee reads\/ACKs the latest agreement and continues permitted work/);
  assert.match(situations, /legacy `Subtask blocked`: read current requirements and blocking evidence/);
  assert.match(situations, /automation, also inspect run facts and any barrier/);
  const rework = skill.split('**F6 Cancel or reopen.**')[1].split('**F7')[0];
  assert.match(rework, /With the user's consent/);
  assert.match(rework, /Reopening does not revive resolved dependencies/);
  assert.match(rework, /Handle newly discovered gaps through R4/);
  assert.match(prose(read(treeDirectory, 'references/automation.md')),
    /`done` unless explicitly cancelled; neither status proves success or process-group exit/);
});

test('basic situations F1-F7 and service guarantees preserve the core contract', () => {
  const skill = read(treeDirectory, 'SKILL.md');
  regexInOrder(skill, ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7'].map(id => new RegExp(`\\*\\*${id} `)));
  const guarantees = prose(skill.split('## Service guarantees')[1]);
  for (const requirement of [
    /Rejected changes/, /service rejects/, /inspect actual effects under R6/,
    /Idempotent writes/, /request_id/, /write_context/,
    /every notice above is sent by the service/, /never retried/, /never clear or rewrite queued session messages/,
    /definition_check/,
  ]) assert.match(guarantees, requirement);
  assert.doesNotMatch(guarantees, /saving nothing/);
});

test('guidance forbids manual Task notices and deleted references stay removed from Skills and roles', () => {
  for (const file of [join(root, treeDirectory, 'SKILL.md'), join(root, treeDirectory, 'references/automation.md'), join(root, 'roles/task-node.md')]) {
    assertNoDirectAgentMessaging(readFileSync(file, 'utf8'), file);
  }
  const roots = [join(root, 'skills'), join(root, 'roles')];
  for (const base of roots) {
    for (const entry of readdirSync(base, { recursive: true })) {
      const path = join(base, entry);
      if (!lstatSync(path).isFile()) continue;
      const source = readFileSync(path, 'utf8');
      for (const deleted of deletedReferences) assert.doesNotMatch(source, new RegExp(deleted.replace('.', '\\.')), `${entry}: ${deleted}`);
    }
  }
});

test('role prompt and compact Skill texts respect character quotas and point to cockpit-task-tree', () => {
  const role = read('roles/task-node.md');
  const usages = readMarkdownQuotas(root);
  assert.ok(usages.every(usage => !usage.exceeded), formatQuotaReport(usages));
  assert.match(role, /Load `cockpit-task-tree` when first needed/);
  assert.match(role, /Task is the only channel between formal Task nodes/);
  assert.match(role, /ACK its exact revision/);
});

test('automation reference keeps trusted-script boundaries', () => {
  const automation = prose(read(treeDirectory, 'references/automation.md'));
  for (const requirement of [
    /Agent work stays the default/,
    /existing, reviewed, trusted and repeatable script within the user's authorization/,
    /registration never authorizes running it/,
    /never create a script, command template or workflow to bypass Agent delivery/,
    /Automation needs a Linux \(or WSL2\) host/,
    /use Agent work under R3 without changing existing authorization or responsibility/,
    /no assignee: never assign, ACK or report it/,
    /subscribe before `task_automation_start`/,
    /replaying the same request never reruns it/,
    /Do not poll/,
    /cancellation requests termination but proves neither exit nor rollback/,
    /Review its possible effects before `task_automation_reconcile`/,
    /same-user trust boundary, not a sandbox/,
    /must not daemonize, detach or escape/,
  ]) assert.match(automation, requirement);
  assert.doesNotMatch(automation, /elsewhere use an Agent Task|use an Agent Task or ask the user/);
});

test('current coding exercises use R3 rather than requiring delegation for ordinary work', () => {
  const source = read('docs/task-lifecycle-testing.md');
  const rows = source.split('\n');
  for (const id of ['G1', 'G4']) {
    const row = rows.find(line => line.startsWith(`| ${id}:`));
    assert.ok(row, `${id} remains a current exercise`);
    assert.match(row, /under R3/);
    assert.match(row, /implementing node/);
    assert.doesNotMatch(row, /creates the assignee|no personal implementation|delegates to one capable assignee/);
  }
  assert.match(rows.find(line => line.startsWith('| G1:')), /If delegated.*eligible existing or new session/);
});

test('fixed notice labels contain no pronouns or role prefixes', () => {
  for (const text of Object.values(TASK_EVENTS)) {
    assert.doesNotMatch(text, /\b(?:you|your)\b/i);
    assert.doesNotMatch(text, /\b(?:As Owner|As Executor|Owner:|Executor:)\b/i);
  }
});

test('github-coding guidance still composes with Task coordination without widening authority', () => {
  const coding = prose(read(codingDirectory, 'SKILL.md'));
  const role = prose(read('roles/task-node.md'));
  const metadata = skillMetadata(read(codingDirectory, 'SKILL.md'));
  assert.match(metadata.description, /authorized work requires changing version-controlled repository files/);
  assert.match(metadata.description, /implementing node reuses or creates the Issue, creates its own branch and worktree/);
  assert.match(metadata.description, /Choose collaboration through cockpit-task-tree/);
  assert.match(coding, /This is a work Skill, not a Task role or authority to change scope/);
  assert.match(coding, /Task guidance still governs assignment, current-definition reads\/ACK, reporting and communication/);
  assert.match(coding, /implementing node is the assignee for delegated work, otherwise the current node/);
  assert.match(coding, /Independent review may use an internal helper; it does not require a separate Task or session/);
  assert.match(coding, /reference project instructions, methods and prior evidence instead of copying them/);
  assert.match(coding, /Questions and idea exploration do not require an Issue, Task or worktree/);
  assert.match(coding, /investigation-only, patch-only or PR-only authorization stops at that boundary/);
  assert.match(coding, /The orchestrator does not prepare or clean up branches or worktrees/);
  assert.match(coding, /Treat it as read-only: fetching is fine, but never edit, switch, pull into, reset or stash it/);
  assert.match(coding, /create a dedicated branch and isolated worktree from freshly fetched remote mainline/);
  assert.match(coding, /ask the user directly before editing, not the orchestrator/);
  assert.match(coding, /Do not manually message the orchestrator, directly or through subagents/);
  assert.match(coding, /Task done means the complete agreed result/);
  assert.match(coding, /not code merge alone, resource cleanup or an idle native session/);
  assert.match(coding, /default to reusing the retained worktree and branch when they still exist, even after its previous PR merged/);
  assert.match(coding, /If your worktree was already removed after merge, create a fresh branch and worktree from freshly fetched mainline/);
  assert.match(role, /Load `cockpit-task-tree` when first needed/);
  assert.doesNotMatch(coding, /Owner|Executor|orchestrator prepares|orchestrator safely cleans/);
});

test('role and active documentation preserve helper responsibility without forcing delegation or copied context', () => {
  const role = prose(read('roles/task-node.md'));
  assert.match(role, /Choose direct work, internal subagents or Task delegation/);
  assert.match(role, /integrate helper and Subtask results.*helper does not take over responsibility/);
  assert.match(role, /Keep Task records work-specific/);
  assert.match(role, /external material referenced rather than copied/);
  assert.match(role, /without repeating a question another node is asking/);
  const skill = prose(read(treeDirectory, 'SKILL.md'));
  assert.match(skill, /Internal subagents are helpers whose results you integrate/);
  const rootCase = skill.split('**F1 The root receives a request.**')[1].split('**F2')[0];
  assert.match(rootCase, /choose how to do it.*For Task delegation/);
  assert.match(rootCase, /capable existing or new node.*assignee owns delivery/);
  for (const file of [
    'README.md', 'docs/task-tools-skills.md', 'docs/task-design.md', 'docs/task-board.md',
    'docs/task-schema.md', 'docs/task-mcp-contract.md',
  ]) {
    const source = prose(read(file));
    assert.doesNotMatch(source, /默认委派|delegates implementation and state-changing delivery by default|default delegation responsibility/, file);
    assert.doesNotMatch(source, /agent 不给其他 agent 发消息|Never send anything to another agent/, file);
    assert.match(source, /work-specific|本项工作.*(?:特有|目标)/, file);
  }
  const cases = read('docs/task-lifecycle-testing.md').split('## Tree-node cases T1-T22')[1].split('### Recorded')[0];
  assert.doesNotMatch(cases, /copied verbatim|assigns it to a new node/);
});

test('worktree initialization stays project-specific rather than adding package-manager rules to the Skill', () => {
  const coding = prose(read(codingDirectory, 'SKILL.md'));
  assert.match(coding, /New checkouts do not inherit untracked or ignored local environment files/);
  assert.match(coding, /Follow the project guide to prepare the environment needed for the current work/);
  assert.match(coding, /another worktree being runnable does not establish that this one is ready/);
  assert.doesNotMatch(coding, /\b(?:npm|pnpm|node_modules|registry)\b/);

  const contributing = read('CONTRIBUTING.md');
  const setupLink = localLinks(contributing).find(link => link.startsWith('README.md#'));
  assert.ok(setupLink, 'CONTRIBUTING links the authoritative README initialization section');
  const readme = read('README.md');
  assert.ok(readme.includes(`## ${decodeURIComponent(setupLink.split('#')[1])}`));
  assert.match(contributing, /npm run quotas/);
  for (const requirement of [
    /npm ci --ignore-scripts --no-audit --no-fund/,
    /Each worktree needs its own `node_modules`/,
    /npm's own cache/,
    /Do not copy production dependencies or credentials, or symlink another worktree's entire `node_modules`/,
    /Documentation-only edits do not require dependency installation/,
    /a ready environment should not be reinstalled unconditionally/,
  ]) assert.match(prose(readme), requirement);
});

test('module packaging carries both Skills without evaluation resources', () => {
  const packaged = spawnSync('npm', ['run', 'package:module'], { cwd: root, encoding: 'utf8' });
  assert.equal(packaged.status, 0, packaged.error?.message ?? `${packaged.stdout}\n${packaged.stderr}`);
  const manifest = JSON.parse(read('cockpit.module.json'));
  const archive = join(root, 'dist', `cockpit-task-${manifest.version}.tgz`);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(entries.includes('./module-build.json'));
  const expectedSkills = [
    ...treeFiles.map(file => `./${treeDirectory}/${file}`),
    `./${codingDirectory}/SKILL.md`,
  ].sort();
  assert.deepEqual(entries.filter(entry => entry.startsWith('./skills/') && !entry.endsWith('/')).sort(), expectedSkills);
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  execFileSync(process.execPath, ['scripts/verify-package.js', archive, sourceSha], { cwd: root, stdio: 'pipe' });

  assert.ok(!entries.some(entry => /^\.\/(?:docs|test)\//.test(entry)), 'No docs, tests, design or evaluation payloads');
  const topLevel = [...new Set(entries.filter(entry => entry !== './').map(entry => entry.split('/')[1]))].sort();
  assert.deepEqual(topLevel, ['README.md', 'cockpit.module.json', 'module-build.json', 'node_modules', 'package.json', 'roles', 'scripts', 'skills', 'src', 'web']);
  assert.deepEqual(entries.filter(entry => entry.startsWith('./scripts/') && !entry.endsWith('/')), ['./scripts/migrate-task-v10.js', './scripts/migrate-task-v11.js']);
  assert.equal(execFileSync('tar', ['-xOf', archive, './scripts/migrate-task-v10.js'], { encoding: 'utf8' }), read('scripts/migrate-task-v10.js'));
  assert.equal(execFileSync('tar', ['-xOf', archive, './scripts/migrate-task-v11.js'], { encoding: 'utf8' }), read('scripts/migrate-task-v11.js'));
  assert.equal(execFileSync('tar', ['-xOf', archive, './src/task-board/tool-descriptions.js'], { encoding: 'utf8' }),
    read('src/task-board/tool-descriptions.js'));
  assert.equal(execFileSync('tar', ['-xOf', archive, './src/task-board/tool-names.js'], { encoding: 'utf8' }),
    read('src/task-board/tool-names.js'));
  const packagedManifest = JSON.parse(execFileSync('tar', ['-xOf', archive, './cockpit.module.json'], { encoding: 'utf8' }));
  assert.deepEqual(packagedManifest.roles.map(role => role.id), ['node']);
  assert.deepEqual(packagedManifest.roles[0].skillDirectories.sort(), ['skills/cockpit-task-tree', 'skills/github-coding']);
  for (const entry of expectedSkills) {
    assert.equal(execFileSync('tar', ['-xOf', archive, entry], { encoding: 'utf8' }),
      readFileSync(join(root, entry), 'utf8'), `Archive must contain the current resource: ${entry}`);
  }
});

test('release publishes only the checked archive after the draft gate', () => {
  const workflow = read('.github/workflows/release.yml');
  for (const text of ['uses: ./.github/workflows/task-board-ci.yml', 'actions: read', 'check-release.js',
    'release-write.js create', 'release-write.js upload', 'gh api --paginate --slurp', 'release-state.js select',
    "Accept: application/octet-stream", 'release-write.js publish']) {
    assert.ok(workflow.includes(text), text);
  }
  assert.ok(workflow.indexOf('Accept: application/octet-stream') < workflow.indexOf('release-write.js publish'));
  assert.doesNotMatch(workflow, /--clobber|gh release (?:download|edit)|npm run package:module|pull_request_target|secrets\./);
  for (const [, use] of workflow.matchAll(/uses:\s+([^\s]+)/g)) {
    if (!use.startsWith('./')) assert.match(use, /^[\w/-]+@[a-f0-9]{40}$/);
  }
});

test('public documentation links resolve to active resources rather than retired content', () => {
  const files = ['README.md', 'CONTRIBUTING.md', ...readdirSync(join(root, 'docs')).filter(file => file.endsWith('.md')).map(file => `docs/${file}`)];
  for (const file of files) {
    const path = join(root, file);
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /#exceptional-update-handoff|skills\/(?:task-owner|task-executor)\//);
    assert.doesNotMatch(source, /references\/(?:own-task|subtasks|important-updates|reading-tasks|task-links|task-writes-and-recovery)\.md/,
      `${file} links a deleted Skill reference`);
    assert.doesNotMatch(source, /notify_assignee|UPDATE_NOTICE_NOT_APPLICABLE/, `${file} documents the removed notice parameter`);
    for (const link of localLinks(source)) {
      const target = resolve(dirname(path), decodeURIComponent(link.split(/[?#]/)[0]));
      assert.ok(target.startsWith(root), `${file}: ${link} escapes the repository`);
      assert.ok(existsSync(target), `${file}: missing local reference ${link}`);
    }
  }
});

test('unquoted mapping separators in Skill descriptions fail release validation', () => {
  const description = 'Cockpit Task node role: explicit authorized work.';
  const source = `---\nname: cockpit-task-node\ndescription: ${description}\n---\n`;
  assert.throws(() => skillMetadata(source), /JSON-quoted description/);
  assert.deepEqual(skillMetadata(source.replace(`description: ${description}`, `description: ${JSON.stringify(description)}`)),
    { name: 'cockpit-task-node', description });
  assert.throws(() => skillMetadata('---\nname: cockpit-task-node\ndescription: "invalid \\q escape"\n---\n'), SyntaxError);
});
