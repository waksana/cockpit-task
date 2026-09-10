import { z } from 'zod';

const id = z.string().min(1).max(120).regex(/^[a-zA-Z0-9_-]+$/);
const text = z.string().trim().min(1).max(8000);
const version = z.number().int().positive();
const key = z.string().min(8).max(120).regex(/^[a-zA-Z0-9_.:-]+$/);
export const goal = z.object({
  objective: text, scope: text, acceptance: text, authorization: text,
}).strict();
const mutation = { idempotencyKey: key };
const bound = { taskId: id, goalVersion: version };
export const schemas = {
  work_dispatch: z.object({
    ...mutation,
    selection: z.enum(['new', 'fork', 'continue']),
    taskId: id.optional(),
    goalVersion: version.optional(),
    workstream: id.optional(),
    goal: goal.optional(),
    cwd: z.string().min(1).max(2048).optional(),
    sourceSessionId: id.optional(),
    toEventId: id.optional(),
    modelId: id.default('gpt-6-astra'),
    reasoningEffort: z.string().max(30).optional(),
    contextTier: z.enum(['default', 'long_context']).optional(),
    message: text.optional(),
  }).strict().superRefine((v, ctx) => {
    const fail = message => ctx.addIssue({ code: 'custom', message });
    if (v.selection === 'continue') {
      if (!v.taskId || !v.goalVersion || !v.message) fail('continue requires taskId, goalVersion, message');
      if (v.goal || v.workstream || v.cwd || v.sourceSessionId || v.toEventId) fail('continue cannot rebind goal or session; use work_amend');
    } else {
      if (!v.goal || !v.workstream) fail('new/fork requires goal and workstream');
      if (v.taskId || v.goalVersion) fail('new/fork cannot reuse a task');
      if (v.selection === 'new' && (!v.cwd?.startsWith('/') || v.sourceSessionId || v.toEventId)) fail('new requires absolute cwd, no fork fields');
      if (v.selection === 'fork' && (!v.sourceSessionId || v.cwd)) fail('fork requires sourceSessionId and inherits cwd; it does not isolate files');
    }
  }),
  work_read: z.object({
    taskId: id.optional(),
    view: z.enum(['summary', 'board', 'detail', 'events', 'operations']).default('summary'),
    group: z.enum(['working', 'blocked', 'decision', 'closed']).optional(),
    status: z.enum(['recorded', 'dispatched', 'active', 'blocked', 'needs_decision', 'result_reported', 'delivered', 'failed', 'cancelled']).optional(),
    limit: z.number().int().min(1).max(50).default(10),
    before: z.number().int().positive().optional(),
  }).strict(),
  work_report: z.object({
    ...mutation, ...bound,
    kind: z.enum(['accepted', 'progress', 'blocked', 'needs_decision', 'result']),
    summary: z.string().trim().min(1).max(2000),
    artifacts: z.array(z.string().min(1).max(2048)).max(10).default([]),
  }).strict(),
  work_deliver: z.object({
    ...mutation, ...bound,
    outcome: z.enum(['delivered', 'failed', 'cancelled']),
    summary: z.string().trim().min(1).max(2000),
    artifacts: z.array(z.string().min(1).max(2048)).max(10).default([]),
  }).strict(),
  work_amend: z.object({
    ...mutation, ...bound, goal,
    reason: z.string().trim().min(1).max(2000),
  }).strict(),
  work_recover: z.object({
    ...mutation, operationId: id,
    resolution: z.object({
      outcome: z.enum(['applied', 'not_applied']),
      evidence: z.string().trim().min(10).max(2000),
      sessionId: id.optional(),
    }).strict().optional(),
  }).strict(),
};
export const descriptions = {
  work_dispatch: 'Explicitly assign ONE complete goal to a fresh/forked owner, or continue the SAME task/owner/version. Caller identity comes from credential. One durable operation; no auto-retry of unknown effects. Default Astra. Not filesystem isolation.',
  work_read: 'Read authoritative work data only; no chat, model catalog, or native session polling. Defaults to 10 compact summaries. Select one task/detail, paginated events or operations as needed.',
  work_report: 'Owner-only: accept current goal version, or report meaningful progress/blocker/decision/result. Persists to dashboard without waking caller. Ask real decisions in your own session. Result report is NOT delivery.',
  work_deliver: 'Owner-only final outcome of the WHOLE current authorized goal. Persists result and attempts exactly one directed caller notification through service. Never send an additional manual final notification.',
  work_amend: 'Caller-only explicit change of goal/authorization, increments version and invalidates old acceptance. Does not send or reopen work automatically; use explicit continue with the returned version.',
  work_recover: 'Caller-only explicit recovery of failed operation. Unknown effects require evidence-backed applied/not_applied resolution; never guess. Reuses created owner and completed steps; never silently creates a replacement.',
};
