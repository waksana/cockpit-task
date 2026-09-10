import Fastify from 'fastify';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { ZodError } from 'zod';
import { Store, WorkError, fail } from './store.js';
import { Cockpit } from './cockpit.js';
import { Work } from './work.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export function createApp({ store, cockpit, port = 8790, publicUrl = `http://127.0.0.1:${port}`, cockpitWeb } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 65536, requestTimeout: 240000, forceCloseConnections: true });
  const work = new Work(store, cockpit, { publicUrl, cockpitWeb });
  const origin = new URL(publicUrl).origin;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, new URL(publicUrl).host]);
  function auth(req, browser = false) {
    let token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
    if (!token && browser) token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('wc_view='))?.slice(8);
    return store.authenticate(token);
  }
  app.addHook('onRequest', async (req, reply) => {
    fail(!hosts.has(req.headers.host), 'INVALID_HOST', 'Use the configured loopback host', 403);
    if (req.headers.origin) fail(![origin, `http://localhost:${port}`].includes(req.headers.origin), 'INVALID_ORIGIN', 'Cross-origin access denied', 403);
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
  app.get('/health', async () => ({ ok: store.get('PRAGMA quick_check').quick_check === 'ok',
    version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, release: basename(root) }));
  for (const [route, file, type] of [['/', 'index.html', 'text/html'], ['/app.js', 'app.js', 'text/javascript'], ['/style.css', 'style.css', 'text/css']]) {
    app.get(route, async (req, reply) => reply.type(type).send(readFileSync(join(root, 'web', file))));
  }
  app.post('/api/login', async (req, reply) => {
    fail(!req.body || Object.keys(req.body).some(k => k !== 'token'), 'INVALID_INPUT', 'Supply viewer token only', 400);
    const principal = store.authenticate(req.body.token);
    fail(principal.role !== 'viewer', 'FORBIDDEN', 'Browser login requires read-only viewer credential', 403);
    reply.header('set-cookie', `wc_view=${req.body.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
    return { ok: true };
  });
  app.post('/api/logout', async (req, reply) => {
    reply.header('set-cookie', 'wc_view=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return { ok: true };
  });
  app.post('/api/tools/:name', async req => work.execute(auth(req), req.params.name, req.body));
  app.post('/api/read', async req => work.execute(auth(req, true), 'work_read', req.body));
  app.get('/api/events', async (req, reply) => {
    const principal = auth(req, true);
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
    const close = () => { clearInterval(timer); work.listeners.delete(changed); };
    reply.raw.on('close', close);
  });
  return { app, work };
}

async function main() {
  if (process.env.WORK_LOCK_HELD !== '1') throw new Error('Start via npm start / src/launch.js to acquire the process lock');
  const directory = process.env.WORK_DATA_DIR ?? join(homedir(), '.local/state/work-commander');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // The launcher holds a kernel flock; recovery is only safe with one service writer.
  const store = new Store(directory);
  store.recoverInterrupted();
  const port = Number(process.env.WORK_PORT ?? 8790);
  const cockpit = new Cockpit({ url: process.env.COCKPIT_URL, token: process.env.COCKPIT_API_TOKEN });
  const { app } = createApp({ store, cockpit, port, cockpitWeb: process.env.COCKPIT_WEB_URL });
  const stop = async () => { await app.close(); store.close(); process.exit(0); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  await app.listen({ host: '127.0.0.1', port });
  console.log(`Work Commander listening on http://127.0.0.1:${port}`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
