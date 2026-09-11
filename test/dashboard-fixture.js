// Synthetic records only. Shared by browser previews and the dashboard DOM tests.
const time = Date.parse('2026-09-11T03:30:00Z');
export const groupNames = ['working', 'backlog', 'decision', 'blocked', 'deferred', 'closed'];
const titles = {
  working: ['整理工作台的信息层级与阅读体验', '统一接口文档与交付说明', '移动端列表与详情适配'],
  backlog: ['补充常见问题与操作指引', '整理下一轮迭代范围'],
  decision: ['确认文档导航的归档方式'],
  blocked: ['等待前置版本交付后联调'],
  deferred: ['帮助中心改版 · 等待发布窗口'],
  closed: ['完成只读入口的边界说明', '交付记录来源与结果链接整理'],
};
const summaries = {
  working: '已完成内容梳理，正在将摘要、状态与时间统一到一条清晰的阅读路径。详情保留完整目标、前置条件和原始报告。',
  backlog: '已登记需求与相关背景，尚未建立执行授权。后续按明确目标推进，不因出现在列表中自动开工。',
  decision: '方案已整理，需要确认历史文档是否按主题归档；当前记录保留原始目标与两种候选。',
  blocked: '前置工作尚未交付，保留当前结果，待依赖条件满足后再由负责方决定下一步。',
  deferred: '实现成果已保留，当前暂缓发布；这不等于线上已经运行该版本。',
  closed: '完整目标已交付，相关说明与结果入口已保留，可在详情中回看。',
};
export function fixtureTask(group = 'working', index = 0) {
  const status = { working: 'active', backlog: 'backlog', decision: 'needs_decision', blocked: 'blocked', deferred: 'result_reported', closed: 'delivered' }[group];
  return {
    taskId: `demo-${group}-${index}`, workstream: `example-${group}-${index}`,
    title: titles[group][index % titles[group].length], summary: summaries[group],
    recordRevision: 2, goalVersion: group === 'backlog' ? 0 : 1, status, disposition: group === 'deferred' ? 'deferred' : 'open',
    ownerSessionId: group === 'backlog' ? null : 'example-owner', callerSessionId: 'example-caller',
    updatedAt: time - index * 3600000,
    conditions: { total: group === 'blocked' ? 2 : 0, satisfied: 0, waiting: group === 'blocked' ? 1 : 0, needsConfirmation: group === 'blocked' ? 1 : 0, ready: group !== 'blocked' },
  };
}
export function fixtureRead(input, records = Object.fromEntries(groupNames.map(group => [group, titles[group].map((_, i) => fixtureTask(group, i))]))) {
  function page(items, limit) {
    const start = input.before ? Number(input.before) : 0;
    return { items: items.slice(start, start + limit), nextBefore: start + limit < items.length ? start + limit : null };
  }
  if (!input.taskId) {
    const readGroup = group => page(records[group].filter(t => !input.query || `${t.title} ${t.summary} ${t.workstream}`.includes(input.query)), input.limit || 10);
    return input.view === 'board' ? { groups: Object.fromEntries(groupNames.map(group => [group, readGroup(group)])) } : readGroup(input.group);
  }
  const task = Object.values(records).flat().find(t => t.taskId === input.taskId);
  if (!task) throw new Error('任务不存在');
  if (input.view === 'detail') return {
    ...task, notes: '这是一条专用于界面演示的合成记录，不来自任何真实任务、会话或私人数据。',
    goal: task.goalVersion ? { objective: task.title, scope: '统一工作清单与任务详情的信息呈现；不修改任务状态、调度或权限。',
      acceptance: '桌面与窄屏均清晰可读，搜索、独立分页、来源链接和键盘访问保持可用。',
      authorization: '仅用于隔离的界面演示，不允许对生产任务执行任何写操作。' } : null,
    acceptedGoalVersion: task.goalVersion || null, artifacts: ['https://example.com/design-delivery', '/local/example/release-notes.txt'],
    sources: ['https://example.com/design-brief'], ownerUrl: task.ownerSessionId ? 'https://example.com/session/owner' : null,
    callerUrl: 'https://example.com/session/discussion',
  };
  if (input.view === 'events') return page(Array.from({ length: 12 }, (_, index) => ({
    at: time - index * 3600000, goalVersion: 1, kind: index ? 'progress' : 'accepted',
    summary: index ? '已记录阶段性结果，相关工作继续按当前目标推进。此文本是合成演示内容。' : '承接当前目标，已明确执行范围与交付边界。',
    artifacts: index ? [] : ['https://example.com/progress'],
  })), input.limit || 10);
  if (input.view === 'dependencies') return page([
    { title: '统一接口文档与交付说明', prerequisiteId: 'demo-working-1', prerequisiteGoalVersion: 1, reason: 'not_delivered', note: '等待明确的交付记录。' },
    { title: '补充常见问题与操作指引', prerequisiteId: 'demo-backlog-0', prerequisiteGoalVersion: null, reason: 'no_bound_goal', note: '需要先明确正式目标。' },
  ], input.limit || 10);
  if (input.view === 'sources') return page([{ namespace: 'example', sourceKey: 'synthetic-001', raw: { description: '合成来源，仅用于界面演示' } }], input.limit || 3);
  return { items: [], nextBefore: null };
}
