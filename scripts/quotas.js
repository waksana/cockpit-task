import { fileURLToPath } from 'node:url';
import { toolDescriptions } from '../src/task-board/tool-descriptions.js';
import { formatQuotaReport, measureToolDescriptionQuota, readMarkdownQuotas } from './prompt-quotas.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const usages = [
  ...readMarkdownQuotas(root),
  ...Object.entries(toolDescriptions).map(([name, description]) => measureToolDescriptionQuota({ name, description })),
];
console.log(formatQuotaReport(usages));
process.exitCode = usages.some(usage => usage.exceeded) ? 1 : 0;
