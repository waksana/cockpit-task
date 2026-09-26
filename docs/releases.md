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
The current database remains `task-board.sqlite`, schema **11**, with no migration:
the existing schema-11 deployment baseline can continue safely. Existing v10/v9
data requires the separately reviewed migration procedures, not an invented
automatic hook. Unknown compatibility or schema transitions must fail closed in
the deployer; adding a real migration requires reviewing its nondestructive
preflight/apply plan and hashes before publishing that declaration.

The external deployment service consumes compatible descriptors independently.
Publication neither installs nor migrates data nor restarts a host. Its deployment
authorization and evidence remain separate from release/merge evidence.

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
