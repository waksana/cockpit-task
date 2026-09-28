# Cockpit Task responsibility model

## Internal helpers are read-only

- Helpers may call `task_read` and `task_script_read`, but cannot maintain Tasks,
  even through activity-only reports or write replay. The main agent integrates
  helper results and records progress, outcomes and responsibility changes.
- The service returns `SUBAGENT_WRITE_FORBIDDEN` before Task or host effects.
  MCP writes require explicit, consistent main-agent invocation metadata; missing
  provenance is not treated as a main agent.
- Formal child-Task main agents, Web users, service-managed automation and
  session-scoped historical receipts retain their existing identities and authority.
  No schema migration or per-activity helper attribution is introduced.

## Recursive responsibility (schema12)

- One Agent assignee binding; parent responsibility derives from current parent,
  never historical creation. Ordinary roots can be claimed or attached above
  existing work without replacing bindings/history.
- Atomic start selects execute/orchestrate. Both modes may use helpers; explicit
  conversion records completed/remaining work before narrower formal delegation.
- Done and final cancellation require every direct child terminal. Agent cancellation
  first records intent and then disposition; no blind cascade or abandoned children.
- Assignees resolve their own concrete conditions with recorded satisfaction evidence.
  Bounded ancestors/responsibility history, derived parent reads, notice recipient
  validation and the Web surfaces follow the same model.
- No fixed three-level cap, native mode synchronization or creator-authority fallback.
  Cycles, resource limits, exact ACKs, stale writes and caller-scoped recovery remain.

Existing pre-12 databases are **not** an automatic/no-migration replacement.
Follow the separately authorized [schema12 procedure](task-responsibility-migration.md).
Historical unknown modes, JSON and receipts remain historical; migration never
replays external effects. Merge/automatic Rolling is not deployment or production migration.

## Historical 0.3.2 notes

The following describes the immutable prior release, not schema12 compatibility.

## Task cards and details

- Compact three-row cards show lifecycle/assignment icons, session names, activity
  totals, definition/ACK versions and an inline refresh button.
- Long session names stay on one line, with complete names and IDs available in
  detail. Background refresh spins only the icon and preserves the visible content.
- Overview, Activity, Relations and History organize full definitions, outcomes,
  cancellation reasons, prerequisites, Subtasks, retrospectives and automation facts.

## Reliable refresh

- Repeated references and React remounts share cached data and in-flight reads.
  Ordinary chat invalidation and closing detail no longer reread old Tasks.
- Committed Task changes publish identity-scoped version events, including affected
  parents and dependents. Reconnection reconciles missed events; failures retain
  explicitly unconfirmed data.
- The module declares its browser cache/icon imports and bundled Lucide license
  as assets so the host can serve every frontend dependency.

## Compatibility

That release retained schema v11 and the documented host capability requirements. No new
persistent database migration is added. Session titles use passive host reads
without loading sessions. Task completion and cancellation remain separate from
native session activity and automation success or process exit.

This Release does not install packages, migrate production data or restart services.
