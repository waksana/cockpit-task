import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { schemas } from '../src/task-board/contracts.js';

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
// The single tree-node Skill keeps each former role's guidance in its own category reference.
const roleReference = { orchestrator: 'references/subtasks.md', assignee: 'references/own-task.md' };
const treeFiles = ['SKILL.md', ...['automation.md', 'important-updates.md', 'own-task.md',
  'reading-tasks.md', 'subtasks.md', 'task-links.md', 'task-writes-and-recovery.md'].map(name => `references/${name}`)].sort();
const roleGuide = role => ['SKILL.md', roleReference[role]]
  .map(file => readFileSync(join(root, treeDirectory, file), 'utf8')).join('\n');
const prose = source => source.replace(/\s+/g, ' ');
const localLinks = source => [...source.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)]
  .map(([, target]) => target)
  .filter(target => !/^(?:[a-z][a-z\d+.-]*:|#)/i.test(target));

function assertSkillClosure(directory, expected) {
  const directories = [...new Set(expected.map(file => dirname(file)).filter(path => path !== '.'))];
  assert.deepEqual(readdirSync(directory, { recursive: true }).sort(),
    [...expected, ...directories].sort(), 'Only the body and runtime references belong in a Skill');
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

test('one Task tree Skill and one shared coding Skill have unique YAML-safe metadata', () => {
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
  assert.deepEqual([...names].sort(), ['cockpit-task-tree', 'github-coding']);
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
  assert.deepEqual(readdirSync(join(root, 'roles')).sort(), ['task-node.md']);
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
  const directory = join(isolated, 'tree');
  cpSync(join(root, treeDirectory), directory, { recursive: true });
  assertSkillClosure(directory, treeFiles);
  const body = readFileSync(join(directory, 'SKILL.md'), 'utf8');
  const metadata = skillMetadata(body);
  assert.equal(metadata.name, 'cockpit-task-tree');
  assert.match(metadata.description, /first|reuse/i);
  assert.ok(body.split('\n').length < 100, 'Keep the tree-node principle concise; category guidance belongs in references');
  assert.match(body, /Load only the reference needed, not the whole set/);
  assert.match(body, /Reuse this Skill while it remains in context/);
  assert.match(body, /fresh Task/);
  for (const role of ['orchestrator', 'assignee']) {
    const guide = readFileSync(join(directory, roleReference[role]), 'utf8');
    assert.match(guide, /Load only the reference needed, not the whole set/, `${role} guidance keeps its reference index`);
  }
  const coding = join(isolated, 'github-coding');
  cpSync(join(root, codingDirectory), coding, { recursive: true });
  assertSkillClosure(coding, ['SKILL.md']);
  const source = readFileSync(join(coding, 'SKILL.md'), 'utf8');
  assert.equal(skillMetadata(source).name, 'github-coding');
  assert.ok(source.split('\n').length < 150, 'Coding guidance stays a short flow, not a command catalogue');
  assert.doesNotMatch(source, /```(?:sh|bash)|git (?:checkout|reset|stash|push|clean)\b/);
});

test('coding guidance composes with roles without widening implementation or subscription authority', () => {
  for (const role of ['orchestrator', 'assignee']) {
    const source = roleGuide(role);
    const section = source.match(/## Coding work\n([\s\S]*?)(?=\n## )/)?.[1];
    assert.ok(section?.includes('`github-coding`'), `${role} must independently discover the work Skill`);
    assert.ok(section.trim().split('\n').length <= 8, 'Do not duplicate the work flow in role Skills');
  }
  const prompt = prose(readFileSync(join(root, 'roles/task-node.md'), 'utf8'));
  assert.match(prompt, /Coding assignees get cwd at a target repository.s main checkout and set up\/clean up their own worktree/);
  assert.match(prompt, /cwd at a target repository's main checkout/);
  assert.doesNotMatch(prompt, /Issue\/environment preparation/);
  const executorPrompt = prose(readFileSync(join(root, 'roles/task-node.md'), 'utf8'));
  assert.match(executorPrompt, /set up\/clean up their own worktree \(`github-coding`\); the cwd checkout stays read-only/);
  const coding = prose(readFileSync(join(root, codingDirectory, 'SKILL.md'), 'utf8'));
  const requirements = [
    /"main" means the repository's agreed target mainline/,
    /Questions and idea exploration do not require an Issue, Task or worktree/,
    /investigation-only, patch-only or PR-only authorization stops at that boundary/,
    /existing suitable Issue or work environment rather than duplicating it/,
    /not hosted on GitHub.*skipping inapplicable Issue\/PR steps/,
    /Release\/tag creation, installation, deployment, restart and data migration are not default coding stages/,
    /The orchestrator states what should change, which repository or repositories are involved and the delivery boundary/,
    /references an existing suitable Issue when there is one/,
    /The orchestrator does not prepare or clean up branches or worktrees/,
    /setting up and releasing the work environment is always the assignee's job/,
    /not permission to implement the code personally or through the orchestrator's subagents/,
    /Treat it as read-only: fetching is fine, but never edit, switch, pull into, reset or stash it, and never touch another worker's worktree/,
    /Tools default to the session cwd, so after creating your worktree direct every edit, build, test and Git command at worktree paths explicitly/,
    /reuse or create the Issue describing goal, scope and completion conditions, then create a dedicated branch and isolated worktree from freshly fetched remote mainline/,
    /Reuse an existing environment only after verifying it is yours/,
    /record the Issue in Task `references` and the branch and worktree path in `metadata`/,
    /For several repositories, do the same for each and record every Issue, branch and path/,
    /one Task for the complete result/,
    /`references`.*`metadata`.*`outcome.references`/,
    /Link them rather than mirroring every comment or log/,
    /Environment cleanup is not a reason to wait for or wake the orchestrator/,
    /Worktrees the orchestrator prepared before this workflow may be cleaned up by the orchestrator once, using the same safety checks as assignee cleanup below; this is not a routine duty/,
    /Default to no subscription/,
    /future status unlocks specific necessary authorized orchestrator work/,
    /smallest one-shot subscription before assignment/,
    /Completion confirmation or repeated reporting is not that work/,
    /without polling, automatic renewal or a new script\/timer/,
    /Read the latest Task, linked Issue and repository instructions/,
    /Do not assume you inherited the orchestrator's Skill context/,
    /independent read-only review and fixes/,
    /PR and promptly add its link to Task/,
    /exact latest PR head, not an earlier green run/,
    /Merge normally only within the authorized boundary and repository protections; never bypass them/,
    /Do not manually message the orchestrator, directly or through subagents/,
    /Task done means the complete agreed result/,
    /not code merge alone, resource cleanup or an idle native session/,
    /every PR\/branch\/worktree path and the cleanup result: what was removed, and anything kept with its reason, outstanding users and artifacts to preserve/,
    /After merge, clean up your own environment before reporting done/,
    /including squash or rebase merges/,
    /Confirm nobody still uses the worktree: you, your subagents or other work; an idle label alone does not establish that/,
    /uncommitted, untracked, ignored or otherwise needed artifacts and unmerged work/,
    /remove only this work's worktree and local\/remote branches, except those retained by repository policy/,
    /Never remove a session's cwd, including the shared checkout/,
    /If merge or use is uncertain, keep the resources and record why/,
    /ask it directly, one focused question at a time/,
    /an answer alone does not prove safety/,
    /Limited delivery without merge keeps the branch and worktree/,
  ];
  for (const requirement of requirements) assert.match(coding, requirement);
  for (const retired of [
    /Owner: prepare, then delegate/,
    /Owner: finish the environment cleanup/,
    /Owner still cleans up/,
    /Owner retains safe cleanup responsibility/,
    /prepare the isolated environment/,
    /designated \(or authorized self-prepared\) worktree/,
    /Return your main working directory to clean/,
  ]) assert.doesNotMatch(coding, retired);
  const description = skillMetadata(readFileSync(join(root, codingDirectory, 'SKILL.md'), 'utf8')).description;
  assert.match(description, /the orchestrator states requirements and any existing Issue; the assignee reuses or creates the Issue, creates its own branch and worktree from fresh mainline/);
  assert.match(description, /safely cleans up after merge/);
  assert.doesNotMatch(description, /Owner|Executor|orchestrator prepares|orchestrator safely cleans/);
  for (const role of ['orchestrator', 'assignee']) {
    const roleSkill = prose(roleGuide(role));
    assert.doesNotMatch(roleSkill, /prepared worktree|Owner handles safe post-merge|prepare clean mainline|freshly fetched|local\/remote branches/,
      `${role} Skill must leave Git mechanics to github-coding`);
  }
});

test('rework guidance keeps self-reopen narrow and defaults to safe retained worktree continuation', () => {
  const executor = prose(roleGuide('assignee'));
  for (const requirement of [
    /user explicitly authorizes rework/,
    /read full current `execution` and use `task_reopen` yourself only if eligible/,
    /same Task, orchestrator and original assignee/,
    /no other Task assigned to you since that assignment \(even one now done\/cancelled\)/,
    /Pre-upgrade assignments are ineligible/,
    /new revision even if the text is identical/,
    /Ended subscriptions remain ended/,
    /Cancelled Tasks and automation never use this path/,
  ]) assert.match(executor, requirement);
  assert.doesNotMatch(executor, /done\/cancelled cannot reopen/);
  const owner = prose(roleGuide('orchestrator'));
  assert.match(owner, /Prefer eligible original-assignee `task_reopen`.*not replacement\/redispatch/);
  const coding = prose(readFileSync(join(root, codingDirectory, 'SKILL.md'), 'utf8'));
  for (const requirement of [
    /default to reusing the retained worktree and branch when they still exist, even after its previous PR merged/,
    /ownership\/no conflicting worker; metadata is not ownership proof/,
    /unrelated transcripts must not be scanned/,
    /If your worktree was already removed after merge, create a fresh branch and worktree from freshly fetched mainline/,
    /Repurposed or conflicting worktrees require explicit resolution with the user, never taking over/,
    /normally merge current mainline into a retained branch/,
    /never force-push, reset, amend prior delivered commits or discard work/,
    /create a new follow-up PR linking prior results/,
    /explicit retro text or null, including on every reopened delivery/,
  ]) assert.match(coding, requirement);
});

test('coding scope distinguishes repository changes from deployment and keeps mixed delivery together', () => {
  const source = readFileSync(join(root, codingDirectory, 'SKILL.md'), 'utf8');
  assert.match(skillMetadata(source).description, /version-controlled repository files/);
  const scope = prose(source.split('## Agree on the result before creating work')[1]
    .split('## Orchestrator: state the requirements, then delegate')[0]);
  for (const requirement of [
    /changes intended for commit/,
    /existing verified artifacts/,
    /without this Skill requiring an Issue, PR, branch or worktree/,
    /immutable installation directories/,
    /Runtime configuration is distinct from repository changes/,
    /Mixed delivery stays one complete Task/,
    /Issue\/PR scope covers only necessary repository changes/,
    /require separate authorization/,
  ]) assert.match(scope, requirement);
  assert.match(prose(source), /including separately authorized non-coding work in mixed delivery/);
  const setup = prose(source.split('## Assignee: create your own isolated worktree')[1]
    .split('## Assignee: deliver through the authorized boundary')[0]);
  assert.match(setup, /If the same result needs changes not covered by the agreed scope, including in other code or repositories, ask the user directly before editing, not the orchestrator; scope is the user's decision/);
  assert.match(setup, /Once authorized, keep the Task description current and set up that repository's Issue, branch and worktree the same way/);
  assert.match(setup, /Unrelated changes need a separate Task, not a drive-by fix/);
  assert.doesNotMatch(prose(source), /Owner-coordinated Issue\/environment preparation/);
  assert.match(prose(source), /verify your own worktree before editing/);
  assert.doesNotMatch(setup, /For GitHub work,/);
  const owner = prose(roleGuide('orchestrator')
    .split('## Coding work')[1].split('## Coordinate through Task')[0]);
  assert.match(owner, /version-controlled repository files/);
  assert.match(owner, /pure deployment using existing verified artifacts/);
  assert.match(owner, /State the requirements and reference any existing Issue; the assignee sets up and cleans up its own environment, so you do not prepare or clean branches\/worktrees/);
  assert.match(owner, /Create the assignee session with cwd at a target repository's shared main checkout \(any involved one for cross-repository work\)/);
  const executorCoding = prose(roleGuide('assignee')
    .split('## Coding work')[1].split('\n## ')[0]);
  assert.match(executorCoding, /set up your own isolated environment, deliver through the authorized review\/PR\/merge boundary and clean up after merge; nobody prepares or cleans it for you/);
  assert.match(executorCoding, /Ask the user, not your orchestrator, before scope changes/);
  const board = prose(readFileSync(join(root, 'docs/task-board.md'), 'utf8'));
  assert.match(board, /If changes outside the agreed scope emerge, assignee asks the user first; once authorized it sets up that Issue and worktree within the same Task/);
  assert.match(board, /orchestrator has no routine cleanup duty/);
  assert.doesNotMatch(board, /Owner prepares clean current mainline|preparing the isolated environment and safe post-merge cleanup are Owner coordination/);
  assert.match(owner, /Mixed delivery stays one Task/);
  assert.match(owner, /default delegation responsibility/);
});

test('role prompts stay short while the Skills preserve delegation, communication and synchronization boundaries', () => {
  const prompt = prose(readFileSync(join(root, 'roles/task-node.md'), 'utf8'));
  assert.ok(prompt.split(' ').length <= 360, 'node: one prompt replaces two; keep details in the Skill and references');
  assert.ok(prompt.includes('Load `cockpit-task-tree` when first needed'));
  assert.match(prompt, /Reuse.*reload only when missing, changed or a rule is unclear/);
  assert.match(prompt, /Stable Skill reuse never replaces fresh Task reads/);
  assert.match(prompt, /only judgment is whether to do work yourself or split it into Subtasks/);
  assert.match(prompt, /With a Task, you own completing it/);
  assert.match(prompt, /Without a Task, stay available: delegate delivery through Task/);
  assert.match(prompt, /Derive your relation from Task facts, not memory/);
  assert.match(prompt, /coordinate through Task, not chats with assignees/);
  assert.match(prompt, /directly of the user here; do not message your orchestrator, directly or through other agents/);
  assert.match(prompt, /exact revision.*every `definition_check`/);

  const owner = prose(roleGuide('orchestrator'));
  assert.match(owner, /independent assignee, not your own tools or subagents/);
  assert.match(owner, /A result request is not permission for personal implementation, even for small work/);
  assert.match(owner, /Split independent outcomes, not tightly coupled stages, resources or specialties/);
  assert.match(owner, /Do not chat with an assignee to ask for progress, clarify requirements, chase work or request confirmation/);
  assert.match(owner, /Assignee-facing notices remain the initial assignment.*important-update handoff/);
  assert.match(owner, /Ordinary edits\/reports are silent without an explicit status subscription/);
  assert.doesNotMatch(owner, /only two cross-session notices|there are no reminders or service final notifications/);
  assert.match(owner, /`task_assign` sends the first assigned reference itself; do not send a duplicate/);
  assert.match(owner, /task_read\(view=list, orchestrator=<your session ID>\)/);
  assert.match(owner, /view=overview/);
  assert.match(owner, /Context always supplies identity, assignment, status, revision\/ACK and write context/);
  assert.match(owner, /Read `definition` before editing requirements/);
  assert.match(owner, /use histories only for a historical question/);
  assert.match(owner, /Avoid a fixed overview-then-outcomes sequence, guessing outcomes then activity, or reading every group/);
  assert.match(owner, /scan chats routinely or schedule monitoring/);

  const executor = prose(roleGuide('assignee'));
  assert.match(executor, /task_read\(view=execution\)/);
  assert.match(executor, /At start, on resumption, between stages, before consequential actions and before delivery, read the latest Task/);
  assert.match(executor, /complete requirements with `task_read\(view=execution\)` and ACK the exact current revision/);
  assert.match(executor, /Selective overview reads never replace this execution read or precise ACK/);
  assert.match(executor, /Inspect `definition_check` on every Task response, including errors and replays/);
  assert.match(executor, /later ACKs do not confirm skipped revisions/);
  assert.match(executor, /complete updated Task definition with reason\/source and the decision superseded/);
  assert.match(executor, /report `done` with a new outcome in the same request/);
  assert.match(executor, /not as a mandatory orchestrator acceptance gate/);
  assert.match(executor, /Do not send your orchestrator questions, confirmations, progress, blockers or completion messages, directly or via subagents/);
});

test('preparation guidance keeps professional selection and Skill body loading explicit', () => {
  const owner = prose(roleGuide('orchestrator'));
  const executor = prose(roleGuide('assignee'));
  assert.match(owner, /Exclude every node that is assignee of an unfinished Task, even if native idle/);
  assert.match(owner, /existing discoverable Skill\/MCP names, not guesses from Task text/);
  assert.match(owner, /`task_session_create` with selections or `task_session_prepare`/);
  assert.match(owner, /Neither new nor reuse is mandatory; backlog does not dispatch/);
  assert.match(owner, /`task_assign` once: it checks, never repairs/);
  assert.match(owner, /Unknown effects need inspection, not blind retry\/replacement/);
  assert.match(executor, /Preparation\/readiness is not assignment, authorization, ACK or execution/);
  assert.match(executor, /Skill enabled is not body loaded; load relevant Skill bodies when first needed/);
  assert.match(executor, /MCP connected is not tool offered/);
  assert.match(executor, /initialized tool metadata is not final readiness/);
});

test('record guidance preserves the task-specific agreement and evidence without copying prior context', () => {
  for (const role of ['orchestrator', 'assignee']) {
    const source = prose(roleGuide(role));
    for (const requirement of [
      /goal, scope, key decisions, authorization boundaries, special constraints and completion conditions/,
      /not complete prior context/,
      /[Rr]eference general Skills, repository instructions and environment documentation as needed instead of repeating them/,
      /keep execution-critical task-specific facts explicit/i,
      /[Ss]eparate prior investigation from current requirements/,
      /not a raw evidence store/,
      /accessible, locatable references for detailed evidence/,
      /"see Issue".*essential agreement|essential agreement.*"see Issue"/,
      /hide requirements in metadata/,
      /inherited context/,
      /[Kk]eep exact values needed to support conclusions or resume safely/,
    ]) assert.match(source, requirement, `${role}: ${requirement}`);
  }
  const executor = prose(roleGuide('assignee'));
  assert.match(executor, /Lead activity with meaningful new changes, findings, decisions or blockers and necessary remaining work/);
  assert.match(executor, /not a restatement of the brief/);
  assert.match(executor, /State what a blocker needs/);
  assert.match(executor, /Lead outcome with the delivered result, how it meets the agreement and remaining limitations, then necessary supporting evidence/);
  assert.match(executor, /Research results may be detailed: distinguish conclusions, reasoning and unverified points/);
});

test('explicit one-shot subscriptions preserve silent defaults, role boundaries and uncertain delivery guidance', () => {
  const owner = prose(roleGuide('orchestrator'));
  assert.match(owner, /An orchestrator may explicitly subscribe to specified Task states/);
  assert.match(owner, /first real matching transition ends the subscription/);
  assert.match(owner, /already matching at registration means failure, not an immediate notice/);
  assert.match(owner, /read only necessary latest content in one bounded call where possible and reassess the planned follow-up/);
  assert.match(owner, /card is not proof of complete delivery or an assignee definition-ACK instruction/);
  assert.match(owner, /Do not automatically resubscribe, poll or hold this turn open waiting/);
  const ownerPrompt = prose(readFileSync(join(root, 'roles/task-node.md'), 'utf8'));
  assert.match(ownerPrompt, /An orchestrator's status subscription permits only a system notice/);
  assert.match(ownerPrompt, /Read only needed latest content on receipt, in one bounded call where possible/);
  assert.match(ownerPrompt, /No automatic resubscription or acceptance/);
  const executor = prose(roleGuide('assignee'));
  assert.match(executor, /Only the system sends that one-shot notice/);
  assert.match(executor, /no subscription capability or permission to notify the orchestrator/);
  assert.match(executor, /not an instruction to execute or ACK a notification/);
  const executorPrompt = prose(readFileSync(join(root, 'roles/task-node.md'), 'utf8'));
  assert.match(executorPrompt, /only a system notice, not assignee messages, subscription capability or a notification ACK/);
  for (const role of ['orchestrator', 'assignee']) {
    const reference = name => prose(readFileSync(join(root, treeDirectory, 'references', name), 'utf8'));
    const writes = reference('task-writes-and-recovery.md');
    for (const name of ['task_subscribe', 'task_unsubscribe', 'task_read(view=subscriptions)']) {
      assert.ok(writes.includes(`\`${name}\``), `Missing subscription interface ${name}`);
    }
    assert.match(writes, /At most one subscription may be waiting per Task/);
    assert.match(writes, /recipient is derived from the Task's `orchestrator`, not an arbitrary addressee or the reported actor/);
    assert.match(writes, /no subscription capability to the assignee/);
    assert.match(writes, /Only a real transition.*first match, after which the subscription ends/);
    assert.match(writes, /does not listen to activity, definition changes or native busy\/idle state/);
    assert.match(writes, /already has a selected status at registration, registration fails/);
    assert.match(writes, /no subscription is created and no notice sent/);
    assert.match(writes, /does not keep the subscribing turn suspended; host enqueue queues it when busy without interrupting/);
    assert.match(writes, /do not clear queues, interrupt work or request a notification ACK/);
    assert.match(writes, /Queued or accepted does not mean read/);
    assert.match(writes, /do not claim exactly-once delivery/);
    assert.match(writes, /unknown send does not authorize a blind resend, replacement Task or another subscription/);
    assert.match(writes, /neither restores default progress\/final notifications nor permits assignee-to-orchestrator messages/);
    assert.match(writes, /Unsubscribe cancels only a waiting subscription; it cannot retract a triggered notification/);
    assert.match(writes, /terminal status outside the selected targets, the waiting subscription expires without notification/);
    assert.match(writes, /original `result`, including `subscription_ids`, is retained alongside `notifications` and an independent `notification_error`/);
    assert.match(writes, /notification failure can set MCP `isError=true` while `error` remains null/);
    assert.match(writes, /saved Task status and outcome are not rolled back/);
    assert.match(writes, /Do not repeat a saved report, redo delivery or manually send a replacement notice to the orchestrator because notification failed/);
    const reading = reference('reading-tasks.md');
    assert.match(reading, /`subscriptions` with `task_id`/);
    assert.match(reading, /do not poll while waiting/);
    const links = reference('task-links.md');
    assert.ok(links.includes('[Subtask status changed](task:<uuid>?event=status_changed)'));
    assert.match(links, /System notice to the Task's orchestrator after an explicit status subscription matches/);
    assert.match(links, /not an assignee instruction or a request to ACK a notification/);
    assert.match(links, /distinct from `updated`, which asks the assignee to read and ACK the current definition/);
    assert.match(links, /Only lowercase `assigned`, `updated`, `status_changed`, `ready`, `blocker_cancelled`, `child_done`, `child_blocked` and `child_cancelled`/);
    assert.ok(links.includes('[Subtask ready](task:<uuid>?event=ready)'));
    assert.ok(links.includes('[Subtask blocker cancelled](task:<uuid>?event=blocker_cancelled)'));
    assert.match(links, /They point to the dependent, not the blocker; nothing was assigned or started/);
    assert.match(reading, /`dependency_notices` with the dependent's `task_id`/);
    assert.match(reading, /`blocked_by`, `ready`/);
    assert.match(links, /A link alone neither creates a subscription nor authorizes editing or scheduling/);
  }
  const handoff = prose(readFileSync(join(root, treeDirectory, 'references/important-updates.md'), 'utf8'));
  assert.match(handoff, /`status_changed` subscription notice to the orchestrator is separate/);
  assert.match(handoff, /does not trigger this assignee-directed `updated` handoff/);
});

test('important updates use one immediate notice without queue intervention or interruption', () => {
  const owner = prose(roleGuide('orchestrator'));
  assert.match(owner, /one `immediate` notice/);
  assert.doesNotMatch(owner, /before handling pending messages or interrupting/);
  const source = readFileSync(join(root, treeDirectory, 'references/important-updates.md'), 'utf8');
  const handoff = prose(source);
  for (const requirement of [
    /cannot wait.*normal checkpoints/,
    /Ordinary edits, delayed ACKs and routine progress do not trigger/,
    /Save the complete updated requirements in Task first/,
    /Freshly read Task context/,
    /unfinished, still assigned to the same assignee/,
    /latest revision is not already ACKed/,
    /already aligned, do not send/,
    /pending ask, plan or elicitation requires its native response/,
    /`cockpit_send_prompt` once/,
    /interjects into the current turn/,
    /Task remains the agreement authority/,
    /`task_edit` remains silent/,
    /Leave queued user and subagent messages intact: do not copy, remove or replay/,
    /Do not stop or interrupt the main turn or background work merely to notify/,
    /explicit user stop\/cancel or other authorized interruption is separate/,
    /Acceptance is not consumption or ACK/,
    /bounded inspection/,
    /No blind retry, duplicate prompt, replacement session, subscription, polling or automatic escalation to interruption/,
  ]) assert.match(handoff, requirement);
  assert.doesNotMatch(handoff, /Remove only the saved|preserved-context summary|interrupt the main turn once|remove-queued|cockpit_cancel_turn/);
  const example = JSON.parse(source.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.equal(example.session_id, '<assignee-session-id>');
  assert.equal(example.mode, 'immediate');
  assert.ok(example.text.includes('[Task updated](task:<uuid>?event=updated)'));
  assert.match(example.text, /full current Task execution view/);
  assert.match(example.text, /ACK its exact latest revision before continuing affected work/);
});

test('subscription guidance requires necessary orchestrator follow-up without gating assignee work', () => {
  const owner = prose(roleGuide('orchestrator'));
  assert.match(owner, /Default to no subscription/);
  assert.match(owner, /identify the concrete, necessary authorized orchestrator action that a future Task state enables/);
  assert.match(owner, /Merely knowing progress or confirming completion, including repeated reporting, is not a reason to subscribe/);
  assert.match(owner, /Even when blocked, their direct user question is not yours to relay or answer on their behalf/);
  assert.match(owner, /Judge the need yourself; the user need not explicitly request a subscription/);
  assert.match(owner, /Do not invent follow-up work, split a complete outcome or add an approval gate/);
  assert.match(owner, /Choose the fewest target states that enable it/);
  assert.match(owner, /withdraw a still-waiting subscription if the follow-up is no longer needed/);
  assert.match(owner, /create B at once as an unassigned Task with `blocked_by` and a complete description instead of subscribing; private notes never wake you/);
  assert.match(owner, /`event=blocker_cancelled`\) card, reassess before dispatching or revising B/);
  assert.match(owner, /undecided follow-up may be a pending-decision planning Task, dispatched to a new session that discusses it with the user/);
  assert.match(owner, /`blocked_by` readiness gates, not workflow engines/);
  assert.doesNotMatch(owner, /Tasks are flat/);
  assert.match(owner, /act only if it is still needed and authorized/);
  const ownerPrompt = prose(readFileSync(join(root, 'roles/task-node.md'), 'utf8'));
  assert.match(ownerPrompt, /Default to no subscription; register only when a future status unlocks necessary authorized orchestrator work/);
  assert.match(ownerPrompt, /Assignees ask users directly, without orchestrator relay/);
  const executor = prose(roleGuide('assignee'));
  assert.match(executor, /Do not wait for your orchestrator to subscribe or read a notice before continuing authorized work or delivering it/);
  const executorPrompt = prose(readFileSync(join(root, 'roles/task-node.md'), 'utf8'));
  assert.match(executorPrompt, /Subtasks of your Task notify you when done, blocked or cancelled/);
  for (const role of ['orchestrator', 'assignee']) {
    const writes = prose(readFileSync(join(root, treeDirectory, 'references/task-writes-and-recovery.md'), 'utf8'));
    assert.match(writes, /Default to no subscription/);
    assert.match(writes, /concrete, necessary authorized orchestrator follow-up, not simply to track progress, know completion or repeat a report/);
    assert.match(writes, /direct user question, even when blocked, stays in that session/);
    assert.match(writes, /the orchestrator does not subscribe to relay it or turn it into an acceptance step/);
    assert.match(writes, /standalone delivery with no orchestrator action needs no wait/);
    assert.match(writes, /The orchestrator judges this need without asking the user to name or approve the subscription/);
    assert.match(writes, /If that action is no longer needed, withdraw the still-waiting subscription/);
    assert.match(writes, /The assignee's authorized work never waits for the orchestrator to subscribe or read a notice/);
    assert.match(writes, /Sequenced follow-up uses \[Task dependencies\]\(#task-dependencies-blocked_by\), not per-prerequisite subscriptions/);
    assert.match(writes, /create B immediately as an unassigned Task with `blocked_by` and its complete description/);
    assert.match(writes, /Keep one-shot subscriptions for other necessary follow-ups/);
    assert.match(writes, /Private orchestrator notes, todos and plans trigger no reminder: without a dependency or subscription, a status-dependent follow-up waits until the user prompts it/);
    assert.match(writes, /reject `TASK_NOT_READY` otherwise, before any assignee check; there is no override/);
    assert.match(writes, /Readiness never changes status, assigns, starts or dispatches/);
    assert.match(writes, /sends one `\[Subtask ready\]\(task:<uuid>\?event=ready\)` card for the dependent to its orchestrator/);
    assert.match(writes, /When a blocker is cancelled, it sends one `\[Subtask blocker cancelled\]\(task:<uuid>\?event=blocker_cancelled\)`/);
    assert.match(writes, /There is no polling, automatic assignment, reminder or workflow engine/);
    assert.match(writes, /unassigned planning Task `blocked_by` its prerequisites/);
    assert.match(writes, /pending decision \(what must be discussed, candidate items, links\) and must not be executed before that discussion/);
    assert.match(writes, /assign it to a new session rather than claiming it yourself/);
    assert.match(writes, /cancel it with the user's decision as the reason\. This is guidance only: no new status, kind or tool/);
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

test('selective read examples match the overview contract without replacing execution checkpoints', () => {
  for (const role of ['orchestrator', 'assignee']) {
    const source = readFileSync(join(root, treeDirectory, 'references/reading-tasks.md'), 'utf8');
    const reading = prose(source);
    for (const requirement of [
      /`include` is valid only with `view="overview"`/,
      /nonempty array of at most seven unique group names/,
      /Unknown names, duplicates, empty arrays and use with other views are invalid/,
      /Omitting `include` preserves every existing view's shape/,
      /not arbitrary columns or a role-dependent projection/,
      /Context is always returned even if not explicit/,
      /Latest complete activity record or null/,
      /Latest complete outcome record or null.*excluding nested retro/,
      /text including explicit null and provenance/,
      /Current full description, references and metadata nested with revision, author, at, source and current/,
      /Definition author and `at` identify the description revision, not later material edits/,
      /Full immutable script\/parameter snapshot and run facts, or null; no logs/,
      /Cancellation object or null/,
      /retain IDs, revision, `current`, source, author, assignee and `at`/,
      /latest recorded retro is independent of the latest outcome/,
      /Selecting outcome does not implicitly select retro/,
      /one bounded call where possible, not a fixed overview-plus-outcomes sequence/,
      /speculative outcomes-then-activity, or every group/,
      /one SQLite read transaction/,
      /Unselected bodies, logs and histories are not retrieved/,
      /48,000 serialized JSON character budget/,
      /`RESULT_TOO_LARGE` \(413\) with group sizes/,
      /not truncation, a cursor or a cached continuation/,
      /Narrow the groups or use existing full `execution` \/ `definition` views or bounded history and log pages/,
      /`definition_check` is unchanged and reads never ACK/,
      /The assignee still reads full `execution` at start, resume and checkpoints and ACKs the exact current revision/,
      /Selecting `definition` or any other overview groups cannot replace that requirement/,
    ]) assert.match(reading, requirement, `${role}: ${requirement}`);
    for (const field of ['id', 'task_id', 'title', 'orchestrator', 'assignee', 'status', 'revision',
      'acknowledged_revision', 'created_at', 'updated_at', 'write_context', 'kind']) {
      const context = reading.match(/Every selected response includes compact current context: (.*?)\. Context/)?.[1];
      assert.ok(context?.includes(`\`${field}\``), `${role}: always-returned context field ${field}`);
    }
    const examples = [...source.matchAll(/```json\n([\s\S]*?)\n```/g)].map(([, json]) => JSON.parse(json));
    assert.deepEqual(examples.map(example => example.include),
      [['context'], ['outcome'], ['activity', 'outcome'], ['retro']],
      'Each question selects only its needed content; examples are not a universal bundle');
    for (const example of examples) {
      const parsed = schemas.task_read.safeParse(example);
      assert.ok(parsed.success, parsed.error?.message);
      assert.deepEqual(parsed.data, example, 'Selections must be preserved, not silently stripped');
    }
    const base = examples[0];
    for (const include of [[], ['context', 'context'], ['description'], ['logs']]) {
      assert.equal(schemas.task_read.safeParse({ ...base, include }).success, false);
    }
    for (const view of ['execution', 'definition', 'activity', 'outcomes']) {
      assert.equal(schemas.task_read.safeParse({ ...base, view }).success, false,
        `include must not silently alter ${view}`);
    }
    assert.ok(schemas.task_read.safeParse({ ...base,
      include: ['context', 'activity', 'outcome', 'retro', 'definition', 'automation', 'cancellation'],
    }).success, 'All seven groups are supported, but not recommended as a default');
    const { include, ...legacy } = base;
    assert.deepEqual(schemas.task_read.parse(legacy), legacy, 'Omission retains the legacy read contract');
  }
});

test('automation guidance preserves Agent default, explicit service execution and bounded evidence', () => {
  const owner = prose(roleGuide('orchestrator'));
  assert.match(owner, /Agent remains the default/);
  assert.match(owner, /trusted repeatable known script.*not to bypass delegation for arbitrary work/);
  assert.match(owner, /\[automation\]\(automation.md\)/);
  const source = readFileSync(join(root, treeDirectory, 'references/automation.md'), 'utf8');
  const automation = prose(source);
  for (const requirement of [
    /No installation, deployment or production testing is implied/,
    /Execution is exactly `executable \[\.\.\.argv, script_path, \.\.\.typedStrings\]`, with no shell/,
    /registration's parameter order, not JSON key order/,
    /Booleans are the literal strings `true` \/ `false`/,
    /script selection and inputs can never be edited/,
    /frozen while queued, starting or running/,
    /no assignee or fake ACK.*no session assignment slot/,
    /Do not use `task_assign`, `task_ack` or `task_report`/,
    /subscribe \*\*before start\*\*/,
    /persistent single queue.*does not subscribe automatically/,
    /Default to no subscription, just as for Agent work/,
    /next necessary authorized orchestrator action needs the result, subscribe \*\*before start\*\*/,
    /Completion confirmation or repeated reporting is not such an action/,
    /select only needed latest content in one bounded overview call where possible/,
    /No automatic resubscription, acceptance, polling/,
    /`event.source='automation'`, `event.run_id` and `actor:null`/,
    /`assignee:null`, `source:'automation'` and `author:'automation:<run_id>'`.*service label, not a native session/,
    /8192.*65536.*omitted_characters.*truncation/,
    /Recovery never reruns started work/,
    /Prelaunch queued work may resume/,
    /`kill\(-pgid,0\)` returns `ESRCH`/,
    /both durable PID and process group are absent.*reconciliation needs no probe.*launch handshake/,
    /including unreaped zombies.*`EPERM` or observation uncertainty.*keeps the barrier/,
    /until the host reaps them.*never manually edit the database or bypass the barrier/,
    /Shutdown cannot always prove exit.*blocked plus a barrier/,
    /does not kill recovered processes, rerun the script, turn blocked into done/,
    /Any repeat requires fresh authorization and a new Task/,
    /same-user trusted execution boundary, not a sandbox or authentication/,
    /must NOT daemonize, detach or escape/,
    /SHA256.*do not freeze the interpreter, runtime, imports/,
  ]) assert.match(automation, requirement);
  assert.doesNotMatch(automation, /\/proc|ignoring zombies|zombies are ignored/);

  const examples = [...source.matchAll(/```json\n([\s\S]*?)\n```/g)].map(([, json]) => JSON.parse(json));
  const tools = ['task_script_read', 'task_script_register', 'task_create', 'task_subscribe',
    'task_automation_start', 'task_read', 'task_read', 'task_automation_reconcile'];
  assert.equal(examples.length, tools.length, 'Keep each complete argument example schema-checked');
  examples.forEach((example, index) => {
    const parsed = schemas[tools[index]].safeParse(example);
    assert.ok(parsed.success, `${tools[index]}: ${parsed.error?.message}`);
  });
  assert.deepEqual(examples[5].include, ['outcome'], 'The result-dependent decision reads one selected result, not a fixed bundle');
  assert.deepEqual(examples[3].statuses, ['done', 'blocked'], 'Only statuses needed by the documented decision');
  const registration = examples[1], inputs = examples[2].automation.parameters;
  assert.deepEqual(registration.parameters.map(parameter => parameter.type), ['string', 'integer', 'boolean']);
  assert.deepEqual([...registration.argv, registration.script_path,
    ...registration.parameters.map(parameter => String(inputs[parameter.name]))],
  ['-I', '/srv/task-scripts/inventory.py', '/srv/inventory', '25', 'false']);

  const executor = prose(roleGuide('assignee'));
  assert.match(executor, /Automation Tasks are service-managed, not assignments to a node/);
  assert.match(executor, /do not ACK or report them/);
  assert.match(executor, /does not grant create\/start or script registration/);
  assert.match(executor, /only \[Subtask orchestration\]\(subtasks\.md\) guidance covers trusted automation, including as a Subtask/);
});

test('completion retro guidance separates evidence-based reflection from delivery and authority', () => {
  const executor = prose(roleGuide('assignee'));
  for (const requirement of [
    /After completing delivery, before done/,
    /actionable observed automation candidates/,
    /specific slow or repeated sticking point/,
    /Skill\/MCP discovery, contract or capability harness gaps/,
    /never fabricate timings/,
    /Distinguish observation from hypothesis and external waits/,
    /no mandatory multi-section template/,
    /`retro:null` when there are none, not filler/,
    /Retro is separate from outcome and blockers/,
    /does not authorize improvements, scope expansion or another dispatch/,
    /service guarantees explicit submission and persistence, not thoughtful reflection or the quality/,
    /Automation has no Agent retro/,
  ]) assert.match(executor, requirement);
  const owner = prose(roleGuide('orchestrator'));
  assert.match(owner, /Read it on demand/);
  assert.match(owner, /The service adds no notification,\s+subscription or completion gate; handling it is Skill work/);
  for (const requirement of [
    /the node that created a Task,\s+its orchestrator, handles that Task's retro with findings/,
    /`task_retro_handle`/,
    /Terminal: do not revisit this retro when the follow-up finishes/,
    /Only the orchestrator handles; an assignee never handles its own retro/,
    /A reopened delivery's new retro needs its own handling/,
    /handle every Subtask retro with findings before\s+your own done/,
    /Handling is a\s+record, not authorization/,
    /go into your own retro for your orchestrator to handle in turn/,
    /Without a Task \(the root\), do not digest retros routinely\. When the user asks/,
  ]) assert.match(owner, requirement);
  assert.match(executor, /Before your done, handle each Subtask retro with findings/);
  const role = prose(readFileSync(join(root, 'roles/task-node.md'), 'utf8'));
  assert.match(role, /After delivery, do a lightweight evidence-based retro before done/);
  assert.match(role, /explicit `retro` text or `null` together with `status=done`/);
  assert.match(role, /Handle Subtask retros with `task_retro_handle` before your done; root only on request/);

  for (const roleName of ['orchestrator', 'assignee']) {
    const source = readFileSync(join(root, treeDirectory, 'references/task-writes-and-recovery.md'), 'utf8');
    const writes = prose(source);
    assert.match(writes, /Ordinary reports omit retro; only done accepts it/);
    assert.match(writes, /Missing retro is rejected, not interpreted as no findings/);
    assert.match(writes, /including an old-format replay, returns `INVALID_INPUT` before any writes/);
    assert.match(writes, /Do not auto-fill null or retry modified input with the same request ID/);
    assert.match(writes, /completion status, new outcome and retro save atomically/);
    assert.match(writes, /combined serialized `\{outcome,retro\}` is at most 16,000 characters/);
    const examples = [...source.matchAll(/```json\n([\s\S]*?)\n```/g)].map(([, json]) => JSON.parse(json));
    assert.equal(examples.length, 2, 'Include both explicit text and no-findings done examples');
    assert.equal(typeof examples[0].retro, 'string');
    assert.equal(examples[1].retro, null);
    for (const example of examples) {
      const parsed = schemas.task_report.safeParse(example);
      assert.ok(parsed.success, parsed.error?.message);
      assert.equal(example.status, 'done');
      assert.ok(example.outcome.summary);
      const { retro, ...omitted } = example;
      assert.equal(schemas.task_report.safeParse(omitted).success, false);
      assert.equal(schemas.task_report.safeParse({ ...example, status: 'in_progress' }).success, false);
    }
    const reading = prose(readFileSync(join(root, treeDirectory, 'references/reading-tasks.md'), 'utf8'));
    for (const status of ['recorded', 'not_recorded', 'not_applicable']) assert.ok(reading.includes(status));
    assert.match(reading, /Without `include`, overview\/list return the same status and attribution without `text`/);
    assert.match(reading, /description edit preserves the recorded revision and sets `current:false`/);
    assert.match(reading, /migration never invents old reflections/);
    assert.match(reading, /`has_findings` distinguishes non-null text from explicit no findings, not quality/);
  }
});

test('module packaging carries the tree Skill and shared coding Skill without evaluation resources', t => {
  const packaged = spawnSync('npm', ['run', 'package:module'], { cwd: root, encoding: 'utf8' });
  assert.equal(packaged.status, 0, packaged.error?.message ?? `${packaged.stdout}\n${packaged.stderr}`);
  const manifest = JSON.parse(readFileSync(join(root, 'cockpit.module.json'), 'utf8'));
  const archive = join(root, 'dist', `cockpit-task-${manifest.version}.tgz`);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  const expected = [
    ...treeFiles.map(file => `./${treeDirectory}/${file}`),
    `./${codingDirectory}/SKILL.md`,
  ].sort();
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
  const packagedManifest = JSON.parse(execFileSync('tar', ['-xOf', archive, './cockpit.module.json'], { encoding: 'utf8' }));
  assert.deepEqual(packagedManifest.roles.map(role => role.id), ['node']);
  for (const selected of [packagedManifest.roles]) {
    const directories = new Set(selected.flatMap(role => role.skillDirectories));
    assert.ok(directories.has('skills/github-coding'));
    const discovered = entries.filter(entry => entry.endsWith('/SKILL.md') &&
      [...directories].some(directory => entry.startsWith(`./${directory}/`)));
    assert.equal(discovered.filter(entry => entry === `./${codingDirectory}/SKILL.md`).length, 1);
    assert.equal(discovered.length, selected.length + 1);
  }
  for (const entry of expected) {
    assert.equal(execFileSync('tar', ['-xOf', archive, entry], { encoding: 'utf8' }),
      readFileSync(join(root, entry), 'utf8'), `Archive must contain the current resource: ${entry}`);
  }
  const readme = execFileSync('tar', ['-xOf', archive, './README.md'], { encoding: 'utf8' });
  assert.doesNotMatch(readme, /#exceptional-update-handoff/);
  for (const link of localLinks(readme)) {
    assert.ok(entries.includes(`./${link.split('#')[0]}`), `Packaged README link: ${link}`);
  }
  t.diagnostic(`npm run package:module produced ${archive} with three Skills and eight runtime references`);
});

test('unquoted mapping separators in either role description fail release validation', () => {
  for (const role of ['orchestrator', 'assignee']) {
    const description = `Cockpit Task ${role} role: explicit authorized work.`;
    const source = `---\nname: cockpit-task-${role}\ndescription: ${description}\n---\n`;
    assert.throws(() => skillMetadata(source), /JSON-quoted description/);
    assert.deepEqual(skillMetadata(source.replace(`description: ${description}`, `description: ${JSON.stringify(description)}`)),
      { name: `cockpit-task-${role}`, description });
  }
  assert.throws(() => skillMetadata('---\nname: cockpit-task-owner\ndescription: "invalid \\q escape"\n---\n'), SyntaxError);
});

test('delegation guidance assigns relations per Task and bounds Subtask scope', () => {
  const owner = prose(roleGuide('orchestrator'));
  const executor = prose(roleGuide('assignee'));
  for (const source of [owner, executor]) {
    assert.match(source, /Relations are per Task: assignee of your Task, orchestrator/);
    assert.match(source, /more specific than (its parent|your Task), never passed down unchanged/);
    assert.match(source, /within (the parent's|its) authorized scope/);
    assert.match(source, /integrate (their|and verify Subtask) outcomes before/);
    assert.match(source, /task-writes-and-recovery\.md#subtasks-of-your-task/);
  }
  assert.match(owner, /caps it at 3 levels; pending-decision Tasks go to a new session/);
  assert.match(executor, /Then follow \[Subtask orchestration\]\(subtasks.md\) for each Subtask/);
  for (const prompt of ['node']) {
    assert.match(prose(readFileSync(join(root, `roles/task-${prompt}.md`), 'utf8')), /orchestrate more specific Subtasks within its authorized scope/);
  }
  for (const role of ['orchestrator', 'assignee']) {
    const writes = prose(readFileSync(join(root, treeDirectory, 'references/task-writes-and-recovery.md'), 'utf8'));
    assert.match(writes, /A session's relation is decided per Task/);
    assert.match(writes, /There are no preset domain-lead identities/);
    assert.match(writes, /never passed down unchanged, and within the parent's authorized scope/);
    assert.match(writes, /The parent integrates and verifies Subtask results before completing its own Task/);
    assert.match(writes, /never fake delegation/);
    assert.match(writes, /the orchestrator does not claim them itself/);
    assert.match(writes, /capped at 3 levels: creating beneath a depth-3 Task fails with `DELEGATION_DEPTH_EXCEEDED` and saves nothing/);
    assert.match(writes, /does not change `blocked_by` readiness, notices, assignment or authority/);
    assert.match(writes, /`task_read\(view=list, parent_task_id=<Task ID>, status=all\)`/);
  }
});

test('tree Skill states the node principle, per-Task relations, Subtask cards and delegation guards', () => {
  const read = file => prose(readFileSync(join(root, treeDirectory, file), 'utf8'));
  const skill = read('SKILL.md');
  assert.match(skill, /every session is a node/);
  assert.match(skill, /If you have a Task, you own completing it\./);
  assert.match(skill, /Without a Task\*\* \(in practice the root session the user prompts directly\)/);
  assert.match(skill, /Your relation comes from Task facts, not memory/);
  assert.match(skill, /Reads return `actor_role` \(`assignee`, `orchestrator` or `none`\); notice cards say `Task …` about your Task and `Subtask …` about Tasks you orchestrate/);
  assert.doesNotMatch(skill, /As Owner|As Executor|actor_session_id/);
  const reading = read('references/reading-tasks.md');
  assert.match(reading, /\| `actor_role` \|/);
  assert.match(reading, /child_notices/);
  const links = read('references/task-links.md');
  for (const status of ['done', 'blocked', 'cancelled']) {
    assert.ok(links.includes(`[Subtask ${status}](task:<uuid>?event=child_${status})`), status);
  }
  assert.ok(links.includes('[Task assigned](task:<uuid>?event=assigned)'));
  assert.ok(links.includes('[Task assigned to you](task:<uuid>?event=assigned)'), 'Legacy unprefixed labels stay recognized');
  assert.ok(links.includes('[As Owner: child Task done](task:<uuid>?event=child_done)'), 'Legacy prefixed labels stay recognized');
  const writes = read('references/task-writes-and-recovery.md');
  for (const code of ['SELF_ASSIGNMENT', 'DELEGATION_CYCLE', 'BLOCKER_ANCESTOR']) assert.match(writes, new RegExp(`\`${code}\``));
  assert.doesNotMatch(writes, /DELEGATION_OWNER_MISMATCH|BLOCKER_OWNER_MISMATCH|actor_session_id/);
  assert.match(read('references/own-task.md'), /`Subtask done`, `Subtask blocked` or `Subtask cancelled` card/);
  assert.match(read('references/subtasks.md'), /`Subtask done`, `Subtask blocked` or `Subtask cancelled` card/);
  const node = prose(readFileSync(join(root, 'roles/task-node.md'), 'utf8'));
  assert.doesNotMatch(node, /cockpit-task-owner|cockpit-task-executor/);
  assert.match(node, /cockpit-task-tree/);
});

test('tree Skill follows the node-perspective structure with Subtask topology, conflict checks and re-planning', () => {
  const read = file => prose(readFileSync(join(root, treeDirectory, file), 'utf8'));
  const skill = readFileSync(join(root, treeDirectory, 'SKILL.md'), 'utf8');
  assert.deepEqual([...skill.matchAll(/^## (\d)\. (.+)$/gm)].map(([, n, title]) => `${n}. ${title}`), [
    '1. Principle: every session is a node',
    '2. Doing your own Task',
    '3. Orchestrating Subtasks',
    '4. Root node: no Task of your own',
    '5. Mechanics references',
  ]);
  assert.match(prose(skill), /identity from the host, never from a parameter/);
  const subtasks = read('references/subtasks.md');
  for (const requirement of [
    /check every unfinished Task \(`todo`, `in_progress`, `blocked` and `in_review`, whether or not it is assigned and whoever created it; not `done` or `cancelled`\)/,
    /same repository, the same files or the same scope\. This is your judgment; the service does not check it/,
    /For a Subtask not yet dispatched, add `blocked_by`/,
    /never to an ancestor of the dependent Task \(the service rejects that with `BLOCKER_ANCESTOR`/,
    /write the coordination order into each one's requirements and send the affected assignee one \[important update\]/,
    /makes an existing Subtask obsolete.*revise it, change its dependencies or cancel it with a recorded reason/,
    /Do not leave stale work running or waiting/,
    /The service rejects assigning a Task to its own orchestrator for every node/,
    /task_read\(view=list, orchestrator=<your session ID>\)/,
  ]) assert.match(subtasks, requirement);
  assert.match(prose(skill), /You are still their orchestrator: check conflicts and order before dispatching, exactly as in section 3, but do not follow their progress/);
  for (const file of treeFiles) {
    assert.doesNotMatch(readFileSync(join(root, treeDirectory, file), 'utf8'), /actor_session_id|"owner"|DELEGATION_OWNER_MISMATCH|BLOCKER_OWNER_MISMATCH/, file);
  }
  const writes = read('references/task-writes-and-recovery.md');
  assert.match(writes, /`_meta\["cockpit\/invocation"\]`, and the service rejects a call without it \(`INVOCATION_REQUIRED`\)/);
  assert.match(writes, /Calls from your subagents are attributed to your session and recorded as subagent calls/);
  assert.match(writes, /`task_create` has no owner parameter: the calling session becomes `orchestrator`/);
  const node = prose(readFileSync(join(root, 'roles/task-node.md'), 'utf8'));
  assert.match(node, /check all unfinished Tasks for conflicts and order with `blocked_by`/);
  assert.doesNotMatch(node, /Owner|Executor/);
});
