import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fixtureRead, fixtureTask, groupNames } from './dashboard-fixture.js';

const root = resolve(process.argv[2] || 'web');
const port = Number(process.argv[3] || 18797);
const records = process.argv[4] === '--expanded'
  ? Object.fromEntries(groupNames.map(group => [group, Array.from({ length: 12 }, (_, i) => fixtureTask(group, i))]))
  : undefined;
const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
const clients = new Set();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' && assets[url.pathname]) {
    const [file, type] = assets[url.pathname];
    try { const data = await readFile(resolve(root, file)); res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(data); }
    catch (e) { console.error(e.message); res.writeHead(500); res.end('Preview asset could not be read'); }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('event: ready\ndata: {}\n\n');
    clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  if (req.method === 'POST' && url.pathname === '/api/read') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(fixtureRead(JSON.parse(body), records))); }
    catch (e) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: e.message })); }
    return;
  }
  // A local preview-only event, never part of the application or its data model.
  if (req.method === 'POST' && url.pathname === '/preview/changed') {
    for (const client of clients) client.write('event: changed\ndata: {}\n\n');
    res.end('sent'); return;
  }
  res.writeHead(404); res.end('Not found');
});
server.listen(port, '127.0.0.1', () => console.log(`Synthetic dashboard preview: http://127.0.0.1:${port}`));
