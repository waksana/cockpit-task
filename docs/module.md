# Managed Cockpit Task module

`module.json` is the schema-v1 official module artifact (package version 1.2.6).
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

Before sending an owner prompt, managed dispatch reads `session/modules/get`
and checks the exact session, `applied` phase and sole Task owner selection.
`new` already supplies the requested modules to native creation; it only
verifies that selection and never invokes apply on the empty session. New
creation checkpoints retain the selected version for explicit recovery after
a service update. An already-applied sole owner on `continue` or `adopt` keeps
its pinned version, even when the shared Task service runs a newer release.

Explicit fork/continue/adopt still use the existing safe apply operation when
the required owner environment is absent or differs. Only an explicit
`modules:null` means no configuration; missing/malformed responses, uncertain
phases or `nativePresent:false` never trigger apply or prompt. Apply retains
its native busy/schedule fences and exact result validation. Old completed
checkpoints cannot override contradictory current module state. An HTTP 200
dispatch envelope alone is not success: check `operation.status`. Existing
failed/unknown dispatches are not automatically retried or assigned new owners.
MCP preserves that same HTTP result body and marks failed/unknown operations
with `isError:true`. Its reported version comes from its installed `package.json`,
not a separate hardcoded version or a fabricated native-state mirror.

## Use-time native target checks

Starting in 1.2.6, only successful `session/get {sessionId}` returning
`{meta:null}` establishes absence. Metadata must otherwise identify that exact
session and include the native loaded/status fields. Unloaded sessions exist;
403/404, timeout, malformed envelopes and mismatched IDs are
`UPSTREAM_READ_FAILED`, never absence.

Dispatch checks its original caller before native creation/preparation, its
original owner during preparation, and again immediately before the goal
prompt. Notifications check their exact caller before sending. Confirmed
absence records a failed operation with `SESSION_NOT_FOUND`; no prompt,
replacement session or replacement credential follows. HTTP 200 tool envelopes
can carry this failed operation and are not success receipts. Read failures
also refuse the operation, without treating the reference as invalid.

Cold owner preparation uses `session/load {sessionId}` and requires
`{ok:true,sessionId}` for the original ID, followed by a loaded metadata read.
It never uses close/resume `session/reload`, cannot recreate a missing empty
owner, and does not send an initialization message. Applied continue/adopt
owner selections retain their pinned release, including across service updates.

Native deletion invokes no Task unbind or broadcast. Task does not maintain a
second native-session catalog or mutable outbound-route registry. Its
caller/owner fields are historical identity and authorization bindings, so they
are not cleared, revoked or rewritten after deletion. The failed operation is
the use-time refusal; operation reservations remain for explicit recovery of
that original operation, not automatic dispatch. Task records, versions,
credentials, imported references and final results remain durable, including a
result whose notification failed. Normal record/history reads remain passive.

## Processes and persistent paths

Cockpit and Task run in separate processes; Assistant supplies role content, not
a service process. WeChat retains its own connector process. Task listens only on
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
| `WORK_MODULE_GATEWAY_URL` | Canonical HTTPS Cockpit origin, including an optional non-default port, trusted for viewer-only proxy requests |
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
Canonical HTTPS origins with explicit non-default ports are supported, for example
`WORK_MODULE_GATEWAY_URL=https://127.0.0.1:34907` with
`WORK_PUBLIC_URL=https://127.0.0.1:34907/modules/task/`. The gateway value must
exactly equal the URL's canonical origin: no trailing slash, path, query,
fragment or credentials. Default HTTPS port 443 is omitted in canonical form.
The proxy must preserve the configured Host **including its port**. If Origin
is present, it must exactly match that gateway's HTTPS origin; trusting two
gateway origins does not allow cross-origin requests between them, even on the
same hostname with different ports. Requests without Origin still require the
viewer bearer and the same method/path allowlist. Task remains loopback HTTP
behind the HTTPS proxy; this setting does not enable TLS on the Task listener.

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
session/modules/get { sessionId: <bound-owner> }
```

Only explicit fork/continue/adopt with an absent or different owner selection
may additionally call:

```
session/modules/apply {
  sessionId: <bound-owner>,
  selections: [{moduleId: "task", roleId: "owner", version: WORK_COCKPIT_MODULE_VERSION}],
  operationId: <original-persisted-Task-operation-id>
}
```

`session/fork` retains its existing source/event body and returns an unloaded
child. Task reads that child and explicitly calls `session/load {sessionId}`,
reads back the loaded session/model, then calls `session/modules/apply`.
Apply requires an already loaded, safe-idle session without active native
schedules; native fork also refuses source schedules/queued work. Task does not
stop schedules or clear work to force this boundary. Cold load/resume alone does
not initialize a role or send a seed prompt. Only a response with `phase:"applied"`,
the correct sessionId and exactly the pinned Task owner selection permits the
normal business goal prompt. Existing owners on explicit
continue/adopt first verify their pinned selection read-only; model/cwd/task binding semantics do
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

## Fresh local configuration initialization

`node src/module-setup.js` is the noninteractive, local-only bootstrap entry for
an explicitly fresh installation. The host sends exactly one stdin JSON request:

```json
{"operation":"config-initialize","operationId":"task-install-0001","dataDirectory":"/absolute/private/task-data"}
```

The absolute `dataDirectory` must be canonical (no symlink aliases, trailing
slash, dot segments, NUL or newline), either absent or already empty and owned
0700. Its parent must already be an owned canonical 0700 directory. Missing
ancestors, public permissions, existing database/business files, credential
directories and service locks are refused **before** constructing `Store`.
The CLI never chmods/adopts an existing installation, moves/copies native data,
connects to Cockpit, starts a service or creates a caller/native session.

Success is one JSON line, exit 0, containing only this path contract:

```json
{
  "ok": true,
  "operationId": "task-install-0001",
  "dataDirectory": "/absolute/private/task-data",
  "credentialDirectory": "/absolute/private/task-data/credentials",
  "managerCredentialFile": "/absolute/private/task-data/credentials/module-manager.json",
  "viewerCredentialFile": "/absolute/private/task-data/credentials/module-viewer.json"
}
```

The viewer is issued through the existing `Store.issue('viewer')` with null
session/task scope. The independent manager token uses a separate 32-byte random
value and is **not** a caller/owner/viewer database principal. Both files use
the existing private JSON `{token}` credential format and 0600 permissions;
tokens never appear on stdout or in the setup receipt. There are no task,
business-operation or module-caller-provision rows.

Before any database or credential creation, an exclusive, fsynced
`.module-setup.json` claims the directory for the exact operation ID. Atomic,
fsynced stages precede store creation, viewer issuance, manager issuance and
store close. Partial failures preserve the last phase and all partial
files/rows. Identical-ID invocations only read a completed result or refuse
with `SETUP_OUTCOME_UNKNOWN`; they never mint again or automatically continue.
Another ID receives `SETUP_OPERATION_CONFLICT` and cannot bypass a claimed
directory. A malformed/incomplete claim also refuses initialization.
Completed readback checks the fixed result paths and protected credential-file
hashes without opening/migrating the database; changed/missing credentials are
not repaired or reissued. No claim/lock is removed or stolen, and no failure
path clears data.

Errors exit 2 and return only
`{"ok":false,"error":{"code":"STABLE_CODE"}}`. Codes include
`INVALID_SETUP_REQUEST`, `INVALID_SETUP_DIRECTORY`, `UNSAFE_SETUP_DIRECTORY`,
`UNSAFE_SETUP_FILE`, `SETUP_DIRECTORY_NOT_EMPTY`, `SETUP_OPERATION_CONFLICT`,
`SETUP_OUTCOME_UNKNOWN` and `SETUP_IO_FAILED`. Transport size/deadline policy is
the host's responsibility; there are no prompts, automatic retries or service
operations.

The host can map returned paths directly to the existing startup contract:
`WORK_DATA_DIR=dataDirectory`,
`WORK_MODULE_MANAGER_CREDENTIAL=managerCredentialFile`, and the viewer file to
its private read-only HTTP proxy bearer. MCP's existing credential root is
`WORK_CREDENTIAL_DIR=credentialDirectory`. This does not authorize caller/owner
provisioning or business writes. Service startup remains a separate explicit
launch through `src/launch.js` and the normal flock, identity, viewer auth and
manager-authenticated drain controls.

The optional manifest declaration for host-owned integration is
`configLifecycle:{"initialize":{"entry":"src/module-setup.js"}}`, explicitly
declared by Task 1.2.3. It is not a default for every module or a new generic
hook framework. Cockpit owns the installer/parser/API integration.

`node --test test/module-setup.test.js` uses real Node subprocesses to cover
empty/missing directories, idempotent readback, concurrent claims, existing-data
refusal, unsafe paths/permissions, injected failure and process exit after
viewer issuance. A synthetic isolated initialized directory also starts the
real `src/launch.js` service: `/version` and `/health` agree, the viewer can read
but cannot write, the manager is not a viewer principal, and manager `/drain`
exits naturally. Outbound fetch is forbidden in that fixture; no native session
is needed or created.
