#!/usr/bin/env bash
# Print a private directory for files one agent session hands to another (quick-pr and child-pr
# prompts, the orchestrator's registry, handoff notes), creating it if needed. It lives in your own
# state directory with mode 0700, so other local users can neither read nor replace what is written
# there, unlike files in the shared /tmp.
#
#   handoff-dir.sh [subdir]
set -euo pipefail

base="${XDG_STATE_HOME:-$HOME/.local/state}/agent-handoff"
dir="$base${1:+/$1}"
mkdir -p "$dir"
for d in "$base" "$dir"; do
  if [[ -L "$d" || ! -O "$d" ]]; then
    echo "handoff-dir.sh: $d must be a directory you own, not a link" >&2
    exit 1
  fi
  chmod 700 "$d"
done
echo "$dir"
