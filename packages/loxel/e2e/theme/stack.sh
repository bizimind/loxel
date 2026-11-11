#!/usr/bin/env bash
# Start a throwaway Loxel dev stack for theme screenshots: the Bun server on 7434 with its own
# state dir, and Vite on 5173 (HMR, so source edits show up in the next shot without a build).
# Usage: e2e/theme/stack.sh <work-dir>   (runs in the foreground; Ctrl+C stops both)
#
# The ports are the dev ports Vite and the server's origin check expect, so a developer's own dev
# server may hold them. The stack refuses to start then, and `shoot.ts` refuses to run against a
# server this stack did not seed (see `assertThemeStack` in lib.ts).
set -euo pipefail
WORK=${1:?usage: stack.sh <work-dir>}
cd "$(dirname "$0")/../.."
for port in 7434 5173; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is in use (a dev server?); stop it before starting the theme stack" >&2
    exit 1
  fi
done
mkdir -p "$WORK/state"
FIXTURE="$WORK/fixture/orbit-shop"
bun e2e/theme/fixture.ts "$FIXTURE" >/dev/null

# The server shuts itself down after a while with no window connected; between shots there is
# none, so keep restarting it, pausing between runs so a server that fails at once does not spin.
# State lives in $WORK/state and survives restarts.
(
  while true; do
    LOXEL_DEV=1 LOXEL_STATE_DIR="$WORK/state" LOXEL_SERVE_PORT=7434 LOXEL_STATIC_DIR="$PWD/dist" \
      bun src/server/index.ts >>"$WORK/server.log" 2>&1 || true
    sleep 1
  done
) &
SERVER=$!
VITE_SCREENSHOT=1 node_modules/.bin/vite --mode development >"$WORK/vite.log" 2>&1 &
VITE=$!
trap 'pkill -P $SERVER; kill $SERVER $VITE 2>/dev/null' EXIT INT TERM

until curl -sf http://127.0.0.1:7434/api/version >/dev/null; do sleep 0.5; done
bun e2e/theme/seed.ts "$WORK"
until curl -sf http://127.0.0.1:5173/ >/dev/null; do sleep 0.5; done
echo "theme stack ready: http://127.0.0.1:5173 (fixture $FIXTURE)"
wait
