import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const groups = Object.fromEntries(['backlog', 'working', 'blocked', 'decision', 'deferred', 'closed']
  .map(group => [group, { items: [], nextBefore: null }]));

async function page({ denied = false } = {}) {
  const elements = new Map(), requests = [], streams = [];
  function element() {
    return { hidden: true, value: '', textContent: '', children: [],
      replaceChildren(...children) { this.children = children; },
      append(...children) { this.children.push(...children); } };
  }
  const location = new URL('https://work.example.com/');
  const context = {
    URL, URLSearchParams, encodeURIComponent, location,
    history: { replaceState(_state, _unused, url) { location.href = url; } },
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    }, createElement: element },
    window: { addEventListener() {} },
    fetch: async (path, options) => {
      requests.push({ path, options });
      return { ok: !denied, status: denied ? 401 : 200,
        json: async () => denied ? { error: 'UNAUTHORIZED', message: 'Access denied' } : { groups } };
    },
    EventSource: class {
      listeners = {};
      constructor(path) { this.path = path; streams.push(this); }
      addEventListener(name, listener) { this.listeners[name] = listener; }
      close() { this.closed = true; }
    },
  };
  await runInNewContext(`(async () => { ${source}\n })()`, context);
  return { elements, requests, streams, location, deny() { denied = true; } };
}

test('dashboard loads data directly without discovering or managing authentication', async () => {
  const p = await page();
  assert.deepEqual(p.requests.map(r => r.path), ['/api/read']);
  assert.equal(p.elements.get('board').hidden, false);
  assert.equal(p.elements.get('reopen').hidden, true);
  assert.equal(p.streams[0].path, '/api/events');
  assert.equal(p.elements.has('login'), false);
  assert.equal(p.elements.has('logout'), false);
  assert.equal(p.requests[0].options.headers.authorization, undefined);
});

test('initial access failure does not loop, expose a login or start an unauthenticated stream', async () => {
  const p = await page({ denied: true });
  assert.equal(p.requests.length, 1);
  assert.equal(p.streams.length, 0);
  assert.equal(p.elements.get('board').hidden, true);
  assert.equal(p.elements.get('error').hidden, false);
  assert.equal(p.elements.get('reopen').href, 'https://work.example.com/');
  assert.equal(p.elements.get('reopen').hidden, false);
  assert.equal(p.location.href, 'https://work.example.com/');
});

test('expired access clears data and offers same-page navigation with task context', async () => {
  const p = await page();
  p.location.hash = 'fixture-task';
  p.deny();
  await p.streams[0].listeners.changed();
  assert.equal(p.streams[0].closed, true);
  assert.equal(p.elements.get('board').hidden, true);
  assert.equal(p.elements.get('detail').hidden, true);
  assert.equal(p.elements.get('columns').children.length, 0);
  assert.equal(p.elements.get('reopen').href, 'https://work.example.com/?task=fixture-task');
  assert.equal(p.requests.length, 2);
});
