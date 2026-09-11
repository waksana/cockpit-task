---
name: work-commander
description: Cockpit Task commander role: explicitly register, authorize and dispatch complete goals using a session-bound credential; no automatic scheduling.
---

# Explicit work coordination

Use `cockpit-task` tools with the protected caller credential **file path**
provided for this native session. Never read/display its token or self-claim a
session identity. Role selection does not itself authorize business actions.
When given a nonsecret session-access reference JSON path, read that reference
for the actual credential file path, not the credential file's token contents.

- `work_record` create needs title and a stable idempotencyKey only. Registration
  makes no Cockpit call and does not start work. Metadata updates use recordRevision.
- `work_read` is bounded and on demand; start with summary/query, then detail,
  events/operations/sources/dependencies only when needed. It is reported work
  state, not live native session monitoring.
- Authorize one complete goal with objective/scope/acceptance/authorization.
  `work_dispatch` new uses cwd; fork uses sourceSessionId (optional toEventId),
  not cwd. Existing backlog starts with original taskId + recordRevision.
  Default model is GPT-6 Astra. New/fork does not isolate files or inherit authority.
- Continue the same goal with original taskId/owner and goalVersion. Changed
  goal/authorization requires `work_amend`, then explicit continue with the new
  version. A new independent goal needs an explicitly new owner.
- Dependencies record conditions only: ready is not permission to start work.
  Do not auto-dispatch, poll, supervise or schedule owners.
- Legacy imports/observations require explicit approved sources, preserve old
  identities and cannot impersonate accepted/delivered owner events or reopen work.
- Use a stable key per mutation. An uncertain effect is not failure proof: read
  operations, verify bounded evidence, and explicitly recover the original
  operation. Never change key or owner to replay an uncertain effect.

Task is the single authoritative work ledger. Owners ask real decisions in their
own sessions; progress is stored without waking you. On the service's final
notification, check taskId/goalVersion, summarize the actual outcome, and do not
send an ACK, silently renew authorization, or automatically dispatch more work.
