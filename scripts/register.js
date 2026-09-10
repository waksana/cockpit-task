import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

if (!process.argv.includes('--confirm')) throw new Error('Global registration needs explicit --confirm authorization');
const release = resolve(process.argv[2]);
if (!existsSync(join(release, 'src/mcp.js'))) throw new Error('Supply an installed release path');
const configPath = join(homedir(), '.copilot/mcp-config.json');
const original = readFileSync(configPath, 'utf8'), config = JSON.parse(original);
config.mcpServers ??= {};
if (config.mcpServers['work-commander']) throw new Error('work-commander is already registered; inspect rather than replace');
config.mcpServers['work-commander'] = {
  type: 'local', command: process.execPath, args: [join(release, 'src/mcp.js')], tools: ['*'],
};
// Preserve every unrelated definition; never include credentials in MCP config.
if (readFileSync(configPath, 'utf8') !== original) throw new Error('MCP configuration changed concurrently');
const temporary = `${configPath}.work-commander-${process.pid}`;
writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
renameSync(temporary, configPath);
for (const name of ['work-commander', 'work-commander-owner']) {
  const target = join(homedir(), '.copilot/skills', name);
  if (existsSync(target)) throw new Error(`Skill ${name} already exists; not overwriting it`);
  mkdirSync(join(homedir(), '.copilot/skills'), { recursive: true });
  symlinkSync(join(release, 'skills', name), target);
}
console.log('Registered independent MCP and skills. REQUIRED: set native global MCP default OFF, then refresh MCP/skills; do not reload other sessions.');
