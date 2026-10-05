import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASK_EVENTS } from '../src/task-board/reference.js';
import { TOOL_NAMES } from '../src/task-board/tool-names.js';
import { toolDescriptions } from '../src/task-board/tool-descriptions.js';
import { parseInput } from '../src/task-board/contracts.js';
import { formatQuotaReport, markdownBody, readMarkdownQuotas } from '../scripts/prompt-quotas.js';

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
const advisorDirectory = 'skills/cockpit-task-advisor/cockpit-task-advisor';
const treeFiles = ['SKILL.md', 'references/automation.md'].sort();
const read = (...path) => readFileSync(join(root, ...path), 'utf8');
const prose = source => markdownBody(source, true).replace(/\s+/g, ' ');
const localLinks = source => [...source.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)]
  .map(([, target]) => target)
  .filter(target => !/^(?:[a-z][a-z\d+.-]*:|#|task:)/i.test(target));

function assertSkillClosure(directory, expected) {
  const directories = [...new Set(expected.map(file => dirname(file)).filter(path => path !== '.'))];
  assert.deepEqual(readdirSync(directory, { recursive: true }).sort(), [...expected, ...directories].sort());
  const pending = ['SKILL.md'];
  const visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const path = join(directory, file);
    assert.ok(lstatSync(path).isFile(), `${file} must be a regular file`);
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /Candidate for|not active|Discussion draft|not an installed Skill|skill-drafts|evaluation\/|\/home\//);
    for (const link of localLinks(source)) {
      const target = resolve(dirname(path), decodeURIComponent(link.split(/[?#]/)[0]));
      assert.ok(target.startsWith(`${directory}${sep}`), `${file}: ${link} escapes Skill`);
      assert.ok(existsSync(target), `${file}: missing ${link}`);
      pending.push(relative(directory, target));
    }
  }
  assert.deepEqual([...visited].sort(), expected, 'Every runtime reference is reachable');
}

test('Skills have unique YAML-safe metadata and independent runtime closures', () => {
  const files = readdirSync(join(root, 'skills'), { recursive: true }).filter(path => basename(path) === 'SKILL.md');
  const names = files.map(path => {
    const metadata = skillMetadata(read('skills', path));
    assert.equal(metadata.name, basename(join(path, '..')));
    return metadata.name;
  });
  assert.deepEqual(names.sort(), ['cockpit-task-advisor', 'cockpit-task-tree', 'github-coding']);
  assertSkillClosure(join(root, treeDirectory), treeFiles);
  assertSkillClosure(join(root, codingDirectory), ['SKILL.md']);
  assertSkillClosure(join(root, advisorDirectory), ['SKILL.md']);
});

test('module entrypoints retain the Node role and both Skill discovery roots', () => {
  const manifest = JSON.parse(read('cockpit.module.json'));
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.name, manifest.id);
  assert.equal(pkg.version, '0.0.0-dev');
  assert.equal(pkg.version, manifest.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.deepEqual(Object.keys(pkg.scripts).sort(), ['package:module', 'quotas', 'test']);
  assert.deepEqual(readdirSync(join(root, 'src')), ['task-board']);
  assert.deepEqual(readdirSync(join(root, 'web')), ['task-board']);
  assert.deepEqual(readdirSync(join(root, 'roles')).sort(), ['task-advisor.md', 'task-node.md']);
  assert.deepEqual(manifest.roles.map(role => role.id), ['node', 'advisor']);
  assert.deepEqual(manifest.roles[0].skillDirectories.sort(), ['skills/cockpit-task-tree', 'skills/github-coding']);
  assert.deepEqual(readdirSync(join(root, 'scripts')).sort(), [
    'check-release.js', 'deployment-manifest.js', 'migrate-task-v10.js', 'migrate-task-v11.js',
    'migrate-task-v12.js', 'package-task-board.js', 'prompt-quotas.js', 'quotas.js',
    'release-state.js', 'release-write.js', 'rolling-release.js', 'verify-package.js',
  ]);
  assert.deepEqual(readdirSync(join(root, '.github/workflows')).sort(),
    ['milestone.yml', 'release.yml', 'rolling.yml', 'task-board-ci.yml']);
});

test('fixed prompt quotas stay unchanged; coding guidance does not grow past its previous body', () => {
  const usages = readMarkdownQuotas(root);
  assert.deepEqual(usages.map(({ limit }) => limit), [2300, 9500, 3400, 900, 8500]);
  assert.ok(usages.every(usage => !usage.exceeded), formatQuotaReport(usages));
  assert.ok(markdownBody(read(codingDirectory, 'SKILL.md'), true).length <= 10183);
  const role = prose(read('roles/task-node.md'));
  for (const pattern of [/continuing responsibility/, /Both modes may use helpers/,
    /they only read Task tools and return results/, /main agent alone maintains Tasks, including activity/,
    /creation history grants no control/i, /ACK its exact revision/, /task_start/,
    /all direct children must be terminal/, /Cancellation records intent first/,
    /Load `cockpit-task-tree` when first needed/]) assert.match(role, pattern);
});

test('advisor guidance is general, read-only and distinguishes context from business reasoning', () => {
  const role = prose(read('roles/task-advisor.md'));
  assert.match(role, /Load `cockpit-task-advisor` when first needed/);
  assert.match(role, /only `task_read`/);
  assert.match(role, /not Node instructions/);
  const skill = prose(read(advisorDirectory, 'SKILL.md'));
  for (const pattern of [
    /Native session\/Chat is the only source of business conversation/,
    /metadata.*assists discovery/, /cannot replace the actual session context/,
    /not permission to analyze the business problem/,
    /clarify only which topic/, /`status: "all"`/, /`parent_assignee`/,
    /`depth` is structural/, /`created_by` is historical/,
    /own assignee or its current direct parent's assignee/,
    /No single running\/idle flag/, /unknown activity is not idle/,
    /Waiting silently can be appropriate/, /service-managed automation have no agent assignee/,
    /at most one unfinished Task/, /`task_create`.*`task_claim`/,
    /A child instead belongs to its active orchestrating parent/,
    /These are the responsible Node's actions/,
    /per-Task modes of the same Node/, /reopened Task preserves its mode/,
    /saved selection is not applied capability/,
    /Formal nodes coordinate through Task facts and service notices/,
    /rather than calling coordination a user relay/,
    /Do not poll workers/, /not an intrinsic dependency in another module/,
  ]) assert.match(skill, pattern);
  assert.doesNotMatch(skill, /Assistant|assistant\/coordinator|task_session_create/);
});

test('Task Skill is an operational responsibility model with ordered recovery boundaries', () => {
  const skill = prose(read(treeDirectory, 'SKILL.md'));
  let previous = -1;
  for (const id of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']) {
    const index = skill.indexOf(`**${id} `);
    assert.ok(index > previous, `${id} rule order`);
    previous = index;
  }
  for (const pattern of [
    /continuing responsibility/, /Splitting never removes responsibility/,
    /Task is the only channel between formal Task nodes/, /`created_by` is history, not control/,
    /`parent_assignee`/, /Both modes may use tools and helpers/,
    /independent continuing responsibilities/, /not tool names/,
    /Helpers may only read Task tools/, /main agent for all maintenance, including activity/,
    /Child Task main agents retain their authority/,
    /first `task_convert` with reason, completed results and remaining work/,
    /sustained implementation\/deep investigation in children/, /never downgrade/,
    /todo\/undecided/, /Binding, ACK and activity do not start/,
    /`task_start` atomically enters `in_progress`/, /`task_report` cannot start todo/,
    /Readiness never overrides a user pause/, /do not synchronize/,
    /all direct children must be `done` or `cancelled`/, /not parent success or automatic closure/,
    /For done, satisfy prerequisites/,
    /new outcome and evidence-based retro/, /explicit `null`/,
    /`task_cancel` records an Agent cancellation request, not terminal status/,
    /task_cancel_finalize/, /Cancellation need not satisfy abandoned execution prerequisites/,
    /Only its assignee uses `task_cancel_finalize` with disposition; Web user finalizes unbound work/,
    /Cancellation need not satisfy abandoned execution prerequisites or ACK/,
    /Ancestor intent blocks new progress, but existing child done may close under active orchestrating ancestors' intent\/blockers; own intent forbids own done/,
    /Blocked roots may be claimed for clarification/,
    /Ancestor intent/, /task_claim/, /task_attach/,
    /no fixed business depth cap/, /cancelled\/ineligible ancestors prevent in-place reopen/,
    /Unknown legacy mode cannot reopen or be repaired by API; never infer from child absence or session activity/,
  ]) assert.match(skill, pattern);
  assert.doesNotMatch(skill, /more than 3 levels|DELEGATION_DEPTH_EXCEEDED|orchestrator` is you|root receives a request/);
});

test('user decisions, exact condition evidence and failure recovery remain actionable', () => {
  const skill = prose(read(treeDirectory, 'SKILL.md'));
  for (const pattern of [
    /Ask the user decisions directly/, /repeat another node's question/,
    /Write changed agreements back/, /Keep secrets out of Tasks/,
    /ACK its exact revision/, /definition_check/,
    /Resolve your own satisfied condition with `task_resolve_condition`/,
    /exact `dependency_id`/, /recorded user answer\/objective evidence/,
    /cannot remove Task-ID dependencies, change meaning or widen scope/,
    /description edit alone does not resolve/,
    /A Task-ID dependency waits for that execution's `done`, not success/,
    /Cancellation does not satisfy it/, /reopening does not revive resolved relations/,
    /original `operation`/, /never blindly retry, redispatch, replace a Task or repeat external effects/,
    /Replay keeps `request_id` and original inputs/, /current `write_context`/,
    /Never poll progress, chase ACKs or wait for notices to be read/,
    /Subscribe only for a necessary follow-up/, /never auto-renew/,
  ]) assert.match(skill, pattern);
});

test('responsibility selection precedes session and workspace reuse across guidance surfaces', () => {
  const tree = prose(read(treeDirectory, 'SKILL.md'));
  for (const pattern of [
    /not a permanent session identity/, /Continue unfinished work in its Task/,
    /`task_create` for a new independent goal/, /`task_reopen` only for authorized/,
    /same completed delivery, not a new feature\/result/,
    /retained worktree does not justify reopen/,
    /Done\/cancelled releases occupancy but preserves assignee, assignments and outcomes/,
    /A former orchestrator can execute a new Task; reopen preserves mode/,
    /Choose `execute` for one bounded result/, /steps do not themselves need intermediate Tasks/,
    /Delegate sustained discussion, research and design promptly/,
    /short questions need no Task/, /not unchanged pass-through delegation/,
    /Zero children is valid; complex work may recurse/,
    /Task completion does not prove native idle/, /A long-lived root may stay idle/,
    /no later assignment or other unfinished Task/, /not same-goal judgment, success or consent/,
  ]) assert.match(tree, pattern);
  assert.ok(tree.indexOf('Read the agreement/prior delivery') < tree.indexOf('**R2 '));
  const coding = prose(read(codingDirectory, 'SKILL.md'));
  assert.match(coding, /Choose responsibility before environment/);
  assert.match(coding, /Only after selecting authorized same-delivery rework and legally reopening/);
  assert.match(coding, /Reusing a session for a new goal instead follows the new-work setup above/);
  assert.match(toolDescriptions.task_create, /Without an unfinished Task, create an unbound ordinary root/);
  assert.match(toolDescriptions.task_assign, /Prior done\/cancelled Tasks retain their assignee\/history/);
  assert.match(toolDescriptions.task_assign, /does not prove native idle/);
  assert.match(toolDescriptions.task_start, /A new Task does not inherit/);
  assert.match(toolDescriptions.task_reopen, /new independent goal uses task_create/);
  assert.match(toolDescriptions.task_reopen, /scope judgment is not title matching/);
  assert.match(toolDescriptions.task_reopen, /preserving binding\/work_mode\/history, never resetting mode/);
});

test('documented responsibility entrypoints exist with the published strict schemas', () => {
  const skill = read(treeDirectory, 'SKILL.md');
  const documented = [...new Set([...skill.matchAll(/`(task_[a-z_]+)`/g)].map(([, name]) => name))];
  for (const name of documented) assert.ok(TOOL_NAMES.includes(name), name);
  const current = { request_id: 'guidance-example', task_id: '00000000-0000-0000-0000-000000000000',
    write_context: 'opaque-context-from-read', revision: 1 };
  for (const [name, extra] of [
    ['task_claim', {}], ['task_start', { work_mode: 'execute' }],
    ['task_convert', { reason: 'Independent responsibility needed', completed: 'Evidence recorded', remaining: 'Narrower delivery' }],
    ['task_attach', { parent_task_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', parent_write_context: 'parent-context', reason: 'Authorized broader responsibility' }],
    ['task_resolve_condition', { dependency_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', evidence: 'Recorded answer satisfies the condition' }],
    ['task_cancel_finalize', { summary: 'Children terminal; residual effects recorded' }],
  ]) assert.doesNotThrow(() => parseInput(name, { ...current, ...extra }), name);
  assert.throws(() => parseInput('task_read', { view: 'list', orchestrator: 'creator' }));
  assert.doesNotThrow(() => parseInput('task_read', { view: 'list', parent_assignee: 'parent', root: false, work_mode: 'orchestrate' }));
  assert.doesNotThrow(() => parseInput('task_read', { view: 'responsibility_events', task_id: current.task_id, limit: 10 }));
  assert.doesNotThrow(() => parseInput('task_read', { view: 'ancestors', task_id: current.task_id, limit: 50 }));
});

test('notice actions cover actual events, including cancellation intent and historical cards', () => {
  const skill = read(treeDirectory, 'SKILL.md');
  const notices = skill.split('## Notices and situations')[1].split('### Establish')[0];
  const labels = [...notices.matchAll(/`\[([^\]]+)\]`/g)].map(([, label]) => label);
  assert.deepEqual(labels.sort(), Object.values(TASK_EVENTS).sort());
  assert.match(prose(notices), /cancellation requested.*Read intent; cleanup\/finalize/);
  assert.match(prose(notices), /Task cancelled.*legacy assignee.*no execution reports/);
  assert.match(prose(notices), /Delivery rechecks relations, never reroutes stale recipients/);
  for (const label of Object.values(TASK_EVENTS)) assert.doesNotMatch(label, /\b(?:you|your|As Owner|As Executor)\b/i);
});

test('runtime guidance has no private Task-node messaging or retired reference escape', () => {
  for (const file of [join(treeDirectory, 'SKILL.md'), join(treeDirectory, 'references/automation.md'), 'roles/task-node.md']) {
    const source = read(file);
    assert.doesNotMatch(source, /cockpit_send_prompt|notify_assignee|write_agent/);
    assert.doesNotMatch(prose(source), /\b(?:send|message) the (?:assignee|orchestrator)\b/i);
    assert.doesNotMatch(source, /references\/(?:own-task|subtasks|important-updates|reading-tasks|task-links|task-writes-and-recovery)\.md/);
  }
  for (const directory of ['skills', 'roles']) {
    for (const entry of readdirSync(join(root, directory), { recursive: true })) {
      const path = join(root, directory, entry);
      if (!lstatSync(path).isFile()) continue;
      assert.doesNotMatch(readFileSync(path, 'utf8'),
        /(?:own-task|subtasks|important-updates|reading-tasks|task-links|task-writes-and-recovery)\.md/,
        `Retired reference in ${path}`);
    }
  }
});

test('automation reference preserves trustworthy execution while adapting current parent authority', () => {
  const source = prose(read(treeDirectory, 'references/automation.md'));
  for (const pattern of [/Agent work stays the default/, /existing, reviewed, trusted and repeatable script/,
    /registration never authorizes running it/, /never create a script, command template or workflow to bypass/,
    /Linux \(or WSL2\)/, /no assignee: never assign, ACK or report it/,
    /work_mode is null/, /parent-assignee authority, not creator history/,
    /root automation is managed by the Web user/, /subscribe before `task_automation_start`/,
    /replaying the same request never reruns it/, /neither status proves success or process-group exit/,
    /cancellation requests termination but proves neither exit nor rollback/,
    /Review its possible effects before `task_automation_reconcile`/, /process group is gone/,
    /repeat needs fresh authorization and a new Task/, /Do not poll/,
    /same-user trust boundary, not a sandbox/, /must not daemonize, detach or escape/,
    /do not apply Agent cancellation-request, ACK or finalization steps/]) assert.match(source, pattern);
});

test('coding guidance composes with responsibility mode, user scope and safe worktree delivery', () => {
  const coding = prose(read(codingDirectory, 'SKILL.md'));
  for (const pattern of [/work Skill, not a Task role or authority/, /both modes may use helpers/,
    /implements in `execute`/, /`orchestrate` arranges children/, /parent assignee, not the creator/,
    /Independent review may use an internal helper/, /The orchestrator does not prepare or clean up/,
    /Treat it as read-only/, /freshly fetched remote mainline/,
    /ask the user directly before editing, not the orchestrator/,
    /Do not manually message the orchestrator, directly or through subagents/,
    /Task done means the complete agreed result/,
    /default to reusing the retained worktree and branch/,
    /New checkouts do not inherit untracked or ignored local environment files/,
    /Short questions need no Issue, Task or worktree/,
    /independent sustained discussion\/research may be a Task/,
    /investigation-only, patch-only or PR-only authorization stops at that boundary/,
    /reference project instructions, methods and prior evidence instead of copying them/,
    /not code merge alone, resource cleanup or an idle native session/,
    /If your worktree was already removed after merge, create a fresh branch and worktree from freshly fetched mainline/]) assert.match(coding, pattern);
  assert.doesNotMatch(coding, /\b(?:npm|pnpm|node_modules|registry)\b/);
  const metadata = skillMetadata(read(codingDirectory, 'SKILL.md'));
  assert.match(metadata.description, /authorized work requires changing version-controlled repository files/);
  assert.match(metadata.description, /implementing node reuses or creates the Issue, creates its own branch and worktree/);
  assert.match(metadata.description, /Choose collaboration through cockpit-task-tree/);
});

test('current acceptance is separate from historical model evidence and canonical migration instructions', () => {
  const replay = read('docs/task-lifecycle-testing.md');
  assert.ok(replay.indexOf('## Schema12 responsibility acceptance') < replay.indexOf('## Historical specifications and recorded runs'));
  assert.match(prose(replay), /No new model\/native-host replay result is asserted/);
  assert.match(prose(replay), /R04\/R19 require an actual recorded agent run/);
  for (const file of ['README.md', 'docs/task-design.md', 'docs/task-schema.md', 'docs/task-mcp-contract.md']) {
    const source = read(file);
    assert.match(source, /task-responsibility-migration\.md/, file);
    assert.doesNotMatch(source, /最多 3 层|只有 orchestrator.*解除|orchestrator="user"/, file);
  }
});

test('guidance distinguishes closure from new progress and keeps migration stages separate', () => {
  const contract = prose(read('docs/task-mcp-contract.md'));
  assert.match(contract, /done 必须 in_progress、current ACK、ready、无自身取消意图/);
  assert.match(contract, /祖先仍须有绑定且 active orchestrate，但祖先的取消意图或 blockers 不阻止既有 child done 收口/);
  assert.doesNotMatch(contract, /done 必须[^。]*无自身\/祖先取消意图/);
  assert.match(contract, /不要求 abandoned prerequisites ready 或 ACK/);
  assert.match(contract, /可承接 blocked root 以澄清前置/);
  assert.match(contract, /最近 parent 在前/);
  assert.match(contract, /cancellation_request 为 null 或 `\{reason,author,at,request_id\}`/);
  assert.match(contract, /responsibility_events 项为 `\{id,task_id,kind,author,at,details\}`/);
  const implementation = prose(read('docs/task-implementation.md'));
  assert.match(implementation, /`migrate-task-v10\.js` stops at schema10/);
  assert.match(implementation, /`migrate-task-v11\.js` performs only receipt migration and stops at schema11/);
  assert.match(implementation, /Neither constructs a live TaskStore, starts services or chooses responsibility modes/);
  assert.match(implementation, /re-inventory schema11 for the separate reviewed schema12 plan/);
  assert.match(implementation, /Schema12 preflight validates read-only without applying DDL/);
  assert.match(implementation, /There is no post-schema12 mode-repair API; runtime reopen refuses an unknown mode/);
});

test('worktree-local initialization and fixed quota entrypoint remain documented', () => {
  const contributing = read('CONTRIBUTING.md');
  const setup = localLinks(contributing).find(link => link.startsWith('README.md#'));
  assert.ok(setup);
  const readme = read('README.md');
  assert.ok(readme.includes(`## ${decodeURIComponent(setup.split('#')[1])}`));
  for (const pattern of [/npm ci --ignore-scripts --no-audit --no-fund/,
    /Each worktree needs its own `node_modules`/, /npm's own cache/,
    /Do not copy production dependencies or credentials, or symlink another worktree's entire `node_modules`/,
    /Documentation-only edits do not require dependency installation/,
    /ready environment should not be reinstalled unconditionally/, /npm run quotas/]) assert.match(prose(readme), pattern);
});

test('module packaging carries runtime Skills and all explicit migration CLIs', () => {
  const packaged = spawnSync('npm', ['run', 'package:module'], { cwd: root, encoding: 'utf8' });
  assert.equal(packaged.status, 0, packaged.error?.message ?? `${packaged.stdout}\n${packaged.stderr}`);
  const version = process.env.ROLLING_SEQUENCE ? `0.0.0-rolling.${process.env.ROLLING_SEQUENCE}` : '0.0.0-dev';
  const archive = join(root, 'dist', `cockpit-task-${version}.tgz`);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  const expectedSkills = [...treeFiles.map(file => `./${treeDirectory}/${file}`),
    `./${codingDirectory}/SKILL.md`, `./${advisorDirectory}/SKILL.md`].sort();
  assert.deepEqual(entries.filter(entry => entry.startsWith('./skills/') && !entry.endsWith('/')).sort(), expectedSkills);
  assert.ok(entries.includes('./module-build.json'));
  assert.ok(!entries.some(entry => /^\.\/test\//.test(entry)));
  const packagedGuides = ['docs/releases.md', 'docs/task-responsibility-migration.md'];
  assert.deepEqual(entries.filter(entry => entry.startsWith('./docs/') && !entry.endsWith('/')).sort(),
    packagedGuides.map(path => `./${path}`), 'Only the canonical offline procedure and its entry point are packaged');
  for (const path of packagedGuides) {
    assert.equal(execFileSync('tar', ['-xOf', archive, `./${path}`], { encoding: 'utf8' }), read(path));
  }
  assert.deepEqual([...new Set(entries.filter(entry => entry !== './').map(entry => entry.split('/')[1]))].sort(),
    ['README.md', ...(process.env.ROLLING_SEQUENCE ? ['cockpit-deployment.json'] : []),
      'cockpit.module.json', 'docs', 'module-build.json', 'node_modules', 'package.json', 'roles',
      'scripts', 'skills', 'src', 'web']);
  for (const entry of expectedSkills) assert.equal(
    execFileSync('tar', ['-xOf', archive, entry], { encoding: 'utf8' }), read(entry));
  const scripts = ['migrate-task-v10.js', 'migrate-task-v11.js', 'migrate-task-v12.js'];
  assert.deepEqual(entries.filter(entry => entry.startsWith('./scripts/') && !entry.endsWith('/')).sort(),
    scripts.map(file => `./scripts/${file}`));
  for (const file of scripts) assert.equal(
    execFileSync('tar', ['-xOf', archive, `./scripts/${file}`], { encoding: 'utf8' }), read('scripts', file));
  for (const file of ['tool-descriptions.js', 'tool-names.js']) assert.equal(
    execFileSync('tar', ['-xOf', archive, `./src/task-board/${file}`], { encoding: 'utf8' }),
    read('src/task-board', file));
  const packagedManifest = JSON.parse(execFileSync('tar', ['-xOf', archive, './cockpit.module.json'], { encoding: 'utf8' }));
  assert.deepEqual(packagedManifest.roles.map(role => role.id), ['node', 'advisor']);
  assert.deepEqual(packagedManifest.roles[0].skillDirectories.sort(), ['skills/cockpit-task-tree', 'skills/github-coding']);
  assert.deepEqual(packagedManifest.roles[1], JSON.parse(read('cockpit.module.json')).roles[1]);
  assert.deepEqual(entries.filter(entry => entry.startsWith('./roles/') && !entry.endsWith('/')).sort(),
    ['./roles/task-advisor.md', './roles/task-node.md']);
  for (const role of packagedManifest.roles) assert.equal(
    execFileSync('tar', ['-xOf', archive, `./${role.instructions}`], { encoding: 'utf8' }), read(role.instructions));
  const packagedReadme = execFileSync('tar', ['-xOf', archive, './README.md'], { encoding: 'utf8' });
  for (const link of localLinks(packagedReadme)) assert.ok(entries.includes(`./${link.split(/[?#]/)[0]}`),
    `Packaged README link must resolve: ${link}`);
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  execFileSync(process.execPath, ['scripts/verify-package.js', archive, sourceSha], { cwd: root, stdio: 'pipe' });
});

test('legacy release recovery still publishes only checked archive bytes after the draft gate', () => {
  const workflow = read('.github/workflows/release.yml');
  for (const text of ['uses: ./.github/workflows/task-board-ci.yml', 'actions: read', 'check-release.js',
    'release-write.js create', 'release-write.js upload', 'gh api --paginate --slurp', 'release-state.js select',
    'Accept: application/octet-stream', 'release-write.js publish']) assert.ok(workflow.includes(text), text);
  assert.ok(workflow.indexOf('Accept: application/octet-stream') < workflow.indexOf('release-write.js publish'));
  assert.doesNotMatch(workflow, /--clobber|gh release (?:download|edit)|npm run package:module|pull_request_target|secrets\./);
  for (const [, use] of workflow.matchAll(/uses:\s+([^\s]+)/g)) {
    if (!use.startsWith('./')) assert.match(use, /^[\w/-]+@[a-f0-9]{40}$/);
  }
});

test('public documentation links resolve within the repository without retired Skill references', () => {
  const files = ['README.md', 'CONTRIBUTING.md', ...readdirSync(join(root, 'docs')).filter(file => file.endsWith('.md')).map(file => `docs/${file}`)];
  for (const file of files) {
    const path = join(root, file);
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /#exceptional-update-handoff|skills\/(?:task-owner|task-executor)\//);
    assert.doesNotMatch(source, /references\/(?:own-task|subtasks|important-updates|reading-tasks|task-links|task-writes-and-recovery)\.md/);
    assert.doesNotMatch(source, /notify_assignee|UPDATE_NOTICE_NOT_APPLICABLE/, file);
    for (const link of localLinks(source)) {
      const target = resolve(dirname(path), decodeURIComponent(link.split(/[?#]/)[0]));
      assert.ok(target.startsWith(root), `${file}: ${link} escapes repository`);
      assert.ok(existsSync(target), `${file}: missing ${link}`);
    }
  }
});

test('unquoted mapping separators and invalid escapes in Skill descriptions fail validation', () => {
  const description = 'Task node: authorized responsibility.';
  const source = `---\nname: cockpit-task-node\ndescription: ${description}\n---\n`;
  assert.throws(() => skillMetadata(source), /JSON-quoted description/);
  assert.deepEqual(skillMetadata(source.replace(description, JSON.stringify(description))),
    { name: 'cockpit-task-node', description });
  assert.throws(() => skillMetadata('---\nname: cockpit-task-node\ndescription: "invalid \\q escape"\n---\n'), SyntaxError);
});
