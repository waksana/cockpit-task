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
    selection: z.enum(['new', 'fork', 'continue', 'adopt']),
    taskId: id.optional(),
    recordRevision: version.optional(),
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
      if (v.recordRevision) fail('continue uses goalVersion, not recordRevision');
    } else if (v.selection === 'adopt') {
      if (!v.taskId || !v.recordRevision || !v.goal) fail('adopt requires taskId, recordRevision and complete current goal/authorization');
      if (v.goalVersion || v.sourceSessionId || v.toEventId || v.cwd || v.workstream) fail('adopt uses the preserved legacy owner reference, never a caller-supplied replacement');
    } else {
      if (!v.goal || (!v.taskId && !v.workstream)) fail('new/fork requires complete goal and workstream (or existing backlog taskId)');
      if (v.taskId && !v.recordRevision) fail('starting backlog requires recordRevision');
      if (!v.taskId && v.recordRevision) fail('recordRevision requires an existing backlog');
      if (v.goalVersion) fail('first dispatch creates goalVersion 1');
      if (v.selection === 'new' && (!v.cwd?.startsWith('/') || v.sourceSessionId || v.toEventId)) fail('new requires absolute cwd, no fork fields');
      if (v.selection === 'fork' && (!v.sourceSessionId || v.cwd)) fail('fork requires sourceSessionId and inherits cwd; it does not isolate files');
    }
  }),
  work_read: z.object({
    taskId: id.optional(),
    workstream: id.optional(),
    query: z.string().trim().min(1).max(200).optional(),
    view: z.enum(['summary', 'board', 'detail', 'events', 'operations', 'sources']).default('summary'),
    group: z.enum(['backlog', 'working', 'blocked', 'decision', 'deferred', 'closed']).optional(),
    status: z.enum(['backlog', 'legacy', 'recorded', 'dispatched', 'active', 'blocked', 'needs_decision', 'result_reported', 'delivered', 'failed', 'cancelled']).optional(),
    includeClosed: z.boolean().default(false),
    limit: z.number().int().min(1).max(50).default(10),
    before: z.number().int().positive().optional(),
  }).strict(),
  work_record: z.object({
    ...mutation, action: z.enum(['create', 'update']),
    taskId: id.optional(), recordRevision: version.optional(),
    title: z.string().trim().min(1).max(240).optional(),
    notes: z.string().max(8000).optional(),
    workstream: id.optional(),
    disposition: z.enum(['open', 'deferred', 'abandoned', 'archived']).optional(),
    reason: z.string().trim().min(1).max(2000).optional(),
    sources: z.array(z.string().min(1).max(2048)).max(20).optional(),
  }).strict().superRefine((v, ctx) => {
    const fail = message => ctx.addIssue({ code: 'custom', message });
    if (v.action === 'create') {
      if (!v.title || v.taskId || v.recordRevision) fail('create requires title only; no existing task/revision');
    } else if (!v.taskId || !v.recordRevision) fail('update requires taskId and recordRevision');
    if (v.action === 'update' && !['title', 'notes', 'workstream', 'disposition', 'sources'].some(k => v[k] !== undefined)) fail('update requires an explicit field change');
    if (v.disposition && v.disposition !== 'open' && !v.reason) fail('deferring/abandoning/archiving requires a reason; does not stop an agent');
  }),
  work_observe: z.object({
    ...mutation, taskId: id, recordRevision: version,
    observedState: z.enum(['backlog', 'working', 'blocked', 'decision', 'deferred', 'done', 'cancelled', 'unknown']),
    observedAt: z.string().trim().min(1).max(100),
    summary: z.string().trim().min(1).max(2000),
    notes: z.string().max(8000).optional(),
    source: text, artifacts: z.array(z.string().min(1).max(2048)).max(20).default([]),
    updateCurrent: z.boolean().default(false),
    reason: z.string().trim().min(1).max(2000).optional(),
  }).strict().superRefine((v, ctx) => {
    if (v.updateCurrent && !v.reason) ctx.addIssue({ code: 'custom', message: 'Updating the current legacy observation requires a reason confirming this source applies to the current authorized scope, not an old phase' });
  }),
  work_import: z.object({
    ...mutation, mode: z.enum(['preview', 'apply']),
    manifestId: z.string().regex(/^[a-f0-9]{64}$/),
    planHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
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
  work_dispatch: 'Explicitly execute a complete authorized goal: new/fork may start an existing backlog taskId+recordRevision without changing identity; continue requires original owner/version; adopt explicitly binds an imported legacy task to its preserved original owner. Never register-only; never automatic retry or filesystem isolation. Default Astra.',
  work_read: 'Unified work/backlog/history query, zero Cockpit calls. Defaults to 10 open records; includeClosed searches history, query searches task text, workstream selects exact task, sources pages immutable legacy records. board has independent lanes; no native session polling.',
  work_record: 'Caller-only lightweight create/update: create needs just title and idempotency key, no goal/model/cwd/session. Update uses recordRevision (not goalVersion). Metadata never changes execution authorization. Deferring/abandoning records cannot stop or close an active owner. Zero Cockpit calls.',
  work_observe: 'Caller-only register a sourced legacy receipt/assessment without pretending to be owner or creating native accepted/delivered events. Requires recordRevision, observedAt and source. Cannot overwrite an adopted current execution. Zero Cockpit calls, notifications or owner wakeups.',
  work_import: 'Caller-only preview/apply a locally staged, hash-bound task-record manifest. Apply requires exact planHash; preserves immutable sources, legacy owner references and local edits. Never binds executing owners, sends historical receipts or calls Cockpit. Use admin migration-stage to stage source files.',
  work_report: 'Owner-only: accept current goal version, or report meaningful progress/blocker/decision/result. Persists to dashboard without waking caller. Ask real decisions in your own session. Result report is NOT delivery.',
  work_deliver: 'Owner-only final outcome of the WHOLE current authorized goal. Persists result and attempts exactly one directed caller notification through service. Never send an additional manual final notification.',
  work_amend: 'Caller-only explicit change of goal/authorization, increments version and invalidates old acceptance. Does not send or reopen work automatically; use explicit continue with the returned version.',
  work_recover: 'Caller-only explicit recovery of failed operation. Unknown effects require evidence-backed applied/not_applied resolution; never guess. Reuses created owner and completed steps; never silently creates a replacement.',
};
