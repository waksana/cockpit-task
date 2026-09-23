# Contributing to Cockpit Task

Use an isolated branch/worktree from fresh main. Preserve concurrent work and
existing version preparations. Validate with the existing `npm test` and
`npm run package:module` commands using synthetic data, never production Tasks,
native sessions or credentials.

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
the appropriate undelivered version, reuse it rather than repeating its bump:
the current 0.1.9 preparation includes the coding/deployment Skill boundary
clarification and supersedes installed 0.1.8; that installation remains immutable.

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
