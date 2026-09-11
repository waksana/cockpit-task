const $ = id => document.getElementById(id);
const labels = { backlog: '未开工', legacy: '历史记录', recorded: '已授权，待投递', dispatched: '已投递，待承接', active: '进行中', blocked: '受阻', needs_decision: '需要用户决定', result_reported: '成果已报告，未交付', delivered: '已交付', failed: '未完成', cancelled: '已取消' };
const observedLabels = { backlog: '未开工', working: '执行中（记录）', blocked: '受阻（记录）', decision: '待决定（记录）', deferred: '暂缓 / 待发布', done: '已结束（记录）', cancelled: '已取消（记录）', unknown: '历史状态待确认' };
const groups = [
  ['待办 · 按登记顺序', 'backlog'], ['执行', 'working'], ['受阻', 'blocked'],
  ['待决定 / 待确认', 'decision'], ['暂缓 / 待发布', 'deferred'], ['完成历史', 'closed'],
];
let stream, pages = {}, refreshBusy = false, dirty = false, detailGeneration = 0;
const initialUrl = new URL(location.href);
const initialTask = initialUrl.searchParams.get('task');
if (initialTask) {
  initialUrl.searchParams.delete('task');
  initialUrl.hash = initialTask;
  history.replaceState(null, '', initialUrl);
}
function node(tag, text, className) {
  const el = document.createElement(tag); if (text !== undefined) el.textContent = text;
  if (className) el.className = className; return el;
}
function error(message) { $('error').textContent = message; $('error').hidden = !message; }
function stateLabel(task) {
  const state = task.status === 'legacy' ? observedLabels[task.legacy.observedState] : labels[task.status];
  const disposition = { deferred: '暂缓', abandoned: '已放弃记录', archived: '已归档' }[task.disposition];
  return disposition ? `${disposition} · ${state}` : state;
}
function conditionLabel(conditions) {
  return `前置条件 ${conditions.satisfied}/${conditions.total} 满足` +
    (conditions.waiting ? ` · ${conditions.waiting} 等待交付` : '') +
    (conditions.needsConfirmation ? ` · ${conditions.needsConfirmation} 需要确认` : '');
}
async function api(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401) accessDenied();
    const e = new Error(response.status === 401 ? '访问已失效，请重新打开工作页。' : value.message);
    e.status = response.status; throw e;
  }
  return value;
}
function accessDenied() {
  stream?.close();
  pages = {}; ++detailGeneration;
  $('columns').replaceChildren(); $('detail').replaceChildren();
  $('board').hidden = true; $('detail').hidden = true;
  $('connection').textContent = '无法访问';
  const url = new URL(location.href);
  if (url.hash) url.searchParams.set('task', url.hash.slice(1));
  url.hash = '';
  $('reopen').href = url.href; $('reopen').hidden = false;
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
      card.append(node('span', `${stateLabel(task)}${task.goalVersion ? ` · v${task.goalVersion}` : ' · 未建立执行授权'}`, 'badge'), node('h3', task.title || task.workstream), node('p', task.summary));
      if (task.legacy && !task.ownerSessionId) card.append(node('small', `来源观察：${task.legacy.observedAt}；非实时会话状态`));
      if (task.pendingOperationId) card.append(node('span', '有待处理投递操作', 'attention'));
      if (task.conditions.total) card.append(node('small', conditionLabel(task.conditions)));
      card.append(node('small', new Date(task.updatedAt).toLocaleString()));
      card.onclick = () => { location.hash = task.taskId; };
      column.append(card);
    }
    if (page.nextBefore) {
      const more = node('button', '更早工作');
      more.onclick = async () => {
        more.disabled = true;
        try {
          const next = await api('/api/read', { group, before: page.nextBefore, limit: 10, ...(page.query ? { query: page.query } : {}) });
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
  panel.append(node('h2', task.title || task.workstream), node('p', `${stateLabel(task)} · 记录 r${task.recordRevision} · 目标 v${task.goalVersion} · 已承接 v${task.acceptedGoalVersion ?? '—'}`));
  panel.append(node('code', task.workstream), node('p', task.notes, 'longtext'));
  panel.append(node('h3', '前置条件'), node('p', conditionLabel(task.conditions)),
    node('p', '就绪仅表示记录的前置条件满足，不等于授权或运行就绪；不自动派工，也不改变当前执行、暂停或决策状态。'));
  if (task.conditions.total) {
    const dependencies = node('div'), load = node('button', '查看前置明细');
    let dependencyBefore;
    load.onclick = async () => {
      load.disabled = true;
      try {
        const page = await api('/api/read', { taskId: id, view: 'dependencies', limit: 10, ...(dependencyBefore ? { before: dependencyBefore } : {}) });
        for (const item of page.items) {
          const row = node('article', undefined, 'event'), link = node('a', item.title ?? item.prerequisiteId);
          link.href = `#${encodeURIComponent(item.prerequisiteId)}`;
          const reasons = { no_bound_goal: '需要确认：尚未绑定正式目标；授权后由 caller 显式重新登记',
            goal_changed: '需要确认：前置目标已变更', delivered: '满足：指定当前目标已交付', not_delivered: '等待：指定目标尚未成功交付' };
          row.append(link, node('p', `目标 v${item.prerequisiteGoalVersion ?? '—'} · ${reasons[item.reason]}`), node('p', item.note));
          dependencies.append(row);
        }
        dependencyBefore = page.nextBefore; load.hidden = !dependencyBefore; load.textContent = '更多前置条件';
      } catch (e) { error(e.message); } finally { load.disabled = false; }
    };
    panel.append(dependencies, load);
  }
  if (task.goal) {
    for (const [label, value] of [['目标', task.goal.objective], ['范围', task.goal.scope], ['验收', task.goal.acceptance], ['授权', task.goal.authorization]]) panel.append(node('h3', label), node('p', value, 'longtext'));
  } else panel.append(node('p', '尚无本服务执行授权。登记、暂缓和历史导入均不会启动 owner。'));
  if (task.legacyDetail) {
    panel.append(node('h3', '历史观察 · 不冒充服务执行回执'),
      node('p', `${task.legacy.observedAt} · ${observedLabels[task.legacy.observedState]}`),
      node('p', task.legacyDetail.summary, 'longtext'), node('p', task.legacyDetail.notes, 'longtext'));
    const sourceButton = node('button', '查看原始来源');
    let before;
    sourceButton.onclick = async () => {
      sourceButton.disabled = true;
      try {
        const page = await api('/api/read', { taskId: id, view: 'sources', limit: 3, ...(before ? { before } : {}) });
        for (const source of page.items) {
          const section = node('details'), title = node('summary', `${source.namespace}:${source.sourceKey}`);
          section.append(title, node('pre', typeof source.raw === 'string' ? source.raw : JSON.stringify(source.raw, null, 2), 'longtext'));
          panel.insertBefore(section, sourceButton);
        }
        before = page.nextBefore; sourceButton.hidden = !before;
      } catch (e) { error(e.message); } finally { sourceButton.disabled = false; }
    };
    panel.append(sourceButton);
  }
  panel.append(node('h3', '结果入口'));
  for (const value of task.artifacts) panel.append(safeLink(value), node('br'));
  if (task.ownerUrl) panel.append(safeLink(task.ownerUrl, '打开 owner 会话'), node('br'));
  else if (task.legacyOwnerUrl) panel.append(safeLink(task.legacyOwnerUrl, '历史 owner 引用（未建立执行绑定）'), node('br'));
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
      const query = $('search').value.trim();
      const page = await api('/api/read', { view: 'board', limit: 10, ...(query ? { query } : {}) });
      pages = page.groups;
      for (const lane of Object.values(pages)) lane.query = query;
      $('board').hidden = false; $('reopen').hidden = true;
      error(''); render(); await detail();
    } while (dirty);
    return true;
  } catch (e) {
    error(e.message); return false;
  } finally { refreshBusy = false; }
}
function connect() {
  stream?.close(); stream = new EventSource('/api/events');
  stream.addEventListener('ready', () => { $('connection').textContent = '实时已连接'; refresh(); });
  stream.addEventListener('changed', refresh);
  stream.onerror = () => { $('connection').textContent = '连接中断，自动重连'; refresh(); };
}
$('refresh').onclick = refresh;
$('searchForm').onsubmit = e => { e.preventDefault(); refresh(); };
window.addEventListener('hashchange', () => detail().catch(e => error(e.message)));
if (await refresh()) connect();
