import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Fixed approved maxima, not limits recalculated from the current prompt text.
export const MARKDOWN_QUOTAS = Object.freeze([
  Object.freeze({ path: 'roles/task-node.md', limit: 2300, frontmatter: false }),
  Object.freeze({ path: 'skills/cockpit-task-tree/cockpit-task-tree/SKILL.md', limit: 9500, frontmatter: true }),
  Object.freeze({ path: 'skills/cockpit-task-tree/cockpit-task-tree/references/automation.md', limit: 3400, frontmatter: false }),
]);
export const MCP_DESCRIPTION_QUOTA = 1399;
export const QUOTA_UNIT = 'UTF-16 code units';

export function markdownBody(source, frontmatter = false) {
  const normalized = source.replace(/\r\n?/g, '\n');
  const body = frontmatter ? normalized.replace(/^---\n(?:[\s\S]*?\n)?---(?:\n|$)/, '') : normalized;
  return body.trim();
}

function quotaUsage(object, text, limit) {
  const used = text.length;
  const remaining = limit - used;
  return { object, used, limit, remaining, unit: QUOTA_UNIT, exceeded: remaining < 0 };
}

export function measureMarkdownQuota(quota, source) {
  return quotaUsage(quota.path, markdownBody(source, quota.frontmatter), quota.limit);
}

export function readMarkdownQuotas(root) {
  return MARKDOWN_QUOTAS.map(quota =>
    measureMarkdownQuota(quota, readFileSync(join(root, quota.path), 'utf8')));
}

export function measureToolDescriptionQuota({ name, description }) {
  return quotaUsage(`MCP ${name}`, description, MCP_DESCRIPTION_QUOTA);
}

export function formatQuotaReport(usages) {
  const exceeded = usages.filter(usage => usage.exceeded).length;
  return [
    'Object | Used | Limit | Remaining | Unit | Status',
    ...usages.map(usage => [
      usage.object, usage.used, usage.limit, usage.remaining, usage.unit, usage.exceeded ? 'EXCEEDED' : 'OK',
    ].join(' | ')),
    '',
    exceeded ? `${exceeded} prompt quota(s) exceeded.` : 'All prompt quotas are within their fixed limits.',
  ].join('\n');
}
