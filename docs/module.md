# Managed Cockpit Task module

`module.json` is the schema-v1 official module artifact (package version 1.2.0).
It declares explicit commander and owner roles with isolated role instruction and
skill roots. Both use `cockpit-task` at `src/mcp.js`; existing `work-commander`
MCP/skill installation paths remain available for legacy clients. Selecting a
role is not business authorization or a credential. Owner role selection must not
inherit Assistant identity from cwd or a fork.

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

**Never proxy** `/api/tools/:name`, `/admin/*`, `/health`, `/version`, or `/status`
through the public module route. Protected local MCP writes keep their existing
caller/owner token roles. Browser authentication does not grant either role.
Health/version/status remain available for separately trusted service management.

## Dedicated caller provisioning handshake

Optional `WORK_MODULE_MANAGER_CREDENTIAL` is the path of an owned private 0600 JSON
file containing `{ "token": "<dedicated high-entropy management token>" }`.
No route is registered if absent. Do not reuse a viewer, caller or owner token.
This credential is supplied only to the trusted Cockpit module manager and Task
service; never to a browser or role MCP process.

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
