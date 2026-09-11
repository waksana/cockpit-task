import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fixtureRead, fixtureTask, groupNames } from './dashboard-fixture.js';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

async function page({ denied = false, url = 'https://work.example.com/', records, respond } = {}) {
  const elements = new Map(), requests = [], streams = [], listeners = {};
  let focused, copied;
  class Element {
    constructor(tag = 'div') { this.tagName = tag; this.hidden = false; this.value = ''; this.children = []; this.dataset = {}; this.attributes = {}; this.text = ''; }
    set textContent(text) { this.text = String(text); this.children = []; }
    get textContent() { return this.text + this.children.map(c => c.textContent).join(''); }
    replaceChildren(...children) { this.text = ''; this.children = children; }
    append(...children) { this.children.push(...children); }
    setAttribute(key, value) { this.attributes[key] = value; }
    focus() { focused = this; }
    scrollIntoView() { this.scrolled = true; }
  }
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) elements.set(id, new Element());
  const all = () => {
    const walk = el => [el, ...el.children.flatMap(walk)];
    return [...elements.values()].flatMap(walk);
  };
  const location = new URL(url);
  const context = {
    URL, URLSearchParams, encodeURIComponent, location, console,
    navigator: { clipboard: { async writeText(text) { copied = text; } } },
    history: { replaceState(_state, _unused, value) { location.href = value; } },
    document: { getElementById(id) { return elements.get(id) || all().find(e => e.id === id); },
      createElement: tag => new Element(tag), get activeElement() { return focused; } },
    window: { scrollY: 150, scrollTo(_x, y) { this.scrollY = y; }, addEventListener(name, listener) { listeners[name] = listener; } },
    fetch: async (path, options) => {
      const body = JSON.parse(options.body);
      requests.push({ path, options, body });
      if (denied) return { ok: false, status: 401, json: async () => ({ message: 'Access denied' }) };
      if (respond) {
        const response = await respond(body);
        if (response) return response;
      }
      let result;
      try { result = fixtureRead(body, records); }
      catch (e) { return { ok: false, status: 404, json: async () => ({ message: e.message }) }; }
      return { ok: true, status: 200, json: async () => structuredClone(result) };
    },
    EventSource: class {
      static CLOSED = 2;
      listeners = {};
      constructor(path) { this.path = path; this.readyState = 1; streams.push(this); }
      addEventListener(name, listener) { this.listeners[name] = listener; }
      close() { this.closed = true; this.readyState = 2; }
    },
  };
  await runInNewContext(`(async () => { ${source}\n })()`, context);
  return { elements, requests, streams, location, context, all,
    get: id => context.document.getElementById(id),
    find: text => all().find(e => e.tagName === 'button' && e.textContent === text),
    deny() { denied = true; }, allow() { denied = false; }, copied: () => copied,
    async route(hash) { location.hash = hash; await listeners.hashchange(); },
    async search(query) { elements.get('search').value = query; await elements.get('searchForm').onsubmit({ preventDefault() {} }); },
  };
}
const expandedRecords = () => Object.fromEntries(groupNames.map(group => [group, Array.from({ length: 12 }, (_, i) => fixtureTask(group, i))]));

test('dashboard loads directly without authentication UI and renders the agreed single-list order', async () => {
  const p = await page();
  assert.deepEqual(p.requests.map(r => r.path), ['/api/read']);
  assert.equal(p.get('board').hidden, false);
  assert.equal(p.get('reopen').hidden, true);
  assert.equal(p.streams[0].path, '/api/events');
  assert.equal(p.elements.has('login'), false);
  assert.equal(p.elements.has('logout'), false);
  assert.equal(p.requests[0].options.headers.authorization, undefined);
  assert.deepEqual(p.get('columns').children.map(e => e.id), groupNames.map(group => `lane-${group}`));
  assert.match(html, /Cockpit Task/);
  assert.match(p.get('countNote').textContent, /不代表全量统计/);
  assert.equal(p.get('metric-working').children[1].textContent, '3');
});

test('initial access failure does not loop, expose a login or start an unauthenticated stream', async () => {
  const p = await page({ denied: true });
  assert.equal(p.requests.length, 1);
  assert.equal(p.streams.length, 0);
  assert.equal(p.get('board').hidden, true);
  assert.equal(p.get('error').hidden, false);
  assert.equal(p.get('loading').hidden, true);
  assert.equal(p.get('reopen').href, 'https://work.example.com/');
  assert.equal(p.get('reopen').hidden, false);
  assert.equal(p.location.href, 'https://work.example.com/');
  p.allow();
  await p.get('refresh').onclick();
  assert.equal(p.get('board').hidden, false);
  assert.equal(p.streams.length, 1);
});

test('expired access clears board, hero and detail and preserves the task context on reopening', async () => {
  const p = await page();
  await p.route('demo-working-0');
  p.deny();
  await p.streams[0].listeners.changed();
  assert.equal(p.streams[0].closed, true);
  assert.equal(p.get('board').hidden, true);
  assert.equal(p.get('detail').hidden, true);
  assert.equal(p.get('columns').children.length, 0);
  assert.equal(p.get('overviewMetrics').children.length, 0);
  assert.equal(p.get('reopen').href, 'https://work.example.com/?task=demo-working-0');
});

test('hero and filters show loaded counts with explicit lower bounds; each group paginates independently', async () => {
  const p = await page({ records: expandedRecords() });
  assert.equal(p.get('metric-working').children[1].textContent, '10+');
  await p.get('more-working').onclick();
  assert.equal(p.get('metric-working').children[1].textContent, '12');
  assert.equal(p.get('metric-backlog').children[1].textContent, '10+');
  assert.equal(p.requests.at(-1).body.group, 'working');
  p.get('filter-blocked').onclick();
  assert.deepEqual(p.get('columns').children.map(e => e.id), ['lane-blocked']);
  assert.equal(p.get('filter-blocked').attributes['aria-pressed'], 'true');
  p.get('filter-all').onclick();
  assert.equal(p.get('columns').children.length, 6);
});

test('search covers historical groups, binds pagination to query and clear resets results', async () => {
  const p = await page({ records: expandedRecords() });
  await p.search('只读');
  assert.equal(p.get('metric-working').children[1].textContent, '0');
  assert.match(p.get('lane-working').textContent, /没有匹配的工作/);
  assert.match(p.get('lane-closed').textContent, /只读/);
  assert.equal(p.requests.at(-1).body.query, '只读');
  await p.search('example');
  await p.get('more-backlog').onclick();
  assert.deepEqual(p.requests.at(-1).body, { group: 'backlog', before: 10, limit: 10, query: 'example' });
  await p.get('clearSearch').onclick();
  assert.equal(p.get('search').value, '');
  assert.equal(p.requests.at(-1).body.query, undefined);
  assert.equal(p.get('metric-backlog').children[1].textContent, '10+');
});

test('deep links render independent detail, dependencies, sources, events and copyable IDs', async () => {
  const records = expandedRecords();
  records.blocked[0].legacy = { ownerRef: 'original-owner', observedAt: '2026-09-10', observedState: 'blocked' };
  const p = await page({ url: 'https://work.example.com/?task=demo-blocked-0', records });
  assert.equal(p.location.hash, '#demo-blocked-0');
  assert.equal(p.get('board').hidden, true);
  assert.equal(p.get('detail').hidden, false);
  assert.match(p.get('detail').textContent, /目标与约定|最近报告/);
  assert(p.all().some(e => e.tagName === 'a' && e.href === 'https://example.com/design-brief'));
  assert(p.all().some(e => e.tagName === 'code' && e.textContent === '/local/example/release-notes.txt'));
  await p.find('复制').onclick();
  assert.equal(p.copied(), 'demo-blocked-0');
  await p.find('查看前置明细').onclick();
  assert.match(p.get('detail').textContent, /尚未绑定正式目标/);
  assert(p.all().some(e => e.href === '#demo-working-1'));
  await p.find('更早进展').onclick();
  assert.equal(p.requests.at(-1).body.before, 10);
  await p.route('');
  assert.equal(p.get('board').hidden, false);
  assert.equal(p.get('detail').hidden, true);
});

test('SSE preserves expanded groups and detail reading position without replacing current detail', async () => {
  const p = await page({ records: expandedRecords() });
  await p.get('more-working').onclick();
  p.context.window.scrollY = 150;
  const row = p.get('task-demo-working-0');
  row.onclick({});
  await p.route('demo-working-0');
  const title = p.get('detail-title');
  await p.streams[0].listeners.changed();
  assert.equal(p.get('detail-title'), title);
  assert.equal(p.get('detailNotice').hidden, false);
  assert.equal(p.get('metric-working').children[1].textContent, '12');
  await p.route('');
  assert.equal(p.context.window.scrollY, 150);
});

test('read errors are visible and retryable, and missing deep links have a return path', async () => {
  let fail = true;
  const p = await page({ respond: () => fail ? { ok: false, status: 503, json: async () => ({ message: '暂时不可用' }) } : null });
  assert.match(p.get('error').textContent, /暂时不可用/);
  assert.equal(p.get('loading').hidden, true);
  fail = false;
  await p.get('refresh').onclick();
  assert.equal(p.get('error').hidden, true);
  await p.route('not-found');
  assert.match(p.get('detail').textContent, /任务不存在/);
  assert(p.all().some(e => e.tagName === 'a' && e.textContent.includes('返回工作清单')));
  assert(p.find('重试读取详情'));
});

test('non-JSON responses report the failure, without pretending an empty board succeeded', async () => {
  const p = await page({ respond: () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('HTML'); } }) });
  assert.match(p.get('error').textContent, /无法读取的响应/);
  assert.equal(p.streams.length, 0);
  assert.equal(p.get('columns').children.length, 0);
});

test('late pagination cannot leak old results into a new search', async () => {
  let release, waiting = false;
  const p = await page({ records: expandedRecords(), respond: body => {
    if (waiting && body.group === 'working') return new Promise(resolve => { release = () => resolve(null); });
  } });
  waiting = true;
  const old = p.get('more-working').onclick();
  await p.search('不存在的匹配项');
  release(); await old;
  assert.equal(p.get('metric-working').children[1].textContent, '0');
  assert.match(p.get('searchResult').textContent, /不存在的匹配项/);
});

test('task text is rendered as text and non-HTTP result links stay inert', async () => {
  const p = await page({ respond: body => {
    if (body.view !== 'detail') return;
    const data = fixtureRead(body);
    data.title = '<img src=x onerror=alert(1)>';
    data.artifacts = ['javascript:alert(1)', 'https://example.com/result'];
    return { ok: true, status: 200, json: async () => data };
  } });
  await p.route('demo-working-0');
  assert.equal(p.get('detail-title').textContent, '<img src=x onerror=alert(1)>');
  assert(!p.all().some(e => e.tagName === 'img'));
  assert(!p.all().some(e => e.tagName === 'a' && e.href?.startsWith('javascript:')));
  assert(p.all().some(e => e.tagName === 'a' && e.href === 'https://example.com/result' && e.rel === 'noopener noreferrer'));
});

test('historical details preserve original-owner semantics and lazy source expansion', async () => {
  const p = await page({ respond: body => {
    if (body.view !== 'detail') return;
    const data = fixtureRead(body);
    Object.assign(data, { status: 'legacy', ownerSessionId: null, ownerUrl: null,
      legacyOwnerUrl: 'https://example.com/session/original',
      legacy: { ownerRef: 'original-owner', observedAt: '2026-09-10', observedState: 'done' },
      legacyDetail: { summary: '有来源的旧回执', notes: '保留原文' } });
    return { ok: true, status: 200, json: async () => data };
  } });
  await p.route('demo-working-0');
  assert.match(p.get('detail').textContent, /仅为历史引用，未建立执行绑定/);
  assert(!p.requests.some(r => r.body.view === 'sources'));
  await p.find('查看原始来源').onclick();
  assert.match(p.get('detail').textContent, /example:synthetic-001/);
  assert(p.all().some(e => e.tagName === 'pre' && e.textContent.includes('合成来源')));
});

test('late detail responses do not reopen a task after returning to the list', async () => {
  let release;
  const p = await page({ respond: body => body.view === 'detail' ? new Promise(resolve => { release = () => resolve(null); }) : null });
  const opening = p.route('demo-working-0');
  await p.route('');
  release(); await opening;
  assert.equal(p.get('detail').hidden, true);
  assert.equal(p.get('board').hidden, false);
});

test('initial SSE readiness does not immediately mark newly opened detail stale', async () => {
  const p = await page({ url: 'https://work.example.com/?task=demo-working-0' });
  await p.streams[0].listeners.ready();
  assert.equal(p.get('detailNotice').hidden, true);
  await p.streams[0].listeners.ready();
  assert.equal(p.get('detailNotice').hidden, false);
});
