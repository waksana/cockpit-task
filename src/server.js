import Fastify from 'fastify';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { Store, WorkError, fail, readCredential } from './store.js';
import { Cockpit } from './cockpit.js';
import { Work } from './work.js';
import { Lifecycle } from './lifecycle.js';
import { captureRuntime } from './runtime.js';
import { timingSafeEqual } from 'node:crypto';
import { dataDirectory, ModuleManager, normalizeBasePath } from './module.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export function createApp({ store, cockpit, port = 8790, publicUrl = `http://127.0.0.1:${port}`, cockpitWeb,
  gatewayUrl, moduleGatewayUrl, basePath = '', gatewayStreamMs = 60000,
  moduleVersion, moduleManagerCredential = process.env.WORK_MODULE_MANAGER_CREDENTIAL,
  lifecycle = new Lifecycle(), runtime = captureRuntime(), adminToken = process.env.WORK_ADMIN_TOKEN } = {}) {
  basePath = normalizeBasePath(basePath);
  const gateways = [gatewayUrl, moduleGatewayUrl].filter(Boolean).map(value => {
    const gateway = new URL(value);
    if (gateway.protocol !== 'https:' || gateway.origin !== value ||
      gateway.username || gateway.password || gateway.port) throw new Error('gatewayUrl must be a canonical HTTPS origin');
    return gateway;
  });
  const gateway = gateways.find(value => value.origin === gatewayUrl);
  const moduleGateway = gateways.find(value => value.origin === moduleGatewayUrl);
  const managerToken = moduleManagerCredential ? readCredential(moduleManagerCredential) : null;
  if (managerToken && (managerToken.length < 32 || managerToken.length > 200)) throw new Error('Invalid module manager credential');
  if (!Number.isInteger(gatewayStreamMs) || gatewayStreamMs < 1 || gatewayStreamMs > 60000) throw new Error('Gateway streams must reauthorize within 60 seconds');
  const app = Fastify({ logger: false, bodyLimit: 65536, requestTimeout: 240000, forceCloseConnections: true });
  const publicBasePath = moduleGateway && gateway && new URL(publicUrl).origin === gateway.origin &&
    gateway.origin !== moduleGateway.origin ? '' : basePath;
  const work = new Work(store, cockpit, { publicUrl, cockpitWeb, lifecycle, basePath: publicBasePath, moduleVersion });
  const manager = new ModuleManager(store, cockpit);
  const origin = new URL(publicUrl).origin;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, new URL(publicUrl).host]);
  for (const value of gateways) hosts.add(value.host);
  const origins = new Set([origin, `http://127.0.0.1:${port}`, `http://localhost:${port}`, ...gateways.map(value => value.origin)]);
  const gatewayReads = new Set(['/', '/app.js', '/style.css', '/api/events']);
  const viaGateway = req => gateways.some(value => req.headers.host === value.host);
  const requestBasePath = req => moduleGateway && gateway && req.headers.host === gateway.host &&
    gateway.host !== moduleGateway.host ? '' : basePath;
  function auth(req) {
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
    return store.authenticate(token);
  }
  app.addHook('onRequest', async (req, reply) => {
    fail(!hosts.has(req.headers.host), 'INVALID_HOST', 'Use the configured loopback host', 403);
    if (req.headers.origin) fail(!origins.has(req.headers.origin), 'INVALID_ORIGIN', 'Cross-origin access denied', 403);
    if (viaGateway(req)) {
      const path = req.raw.url.split('?')[0];
      fail(!((['GET', 'HEAD'].includes(req.method) && gatewayReads.has(path)) ||
        (req.method === 'POST' && path === '/api/read')), 'READ_ONLY_GATEWAY', 'Only dashboard reads are exposed', 404);
      // The trusted proxy replaces client credentials with its private read-only bearer.
      fail(auth(req).role !== 'viewer', 'FORBIDDEN', 'Gateway requires a read-only viewer credential', 403);
    }
    reply.headers({
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'",
    });
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: 'INVALID_INPUT', message: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 2000) });
    if (error instanceof WorkError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    if (error.statusCode === 400 || error.statusCode === 413) return reply.code(error.statusCode).send({ error: 'INVALID_REQUEST', message: 'Invalid or oversized request body' });
    console.error('Work Commander request failed:', error.code ?? error.name);
    return reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Request failed; inspect the service journal, do not blindly repeat side effects' });
  });
  app.get('/version', async () => ({ ...runtime, observedAt: new Date().toISOString() }));
  app.get('/health', async () => ({ ok: store.get('PRAGMA quick_check').quick_check === 'ok',
    version: runtime.version, release: basename(root), instanceId: runtime.instanceId,
    authority: runtime.authority, observedAt: new Date().toISOString() }));
  app.get('/status', async () => ({ ...lifecycle.status(), instanceId: runtime.instanceId,
    authority: runtime.authority, observedAt: new Date().toISOString() }));
  app.post('/admin/restart', async req => {
    fail(!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.raw.socket.remoteAddress) ||
      req.headers.origin !== undefined ||
      ['sec-fetch-site', 'sec-fetch-dest', 'sec-fetch-user'].some(name => req.headers[name] !== undefined),
    'ADMIN_LOCAL_ONLY', 'Restart requires a non-browser trusted loopback client', 403);
    if (adminToken) {
      const actual = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${adminToken}`);
      fail(actual.length !== expected.length || !timingSafeEqual(actual, expected), 'UNAUTHORIZED', 'Admin bearer credential required', 401);
    }
    fail(!req.body || req.body.pending !== true || Object.keys(req.body).length !== 1,
      'INVALID_INPUT', 'Supply only pending:true; drain cannot be cancelled', 400);
    return { ok: true, pending: true, ...lifecycle.requestRestart() };
  });
  if (managerToken) app.post('/admin/module/caller', async req => {
    fail(!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.raw.socket.remoteAddress) ||
      req.headers.origin !== undefined || Object.keys(req.headers).some(name => name.startsWith('sec-fetch-')),
    'MODULE_MANAGER_LOCAL_ONLY', 'Module management requires a non-browser trusted loopback client', 403);
    const actual = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${managerToken}`);
    fail(actual.length !== expected.length || !timingSafeEqual(actual, expected),
      'UNAUTHORIZED', 'Module manager credential required', 401);
    return lifecycle.mutation('module_caller', () => manager.provision(req.body));
  });
  for (const [route, file, type] of [['/', 'index.html', 'text/html'], ['/app.js', 'app.js', 'text/javascript'], ['/style.css', 'style.css', 'text/css']]) {
    app.get(route, async (req, reply) => {
      let content = readFileSync(join(root, 'web', file), 'utf8');
      if (file === 'index.html') {
        const prefix = requestBasePath(req);
        content = content.replace('name="task-base-path" content=""', `name="task-base-path" content="${prefix}"`)
          .replaceAll('href="/', `href="${prefix}/`).replaceAll('src="/', `src="${prefix}/`);
      }
      return reply.type(type).send(content);
    });
  }
  app.post('/api/tools/:name', async req => {
    const principal = auth(req);
    if (req.params.name !== 'work_read') lifecycle.assertAccepting();
    return work.execute(principal, req.params.name, req.body);
  });
  app.post('/api/read', async req => work.execute(auth(req), 'work_read', req.body));
  app.get('/api/events', async (req, reply) => {
    const principal = auth(req);
    fail(principal.role !== 'viewer', 'FORBIDDEN', 'Dashboard requires viewer credential', 403);
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    });
    reply.raw.write('event: ready\ndata: {}\n\n');
    const changed = () => {
      if (!reply.raw.destroyed) reply.raw.write('event: changed\ndata: {}\n\n');
    };
    work.listeners.add(changed);
    const timer = setInterval(() => {
      const active = store.get('SELECT revoked FROM credentials WHERE digest=?', principal.digest);
      if (!active || active.revoked) { reply.raw.end(); return; }
      reply.raw.write(': heartbeat\n\n');
    }, 25000);
    // Reconnect through the proxy periodically, even on a continuously active stream.
    const reauthorize = viaGateway(req) ? setTimeout(() => reply.raw.end(), gatewayStreamMs) : null;
    const close = () => { clearInterval(timer); clearTimeout(reauthorize); work.listeners.delete(changed); };
    reply.raw.on('close', close);
  });
  return { app, work, lifecycle };
}

async function main() {
  if (process.env.WORK_LOCK_HELD !== '1') throw new Error('Start via npm start / src/launch.js to acquire the process lock');
  const runtime = captureRuntime();
  const directory = dataDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // The launcher holds a kernel flock; recovery is only safe with one service writer.
  const store = new Store(directory);
  store.recoverInterrupted();
  const port = Number(process.env.WORK_PORT ?? 8790);
  const cockpit = new Cockpit({ url: process.env.COCKPIT_URL, token: process.env.COCKPIT_API_TOKEN });
  const lifecycle = new Lifecycle({ onDrained: () => {
    // Only now may Fastify close read/SSE sockets; no mutation can still be executing.
    app.close().then(() => { store.close(); process.exit(0); }).catch(error => {
      console.error(error.message); process.exitCode = 1;
    });
  } });
  const { app } = createApp({ store, cockpit, port, publicUrl: process.env.WORK_PUBLIC_URL,
    gatewayUrl: process.env.WORK_GATEWAY_URL, moduleGatewayUrl: process.env.WORK_MODULE_GATEWAY_URL,
    basePath: process.env.WORK_BASE_PATH, moduleVersion: process.env.WORK_COCKPIT_MODULE_VERSION,
    cockpitWeb: process.env.COCKPIT_WEB_URL, lifecycle, runtime });
  const stop = () => lifecycle.requestRestart();
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  await app.listen({ host: '127.0.0.1', port });
  console.log(`Work Commander listening on http://127.0.0.1:${port}`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
