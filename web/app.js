const $ = id => document.getElementById(id);
const basePath = document.querySelector('meta[name="task-base-path"]')?.content ?? '';
const labels = { backlog: '未开工', legacy: '历史记录', recorded: '已授权，待承接或投递', dispatched: '已投递，待承接', active: '进行中', blocked: '受阻', needs_decision: '需要用户决定', result_reported: '成果已报告，未交付', delivered: '已交付', failed: '未完成', cancelled: '已取消' };
const observedLabels = { backlog: '未开工', working: '执行中（记录）', blocked: '受阻（记录）', decision: '待决定（记录）', deferred: '暂缓 / 待发布', done: '已结束（记录）', cancelled: '已取消（记录）', unknown: '历史状态待确认' };
const groups = [
  ['正在做', 'working', '最近记录在前'], ['待办', 'backlog', '按登记顺序'],
  ['待决定', 'decision', '需要明确下一步'], ['受阻', 'blocked', '等待条件解除'],
  ['暂缓 / 待发布', 'deferred', '保留后续安排'], ['完成历史', 'closed', '按需回看'],
];
const eventLabels = { accepted: '已承接', progress: '进展', blocked: '受阻', needs_decision: '待决定', result: '成果报告', delivered: '已交付', failed: '未完成', cancelled: '已取消', recorded: '登记', amended: '目标变更', dispatched: '已投递', observed: '来源观察' };
let stream, pages = {}, activeGroup = 'all', appliedQuery = '', requestedQuery = '';
let refreshBusy = false, dirty = false, boardGeneration = 0, detailGeneration = 0, accessEpoch = 0;
let boardScroll = 0, lastTaskLink, currentTask = '', detailStale = false, changeGeneration = 0;
const initialUrl = new URL(location.href);
const initialTask = initialUrl.searchParams.get('task');
if (initialTask) {
  initialUrl.searchParams.delete('task');
  initialUrl.hash = initialTask;
  history.replaceState(null, '', initialUrl);
}
function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined && text !== null) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function button(text, action, className = 'button') {
  const el = node('button', text, className); el.type = 'button'; el.onclick = action; return el;
}
function error(message) { $('error').textContent = message; $('error').hidden = !message; }
function announce(message) { $('announcer').textContent = message; }
function stateLabel(task) {
  const state = task.status === 'legacy' ? observedLabels[task.legacy.observedState] : labels[task.status];
  const disposition = { deferred: '暂缓', abandoned: '已放弃记录', archived: '已归档' }[task.disposition];
  return disposition ? `${disposition} · ${state}` : state;
}
function conditionLabel(conditions) {
  return `${conditions.satisfied}/${conditions.total} 项前置条件满足` +
    (conditions.waiting ? ` · ${conditions.waiting} 项等待交付` : '') +
    (conditions.needsConfirmation ? ` · ${conditions.needsConfirmation} 项待确认` : '');
}
function dateText(value, full = false) {
  return new Date(value).toLocaleString('zh-CN', {
    ...(full ? { year: 'numeric' } : {}), month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}
function timeNode(value, full = false) {
  const time = node('time', dateText(value, full));
  time.dateTime = new Date(value).toISOString(); time.title = dateText(value, true); return time;
}
async function api(path, body) {
  const epoch = accessEpoch;
  const response = await fetch(`${basePath}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (response.status === 401 || response.status === 403) {
    accessDenied();
    throw new Error('无法访问工作记录，请重新打开工作页。');
  }
  let value;
  try { value = await response.json(); }
  catch { throw new Error('工作页返回了无法读取的响应，请刷新或重新打开页面。'); }
  if (epoch !== accessEpoch) throw new Error('访问已失效，请重新打开工作页。');
  if (!response.ok) throw new Error(value.message || `读取失败（${response.status}），请稍后刷新。`);
  return value;
}
function accessDenied() {
  stream?.close(); ++accessEpoch; ++boardGeneration; ++detailGeneration;
  pages = {};
  $('columns').replaceChildren(); $('overviewMetrics').replaceChildren(); $('filters').replaceChildren(); $('detail').replaceChildren();
  $('board').hidden = true; $('detail').hidden = true;
  $('connection').textContent = '无法访问'; $('connection').dataset.state = 'disconnected';
  error('无法访问工作记录，请重新打开工作页。');
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
function count(group) {
  const page = pages[group];
  return `${page.items.length}${page.nextBefore ? '+' : ''}`;
}
function selectGroup(group) {
  activeGroup = group; render();
  $('list-title').scrollIntoView({ block: 'start' });
}
function taskLink(task, className) {
  const link = node('a', undefined, className); link.href = `#${encodeURIComponent(task.taskId)}`;
  link.id = `task-${task.taskId}`;
  link.onclick = event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    boardScroll = window.scrollY; lastTaskLink = link.id;
  };
  return link;
}
function render() {
  const focused = document.activeElement?.id;
  $('overviewMetrics').replaceChildren();
  const hints = { working: '呈现最近一次进展', backlog: '登记不等于开工', decision: '等待决定或确认', blocked: '前置条件尚未解除' };
  for (const [title, group] of groups.slice(0, 4)) {
    const metric = button('', () => selectGroup(group), `metric ${group}`);
    metric.id = `metric-${group}`;
    metric.setAttribute('aria-label', `${title}，已加载 ${count(group)} 条，筛选此分组`);
    const label = node('span', undefined, 'metric-label'); label.append(node('span', '', 'status-dot'), node('span', title));
    metric.append(label, node('span', count(group), 'metric-value'), node('span', hints[group], 'metric-hint'));
    $('overviewMetrics').append(metric);
  }
  $('countNote').textContent = `${appliedQuery ? '搜索结果中' : '当前'}已加载的记录 · 数字后的 + 表示还有更早记录，不代表全量统计或实时会话状态。`;
  $('filters').replaceChildren();
  for (const [title, group] of [['全部阶段', 'all'], ...groups]) {
    const filter = button(title, () => selectGroup(group), 'filter');
    filter.id = `filter-${group}`; filter.setAttribute('aria-pressed', String(activeGroup === group));
    if (group !== 'all') filter.append(node('span', count(group), 'filter-count'));
    $('filters').append(filter);
  }
  $('searchResult').hidden = !appliedQuery;
  $('searchResult').textContent = appliedQuery ? `“${appliedQuery}”的匹配记录 · 包含完成历史` : '';
  $('clearSearch').hidden = !appliedQuery && !$('search').value;
  $('columns').replaceChildren();
  for (const [title, group, description] of groups) {
    if (activeGroup !== 'all' && activeGroup !== group) continue;
    const column = node('section', undefined, `column ${group}`);
    column.id = `lane-${group}`; column.setAttribute('aria-labelledby', `lane-title-${group}`);
    const heading = node('div', undefined, 'lane-heading'), label = node('h3', title);
    label.id = `lane-title-${group}`;
    heading.append(node('span', '', 'status-dot'), label, node('span', count(group), 'lane-count'), node('span', description, 'lane-description'));
    column.append(heading);
    const page = pages[group], items = node('div', undefined, 'lane-items');
    if (!page.items.length) {
      const empty = node('div', undefined, 'empty');
      empty.append(node('strong', appliedQuery ? '没有匹配的工作' : `暂无${title}记录`), node('span', appliedQuery ? '可调整关键词，或清除搜索查看全部记录。' : '后续记录会在这里显示。'));
      items.append(empty);
    }
    for (const task of page.items) {
      const row = taskLink(task, 'task-row'), main = node('div', undefined, 'task-main');
      main.append(node('h4', task.title || task.workstream), node('p', task.summary || '暂无进展摘要，打开查看工作内容。', 'task-summary'));
      const state = node('div', undefined, 'task-status');
      state.append(node('span', stateLabel(task), `badge ${task.status}`));
      if (task.pendingOperationId) state.append(node('span', '有待处理投递', 'attention'));
      else if (task.conditions.total) state.append(node('small', conditionLabel(task.conditions)));
      else if (task.legacy && !task.ownerSessionId) state.append(node('small', '历史观察 · 非实时'));
      else state.append(node('small', task.goalVersion ? `目标 v${task.goalVersion}` : '尚未授权执行'));
      const date = node('div', undefined, 'task-time');
      date.append(timeNode(task.updatedAt), node('small', '记录更新'));
      row.append(main, state, date, node('span', '›', 'row-arrow')); items.append(row);
    }
    if (page.nextBefore) {
      const footer = node('div', undefined, 'lane-footer');
      const more = button('加载更早记录', async () => {
        const generation = boardGeneration; more.disabled = true; more.textContent = '正在加载…'; localError.hidden = true;
        try {
          const next = await api('/api/read', { group, before: page.nextBefore, limit: 10, ...(appliedQuery ? { query: appliedQuery } : {}) });
          if (generation !== boardGeneration) return;
          const known = new Set(page.items.map(t => t.taskId));
          page.items.push(...next.items.filter(t => !known.has(t.taskId))); page.nextBefore = next.nextBefore;
          render(); announce(`${title}已加载 ${page.items.length} 条`);
          if (!$(`more-${group}`)) $(`lane-title-${group}`).focus({ preventScroll: true });
        } catch (e) { localError.textContent = e.message; localError.hidden = false; }
        finally { more.disabled = false; more.textContent = '加载更早记录'; }
      }, 'button more');
      more.id = `more-${group}`; more.setAttribute('aria-label', `加载更早${title}记录`);
      const localError = node('p', '', 'local-error'); localError.setAttribute('role', 'alert'); localError.hidden = true;
      footer.append(node('span', `已加载 ${page.items.length} 条`), more); items.append(footer, localError);
    }
    label.tabIndex = -1; column.append(items); $('columns').append(column);
  }
  if (focused && $(focused)) $(focused).focus({ preventScroll: true });
}
function section(title, parent, className = '') {
  const el = node('section', undefined, `detail-section ${className}`);
  el.append(node('h2', title)); parent.append(el); return el;
}
function disclosure(title, parent, open = false) {
  const el = node('details'); el.open = open; el.append(node('summary', title)); parent.append(el); return el;
}
function backLink() {
  const a = node('a', '← 返回工作清单', 'back-link'); a.href = '#'; return a;
}
function detailNavigation(panel) {
  const nav = node('div', undefined, 'detail-nav');
  nav.append(backLink(), node('span', '工作清单 / 任务详情')); panel.append(nav);
}
function paginated(parent, { label, nextLabel = label, view, taskId, limit, initial, renderItem, generation }) {
  const content = node('div'), localError = node('p', '', 'local-error');
  localError.setAttribute('role', 'alert'); localError.hidden = true;
  let before = initial?.nextBefore;
  if (initial) for (const item of initial.items) content.append(renderItem(item));
  const more = button(label, async () => {
    more.disabled = true; localError.hidden = true;
    try {
      const page = await api('/api/read', { taskId, view, limit, ...(before ? { before } : {}) });
      if (generation !== detailGeneration) return;
      for (const item of page.items) content.append(renderItem(item));
      before = page.nextBefore; more.hidden = !before; more.textContent = nextLabel;
      announce(`已加载${label.replace('查看', '')}`);
      if (more.hidden) { content.tabIndex = -1; content.focus({ preventScroll: true }); }
    } catch (e) { localError.textContent = e.message; localError.hidden = false; }
    finally { more.disabled = false; }
  });
  more.hidden = Boolean(initial && !before);
  parent.append(content, localError, more);
}
function renderDetail(task, events, operations, generation) {
  const panel = $('detail'); panel.replaceChildren(); detailNavigation(panel);
  const notice = node('div', undefined, 'message notice'); notice.id = 'detailNotice'; notice.hidden = !detailStale;
  notice.append(node('span', '工作清单可能有新记录。当前详情保留在阅读位置。'), button('更新详情', () => loadDetail(false)));
  panel.append(notice);
  const header = node('header', undefined, 'detail-header'), badges = node('div', undefined, 'badges');
  badges.append(node('span', stateLabel(task), `badge ${task.status}`), node('span', task.goalVersion ? `目标 v${task.goalVersion}` : '尚未授权执行', 'muted'));
  const title = node('h1', task.title || task.workstream); title.tabIndex = -1; title.id = 'detail-title';
  const updated = node('p', undefined, 'detail-updated'); updated.append(node('span', '记录更新于 '), timeNode(task.updatedAt, true));
  header.append(badges, title, updated); panel.append(header);
  const layout = node('div', undefined, 'detail-layout'), primary = node('div', undefined, 'detail-primary'), aside = node('aside', undefined, 'detail-aside');
  layout.append(primary, aside); panel.append(layout);
  const latest = section('最近报告', primary);
  latest.append(node('p', task.summary || '尚无进展报告。', 'longtext'));
  if (task.notes) {
    const notes = disclosure('登记说明', latest);
    notes.append(node('p', task.notes, 'longtext'));
  }
  const goal = section('目标与约定', primary);
  if (task.goal) {
    goal.append(node('p', task.goal.objective, 'longtext'));
    for (const [label, value] of [['范围', task.goal.scope], ['验收标准', task.goal.acceptance], ['执行授权', task.goal.authorization]]) {
      disclosure(label, goal).append(node('p', value, 'longtext'));
    }
  } else goal.append(node('p', '尚无本服务执行授权。登记、暂缓和历史导入均不会启动 owner。', 'muted'));
  const dependencies = section('前置条件', primary);
  dependencies.append(node('p', task.conditions.total ? conditionLabel(task.conditions) : '没有登记前置条件。'));
  dependencies.append(node('p', '条件满足不等于执行授权或运行就绪，不会自动派工或改变任务状态。', 'muted'));
  if (task.conditions.total) paginated(dependencies, {
    label: '查看前置明细', nextLabel: '更多前置条件', view: 'dependencies', taskId: task.taskId, limit: 10, generation,
    renderItem(item) {
      const row = node('article', undefined, 'event'), link = node('a', item.title ?? item.prerequisiteId);
      link.href = `#${encodeURIComponent(item.prerequisiteId)}`;
      const reasons = { no_bound_goal: '需要确认：尚未绑定正式目标；授权后由 caller 显式重新登记',
        goal_changed: '需要确认：前置目标已变更', delivered: '满足：指定当前目标已交付', not_delivered: '等待：指定目标尚未成功交付' };
      row.append(link, node('p', `目标 v${item.prerequisiteGoalVersion ?? '—'} · ${reasons[item.reason]}`));
      if (item.note) row.append(node('p', item.note)); return row;
    },
  });
  if (task.legacyDetail) {
    const legacy = section('历史观察', primary);
    legacy.append(node('p', `${task.legacy.observedAt} · ${observedLabels[task.legacy.observedState]}`, 'muted'),
      node('p', '来源记录不等于本服务执行回执。', 'muted'), node('p', task.legacyDetail.summary, 'longtext'));
    if (task.legacyDetail.notes) disclosure('观察说明', legacy).append(node('p', task.legacyDetail.notes, 'longtext'));
    paginated(legacy, {
      label: '查看原始来源', nextLabel: '更多原始来源', view: 'sources', taskId: task.taskId, limit: 3, generation,
      renderItem(source) {
        const el = node('details');
        el.append(node('summary', `${source.namespace}:${source.sourceKey}`),
          node('pre', typeof source.raw === 'string' ? source.raw : JSON.stringify(source.raw, null, 2), 'longtext')); return el;
      },
    });
  }
  const history = section('进展记录', layout, 'detail-history');
  history.append(node('p', '由执行方主动报告，不是会话实时监测。', 'muted'));
  if (!events.items.length) history.append(node('p', '暂无进展记录。', 'empty'));
  paginated(history, {
    label: '更早进展', view: 'events', taskId: task.taskId, limit: 10, initial: events, generation,
    renderItem(event) {
      const row = node('article', undefined, 'event');
      row.append(node('small', `${dateText(event.at, true)} · ${eventLabels[event.kind] || event.kind} · v${event.goalVersion}`), node('p', event.summary));
      const links = node('div', undefined, 'link-list'); for (const artifact of event.artifacts) links.append(safeLink(artifact));
      row.append(links); return row;
    },
  });
  const results = section('结果与来源', aside);
  const links = node('div', undefined, 'link-list'); results.append(links);
  if (!task.artifacts.length) links.append(node('p', '尚无结果入口', 'muted'));
  for (const value of task.artifacts) links.append(safeLink(value));
  if (task.sources?.length) {
    results.append(node('h3', '登记来源'));
    const sources = node('div', undefined, 'link-list');
    for (const value of task.sources) sources.append(safeLink(value));
    results.append(sources);
  }
  const sessions = section('关联会话', aside), sessionLinks = node('div', undefined, 'link-list');
  if (task.ownerUrl) sessionLinks.append(safeLink(task.ownerUrl, '执行方 owner ↗'));
  else if (task.legacyOwnerUrl) sessionLinks.append(safeLink(task.legacyOwnerUrl, '历史 owner 引用 ↗'), node('p', '仅为历史引用，未建立执行绑定。', 'muted'));
  else sessionLinks.append(node('p', '尚未绑定执行方', 'muted'));
  sessionLinks.append(safeLink(task.callerUrl, '讨论会话 ↗')); sessions.append(sessionLinks);
  const metadata = section('记录信息', aside), list = node('dl', undefined, 'metadata'); metadata.append(list);
  for (const [label, value] of [['工作流', task.workstream], ['记录版本', `r${task.recordRevision}`], ['执行目标', task.goalVersion ? `v${task.goalVersion}` : '未建立'],
    ['已承接目标', task.acceptedGoalVersion ? `v${task.acceptedGoalVersion}` : '未承接']]) {
    const item = node('div'); item.append(node('dt', label), node('dd', value)); list.append(item);
  }
  const identifiers = disclosure('技术标识', metadata), copyRow = node('div', undefined, 'copy-row');
  const copy = button('复制', async () => {
    try { await navigator.clipboard.writeText(task.taskId); announce('任务 ID 已复制'); copy.textContent = '已复制'; }
    catch { announce('无法自动复制，请选中任务 ID 手动复制。'); copyError.hidden = false; }
  });
  copy.setAttribute('aria-label', '复制任务 ID');
  const copyError = node('p', '无法自动复制，请选中上方任务 ID 手动复制。', 'local-error'); copyError.hidden = true;
  copyRow.append(node('code', task.taskId), copy); identifiers.append(copyRow, copyError);
  for (const [label, value] of [['Owner', task.ownerSessionId], ['原 Owner', task.legacy?.ownerRef], ['Caller', task.callerSessionId], ['待处理操作', task.pendingOperationId]]) {
    if (value) identifiers.append(node('h3', label), node('code', value));
  }
  const operationSection = section('投递与通知', aside);
  if (!operations.items.length) operationSection.append(node('p', '暂无操作记录', 'muted'));
  paginated(operationSection, {
    label: '更早操作', view: 'operations', taskId: task.taskId, limit: 5, initial: operations, generation,
    renderItem(op) {
      const row = node('article', undefined, 'event');
      row.append(node('p', `${op.kind} · ${op.status}`));
      if (op.step) row.append(node('small', op.step));
      if (op.error) row.append(node('p', op.error));
      disclosure('操作标识', row).append(node('code', op.operationId));
      return row;
    },
  });
}
async function loadDetail(focus = true) {
  const generation = ++detailGeneration, changes = changeGeneration, id = location.hash.slice(1);
  if (!id) return;
  const panel = $('detail'); panel.hidden = false; $('board').hidden = true;
  panel.setAttribute('aria-busy', 'true');
  if (focus) {
    panel.replaceChildren(); detailNavigation(panel);
    panel.append(node('div', '正在读取任务详情…', 'loading')); window.scrollTo(0, 0);
  }
  try {
    const [task, events, operations] = await Promise.all([
      api('/api/read', { taskId: id, view: 'detail' }),
      api('/api/read', { taskId: id, view: 'events', limit: 10 }),
      api('/api/read', { taskId: id, view: 'operations', limit: 5 }),
    ]);
    if (generation !== detailGeneration) return;
    detailStale = changes !== changeGeneration; renderDetail(task, events, operations, generation);
    if (focus) $('detail-title').focus({ preventScroll: true });
  } catch (e) {
    if (generation !== detailGeneration) return;
    panel.replaceChildren(); detailNavigation(panel);
    const message = node('div', e.message, 'message error'); message.setAttribute('role', 'alert');
    panel.append(message, button('重试读取详情', () => loadDetail()));
  } finally { if (generation === detailGeneration) panel.setAttribute('aria-busy', 'false'); }
}
async function route() {
  const id = location.hash.slice(1);
  if (id === 'main') { location.hash = ''; $('main').focus(); return; }
  if (id) { currentTask = id; await loadDetail(); }
  else {
    ++detailGeneration; currentTask = ''; $('detail').hidden = true;
    $('board').hidden = !Object.keys(pages).length;
    window.scrollTo(0, boardScroll);
    if (lastTaskLink) $(lastTaskLink)?.focus({ preventScroll: true });
  }
}
async function refresh() {
  if (refreshBusy) { dirty = true; return; }
  refreshBusy = true; $('refresh').disabled = true; $('board').setAttribute('aria-busy', 'true');
  try {
    do {
      dirty = false;
      const query = requestedQuery, generation = ++boardGeneration;
      const next = await api('/api/read', { view: 'board', limit: 10, ...(query ? { query } : {}) });
      // Re-read already expanded groups so updates neither discard pagination nor keep stale task states.
      if (query === appliedQuery) {
        await Promise.all(groups.map(async ([, group]) => {
          const lane = next.groups[group], target = pages[group]?.items.length || 0;
          while (lane.nextBefore && lane.items.length < target) {
            const older = await api('/api/read', { group, before: lane.nextBefore, limit: 10, ...(query ? { query } : {}) });
            lane.items.push(...older.items); lane.nextBefore = older.nextBefore;
          }
        }));
      }
      if (generation !== boardGeneration) return false;
      if (query !== requestedQuery) { dirty = true; continue; }
      pages = next.groups; appliedQuery = query;
      $('board').hidden = Boolean(location.hash); $('reopen').hidden = true;
      $('updated').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      $('updated').dateTime = new Date().toISOString();
      error(''); render();
    } while (dirty);
    return true;
  } catch (e) { error(e.message); return false; }
  finally { refreshBusy = false; $('refresh').disabled = false; $('loading').hidden = true; $('board').setAttribute('aria-busy', 'false'); }
}
function markDetailStale() {
  ++changeGeneration;
  if (!currentTask) return;
  detailStale = true;
  if ($('detailNotice')) $('detailNotice').hidden = false;
}
function connect() {
  stream?.close(); stream = new EventSource(`${basePath}/api/events`);
  let connected = false;
  stream.addEventListener('ready', () => {
    $('connection').textContent = '更新已连接'; $('connection').dataset.state = 'connected';
    if (connected) markDetailStale();
    connected = true; return refresh();
  });
  stream.addEventListener('changed', () => { markDetailStale(); return refresh(); });
  stream.onerror = () => {
    $('connection').textContent = '更新中断，重连中'; $('connection').dataset.state = 'disconnected';
    markDetailStale(); return refresh();
  };
}
$('refresh').onclick = async () => {
  if (await refresh()) {
    if (location.hash) await loadDetail(false);
    if (!stream || stream.readyState === EventSource.CLOSED) connect();
  }
};
$('searchForm').onsubmit = e => { e.preventDefault(); requestedQuery = $('search').value.trim(); return refresh(); };
$('clearSearch').onclick = () => { $('search').value = ''; requestedQuery = ''; $('search').focus(); return refresh(); };
$('search').oninput = () => { $('clearSearch').hidden = !$('search').value && !appliedQuery; };
window.addEventListener('hashchange', route);
if (await refresh()) { await route(); if ($('reopen').hidden) connect(); }
