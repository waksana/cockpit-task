import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

test('every released skill has YAML-safe frontmatter, including both module roles and legacy roots', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const delivery = JSON.parse(readFileSync(join(root, 'service-delivery.json'), 'utf8'));
  assert.ok(delivery.build.artifactPaths.includes('skills'));
  const files = readdirSync(join(root, 'skills'), { recursive: true })
    .filter(path => basename(path) === 'SKILL.md');
  assert.ok(files.length >= 4);
  const names = new Set();
  for (const path of files) {
    const metadata = skillMetadata(readFileSync(join(root, 'skills', path), 'utf8'));
    assert.equal(metadata.name, basename(join(path, '..')), path);
    assert.ok(!names.has(metadata.name), `Duplicate skill name: ${metadata.name}`);
    names.add(metadata.name);
  }
  for (const name of ['cockpit-task-commander', 'cockpit-task-owner', 'work-commander', 'work-commander-owner']) {
    assert.ok(names.has(name), `Missing released skill: ${name}`);
  }
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
