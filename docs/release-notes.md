# Cockpit Task 0.3.2

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

Retains schema v11 and the documented host capability requirements. No new
persistent database migration is added. Session titles use passive host reads
without loading sessions. Task completion and cancellation remain separate from
native session activity and automation success or process exit.

This Release does not install packages, migrate production data or restart services.
