import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const [name, input] = process.argv.slice(2);
if (!name || !input) throw new Error('Usage: node scripts/mcp-call.js TOOL_NAME JSON_ARGUMENTS (credential path, never token)');
const client = new Client({ name: 'work-commander-local-client', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath, args: [fileURLToPath(new URL('../src/mcp.js', import.meta.url))], stderr: 'inherit',
});
try {
  await client.connect(transport);
  const result = await client.callTool({ name, arguments: JSON.parse(input) });
  for (const content of result.content ?? []) if (content.type === 'text') console.log(content.text);
  if (result.isError) process.exitCode = 1;
} finally { await client.close(); }
