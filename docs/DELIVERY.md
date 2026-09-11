# Task delivery and runtime identity

This private project uses the fixed-version reusable build and transfer workflows
from `waksana/cockpit`. Its integration ref is `main`; push checks/builds only.
`service-delivery.json` binds the complete runtime, including its MCP and skills.
An explicit authenticated service-delivery `submit` with project `task`, environment
`production` and a full integrated SHA is required for deployment. Use the original
request ID for lookup; do not redispatch an uncertain operation.

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
