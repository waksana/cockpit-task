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
  description: 24000, activity: 4000, outcome: 8000, metadata: 8000,
  references: 20, excerpt: 320, list: 50, history: 10,
  page: 24000, definitionPayload: 64000, reportPayload: 16000,
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
const actor = { actor_session_id: session };
const mutation = { ...actor, request_id: request };
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
const readActor = { actor_session_id: session.optional() };
const taskRead = view => z.strictObject({ ...readActor, view: z.literal(view), task_id: id });
export const TASK_STATUSES = Object.freeze(['todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled']);
export const schemas = {
  task_read: z.discriminatedUnion('view', [
    z.strictObject({
      ...readActor, view: z.literal('list'), owner: session.optional(), executor: session.optional(),
      status: z.enum(['todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled', 'unfinished', 'all']).optional(),
      query: text(200).optional(), limit: z.number().int().min(1).max(LIMITS.list).optional(), cursor: text(2000).optional(),
    }),
    ...['overview', 'execution', 'definition'].map(taskRead),
    z.strictObject({ ...readActor, view: z.literal('changelog'), task_id: id, ...pagination, revision: revision.optional() })
      .refine(x => x.revision === undefined || (x.cursor === undefined && x.limit === undefined), 'A revision selector cannot be paginated'),
    ...['activity', 'outcomes', 'subscriptions'].map(view => z.strictObject({ ...readActor, view: z.literal(view), task_id: id, ...pagination })),
    z.strictObject({ ...readActor, view: z.literal('operation'), request_id: request }),
  ]),
  task_create: z.strictObject({
    ...mutation, owner: session, title: text(240), description: text(LIMITS.description),
    references: references.optional(), metadata: metadata.optional(),
  }).refine(definitionFits, 'Combined serialized description and materials exceed 64000 characters'),
  task_session_create: z.strictObject({ ...mutation, cwd: text(4000), ...resources }),
  task_session_prepare: z.strictObject({ ...mutation, session_id: session, ...resources }),
  task_assign: z.strictObject({ ...existing, revision, executor: session, resume_request_id: request.optional() }),
  task_edit: z.strictObject({
    ...existing, revision, reason: text(2000), title: text(240).optional(),
    description: text(LIMITS.description).optional(), references: references.optional(), metadata: metadata.optional(),
  }).refine(x => ['title', 'description', 'references', 'metadata'].some(key => x[key] !== undefined), 'An editable field is required'),
  task_ack: z.strictObject({ ...existing, revision }),
  task_report: z.strictObject({
    ...existing, revision, activity: z.strictObject({ text: text(LIMITS.activity) })
      .refine(value => JSON.stringify(value).length <= LIMITS.reportPayload, 'Serialized activity exceeds 16000 characters').optional(),
    status: z.enum(['in_progress', 'blocked', 'in_review', 'done']).optional(),
    outcome: z.strictObject({ summary: text(LIMITS.outcome), references: references.optional() })
      .refine(value => JSON.stringify(value).length <= LIMITS.reportPayload, 'Serialized outcome and references exceed 16000 characters').optional(),
  }).refine(x => x.activity !== undefined || x.status !== undefined || x.outcome !== undefined, 'A report field is required')
    .refine(x => x.status !== 'done' || x.outcome !== undefined, 'done requires a new outcome in this request'),
  task_cancel: z.strictObject({ ...existing, reason: text(2000) }),
  task_subscribe: z.strictObject({
    ...existing,
    statuses: z.array(z.enum(TASK_STATUSES)).min(1).max(TASK_STATUSES.length)
      .refine(values => new Set(values).size === values.length, 'Target statuses must be unique'),
  }),
  task_unsubscribe: z.strictObject({ ...mutation, task_id: id, subscription_id: id }),
};
// The MCP SDK publishes properties only for object roots, not discriminated unions.
const readToolSchema = z.strictObject({
  ...readActor,
  view: z.enum(['list', 'overview', 'execution', 'definition', 'changelog', 'activity', 'outcomes', 'subscriptions', 'operation']),
  task_id: id.optional().describe('Required for overview, execution, definition, changelog, activity, outcomes and subscriptions'),
  request_id: request.optional().describe('Required only for the operation view'),
  owner: session.optional().describe('List filter only'),
  executor: session.optional().describe('List filter only'),
  status: z.enum(['todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled', 'unfinished', 'all']).optional().describe('List filter only; defaults to unfinished'),
  query: text(200).optional().describe('List title filter only'),
  limit: z.number().int().min(1).max(LIMITS.list).optional().describe('List: default 20, maximum 50. Histories: default 5, maximum 10'),
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
