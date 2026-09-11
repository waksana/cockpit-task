# Task delivery and runtime identity

This public-source project uses the fixed-version reusable build and transfer
workflows from `waksana/cockpit`. Its integration ref is `main`; push checks/builds
only.
`service-delivery.json` binds the complete runtime, including its MCP and skills.
Official Cockpit module artifacts also include `module.json`, `roles/` and the
role-specific skill roots; managed paths, proxy and provisioning contracts are in
[Managed Task module](module.md). Existing deployment/data registrations remain
valid and are not moved by installing a module artifact.

Repository write and workflow authentication is publisher-side only. The official
ordinary-user default is an anonymously downloadable signed Release artifact,
pinned and verified by version and digest before installation. Task runtime/setup
never invokes Git, `gh`, the GitHub API, or asks the consumer for a GitHub account
or PAT. Any host-provided private authenticated source extension remains opt-in
operator configuration and must not become the ordinary-user default. Public
source and Release distribution do not make Task runtime endpoints, task data,
credentials or backups public; their existing loopback, viewer and Passkey
protections remain required.

An explicit authenticated service-delivery `submit` with project `task`, environment
`production` and a full integrated SHA is required for deployment. Use the original
request ID for lookup; do not redispatch an uncertain operation.

## New development owner access

Do not reuse another owner's credential file. Ask the installation operator for
an independent submit credential bound to your session's completion callback.
The installed operator command is
`node /opt/service-delivery-toolkit/current/bin/issue-credential.mjs --config PRIVATE_RUNNER_CONFIG --actor UNIQUE_OWNER_ID --session OWNER_SESSION_ID --output NEW_PRIVATE_CREDENTIAL`.
It exclusively creates a submit-role credential; it does not approve a deployment
or grant admin/import/boot/recovery permission. The current submit role is not a
per-project sandbox: deployment still requires a separately registered exact
project/environment/SHA approval. Keep the credential private and use only your
authorized target.

After integration, provide the operator your full SHA, unique request ID,
`task/production`, committed config hash and explicit user deployment authorization.
The operator reviews the existing allowlist and registers the bound approval
using the toolkit's `authorize` command, returning a private request JSON path.
Writing an authorization JSON yourself is not server-side approval.

Run `node /opt/service-delivery-toolkit/current/bin/service-delivery.mjs submit
--request PRIVATE_REQUEST_JSON --credential OWN_CREDENTIAL` once, then use
`lookup --request-id ORIGINAL_REQUEST_ID --credential OWN_CREDENTIAL`.
A build-only `prepare` needs no deployment approval, but it remains a preview
until submitted. Source integration/push and credential issuance do not deploy.

The loopback process reports `/version` with `sha`, `artifactSha256`, `requestId`,
`instanceId` and package version. `/health` must agree on the instance. The repository
HEAD and the current directory name are not substitute process identities.
The Cockpit system-version view reads these endpoints and the delivery runner on
demand, using a server-side viewer-only credential.

`POST /admin/restart {"pending":true}` closes new mutation admission synchronously
and waits for admitted service operations to finish, including dispatch and final
notification. It does not wait for all business owners to finish their goals.
There is no force timeout or cancellation of in-flight effects. The installed
launcher restarts after safe exit and selects a verified immutable candidate;
an explicit `systemctl stop` remains a stop.

## Local installation boundary

The delivery launcher configuration is
`~/.config/service-delivery/cockpit/launch-task.json`. The per-project selection
root remains `~/.local/share/work-commander`, so the existing `current/src/mcp.js`
future-start path follows the package without changing technical MCP names.
The service's delivery lock lives under `~/.local/state/service-delivery/task`;
the business SQLite database and credentials remain under their original
`~/.local/state/work-commander` location. They are not part of a release or rollback.

The first transition from the pre-drain runtime required an explicitly authorized
maintenance window. New loopback connections were temporarily redirected to a
503 not-admitted response; existing connections and running service operations
were allowed to finish before the old process received its normal stop signal.
The temporary gate was removed after launching the new package. No task rows,
credentials, queues or unknown outcomes were erased, and no healthy delivery
record was fabricated for the inventoried old-runtime bootstrap snapshot.
Future updates use the native drain endpoint instead of repeating that migration.

Already-connected external MCP processes may still run older code. A future
startup path is not evidence that all clients have reconnected. Skill discovery
refresh similarly cannot replace instructions already present in a model context.
