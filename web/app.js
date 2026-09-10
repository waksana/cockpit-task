const $ = id => document.getElementById(id);
const labels = { recorded: '待明确投递', dispatched: '已投递，待承接', active: '进行中', blocked: '受阻', needs_decision: '需要用户决定', result_reported: '成果已报告，未交付', delivered: '已交付', failed: '未完成', cancelled: '已取消' };
const groups = [
  ['正在做', 'working'], ['受阻', 'blocked'],
  ['需要决定', 'decision'], ['最近交付 / 结束', 'closed'],
];
let stream, pages = {}, refreshBusy = false, dirty = false, detailGeneration = 0;
function node(tag, text, className) {
  const el = document.createElement(tag); if (text !== undefined) el.textContent = text;
  if (className) el.className = className; return el;
}
function error(message) { $('error').textContent = message; $('error').hidden = !message; }
async function api(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) { const e = new Error(value.message); e.status = response.status; throw e; }
  return value;
}
function safeLink(value, label = value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return node('code', value);
    const a = node('a', label); a.href = url.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
  } catch { return node('code', value); }
}
function render() {
  $('columns').replaceChildren();
  for (const [title, group] of groups) {
    const column = node('section', undefined, 'column');
    const page = pages[group], items = page.items;
    column.append(node('h2', `${title} · ${items.length}${page.nextBefore ? '+' : ''}`));
    if (!items.length) column.append(node('p', '暂无工作', 'empty'));
    for (const task of items) {
      const card = node('button', undefined, `card ${task.status}`);
      card.append(node('span', `${labels[task.status]} · v${task.goalVersion}`, 'badge'), node('h3', task.workstream), node('p', task.summary));
      if (task.pendingOperationId) card.append(node('span', '有待处理投递操作', 'attention'));
      card.append(node('small', new Date(task.updatedAt).toLocaleString()));
      card.onclick = () => { location.hash = task.taskId; };
      column.append(card);
    }
    if (page.nextBefore) {
      const more = node('button', '更早工作');
      more.onclick = async () => {
        more.disabled = true;
        try {
          const next = await api('/api/read', { group, before: page.nextBefore, limit: 10 });
          const known = new Set(page.items.map(t => t.taskId));
          page.items.push(...next.items.filter(t => !known.has(t.taskId))); page.nextBefore = next.nextBefore; render();
        } catch (e) { error(e.message); more.disabled = false; }
      };
      column.append(more);
    }
    $('columns').append(column);
  }
}
async function detail() {
  const generation = ++detailGeneration;
  const id = location.hash.slice(1);
  if (!id) { $('detail').hidden = true; return; }
  const [task, events, operations] = await Promise.all([
    api('/api/read', { taskId: id, view: 'detail' }),
    api('/api/read', { taskId: id, view: 'events', limit: 10 }),
    api('/api/read', { taskId: id, view: 'operations', limit: 5 }),
  ]);
  if (generation !== detailGeneration) return;
  const panel = $('detail'); panel.replaceChildren(); panel.hidden = false;
  const close = node('button', '关闭详情'); close.onclick = () => { location.hash = ''; }; panel.append(close);
  panel.append(node('h2', task.workstream), node('p', `${labels[task.status]} · 目标 v${task.goalVersion} · 已承接 v${task.acceptedGoalVersion ?? '—'}`));
  for (const [label, value] of [['目标', task.goal.objective], ['范围', task.goal.scope], ['验收', task.goal.acceptance], ['授权', task.goal.authorization]]) panel.append(node('h3', label), node('p', value, 'longtext'));
  panel.append(node('h3', '结果入口'));
  for (const value of task.artifacts) panel.append(safeLink(value), node('br'));
  if (task.ownerUrl) panel.append(safeLink(task.ownerUrl, '打开 owner 会话'), node('br'));
  panel.append(safeLink(task.callerUrl, '打开讨论会话'));
  panel.append(node('h3', '投递与通知'));
  for (const op of operations.items) panel.append(node('p', `${op.kind} · ${op.status} · ${op.step ?? ''}${op.error ? ` — ${op.error}` : ''}`));
  panel.append(node('h3', '重要进展（最新 10 条）'));
  const history = node('div'); panel.append(history);
  function appendEvents(page) {
    for (const event of page.items) {
      const row = node('article', undefined, 'event');
      row.append(node('small', `${new Date(event.at).toLocaleString()} · v${event.goalVersion} · ${event.kind}`), node('p', event.summary));
      for (const artifact of event.artifacts) row.append(safeLink(artifact), node('br'));
      history.append(row);
    }
  }
  appendEvents(events);
  const more = node('button', '更早进展'); more.hidden = !events.nextBefore; let before = events.nextBefore;
  more.onclick = async () => {
    more.disabled = true;
    try { const page = await api('/api/read', { taskId: id, view: 'events', limit: 10, before }); appendEvents(page); before = page.nextBefore; more.hidden = !before; }
    catch (e) { error(e.message); } finally { more.disabled = false; }
  };
  panel.append(more);
}
async function refresh() {
  if (refreshBusy) { dirty = true; return; }
  refreshBusy = true;
  try {
    do {
      dirty = false;
      const page = await api('/api/read', { view: 'board', limit: 10 });
      pages = page.groups;
      $('login').hidden = true; $('board').hidden = false; $('logout').hidden = false;
      error(''); render(); await detail();
    } while (dirty);
  } catch (e) {
    if (e.status === 401) {
      stream?.close(); $('login').hidden = false; $('board').hidden = true; $('detail').hidden = true; $('logout').hidden = true; $('connection').textContent = '未登录';
    } else error(e.message);
  } finally { refreshBusy = false; }
}
function connect() {
  stream?.close(); stream = new EventSource('/api/events');
  stream.addEventListener('ready', () => { $('connection').textContent = '实时已连接'; refresh(); });
  stream.addEventListener('changed', refresh);
  stream.onerror = () => { $('connection').textContent = '连接中断，自动重连'; };
}
$('login').onsubmit = async e => {
  e.preventDefault();
  try { await api('/api/login', { token: $('token').value }); $('token').value = ''; await refresh(); connect(); }
  catch (e) { error(e.message); }
};
$('logout').onclick = async () => { await api('/api/logout', {}); stream?.close(); location.reload(); };
$('refresh').onclick = refresh;
window.addEventListener('hashchange', () => detail().catch(e => error(e.message)));
await refresh();
if ($('login').hidden) connect();
