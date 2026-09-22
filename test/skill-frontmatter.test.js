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
const sharedReferences = ['reading-tasks.md', 'task-links.md', 'task-writes-and-recovery.md'];
const skillDirectory = role => `skills/cockpit-task-${role}/cockpit-task-${role}`;
const codingDirectory = 'skills/github-coding/github-coding';
const skillFiles = role => [
  'SKILL.md',
  ...[...sharedReferences, ...(role === 'owner' ? ['important-updates.md', 'automation.md'] : [])]
    .map(name => `references/${name}`),
].sort();
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

test('two Task role Skills and one shared coding Skill have unique YAML-safe metadata', () => {
  const files = readdirSync(join(root, 'skills'), { recursive: true })
    .filter(path => basename(path) === 'SKILL.md');
  assert.equal(files.length, 3);
  const names = new Set();
  for (const path of files) {
    const metadata = skillMetadata(readFileSync(join(root, 'skills', path), 'utf8'));
    assert.equal(metadata.name, basename(join(path, '..')), path);
    assert.ok(!names.has(metadata.name), `Duplicate skill name: ${metadata.name}`);
    names.add(metadata.name);
  }
  assert.deepEqual([...names].sort(), ['cockpit-task-executor', 'cockpit-task-owner', 'github-coding']);
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
    assertSkillClosure(directory, skillFiles(role));
    const source = readFileSync(join(directory, 'SKILL.md'), 'utf8');
    const metadata = skillMetadata(source);
    assert.equal(metadata.name, `cockpit-task-${role}`);
    assert.match(metadata.description, /first|reuse/i);
    assert.ok(source.split('\n').length < 165, 'Keep role and completion-retro principles concise; details belong in references');
    assert.match(source, /Load only the reference needed, not the whole set/);
    assert.match(source, /Reuse this Skill while it remains in context/);
    assert.match(source, /fresh Task/);
  }
  for (const reference of sharedReferences) {
    assert.equal(readFileSync(join(isolated, 'owner/references', reference), 'utf8'),
      readFileSync(join(isolated, 'executor/references', reference), 'utf8'),
      `${reference}: independent copies must retain the same shared protocol guidance`);
  }
  const coding = join(isolated, 'github-coding');
  cpSync(join(root, codingDirectory), coding, { recursive: true });
  assertSkillClosure(coding, ['SKILL.md']);
  const source = readFileSync(join(coding, 'SKILL.md'), 'utf8');
  assert.equal(skillMetadata(source).name, 'github-coding');
  assert.ok(source.split('\n').length < 130, 'Coding guidance stays a short flow, not a command catalogue');
  assert.doesNotMatch(source, /```(?:sh|bash)|git (?:checkout|reset|stash|push|clean)\b/);
});

test('coding guidance composes with roles without widening implementation or subscription authority', () => {
  for (const role of ['owner', 'executor']) {
    const source = readFileSync(join(root, skillDirectory(role), 'SKILL.md'), 'utf8');
    const section = source.match(/## Coding work\n([\s\S]*?)(?=\n## )/)?.[1];
    assert.ok(section?.includes('`github-coding`'), `${role} must independently discover the work Skill`);
    assert.ok(section.trim().split('\n').length <= 6, 'Do not duplicate the work flow in role Skills');
  }
  const prompt = prose(readFileSync(join(root, 'roles/task-owner.md'), 'utf8'));
  assert.match(prompt, /Issue\/environment preparation and safe post-merge cleanup are coordination, not permission to implement code/);
  const coding = prose(readFileSync(join(root, codingDirectory, 'SKILL.md'), 'utf8'));
  const requirements = [
    /"main" means the repository's agreed target mainline/,
    /Questions and idea exploration do not require an Issue, Task or worktree/,
    /investigation-only, patch-only or PR-only authorization stops at that boundary/,
    /existing suitable Issue or work environment rather than duplicating it/,
    /not hosted on GitHub.*skipping inapplicable Issue\/PR steps/,
    /Release\/tag creation, installation, deployment, restart and data migration are not default coding stages/,
    /clean, freshly fetched main without discarding anyone's work/,
    /not to reset, stash or delete it to look clean/,
    /Do not switch or update another worker's checkout/,
    /dedicated branch and worktree/,
    /before creating and assigning Task/,
    /not permission to implement the code personally or through Owner's subagents/,
    /one Task for the complete result/,
    /`references`.*`metadata`.*`outcome.references`/,
    /Link them rather than mirroring every comment or log/,
    /Routine post-merge worktree cleanup may be deferred or batched/,
    /does not automatically require an immediate per-Task Owner wakeup/,
    /Default to no subscription/,
    /future status unlocks specific necessary authorized Owner work/,
    /smallest one-shot subscription before assignment/,
    /Completion confirmation or repeated reporting is not that work/,
    /without polling, automatic renewal or a new script\/timer/,
    /Read the latest Task, linked Issue and repository instructions/,
    /Do not assume you inherited Owner's Skill context/,
    /independent read-only review and fixes/,
    /PR and promptly add its link to Task/,
    /exact latest PR head, not an earlier green run/,
    /Merge normally only within the authorized boundary and repository protections; never bypass them/,
    /Do not manually message Owner, directly or through subagents/,
    /Task done means Executor's agreed code result, not resource cleanup or an idle native session/,
    /PR\/branch\/worktree path/,
    /explicit release evidence: which workers have stopped using the worktree, any outstanding users and artifacts to preserve/,
    /Do not claim release while you or subagents still use it/,
    /Executor must not delete its own cwd/,
    /worktree is no longer used by Executor, subagents or other work/,
    /If cleanup is blocked, ask the user directly in this session about the specific blocker and the decision or condition needed to continue, using `ask_user` when available/,
    /Ask one focused question at a time/,
    /Do not merely say you are waiting or imply you will wake automatically/,
    /consumed done subscription does not notify again when the environment clears/,
    /On the user's answer or explicit continuation, reread Task\/PR and recheck workspace use and files before resuming cleanup/,
    /an answer alone does not prove it is safe/,
    /Do not create another Task, resubscribe to done or start polling/,
    /uncommitted, untracked, ignored or otherwise needed artifacts and unmerged work/,
    /including squash or rebase merges/,
    /only this work's merged temporary worktree and local\/remote branches/,
    /except those retained by repository policy/,
    /Only then call the complete coding flow finished/,
    /not another Task, new status or mandatory acceptance gate/,
  ];
  for (const requirement of requirements) assert.match(coding, requirement);
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
  assert.match(owner, /Context always supplies identity, assignment, status, revision\/ACK and write context/);
  assert.match(owner, /Read `definition` before editing requirements/);
  assert.match(owner, /use histories only for a historical question/);
  assert.match(owner, /Avoid a fixed overview-then-outcomes sequence, guessing outcomes then activity, or reading every group/);
  assert.match(owner, /scan chats routinely or schedule monitoring/);

  const executor = prose(readFileSync(join(root, skillDirectory('executor'), 'SKILL.md'), 'utf8'));
  assert.match(executor, /task_read\(view=execution\)/);
  assert.match(executor, /At start, on resumption, between stages, before consequential actions and before delivery, read the latest Task/);
  assert.match(executor, /complete requirements with `task_read\(view=execution\)` and ACK the exact current revision/);
  assert.match(executor, /Selective overview reads never replace this execution read or precise ACK/);
  assert.match(executor, /Inspect `definition_check` on every Task response, including errors and replays/);
  assert.match(executor, /later ACKs do not confirm skipped revisions/);
  assert.match(executor, /complete updated Task definition with reason\/source and the decision superseded/);
  assert.match(executor, /report `done` with a new outcome in the same request/);
  assert.match(executor, /not as a mandatory Owner acceptance gate/);
  assert.match(executor, /Do not send Owner questions, confirmations, progress, blockers or completion messages, directly or via subagents/);
});

test('preparation guidance keeps professional selection and Skill body loading explicit', () => {
  const owner = prose(readFileSync(join(root, skillDirectory('owner'), 'SKILL.md'), 'utf8'));
  const executor = prose(readFileSync(join(root, skillDirectory('executor'), 'SKILL.md'), 'utf8'));
  assert.match(owner, /Exclude every Executor bound to an unfinished Task, even if native idle/);
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
  for (const role of ['owner', 'executor']) {
    const source = prose(readFileSync(join(root, skillDirectory(role), 'SKILL.md'), 'utf8'));
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
  const executor = prose(readFileSync(join(root, skillDirectory('executor'), 'SKILL.md'), 'utf8'));
  assert.match(executor, /Lead activity with meaningful new changes, findings, decisions or blockers and necessary remaining work/);
  assert.match(executor, /not a restatement of the brief/);
  assert.match(executor, /State what a blocker needs/);
  assert.match(executor, /Lead outcome with the delivered result, how it meets the agreement and remaining limitations, then necessary supporting evidence/);
  assert.match(executor, /Research results may be detailed: distinguish conclusions, reasoning and unverified points/);
});

test('explicit one-shot subscriptions preserve silent defaults, role boundaries and uncertain delivery guidance', () => {
  const owner = prose(readFileSync(join(root, skillDirectory('owner'), 'SKILL.md'), 'utf8'));
  assert.match(owner, /Owner may explicitly subscribe to specified Task states/);
  assert.match(owner, /first real matching transition ends the subscription/);
  assert.match(owner, /already matching at registration means failure, not an immediate notice/);
  assert.match(owner, /read only necessary latest content in one bounded call where possible and reassess the planned follow-up/);
  assert.match(owner, /card is not proof of complete delivery or an Executor definition-ACK instruction/);
  assert.match(owner, /Do not automatically resubscribe, poll or hold this turn open waiting/);
  const ownerPrompt = prose(readFileSync(join(root, 'roles/task-owner.md'), 'utf8'));
  assert.match(ownerPrompt, /explicit one-shot status subscription permits a system notice to Task's Owner/);
  assert.match(ownerPrompt, /Read only needed latest content on receipt, in one bounded call where possible/);
  assert.match(ownerPrompt, /No automatic resubscription or acceptance/);
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
  assert.match(owner, /identify the concrete, necessary authorized Owner action that a future Task state enables/);
  assert.match(owner, /Merely knowing progress or confirming completion, including repeated reporting, is not a reason to subscribe/);
  assert.match(owner, /Even when blocked, their direct user question is not yours to relay or answer on their behalf/);
  assert.match(owner, /Judge the need yourself; the user need not explicitly request a subscription/);
  assert.match(owner, /Do not invent follow-up work, split a complete outcome or add an approval gate/);
  assert.match(owner, /Choose the fewest target states that enable it/);
  assert.match(owner, /withdraw a still-waiting subscription if the follow-up is no longer needed/);
  assert.match(owner, /act only if it is still needed and authorized/);
  const ownerPrompt = prose(readFileSync(join(root, 'roles/task-owner.md'), 'utf8'));
  assert.match(ownerPrompt, /Default to no subscription; register only when a future status unlocks necessary authorized Owner work/);
  assert.match(ownerPrompt, /Executors ask users directly, without Owner relay/);
  const executor = prose(readFileSync(join(root, skillDirectory('executor'), 'SKILL.md'), 'utf8'));
  assert.match(executor, /Do not wait for Owner to subscribe or read a notice before continuing authorized work or delivering it/);
  const executorPrompt = prose(readFileSync(join(root, 'roles/task-executor.md'), 'utf8'));
  assert.match(executorPrompt, /Execution does not depend on Owner subscribing or reading a notice/);
  for (const role of ['owner', 'executor']) {
    const writes = prose(readFileSync(join(root, skillDirectory(role), 'references/task-writes-and-recovery.md'), 'utf8'));
    assert.match(writes, /Default to no subscription/);
    assert.match(writes, /concrete, necessary authorized Owner follow-up, not simply to track progress, know completion or repeat a report/);
    assert.match(writes, /direct user question, even when blocked, stays in that session/);
    assert.match(writes, /Owner does not subscribe to relay it or turn it into an acceptance step/);
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

test('selective read examples match the overview contract without replacing execution checkpoints', () => {
  for (const role of ['owner', 'executor']) {
    const source = readFileSync(join(root, skillDirectory(role), 'references/reading-tasks.md'), 'utf8');
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
      /retain IDs, revision, `current`, source, author, Executor and `at`/,
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
      /Executor still reads full `execution` at start, resume and checkpoints and ACKs the exact current revision/,
      /Selecting `definition` or any other overview groups cannot replace that requirement/,
    ]) assert.match(reading, requirement, `${role}: ${requirement}`);
    for (const field of ['id', 'task_id', 'title', 'owner', 'executor', 'status', 'revision',
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
  const owner = prose(readFileSync(join(root, skillDirectory('owner'), 'SKILL.md'), 'utf8'));
  assert.match(owner, /Agent remains the default/);
  assert.match(owner, /trusted repeatable known script.*not to bypass delegation for arbitrary work/);
  assert.match(owner, /\[automation\]\(references\/automation.md\)/);
  const source = readFileSync(join(root, skillDirectory('owner'), 'references/automation.md'), 'utf8');
  const automation = prose(source);
  for (const requirement of [
    /No installation, deployment or production testing is implied/,
    /Execution is exactly `executable \[\.\.\.argv, script_path, \.\.\.typedStrings\]`, with no shell/,
    /registration's parameter order, not JSON key order/,
    /Booleans are the literal strings `true` \/ `false`/,
    /script selection and inputs can never be edited/,
    /frozen while queued, starting or running/,
    /no Executor or fake ACK.*no session assignment slot/,
    /Do not use `task_assign`, `task_ack` or `task_report`/,
    /subscribe \*\*before start\*\*/,
    /persistent single queue.*does not subscribe automatically/,
    /Default to no subscription, just as for Agent work/,
    /next necessary authorized Owner action needs the result, subscribe \*\*before start\*\*/,
    /Completion confirmation or repeated reporting is not such an action/,
    /select only needed latest content in one bounded overview call where possible/,
    /No automatic resubscription, acceptance, polling/,
    /`event.source='automation'`, `event.run_id` and `actor_session_id:null`/,
    /`executor:null`, `source:'automation'` and `author:'automation:<run_id>'`.*service label, not a native session/,
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

  const executor = prose(readFileSync(join(root, skillDirectory('executor'), 'SKILL.md'), 'utf8'));
  assert.match(executor, /Automation Tasks are service-managed, not Executor assignments/);
  assert.match(executor, /do not ACK or report them/);
  assert.match(executor, /do not grant create\/start or script registration/);
  assert.match(executor, /Do not create child Tasks or add Owner capabilities/);
});

test('completion retro guidance separates evidence-based reflection from delivery and authority', () => {
  const executor = prose(readFileSync(join(root, skillDirectory('executor'), 'SKILL.md'), 'utf8'));
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
  const owner = prose(readFileSync(join(root, skillDirectory('owner'), 'SKILL.md'), 'utf8'));
  assert.match(owner, /Read it on demand/);
  assert.match(owner, /No mandatory Owner review, new notification, subscription or completion gate/);
  const role = prose(readFileSync(join(root, 'roles/task-executor.md'), 'utf8'));
  assert.match(role, /After delivery, do a lightweight evidence-based retro before done/);
  assert.match(role, /explicit `retro` text or `null` together with `status=done`/);

  for (const roleName of ['owner', 'executor']) {
    const source = readFileSync(join(root, skillDirectory(roleName), 'references/task-writes-and-recovery.md'), 'utf8');
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
    const reading = prose(readFileSync(join(root, skillDirectory(roleName), 'references/reading-tasks.md'), 'utf8'));
    for (const status of ['recorded', 'not_recorded', 'not_applicable']) assert.ok(reading.includes(status));
    assert.match(reading, /Without `include`, overview\/list return the same status and attribution without `text`/);
    assert.match(reading, /description edit preserves the recorded revision and sets `current:false`/);
    assert.match(reading, /migration never invents old reflections/);
    assert.match(reading, /`has_findings` distinguishes non-null text from explicit no findings, not quality/);
  }
});

test('module packaging carries the role Skills and shared coding Skill without evaluation resources', t => {
  const packaged = spawnSync('npm', ['run', 'package:module'], { cwd: root, encoding: 'utf8' });
  assert.equal(packaged.status, 0, packaged.error?.message ?? `${packaged.stdout}\n${packaged.stderr}`);
  const manifest = JSON.parse(readFileSync(join(root, 'cockpit.module.json'), 'utf8'));
  const archive = join(root, 'dist', `cockpit-task-${manifest.version}.tgz`);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  const expected = [
    ...['owner', 'executor'].flatMap(role => skillFiles(role).map(file => `./${skillDirectory(role)}/${file}`)),
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
  for (const selected of [[packagedManifest.roles[0]], [packagedManifest.roles[1]], packagedManifest.roles]) {
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
  for (const role of ['owner', 'executor']) {
    const description = `Cockpit Task ${role} role: explicit authorized work.`;
    const source = `---\nname: cockpit-task-${role}\ndescription: ${description}\n---\n`;
    assert.throws(() => skillMetadata(source), /JSON-quoted description/);
    assert.deepEqual(skillMetadata(source.replace(`description: ${description}`, `description: ${JSON.stringify(description)}`)),
      { name: `cockpit-task-${role}`, description });
  }
  assert.throws(() => skillMetadata('---\nname: cockpit-task-owner\ndescription: "invalid \\q escape"\n---\n'), SyntaxError);
});
