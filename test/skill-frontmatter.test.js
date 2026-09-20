import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';
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
