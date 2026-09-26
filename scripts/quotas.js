import { fileURLToPath } from 'node:url';
import { toolDescriptions } from '../src/task-board/tool-descriptions.js';
import { completeToolEntries } from '../src/task-board/tool-names.js';
import { formatQuotaReport, measureToolDescriptionQuota, readMarkdownQuotas } from './prompt-quotas.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const usages = [
  ...readMarkdownQuotas(root),
  ...completeToolEntries(toolDescriptions, 'MCP descriptions')
    .map(([name, description]) => measureToolDescriptionQuota({ name, description })),
];
console.log(formatQuotaReport(usages));
process.exitCode = usages.some(usage => usage.exceeded) ? 1 : 0;
