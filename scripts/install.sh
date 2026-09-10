#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
revision=$(git rev-parse --short=12 HEAD)
git diff --quiet HEAD --
if [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  printf '%s\n' 'Commit or remove untracked project files before deploying.' >&2
  exit 1
fi

root="$HOME/.local/share/work-commander"
data="$HOME/.local/state/work-commander"
if [[ "${WORK_DATA_DIR:-$data}" != "$data" || "${WORK_PORT:-8790}" != "8790" ]]; then
  printf '%s\n' 'This installer targets the standard data directory and port; use the documented manual procedure for custom paths.' >&2
  exit 1
fi
install -d -m 700 "$data" "$data/backups"
mkdir -p "$root/releases" "$HOME/.config/systemd/user"
exec 9>"$data/deploy.lock"
flock -n 9 || { printf '%s\n' 'Another deployment is active.' >&2; exit 1; }

release="$root/releases/$revision"
if [[ ! -d "$release" ]]; then
  staging=$(mktemp -d "$root/releases/.build-XXXXXXXX")
  git archive HEAD | tar -x -C "$staging"
  npm ci --prefix "$staging" --omit=dev --ignore-scripts --no-audit --no-fund
  mv "$staging" "$release"
fi
test -f "$release/node_modules/@modelcontextprotocol/sdk/package.json"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
if systemctl --user is-active --quiet work-commander; then
  systemctl --user stop work-commander
fi
node "$release/src/admin.js" backup "$data/backups/pre-$revision-$(date +%s).db"
ln -s "$release" "$root/current-next"
mv -T "$root/current-next" "$root/current"
install -m 644 "$release/deploy/work-commander.service" "$HOME/.config/systemd/user/work-commander.service"
systemctl --user daemon-reload
systemctl --user enable --now work-commander
for attempt in {1..30}; do
  if curl --fail --silent "http://127.0.0.1:${WORK_PORT:-8790}/health" | \
    node -e 'let text="";process.stdin.on("data",d=>text+=d);process.stdin.on("end",()=>{try{const h=JSON.parse(text);if(!h.ok||h.release!==process.argv[1])process.exitCode=1;else console.log(text);}catch{process.exitCode=1;}})' "$revision"; then
    printf 'Installed release %s; native MCP/skill registration is a separate explicit step.\n' "$revision"
    exit 0
  fi
  sleep 0.2
done
printf '%s\n' 'Release not healthy; inspect journal and backup. No automatic rollback or side-effect replay.' >&2
exit 1
