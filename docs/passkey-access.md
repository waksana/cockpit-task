# Passkey-protected Task access

The external entry is **https://task.rbym47.com/**. Task still listens only on
`127.0.0.1:8790`; the local MCP, caller/owner credentials, database and execution
bindings are unchanged. No new identity provider or task database is installed.

## Trust boundary

The existing TLS edge forwards to loopback nginx. Its wildcard certificate
covers Task. Gate uses RP ID `rbym47.com`, but its cookies are host-only:
an existing discoverable passkey can authenticate on an explicitly allowed
subdomain; an existing Cockpit login is **not** a Task login. The user must
complete real device verification on Task. Gate registration, management and
revocation remain on `https://auth.rbym47.com/_gate/manage`.

`deploy/task.nginx.conf` allows only the page, its two static assets,
`GET /api/session`, `POST /api/read` and `GET /api/events`. Every application
request requires `auth_request /_gate/check`. Unauthenticated pages/assets
redirect to Gate; read APIs and SSE return JSON 401. Gate's own `/_gate/`
ceremony paths use the existing Gate handler; `check` and `redirect` are
internal-only. Unknown paths, tools, Task login/logout, health/version/status
and Task administration are never proxied.

After successful Gate authorization nginx overwrites `Authorization` with a
dedicated, server-side **viewer** credential and strips all browser cookies.
The credential lives only in the private Task credential file and root-only
`/etc/nginx/task-viewer-secret.inc`; never embed it in HTML, JavaScript,
URLs, logs or source control. Do not publish `nginx -T` output after installation.
No identity header is trusted, no caller identity is minted, and client
Authorization/Cookie/forwarded identity headers cannot replace this viewer.
The viewer can be revoked through the existing local admin command.

The backend separately restricts the configured gateway Host to the same
read-only route/method set and requires a viewer bearer even for static files.
This is a trusted local-machine/nginx boundary, not isolation from privileged
local users. Do not expose the loopback port through a different proxy.

SSE disables buffering and closes every 60 seconds at most, so reconnect must
pass Gate authorization again. Gate expiry/revocation can therefore leave an
already-open stream alive for up to 60 seconds; no unbounded authenticated
stream survives revocation. A reconnect refreshes the board from the same
database, including changes missed between connections. The page redirects
back to Gate when its authentication expires. The Passkey management button
replaces the local viewer logout button; Gate management can revoke sessions.

## Deployment

Use the existing fixed-SHA delivery pipeline for application changes. Configure
these nonsecret Task process environment values without changing other projects:

```text
WORK_PUBLIC_URL=https://task.rbym47.com
WORK_GATEWAY_URL=https://task.rbym47.com
WORK_GATE_MANAGEMENT_URL=https://auth.rbym47.com/_gate/manage
```

The public URL is also used for work-detail and final-notification links.
Generated detail links use `?task=<id>` so the requested task survives Gate's
server-side login return path; the application restores its hash navigation
after login. Existing hash links remain usable inside an authenticated page.
Local HTTP origins remain supported; foreign origins are rejected. Leaving
gateway configuration unset retains the existing local credential workflow.

Add only `https://task.rbym47.com` / `task.rbym47.com` to the existing Gate
origin/host allowlists, retaining its RP ID, database and all existing entries.
Install the two nginx templates and a root-only secret include containing
`proxy_set_header Authorization "Bearer <dedicated viewer>";`. The master
loads the include; it must not be served or readable by untrusted users.
Validate nginx configuration before a graceful reload. Do not force-stop Task;
the installed pipeline waits on its real drain contract. Do not alter Cockpit
authentication or sessions to test Task.

Configuration existence is not acceptance: separately establish public DNS/TLS,
unauthenticated rejection, real-device login, read-only board/details/links,
and SSE ready/changed/reconnect. Isolated credentials or a virtual WebAuthn
fixture establish test boundaries only, not that the user has authenticated.
