import { z } from 'zod';

export class TaskError extends Error {
  constructor(code, message, status = 409, result = null) {
    super(message);
    this.name = 'TaskError';
    this.code = code;
    this.status = status;
    this.result = result;
  }
}

export const LIMITS = Object.freeze({
  description: 24000, activity: 4000, outcome: 8000, retro: 2000, metadata: 8000, retroNote: 2000,
  references: 20, blockers: 20, excerpt: 320, list: 50, history: 10,
  page: 24000, selection: 48000, definitionPayload: 64000, reportPayload: 16000, delegationDepth: 3,
});
export const definitionFits = ({ description, references = [], metadata = {} }) =>
  JSON.stringify({ description, references, metadata }).length <= LIMITS.definitionPayload;
const text = max => z.string().min(1).max(max).refine(value => value.trim().length > 0, 'Must not be blank');
const session = text(200);
const request = text(200);
const id = z.uuid();
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const reference = z.strictObject({ label: text(200), target: text(2000) });
const references = z.array(reference).max(LIMITS.references)
  .refine(value => JSON.stringify(value).length <= 8000, 'References must fit within 8000 characters');
const blockedBy = z.array(id).max(LIMITS.blockers)
  .refine(values => new Set(values.map(value => value.toLowerCase())).size === values.length, 'Blocker Task IDs must be unique')
  .describe('Complete set of Task IDs (max 20, any orchestrator, never an ancestor of this Task) that must all be done before this Task can be assigned or started. Readiness gate only: never changes status, assigns or dispatches');
// Validate JSON iteratively so cyclic, deep, exotic and non-finite JS inputs fail safely.
function validMetadata(value) {
  const seen = new Set();
  const stack = [[value, 0]];
  let count = 0;
  while (stack.length) {
    const [item, depth] = stack.pop();
    if (++count > 2000 || depth > 12) return false;
    if (item === null || typeof item === 'boolean' || typeof item === 'string') continue;
    if (typeof item === 'number') { if (!Number.isFinite(item)) return false; continue; }
    if (typeof item !== 'object' || seen.has(item)) return false;
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return false;
    seen.add(item);
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === 'length') continue;
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) return false;
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (!property || !('value' in property) || !property.enumerable) return false;
      stack.push([property.value, depth + 1]);
    }
  }
  try { return JSON.stringify(value).length <= LIMITS.metadata; } catch { return false; }
}
const metadata = z.preprocess((value, context) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validMetadata(value)) {
    context.addIssue({ code: 'custom', message: 'Metadata must be bounded, plain JSON (max 8000 characters, depth 12)' });
  }
  return value;
}, z.record(z.string(), z.unknown()));
const mutation = { request_id: request };
const resourceNames = max => z.array(text(200)).max(max)
  .refine(values => new Set(values).size === values.length, 'Resource names must be unique');
const resources = {
  skills: resourceNames(64).optional().describe('Explicitly selected existing native Skill names; enabling does not load their bodies'),
  mcp_servers: z.array(z.strictObject({
    name: text(200),
    tools: resourceNames(256).refine(values => !values.includes('*'), 'Wildcard tools are not supported')
      .optional().describe('Required exact raw MCP tool names, no wildcard; omitted or empty means at least one offered tool'),
  })).max(64).refine(values => new Set(values.map(value => value.name)).size === values.length, 'MCP server names must be unique')
    .optional().describe('Explicitly selected existing native MCP servers; no installation, authentication or filter bypass'),
};
const existing = { ...mutation, task_id: id, write_context: text(1000) };
const pagination = { limit: z.number().int().min(1).max(LIMITS.history).optional(), cursor: text(2000).optional() };
const taskRead = view => z.strictObject({ view: z.literal(view), task_id: id });
const scriptId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const argument = z.string().max(4000).refine(value => !value.includes('\0'), 'Arguments cannot contain NUL');
const parameterValue = z.union([argument, z.number().int().safe(), z.boolean()]);
const parameters = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), parameterValue)
  .refine(value => Object.keys(value).length <= 32 && JSON.stringify(value).length <= 8000, 'Parameters exceed bounds');
export const scriptSchema = z.strictObject({
  script_id: scriptId, title: text(240), description: text(2000),
  executable: text(4000), script_path: text(4000),
  argv: z.array(argument).max(32).default([]),
  parameters: z.array(z.strictObject({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    type: z.enum(['string', 'integer', 'boolean']), description: text(1000),
  })).max(32).refine(values => new Set(values.map(value => value.name)).size === values.length, 'Parameter names must be unique'),
}).refine(value => JSON.stringify(value).length <= 12000, 'Script registration exceeds 12000 characters');
export const TASK_STATUSES = Object.freeze(['todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled']);
export const RETRO_HANDLING_STATUSES = Object.freeze(['fixed', 'followup', 'watching', 'dismissed']);
const retroFilter = z.enum(['unhandled', 'watching']);
export const READ_GROUPS = Object.freeze(['context', 'activity', 'outcome', 'retro', 'definition', 'automation', 'cancellation']);
const readInclude = z.array(z.enum(READ_GROUPS)).min(1).max(READ_GROUPS.length)
  .refine(values => new Set(values).size === values.length, 'Include groups must be unique')
  .describe('overview only: select complete latest content groups instead of default excerpts. Context is always returned; ["context"] reads only status/identity/version/write_context. No histories or logs. Unique, nonempty; 48000 serialized JSON character result budget, explicit RESULT_TOO_LARGE on overflow.');
export const schemas = {
  task_read: z.discriminatedUnion('view', [
    z.strictObject({
      view: z.literal('list'), orchestrator: session.optional(), assignee: session.optional(), parent_task_id: id.optional(),
      retro: retroFilter.optional(),
      status: z.enum(['todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled', 'unfinished', 'all']).optional(),
      query: text(200).optional(), limit: z.number().int().min(1).max(LIMITS.list).optional(), cursor: text(2000).optional(),
    }),
    taskRead('overview').extend({ include: readInclude.optional() }),
    ...['execution', 'definition'].map(taskRead),
    z.strictObject({ view: z.literal('changelog'), task_id: id, ...pagination, revision: revision.optional() })
      .refine(x => x.revision === undefined || (x.cursor === undefined && x.limit === undefined), 'A revision selector cannot be paginated'),
    ...['activity', 'outcomes', 'retro_handlings', 'subscriptions', 'dependency_notices', 'child_notices', 'assignee_notices'].map(view => z.strictObject({ view: z.literal(view), task_id: id, ...pagination })),
    z.strictObject({
      view: z.literal('automation_log'), task_id: id,
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      limit: z.number().int().min(1).max(8192).optional(),
    }),
    z.strictObject({ view: z.literal('operation'), request_id: request }),
  ]),
  task_create: z.strictObject({
    ...mutation, title: text(240), description: text(LIMITS.description),
    references: references.optional(), metadata: metadata.optional(), blocked_by: blockedBy.optional(),
    automation: z.strictObject({ script_id: scriptId, parameters }).optional(),
  }).refine(definitionFits, 'Combined serialized description and materials exceed 64000 characters'),
  task_script_register: z.strictObject({ ...mutation, ...scriptSchema.shape })
    .refine(value => JSON.stringify(value).length <= 13000, 'Script registration exceeds 13000 characters'),
  task_script_read: z.strictObject({
    script_id: scriptId.optional(),
    limit: z.number().int().min(1).max(50).optional(), cursor: text(2000).optional(),
  }).refine(value => !value.script_id || (value.limit === undefined && value.cursor === undefined), 'A script selector cannot be paginated'),
  task_automation_start: z.strictObject({ ...existing, revision }),
  task_automation_reconcile: z.strictObject({ ...existing, reason: text(2000) }),
  task_session_create: z.strictObject({ ...mutation, cwd: text(4000), ...resources }),
  task_session_prepare: z.strictObject({ ...mutation, session_id: session, ...resources }),
  task_assign: z.strictObject({
    ...existing, revision, assignee: session,
    resume_request_id: request.optional().describe('Only to finish a dispatch whose finalized operation shows assignment=applied and message=not_sent: the earlier request_id, same Task and assignee. Pending, queued, accepted or unknown sends cannot resume'),
  }),
  task_edit: z.strictObject({
    ...existing, revision, reason: text(2000), title: text(240).optional(),
    description: text(LIMITS.description).optional(), references: references.optional(), metadata: metadata.optional(),
    blocked_by: blockedBy.optional().describe('Replaces the complete blocker set (add/remove by listing the new set; [] clears). Any unfinished Task (automation only before it starts)'),
  }).refine(x => ['title', 'description', 'references', 'metadata', 'blocked_by'].some(key => x[key] !== undefined), 'An editable field is required'),
  task_ack: z.strictObject({ ...existing, revision }),
  task_reopen: z.strictObject({
    ...existing, revision, description: text(LIMITS.description), reason: text(2000),
  }),
  task_report: z.strictObject({
    ...existing, revision, activity: z.strictObject({ text: text(LIMITS.activity) })
      .refine(value => JSON.stringify(value).length <= LIMITS.reportPayload, 'Serialized activity exceeds 16000 characters').optional(),
    status: z.enum(['in_progress', 'blocked', 'in_review', 'done']).optional(),
    outcome: z.strictObject({ summary: text(LIMITS.outcome), references: references.optional() })
      .refine(value => JSON.stringify(value).length <= LIMITS.reportPayload, 'Serialized outcome and references exceed 16000 characters').optional(),
    retro: text(LIMITS.retro).nullable().optional()
      .describe('Required with done only: useful completion retrospective (max 2000 characters), or explicit null when there are no findings. Never default omitted input to null.'),
  }).refine(x => x.activity !== undefined || x.status !== undefined || x.outcome !== undefined, 'A report field is required')
    .refine(x => x.status !== 'done' || x.outcome !== undefined, 'done requires a new outcome in this request')
    .refine(x => x.status !== 'done' || x.retro !== undefined, 'done requires explicit retro (text or null) in this request')
    .refine(x => x.retro === undefined || x.status === 'done', 'retro is only accepted with done')
    .refine(x => x.retro === undefined || JSON.stringify({ outcome: x.outcome, retro: x.retro }).length <= LIMITS.reportPayload,
      'Serialized outcome, references and retro exceed 16000 characters'),
  task_cancel: z.strictObject({ ...existing, reason: text(2000) }),
  task_subscribe: z.strictObject({
    ...existing,
    statuses: z.array(z.enum(TASK_STATUSES)).min(1).max(TASK_STATUSES.length)
      .refine(values => new Set(values).size === values.length, 'Target statuses must be unique'),
  }),
  task_unsubscribe: z.strictObject({ ...mutation, task_id: id, subscription_id: id }),
  task_retro_handle: z.strictObject({
    ...mutation, task_id: id,
    outcome_id: id.describe('outcome_id of a recorded retro with findings on this Task (normally the latest)'),
    status: z.enum(RETRO_HANDLING_STATUSES),
    note: text(LIMITS.retroNote).describe('What was fixed, which follow-up was created, what to watch for, or why it is dismissed'),
    references: references.optional(),
  }).refine(x => x.status !== 'followup' || x.references?.length, 'followup requires a reference to the follow-up Task or Issue'),
};
// The MCP SDK publishes properties only for object roots, not discriminated unions.
const readToolSchema = z.strictObject({
  view: z.enum(['list', 'overview', 'execution', 'definition', 'changelog', 'activity', 'outcomes', 'retro_handlings', 'subscriptions', 'dependency_notices', 'child_notices', 'assignee_notices', 'automation_log', 'operation']),
  task_id: id.optional().describe('Required for overview, execution, definition, changelog, activity, outcomes, retro_handlings, subscriptions, dependency_notices, child_notices, assignee_notices and automation_log'),
  include: readInclude.optional(),
  request_id: request.optional().describe('Required only for the operation view'),
  orchestrator: session.optional().describe('List filter only: Tasks this session orchestrates'),
  assignee: session.optional().describe('List filter only: Tasks assigned to this session'),
  parent_task_id: id.optional().describe('List filter only: direct Subtasks of this parent Task'),
  retro: retroFilter.optional().describe('List filter only: latest retro has findings and is unhandled, or is marked watching; status then defaults to all'),
  status: z.enum(['todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled', 'unfinished', 'all']).optional().describe('List filter only; defaults to unfinished, or all with a retro filter'),
  query: text(200).optional().describe('List title filter only'),
  limit: z.number().int().min(1).max(8192).optional().describe('List: maximum 50. Histories: maximum 10. automation_log: maximum 8192 characters'),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe('automation_log only: character offset'),
  cursor: text(2000).optional().describe('Continuation cursor for list or history views'),
  revision: revision.optional().describe('Select one complete changelog definition; cannot combine with limit or cursor'),
}).superRefine((input, context) => {
  const parsed = schemas.task_read.safeParse(input);
  if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue(issue);
});
export const toolSchemas = { ...schemas, task_read: readToolSchema };
export const TOOL_NAMES = Object.freeze(Object.keys(schemas));

export function parseInput(name, input) {
  const schema = schemas[name];
  if (!schema) throw new TaskError('UNKNOWN_TOOL', `Unknown Task tool: ${name}`, 400);
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new TaskError('INVALID_INPUT', parsed.error.issues.map(x => `${x.path.join('.') || 'input'}: ${x.message}`).join('; ').slice(0, 2000), 400);
  }
  return parsed.data;
}

// Caller identity is never tool input. The service attaches the host-provided actor and
// invocation after public validation; internal re-parsing keeps them.
export function parseInternal(name, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return parseInput(name, input);
  const { actor, invocation, ...fields } = input;
  return {
    ...parseInput(name, fields),
    ...(actor !== undefined ? { actor } : {}), ...(invocation !== undefined ? { invocation } : {}),
  };
}

export const INVOCATION_META_KEY = 'cockpit/invocation';
// Host-injected MCP _meta (waksana/cockpit#205) names the calling session; models cannot set it.
export function invocationFromMeta(meta) {
  const value = meta && typeof meta === 'object' ? meta[INVOCATION_META_KEY] : undefined;
  if (!value || typeof value !== 'object' || typeof value.sessionId !== 'string'
    || !value.sessionId.trim() || value.sessionId.length > 200) return null;
  return {
    sessionId: value.sessionId,
    ...(typeof value.runtimeSessionId === 'string' ? { runtimeSessionId: value.runtimeSessionId.slice(0, 200) } : {}),
    subagent: value.subagent === true,
    ...(typeof value.agentName === 'string' ? { agentName: value.agentName.slice(0, 200) } : {}),
  };
}
