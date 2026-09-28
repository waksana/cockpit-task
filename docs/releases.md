# Releases

## Rolling and Milestone

The switch to this model is the main merge introducing `rolling.yml` (Issue #115).
Historical Releases, including v0.3.2, retain their original identity and bytes.
There is no backfill of historical PRs.

<a id="automated-release-procedure"></a>
### Automatic Rolling publication

Every PR actually merged to `main`, including docs and chores, starts its own
Rolling attempt for `pull_request.merge_commit_sha`. Closed unmerged PRs publish
nothing. There are no label/path gates or shared concurrency queues that can
cancel or displace intervening merges. A failed attempt does not block another.
The trusted `pull_request_target: closed` event permits publication for accepted
fork PRs too; checkout is only the already-merged commit, never a contributor head.

`rolling.yml` and its **Rolling** workflow name are permanent sequence authorities:
do not rename, recreate or reset them. `github.run_number` is the repository-local
sequence; reruns retain it. Completion timestamps are not release order. Consumers
must select the greatest compatible sequence, not the last-completed run or Latest.
Gaps are expected when a run fails or an unmerged closure consumes a number.

Main keeps `0.0.0-dev` in package/lock/module manifests. The MCP runtime reports
`dev+<seven-character source SHA>` in development. Packaging injects
`0.0.0-rolling.N` only into its private stage, including the runtime package
identity; source files and `main` are never rewritten. Tags are immutable
`v0.0.0-rolling.N` lightweight refs at the exact merge SHA. No version-preparation
PR, release label, manual tag or independent SDK version change is needed.

The workflow runs `npm test`, packages once, and validates that package. Each
Release has exactly:

- `cockpit-task-0.0.0-rolling.N.tgz`
- `cockpit-task-0.0.0-rolling.N.tgz.sha256`
- `cockpit-deployment.json`
- `cockpit-deployment.json.sha256`

The format-2, `channel: rolling` descriptor is byte-identical at the archive root
and in the sidecar. Its archive field names the archive without embedding its
checksum (avoiding self-reference). Independent checksum assets bind both files.
`module-build.json`, package and module manifest identify the injected version
and exact source SHA. Release notes include the merged PR's full title and body,
PR URL, source, tag, version, sequence and all four asset digests.

Publication creates a draft prerelease, uploads once, downloads every asset by ID,
verifies its API digest and byte checksum, checks embedded identity and exact asset
set, and publishes that same draft with one PATCH containing the original
release/asset ID, size and digest seal in its notes, `draft: false`,
`prerelease: true` and `make_latest: false`. There is no intermediate body-only
draft edit: such an edit can reset GitHub's selected tag to an `untagged-*`
placeholder. Publication readback permits only the expected sealed body/status
transition; tag, source and all asset identities/bytes must remain unchanged.
Rolling never takes Latest from an explicitly selected Milestone.

### Deployment contract and Task data

`scripts/deployment-manifest.js` derives host API bounds from the module manifest,
checks the actual backend/frontend version gates, and extracts required intents
from the host adapter. Requirements use the host's published capability names.
Resource preparation is declared because the shipped preparation operations need
it, although legacy unselected session creation can work on older hosts.

The database declaration is derived by initializing **synthetic** storage with the
actual `TaskStore`, reading its schema version and every application table/column.
It preserves all those columns, including Task history, operation receipts,
automation and migration audit tables. It does not inspect or change live data.
The database remains `task-board.sqlite`, now schema **12**. This is an incompatible
responsibility-model boundary, **not** a no-migration replacement for schema 11.
The descriptor declares `schema: 12` and `migrations: []`: there is no declared
automatic upgrade path. Empty migrations do not make a different source schema
compatible. Existing schema-11 data must not be activated with this release until
the separately authorized, offline [reviewed migration](#schema-12-migration)
has completed and been verified. Older schemas first require their own historical
migration procedures. Ordinary loading refuses every existing pre-12 database.
Unknown compatibility or undeclared schema transitions must fail closed in the
deployer. The current descriptor format needs no invented hook or extension to
express the required schema and absence of automatic migrations.
The `preserve` entries describe the required **schema-12** columns, including
`tasks.created_by`: the reviewed migration renames the former `orchestrator`
column without changing its historical values. It likewise retains historical
notice recipients and does not rewrite stored event or receipt JSON. An external
schema-11 baseline cannot treat these renamed columns as dropped/untracked data
and proceed automatically; its schema differs and no automatic recipe is declared.
The archive includes this full procedure and `docs/task-responsibility-migration.md`
beside the explicit CLI, so offline operators can review it without a source checkout.

The external deployment service consumes compatible descriptors independently.
Publication neither installs nor migrates data nor restarts a host. Its deployment
authorization and evidence remain separate from release/merge evidence.

### Schema 12 migration

This is the canonical offline schema-11-to-12 procedure and is shipped as
`docs/releases.md` in the module archive. Run commands from its extracted root
with Node 24 or newer. Do not edit an immutable installed package or invoke
migration through ordinary module loading.

#### Authorization and compatibility

Migration is a separately authorized offline operation, not a side effect of
merge, Rolling publication, package installation or restart. Ordinary loading
refuses every existing pre-12 database, including an empty schema-11 database.
Older schemas require their historical migration procedures before this tool
can review schema 11.

The shipped legacy CLIs remain separate stages: `migrate-task-v10.js` accepts a
reviewed schema-9 lifecycle plan and stops at **10**; `migrate-task-v11.js` performs
the receipt-only **10 → 11** upgrade. Neither constructs the current store or
chooses responsibility modes. Re-inventory schema 11 and provide the distinct
reviewed v12 plan afterward; completing an earlier stage does not authorize it.

The Rolling descriptor declares database schema **12** and `migrations: []`.
That means **no automatic migration path**. An external schema-11 baseline does
not match schema 12 and must not infer compatibility or attempt column removal.
The descriptor's preservation inventory describes schema-12 names, not a recipe
for transforming earlier data.

The reviewed migration retains:

- Task IDs, descriptions, statuses, bindings, parent relationships and depths;
- creator history through `tasks.orchestrator` → `tasks.created_by`;
- definition revisions, ACKs, outcomes, assignment records and reopen eligibility;
- original operation IDs, scopes, fingerprints, JSON, recovery markers and uncertainty;
- notification recipient snapshots through renamed `recipient` columns, with
  original event JSON and delivery facts unchanged;
- prerequisites and their history, automation run facts, barriers and uncertainty.

Rebuilt tables retain their exact `sqlite_sequence` INTEGER high-water marks,
including deleted historical IDs and values above JavaScript's safe-integer range.
Fingerprinting reads SQLite integers losslessly and keeps existing safe-integer
fingerprints unchanged. This does not widen the JSON review inventory's numeric
contract: an out-of-range integer in an inventoried record (such as a retained
Task or prerequisite row ID) still fails before migration, without rounding or
writing source data. A sequence at SQLite's maximum integer remains exhausted;
migration does not reset it to reuse deleted IDs.

It adds explicit mode/legacy fields and migration audit/history records.
Lifecycle/editable counters advance to invalidate old write contexts; revisions,
ACKs and historical timestamps are not fabricated. It never assigns, starts,
reopens, cancels or dispatches work, runs scripts, resolves automation barriers,
replays notices or inspects native sessions.

#### Review and exercise an isolated copy first

Obtain a consistent, explicitly authorized isolated copy containing the latest
committed SQLite data. Do not copy just the main file from a live WAL database
and assume it includes committed WAL records. This tool inventories a consistent
logical read, including committed WAL content, but does not create a backup,
stop writers or prove that the operational environment is offline.

```sh
node scripts/migrate-task-v12.js --data-root ./authorized-copy --inventory
```

Inventory produces the source schema, target schema, full logical
`source_fingerprint`, every Task's decision-relevant history, in-flight facts and
the plan contract. It does not choose modes or create an approved plan.

Prepare a separately reviewed JSON plan with exactly these top-level fields:

```json
{
  "schema": 11,
  "target_schema": 12,
  "source_fingerprint": "<exact inventory fingerprint>",
  "reviewer": "<reviewer identity>",
  "source": "<review authorization and evidence reference>",
  "tasks": {
    "<every Task ID>": {
      "revision": 1,
      "work_mode": "undecided",
      "evidence": "<the explicit reviewed decision and its basis>"
    }
  }
}
```

Each entry requires the Task's exact revision and only the three shown keys.
Include **every** Task, not just unfinished work. Reviewer identity is bounded
to 200 characters; review source and each evidence entry to 4,000 characters.

| Source Task | Permitted reviewed mode |
| --- | --- |
| Agent `todo` | `undecided` |
| Agent `in_progress` | `execute` or `orchestrate` |
| Agent `done` | `null` for unknown legacy history, or evidence-backed `execute` / `orchestrate` |
| Agent `cancelled` | `null`, evidence-backed `execute` / `orchestrate`, or `undecided` for an unstarted cancellation |
| Automation | `null` only |

No children does **not** establish `execute`; an orchestrator may have none.
Native activity does not establish mode or lifecycle. Unknown historical
terminal modes remain `legacy: true` and cannot be reopened by guessing a mode.
Even a reviewed known terminal mode creates only a migration event, never a
fictional historical start or assignment record. There is no post-schema-12
legacy-mode repair API; do not use direct database edits to bypass this boundary.

```sh
node scripts/migrate-task-v12.js --data-root ./authorized-copy --plan ./reviewed-v12.json --preflight
node scripts/migrate-task-v12.js --data-root ./authorized-copy --plan ./reviewed-v12.json --apply
```

Preflight validates the plan without applying DDL or changing source rows.
Exercise apply on the isolated copy and verify preservation before any separately
authorized migration of real data. Apply repeats validation under an immediate
transaction and records the source fingerprint, plan fingerprint, reviewer,
evidence and per-Task decisions. Schema/data changes commit together or roll back.
Reapplying to schema 12 is refused; an uncertain command result requires inspection,
not an automatic retry.

#### Refusal and recovery boundaries

Any logical source drift—including history, receipts, schema or committed WAL
changes—invalidates the fingerprint. Inventory and review the changed source
again. A copy's plan is reusable only if the full source fingerprint is identical.

Missing/extra/unknown decisions, unsupported source structure, cycles, invalid
bindings/depths, invalid parent modes, unfinished children under terminal parents,
conflicting assignees and invalid prerequisites fail closed. The tool does not
repair them or manufacture responsibility. Review is bounded to 10,000 Tasks.
Prerequisite validation includes child-completion waits and ancestor readiness
needed by unstarted descendants, not just explicit dependency cycles.
Automation Task status must agree with its run state: unstarted `todo/created`,
finished `done/succeeded|failed|interrupted`, or final `cancelled/cancelled`.
Contradictory pairs are rejected rather than reclassified; in-flight states are
rejected separately below, and legitimate terminal barriers remain preserved.

Pending operations/notices and queued/starting/running automation prevent apply.
Resolve their actual facts separately using authorized procedures; there is no
force flag. Historical unknown delivery/results remain unknown. A terminal
automation barrier is preserved and is not proof of process exit or success.

Schema 12 is forward-only. Switching to an older package is not data rollback.
Retain verified backup and migration evidence; never replace newer live facts with
an old backup merely to make an earlier module open them.

### Explicit Milestone promotion

Run **Milestone** (`milestone.yml`) from `main`, entering an existing successful
Rolling tag in both `tag` and `confirm_tag`. This is explicit selection, not a
request to build or choose the newest release. It rejects non-Rolling tags, drafts,
missing assets, mismatched checksums and changed asset IDs/bytes.

The workflow reads and pins the release/source/tag/title/body and all four asset
identities against the original publication seal in the notes, downloads and
verifies bytes, then repeats that verification before
one PATCH containing only `prerelease: false` and `make_latest: true`. It verifies
the same immutable identity and Latest afterward. It never builds, renumbers,
replaces an asset, changes notes/title/tag, or creates another release. The
descriptor's channel remains `rolling`: a Milestone is the same tested artifact.

<a id="atomic-release-publication"></a>
### Failure and recovery

All tag, release, asset and status mutations reuse the single-attempt HTTPS
transport in `release-write.js`: fixed content length, no redirects or retry.
Once draft creation returns an ID, readback uses `GET /releases/{id}` and verifies
the ID, tag, source, notes and assets directly. A collection omitting a new draft
does not establish that it disappeared and never triggers another creation.
An uncertain response triggers readback for diagnosis and stops all later writes,
even if the write may have succeeded. Never blindly rerun, clobber, replace assets,
move tags or publish changed bytes under an existing version.

Inspect authoritative state first. A separately authorized rerun retains the
original sequence, source and expected notes/bytes. It can verify an already
published release without mutation, or publish a complete byte-identical draft
without uploading again. A partial/conflicting draft fails closed and remains
available for diagnosis. Node/dependency changes that alter rerun bytes also fail
closed. Do not delete it and recreate a replacement to evade immutability.

`release.yml` remains a **dispatch-only legacy draft recovery** entry point with
its existing explicit release/asset IDs and digests. It no longer responds to tag
pushes and is not the Rolling or Milestone entry point. Historical recovery needs
separate authorization; the model switch does not operate historical Releases.

### Local validation

With Node 24 and worktree-local dependencies:

```sh
npm test
npm run package:module
node scripts/verify-package.js dist/cockpit-task-0.0.0-dev.tgz "$(git rev-parse HEAD)"
ROLLING_SEQUENCE=123 npm run package:module
ROLLING_SEQUENCE=123 node scripts/verify-package.js \
  dist/cockpit-task-0.0.0-rolling.123.tgz "$(git rev-parse HEAD)"
```

Local synthetic sequences are validation only, never permission to publish.
