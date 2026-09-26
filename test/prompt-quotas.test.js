import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  MARKDOWN_QUOTAS, MCP_DESCRIPTION_QUOTA, QUOTA_UNIT, formatQuotaReport, markdownBody,
  measureMarkdownQuota, measureToolDescriptionQuota, readMarkdownQuotas,
} from '../scripts/prompt-quotas.js';
import { toolDescriptions } from '../src/task-board/tool-descriptions.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'task-prompt-quotas-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of [
    'package.json', 'scripts/quotas.js', 'scripts/prompt-quotas.js', 'src/task-board/tool-descriptions.js',
    ...MARKDOWN_QUOTAS.map(quota => quota.path),
  ]) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(new URL(`../${file}`, import.meta.url), target);
  }
  return root;
}

const runScript = root => spawnSync(process.execPath, [join(root, 'scripts/quotas.js')], {
  cwd: tmpdir(), encoding: 'utf8',
});

test('prompt quotas are fixed approved maxima and exclude github-coding', () => {
  assert.deepEqual(MARKDOWN_QUOTAS.map(({ path, limit, frontmatter }) => [path, limit, frontmatter]), [
    ['roles/task-node.md', 2300, false],
    ['skills/cockpit-task-tree/cockpit-task-tree/SKILL.md', 9500, true],
    ['skills/cockpit-task-tree/cockpit-task-tree/references/automation.md', 3400, false],
  ]);
  assert.equal(MCP_DESCRIPTION_QUOTA, 1399, 'MCP descriptions must remain strictly below 1400');
  assert.ok(Object.isFrozen(MARKDOWN_QUOTAS));
  for (const quota of MARKDOWN_QUOTAS) assert.ok(Object.isFrozen(quota));
});

test('Markdown quotas accept the exact maximum and reject one extra code unit', () => {
  for (const quota of MARKDOWN_QUOTAS) {
    const header = quota.frontmatter ? '---\r\nname: example\r\ndescription: "not counted"\r\n---\r\n' : '';
    const source = size => `${header}\r\n  ${'a'.repeat(size)} \r\n`;
    const exact = measureMarkdownQuota(quota, source(quota.limit));
    assert.deepEqual(exact, {
      object: quota.path, used: quota.limit, limit: quota.limit, remaining: 0, unit: QUOTA_UNIT, exceeded: false,
    });
    const over = measureMarkdownQuota(quota, source(quota.limit + 1));
    assert.equal(over.used, quota.limit + 1);
    assert.equal(over.remaining, -1);
    assert.equal(over.exceeded, true);
  }
});

test('Markdown normalizes CRLF and CR but retains internal whitespace and rules', () => {
  const body = 'First  line.\n\n---\nKeep\tthis rule.';
  const source = `---\nname: example\ndescription: "an --- inline separator"\n---\n\n ${body} \n`;
  for (const newline of ['\n', '\r\n', '\r']) {
    const input = source.replaceAll('\n', newline);
    assert.equal(markdownBody(input, true), body);
    assert.equal(measureMarkdownQuota(MARKDOWN_QUOTAS[1], input).used, body.length);
    assert.equal(markdownBody(input), source.trim(), 'Only Skill bodies exclude frontmatter');
  }
});

test('only complete leading Skill frontmatter is excluded, including an empty header or body', () => {
  assert.equal(markdownBody('---\n---\nBody', true), 'Body');
  assert.equal(markdownBody('---\nname: example\n---', true), '');
  for (const source of ['Intro\n---\nKeep this\n---\nEnd', '---\nname: unclosed\nBody']) {
    assert.equal(markdownBody(source, true), source);
  }
  assert.equal(markdownBody('\r\n \t'), '');
});

test('characters mean String.length, including BMP, emoji and combining code units', () => {
  const text = '\u6c49\u{1f680}e\u0301';
  const usage = measureMarkdownQuota(MARKDOWN_QUOTAS[0], ` \r\n${text}\r\n `);
  assert.equal(usage.used, 5);
  assert.equal(usage.used, text.length);
  assert.equal(usage.unit, 'UTF-16 code units');
  assert.equal(measureToolDescriptionQuota({ name: 'unicode', description: text }).used, 5);
});

test('MCP descriptions use raw strings and enforce the exclusive upper bound', () => {
  const exact = measureToolDescriptionQuota({ name: 'example', description: 'a'.repeat(MCP_DESCRIPTION_QUOTA) });
  assert.equal(exact.used, 1399);
  assert.equal(exact.remaining, 0);
  assert.equal(exact.exceeded, false);
  const over = measureToolDescriptionQuota({ name: 'example', description: 'a'.repeat(MCP_DESCRIPTION_QUOTA + 1) });
  assert.equal(over.used, 1400);
  assert.equal(over.remaining, -1);
  assert.equal(over.exceeded, true);
  const description = ' \r\n\u6c49\u{1f680}\t ';
  assert.equal(measureToolDescriptionQuota({ name: 'raw', description }).used, 8);
  const withHeader = '---\r\nname: not-markdown\r\n---\r\nBody\r\n';
  assert.equal(measureToolDescriptionQuota({ name: 'raw', description: withHeader }).used, withHeader.length);
});

test('npm run quotas reports every object without installed dependencies', t => {
  const root = fixture(t);
  assert.equal(existsSync(join(root, 'node_modules')), false);
  const result = spawnSync('npm', ['run', 'quotas'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
  const usages = [
    ...readMarkdownQuotas(root),
    ...Object.entries(toolDescriptions).map(([name, description]) => measureToolDescriptionQuota({ name, description })),
  ];
  assert.ok(result.stdout.endsWith(`${formatQuotaReport(usages)}\n`));
  assert.equal(result.stdout.split('\n').filter(line => line.includes(' | ')).length, usages.length + 1);
  assert.match(result.stdout, /Object \| Used \| Limit \| Remaining \| Unit \| Status/);
  assert.doesNotMatch(result.stdout, /github-coding|EXCEEDED/);
});

test('CLI reports negative remaining capacity and exits nonzero for Markdown or MCP overflow', t => {
  for (const kind of ['markdown', 'mcp']) {
    const root = fixture(t);
    let object;
    if (kind === 'markdown') {
      const quota = MARKDOWN_QUOTAS[0];
      writeFileSync(join(root, quota.path), 'a'.repeat(quota.limit + 1));
      object = quota.path;
    } else {
      const descriptions = { ...toolDescriptions, task_read: 'a'.repeat(MCP_DESCRIPTION_QUOTA + 1) };
      writeFileSync(join(root, 'src/task-board/tool-descriptions.js'),
        `export const toolDescriptions = ${JSON.stringify(descriptions)};\n`);
      object = 'MCP task_read';
    }
    const result = runScript(root);
    assert.equal(result.status, 1, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
    const row = result.stdout.split('\n').find(line => line.startsWith(`${object} | `));
    assert.ok(row, result.stdout);
    assert.ok(row.endsWith(` | -1 | ${QUOTA_UNIT} | EXCEEDED`), row);
    assert.match(result.stdout, /1 prompt quota\(s\) exceeded\./);
    assert.doesNotMatch(result.stdout, /All prompt quotas are within/);
  }
});

test('CLI surfaces a missing prompt file instead of reporting success', t => {
  const root = fixture(t);
  rmSync(join(root, MARKDOWN_QUOTAS[0].path));
  const result = runScript(root);
  assert.equal(result.status, 1, result.error?.message ?? result.stderr);
  assert.match(result.stderr, /ENOENT/);
  assert.doesNotMatch(result.stdout, /All prompt quotas are within/);
});
