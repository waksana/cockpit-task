# Managed Cockpit Task module

`module.json` is the schema-v1 official module artifact (package version 1.2.0).
It declares explicit commander and owner roles with isolated role instruction and
skill roots. Both use `cockpit-task` at `src/mcp.js`; existing `work-commander`
MCP/skill installation paths remain available for legacy clients. Selecting a
role is not business authorization or a credential. Owner role selection must not
inherit Assistant identity from cwd or a fork.

Managed skills use unique discovery names `cockpit-task-commander` and
`cockpit-task-owner` beneath `skills/commander/` and `skills/owner/`. Role
instructions and managed goal prompts reference these module-only names, avoiding
native name deduplication with global/project/bundled skills. The original
`skills/work-commander` and `skills/work-commander-owner` files remain unchanged.

## Processes and persistent paths

Cockpit, Task and Assistant remain independent processes. Task listens only on
loopback and remains the sole writer of its business database. The Cockpit module
installer owns release selection, module configuration and log routing:

| Purpose | Default managed path |
| --- | --- |
| Immutable package | `~/.cockpit/modules/task/releases/<version>` |
| Module configuration | `~/.cockpit/module-config/task.json` |
| Task data, credentials and flock | `~/.cockpit/data/task` |
| Task logs | `~/.cockpit/logs/task` |

Set `COCKPIT_USER_ROOT` to change the common managed user root. Managed mode is
explicitly enabled by `WORK_COCKPIT_MODULE_VERSION=<installed-version>`.
`WORK_DATA_DIR` always wins; an existing installation should register its external
data/release paths instead of copying data, rebinding tasks or reissuing existing
credentials. `WORK_CREDENTIAL_DIR` may explicitly override the MCP credential
root; otherwise it follows `<data>/credentials`. Without managed mode, the legacy
`~/.local/state/work-commander` default and dispatch behavior are unchanged.

Launcher remains `node src/launch.js`; preserve existing lifecycle admission/drain
and flock. No forced exit, queue cancellation, service restart or database move is
part of module role application.

### Independent consumer runner startup contract

The manifest declares `service.entry:"src/launch.js"`, `healthPath:"/health"`,
`versionPath:"/version"`, `drainPath:"/drain"` and `publicPath:"/modules/task"`.
The non-Docker consumer runner launches Node 24 from the selected immutable
release directory with argv `["node","src/launch.js"]`. `flock` must be available
on PATH. The launcher acquires `<WORK_DATA_DIR>/service.lock` and alone sets
`WORK_LOCK_HELD=1` for the server child; never set that flag to bypass the launcher.
The runner owns parsing `module-config/task.json` and mapping its validated
references to environment variables. Task does not read a second config database
or a `WORK_CONFIG_FILE`; it consumes the following startup environment.

| Variable | Consumer runner value / meaning |
| --- | --- |
| `COCKPIT_USER_ROOT` | Absolute Cockpit user root, default `~/.cockpit` |
| `WORK_DATA_DIR` | Registered Task data directory, normally `<root>/data/task`; preserve external data overrides |
| `WORK_PORT` | Allocated Task loopback HTTP port, e.g. `8790`; server binds `127.0.0.1` only |
| `COCKPIT_URL` | Cockpit internal HTTP origin, e.g. `http://127.0.0.1:8771`; no module prefix |
| `COCKPIT_API_TOKEN` | Optional existing Cockpit internal bearer, only if required by that endpoint; never UI config contents |
| `COCKPIT_WEB_URL` | Cockpit browser origin used for `/session/<id>` links |
| `WORK_PUBLIC_URL` | Browser Task URL, normally `https://<cockpit>/modules/task/` |
| `WORK_BASE_PATH` | `/modules/task` |
| `WORK_MODULE_GATEWAY_URL` | Canonical HTTPS Cockpit origin trusted for viewer-only proxy requests |
| `WORK_GATEWAY_URL` | Optional preserved legacy gateway origin, e.g. `https://task.rbym47.com` |
| `WORK_MODULE_MANAGER_CREDENTIAL` | Absolute protected manager JSON credential file reference; Task reads its token server-side |
| `WORK_COCKPIT_MODULE_VERSION` | Selected installed Task version, enables explicit Task owner role preparation |
| `COCKPIT_MODULE_ID` | Literal `task` |
| `COCKPIT_MODULE_VERSION` | Selected manifest version; must equal the actual running package version and, when supplied, `WORK_COCKPIT_MODULE_VERSION` |
| `COCKPIT_MODULE_DIGEST` | Verified catalog inventory digest, exactly 64 lowercase hex characters |
| `COCKPIT_MODULE_INSTANCE` | Fresh UUID allocated for this service process instance |

`WORK_PORT` must equal the port in the supervisor's registered `serviceUrl`.
`COCKPIT_MODULE_PORT` is not consumed by Task; setting only that variable does not
configure its listening port.

Pass all four `COCKPIT_MODULE_*` identity fields together. `/version` reports
`moduleApi:1`, actual package `version`, `moduleVersion`, `moduleDigest`, the
runner's `instanceId`, and `identitySource:"module-environment"`. `/health` reports
that same captured instanceId, package version, moduleVersion and moduleDigest. Environment mutation does not
rewrite identity after startup. The module digest is a **catalog inventory**
digest, not a private-CD artifact hash; Task does not pretend to recompute the
runner's catalog verification.

Do not manufacture or inherit `SERVICE_DELIVERY_SHA`, `SERVICE_DELIVERY_ARTIFACT`,
`SERVICE_DELIVERY_REQUEST` or `SERVICE_DELIVERY_INSTANCE` into a consumer launch.
Private-CD and consumer-module identity authorities are mutually exclusive:
simultaneous identities fail closed rather than overriding private-CD priority or
combining incomparable provenance. A private-CD launch with its existing complete
four-field identity remains unchanged and reports `identitySource:"delivery-environment"`.
Consumer mode keeps `sha`, `artifactSha256` and `requestId` null; legacy/private-CD
mode keeps `moduleVersion` and `moduleDigest` null. Partial, malformed, wrong-module
or wrong-package module identities reject startup rather than reporting readiness.

For each role MCP child launch Node with the pinned `src/mcp.js` and:

- `WORK_URL=http://127.0.0.1:<WORK_PORT>` (the Task service, not Cockpit or its
  browser `/modules/task` route).
- `WORK_CREDENTIAL_DIR=<registered-data>/credentials`, an existing canonical
  directory; `WORK_DATA_DIR` may also be supplied to preserve the same data root.
- Optional `COCKPIT_USER_ROOT` and `WORK_COCKPIT_MODULE_VERSION` if relying on managed
  defaults instead of explicit data/credential paths.

Do not pass the module manager credential/token to role MCP clients; they receive
only scoped caller/owner credential file paths per the handshake below.
The service does not write its log destination: the runner routes stdout/stderr
to `<root>/logs/task`. It waits for real same-instance `/version` and `/health`,
not merely a spawned process. The managed supervisor stops through
`POST /drain {"pending":true}` with the dedicated module-manager bearer described
below, then waits for natural exit without force signals or a kill timeout.
Legacy manual shutdown still handles normal SIGTERM/SIGINT or the existing
trusted `/admin/restart {"pending":true}` admission/drain path; `WORK_ADMIN_TOKEN`
remains the optional pre-existing local-admin bearer and is not the module-manager
credential. No force timeout, data relocation, private-CD takeover or production
startup is implied by this contract.

## HTTP proxy contract

Set `WORK_BASE_PATH=/modules/task`. Cockpit strips `/modules/task` before forwarding
to Task; Task's backend routes stay unprefixed. This config changes emitted HTML,
static references, browser API/SSE requests and task deep links, not API routing.
`WORK_PUBLIC_URL` controls emitted task links (set to the Cockpit origin or its
`/modules/task/` URL for new installations).

Set `WORK_MODULE_GATEWAY_URL=https://<cockpit-origin>` for the trusted Cockpit proxy.
The existing `WORK_GATEWAY_URL=https://task.rbym47.com` can remain configured:
when both distinct gateway origins exist, the legacy gateway gets empty-base HTML
and links, preserving its current root URL. Existing WORK_PUBLIC_URL pointing to
that legacy gateway also retains root-based task links.

The proxy must replace incoming browser bearer credentials with its private
**viewer** bearer and set Host to the configured module gateway host. It must
enforce authenticated Cockpit access and exactly these allowed methods/paths:

| Methods | Backend path |
| --- | --- |
| GET, HEAD | `/`, `/app.js`, `/style.css`, `/api/events` |
| POST | `/api/read` |

Query strings such as `/?task=<id>` are allowed; encoded aliases or additional
paths are not a broader grant. `/api/events` streams invalidations and reauthorizes
by reconnecting within 60 seconds. Both configured gateway hosts independently
enforce the viewer role and this allowlist inside Task as defense in depth.

**Never proxy** `/api/tools/:name`, `/admin/*`, `/drain`, `/health`, `/version`, or `/status`
through the public module route. Protected local MCP writes keep their existing
caller/owner token roles. Browser authentication does not grant either role.
Health/version/status remain available for separately trusted service management.

## Dedicated caller provisioning handshake

Optional `WORK_MODULE_MANAGER_CREDENTIAL` is the path of an owned private 0600 JSON
file containing `{ "token": "<dedicated high-entropy management token>" }`.
No route is registered if absent. Do not reuse a viewer, caller or owner token.
This credential is supplied only to the trusted Cockpit module manager and Task
service; never to a browser or role MCP process.

The same manager credential authorizes the optional `POST /drain` route; it is
also absent unless the credential file is configured. Drain uses the same
non-browser loopback/Host/Origin checks as provisioning and requires exactly
`{"pending":true}`. It closes mutation admission synchronously, leaves admitted
operations and notifications intact, and returns:

```
{
  "ok": true, "pending": true, "restartPending": true,
  "acceptingMutations": false, "inFlight": 1, "activeMutations": 1,
  "activeDispatches": 1, "activeNotifications": 0, "activeRecoveries": 0,
  "safeToRestart": false, "reason": "in-flight-mutations",
  "instanceId": "<same-runtime-UUID>",
  "moduleVersion": "<actual-module-version>",
  "moduleDigest": "<catalog-inventory-digest>"
}
```

Counts/reason/safeToRestart reflect the actual current lifecycle, not these example
values. The process exits only after admitted mutations settle. There is no drain
cancellation, forced termination, schedule cancellation or task replay. The
supervisor checks the returned instance identity against the owned child; it must
not drain or take over a separately registered external service.

The manager performs one explicit call:

```
POST /admin/module/caller
Authorization: Bearer <management token>
Content-Type: application/json

{"requestId":"<stable-management-operation-id>","sessionId":"<actual-native-session>"}
```

Only a non-browser loopback client is accepted; Origin and Sec-Fetch headers
reject the request. The body is strict and accepts no claimed caller/owner role,
authority or task binding. Task first verifies native session existence through
`Cockpit.meta(sessionId)`, then issues a normal caller credential bound to it.
Success returns **only** `{"credentialFile":"<absolute-protected-path>"}`.
The database's normal credential hash remains authoritative; new management
receipts contain requestId, sessionId, credential path and time, never raw tokens.

Cockpit builds native role configuration before creating the session. It can
include a stable nonsecret reference path
`<COCKPIT_USER_ROOT>/data/task/session-access/<sessionId>.json` in those instructions,
but must provision only after native creation confirms the session exists.
After Task returns the credential path, Cockpit writes that path (never a token)
to its reference file and marks the role ready before accepting any user prompt.
The agent reads only this nonsecret reference and passes the resulting credential
file path to MCP. No second resume or automatic prompt is needed to insert a
credential filename into instructions. Task does not write or own this Cockpit
reference; its existing same-request receipt supplies the same credential path.

The same requestId/sessionId returns the original path (including after restart).
A changed sessionId conflicts. A durable reservation precedes issuance; a crash
or local write failure after that reservation is explicitly incomplete and cannot
automatically mint another credential. An operator must reconcile it; do not
change requestId to retry an uncertain operation. Revoked/missing credentials
are not silently replaced. The route participates in normal lifecycle admission
and drain and cannot provision after restart admission closes.

Owner role application must **not** call this endpoint. Existing
`Work.ensureOwnerCredential` remains responsible for task+session-bound owner
credentials, supplied by path in the normal goal prompt.

## Owner preparation API

Managed dispatch calls:

```
session/new {
  cwd,
  modules: [{moduleId: "task", roleId: "owner", version: WORK_COCKPIT_MODULE_VERSION}]
}
session/modules/apply {
  sessionId: <bound-owner>,
  selections: [{moduleId: "task", roleId: "owner", version: WORK_COCKPIT_MODULE_VERSION}],
  operationId: <original-persisted-Task-operation-id>
}
```

`session/fork` retains its existing source/event body and returns an unloaded
child. Task reads that child and explicitly calls `session/reload {sessionId}`,
reads back the loaded session/model, then calls `session/modules/apply`.
Apply requires an already loaded, safe-idle session without active native
schedules; native fork also refuses source schedules/queued work. Task does not
stop schedules or clear work to force this boundary. Cold load/resume alone does
not initialize a role or send a seed prompt. Only a response with `phase:"applied"`,
the correct sessionId and exactly the pinned Task owner selection permits the
normal business goal prompt. Existing owners on explicit
continue/adopt use the same apply endpoint; model/cwd/task binding semantics do
not change. Role application is a persisted operation step: a failure/unknown
result prevents prompting and does not automatically replay or replace the owner.
Managed mode replaces legacy per-session MCP/skill toggles, not business authority.
Only Cockpit owns native module selections and exclusion of implicit Assistant
inheritance. Task sends no extra auto-prompts during role setup.

## Version, drain and backup

`/version` declares `moduleApi:1`; `/version` and `/health` report the same captured instanceId and package version;
existing fixed-SHA delivery identity remains unchanged. `POST /admin/restart`
still closes admission and waits for admitted effects without force or timeout.
For a pre-upgrade consistent SQLite snapshot use existing
`WORK_DATA_DIR=<registered-data> node src/admin.js backup <new-private-file>`.
It uses `node:sqlite` online backup without running schema migrations on the source;
also preserve the existing credentials directory. A rollback must not overwrite
business records, external data paths or credentials.
