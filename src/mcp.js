import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { schemas, descriptions } from './contracts.js';
import { readCredential } from './store.js';
import { dataDirectory } from './module.js';

const url = process.env.WORK_URL ?? 'http://127.0.0.1:8790';
const parsed = new URL(url);
if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new Error('MCP requires a local work service');
const credentialRoot = realpathSync(process.env.WORK_CREDENTIAL_DIR ?? join(dataDirectory(), 'credentials'));
const server = new McpServer({ name: 'work-commander', version: '1.2.3' });
for (const [name, schema] of Object.entries(schemas)) {
  server.registerTool(name, {
    description: descriptions[name],
    inputSchema: schema.safeExtend({ credential: z.string().min(1).max(2048).describe('Protected credential FILE PATH issued for your caller/owner scope. Never token contents or a self-claimed session ID.') }),
    annotations: { readOnlyHint: name === 'work_read', destructiveHint: false, idempotentHint: true,
      openWorldHint: ['work_dispatch', 'work_deliver', 'work_recover'].includes(name) },
  }, async ({ credential, ...input }) => {
    try {
      const path = realpathSync(credential), rel = relative(credentialRoot, path);
      if (rel.startsWith('..') || isAbsolute(rel) || path !== credential) throw new Error('Credential path must be canonical and inside the managed credential directory');
      const response = await fetch(`${url}/api/tools/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${readCredential(path)}` },
        body: JSON.stringify(input), signal: AbortSignal.timeout(240000), redirect: 'error',
      });
      const result = await response.json();
      return { content: [{ type: 'text', text: JSON.stringify(result) }],
        isError: !response.ok || ['failed', 'unknown'].includes(result.operation?.status) };
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'CLIENT_ERROR', message: `${error.message}. If a mutation may have reached the service, read the task or reuse EXACTLY the same idempotency key/input; do not issue a new key.` }) }], isError: true };
    }
  });
}
await server.connect(new StdioServerTransport());
