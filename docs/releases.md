# Releases

Cockpit Task Releases contain `cockpit-task-X.Y.Z.tgz` and its matching
`.sha256`, not an npm package or a source archive.

<a id="automated-release-procedure"></a>
## Automated release procedure

1. Prepare the version and current `docs/release-notes.md` through a pull request.
2. Merge it and confirm Task CI passed for that exact `main` SHA.
3. Create and push an annotated immutable `vX.Y.Z` tag at that SHA.
4. The Release workflow runs the native test/package chain on the tag SHA and
   downloads that run's original archive. The publish job never repackages it.
5. The workflow verifies main ancestry, the remote tag target, version, release
   notes, source/build manifest, checksum and the machine-readable host identity.
6. It stages both assets in a draft, downloads and verifies them again, then
   publishes the complete draft as a non-prerelease Latest Release.

Tags, published Releases, versions and assets are immutable. The workflow refuses
an existing published Release and never uses clobber. If an earlier run already
created the unique exact-tag draft, it verifies and reuses that draft without
uploading assets again. Publication does not install, deploy, restart or migrate
Task data.

<a id="atomic-release-publication"></a>
## Failure and unknown-result recovery

Only a formal, non-draft, non-prerelease Release with both verified assets is a
readiness signal. If creation, upload, publication or final readback fails or has
an unknown result, inspect the remote tag, draft/Release and assets first. Keep a
partial draft for diagnosis. Do not blindly retry a mutation, move the tag, delete
or replace a published Release, or publish changed bytes under the same version.

To resume a complete draft, run the Release workflow from `main` with its
`workflow_dispatch` entry point. Supply the immutable tag plus the existing
Release ID, archive/checksum asset IDs and their full `sha256:...` API digests.
The recovery job checks out the tag, reads that Release by ID, downloads both
assets by ID, verifies their API and byte identities against the tagged source,
and only then publishes that same draft. A missing, duplicate, conflicting,
partial or already-published Release fails closed. If a create or publish request
has an unknown result, the workflow rereads authoritative state and never retries
the mutation automatically.

After a joint deployment with the host, follow Cockpit's
[release-after-acceptance policy](https://github.com/waksana/cockpit/blob/main/docs/releasing.md#release-after-acceptance).
