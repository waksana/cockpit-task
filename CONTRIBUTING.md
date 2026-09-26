# Contributing to Cockpit Task

Use an isolated branch/worktree from fresh main. Preserve concurrent work and
existing version preparations. Validate with the existing `npm test` and
`npm run package:module` commands using synthetic data, never production Tasks,
native sessions or credentials.

Follow the [README development and packaging guide](README.md#%E5%BC%80%E5%8F%91%E4%B8%8E%E6%89%93%E5%8C%85)
for worktree-local initialization; another checkout's environment does not establish
readiness here. Run `npm run quotas` to see fixed prompt-text character limits, usage
and remaining capacity; exceeding a limit exits nonzero.

## Immutable installation versions

Do not bump versions for every commit. Before packaging changed content for
installation or deployment, compare against already delivered versions: changed
package bytes require a fresh semantic version, normally the next patch for a
compatible fix. The same module ID and version may only reproduce the same
bytes/digest. A source SHA or digest does not replace the version or permit an
installed identity to be overwritten.

Synchronize `package.json`, `cockpit.module.json`, both root version entries in
`package-lock.json`, the embedded MCP server version, tests and current-source
documentation. Preserve historical release facts. If fresh main already prepares
the appropriate undelivered version, reuse it rather than repeating its bump.
The prepared version is 0.3.1, a caller-scoped idempotency fix with schema v11.
The v10-to-v11 migration preserves original receipts, fingerprints and uncertainty;
unattributable legacy IDs remain reserved and fail with `LEGACY_OPERATION_UNSCOPED`.
See [caller-scoped receipts](docs/task-implementation.md#caller-scoped-receipts-and-schema-v11).
Released 0.3.0 cannot open v11; this forward-only source preparation does not authorize
data migration or deployment, and the released 0.3.0 identity remains immutable.

Released 0.3.0 introduced the incompatible four-state lifecycle and schema v10,
requiring a new minor version before 1.0 rather than a patch or reuse of released
0.2.0 bytes. It includes durable Task/text prerequisites, readiness-boundary notices,
truthful finished automation outcomes and the reviewed, explicit v9-to-v10 migration.
Every existing v9 database requires a reviewed plan, even without legacy statuses;
ordinary activation refuses it. Follow the canonical
[migration procedure](docs/task-implementation.md#schema-v10-migration).
Installed 0.2.0 cannot open schema v10; switching packages back is not data rollback.
Version preparation does not authorize production migration, installation or release.
Previously released 0.1.13 packages the per-Task hierarchical delegation work from #71/#72/#74,
merged via #75. Schema v7 is a non-destructive forward migration that adds
nullable `tasks.parent_task_id`, `tasks.depth` default 1 and `child_notices`.
Schema v7 is roll-forward only: installed 0.1.12 refuses v7 data, and switching
the package back is not a database rollback. Never overwrite live data with a
historical backup. Validate migration on an isolated consistent copy before
separately authorized deployment.

The vocabulary refactor packaged in 0.2.0 for Issue #82 is schema v9 and a one-shot
switch with no aliases: `owner` becomes `orchestrator`, `executor` becomes
`assignee`, and tool inputs/results, error codes, operation receipts, Web and
docs move together. Schema v9 renames columns/indexes in place, adds
`operations.invocation` and `assignee_notices(kind updated|cancelled)`, renames `subscriptions.owner` to `subscriber` (alongside the other v9 renames), migrates event JSON `actor_session_id` to `actor`, and
is roll-forward only: installed 0.1.13 and older modules refuse v9 data with
`SCHEMA_TOO_NEW`. Deploy it only jointly with a Cockpit build that injects
`_meta["cockpit/invocation"].sessionId` into MCP calls (waksana/cockpit#205);
without that host support every tool, including reads, returns
`INVOCATION_REQUIRED` before writing. Old `request_id` replays can conflict after
upgrade because request fingerprints now include the host-supplied caller.

Schema v8 (retro handling, #80) is packaged together with schema v9 in 0.2.0.
Both migrations are roll-forward only, so installed 0.1.13 refuses the upgraded
data.

Version 0.1.12, released as v0.1.12, packages the native Task dependency work and
github-coding Skill updates merged after 0.1.11 (#59, #61, #63, #65). Native Task
dependencies add schema v6 (`task_dependencies`, `dependency_notices`) through a
non-destructive, table-only forward migration. Schema v6 is roll-forward only:
installed 0.1.11 cannot open v6 data, and switching its package back is not a
database rollback.

Version 0.1.11 includes orchestrator sequential subscription follow-up (#53) and
assignee session titles (#55), superseding installed 0.1.10; that installation
remains immutable. Session-title results use the existing operations JSON and add
no schema migration. Hosts without native name provenance safely skip the title
step. Version 0.1.10 introduced orchestrator request follow-through (#45), immediate
important-update notices (#47) and Agent reopen (#49). Version 0.1.9 introduced
the coding/deployment Skill boundary clarification. Schema v5 deliberately does
not backfill assignment records: all pre-upgrade assigned Tasks remain readable
but cannot reopen, and installed 0.1.9 cannot open schema v5.

Keep the documented UI source pairing
`9fd5204bda99a8bd65b2c5ef152cc47ce87837d5` and `uiSurfaceVersion: 1` as the UI
support baseline, separate from backend resource preparation. Explicit preparation
requires `context.host.resourcePreparationVersion === 1` and the public
`session/resources-prepare` contract from [Cockpit #98](https://github.com/waksana/cockpit/pull/98).
Do not infer a deployed capability or minimum host release from a source merge.
Legacy creation without resource selections remains compatible with older hosts.
Verify the final merged
CI artifact before authorized installation. Never delete installed directories
or force installer bypasses to reuse a version. Merge does not authorize tags,
Releases, deployment or restart; those require separate authorization.

Follow the canonical [release procedure](docs/releases.md#automated-release-procedure)
for separately authorized publication. After a joint deployment with the host,
tag and release the accepted commit per Cockpit's
[release-after-acceptance policy](https://github.com/waksana/cockpit/blob/main/docs/releasing.md#release-after-acceptance).
