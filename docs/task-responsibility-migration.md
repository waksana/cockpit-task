# Offline responsibility migration

The complete, canonical [schema-12 migration procedure](releases.md#schema-12-migration)
is shipped alongside this entry in `docs/releases.md`.

Read it before using `scripts/migrate-task-v12.js`. It specifies the exact
inventory/review plan, historical migration stages, isolated-copy exercise,
preservation guarantees, compatibility refusal and recovery boundaries.

Schema 12 has no automatic migration path. Publication or installation does not
authorize migration; no historical work mode or started event may be inferred.
