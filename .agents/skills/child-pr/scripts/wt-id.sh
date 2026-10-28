#!/usr/bin/env bash
# Print the wt-id of the worktree holding the cwd, for `wt add --meta loxel-parent-wt=<id>`.
# Fails with the reason when there is none: the cwd is in no worktree, or worktree metadata is
# off (`wt init --worktree-metadata on`).
#
# A worktree created before metadata was turned on has no id until its metadata is first
# written, so this unsets a key that is never set: a write that changes nothing but assigns
# the id. Switch to `wt meta id` once #769 lands.
set -euo pipefail

# Name the worktree, so wt never mistakes the key for a worktree name.
top=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "Not inside a worktree, so there is nothing to nest under." >&2
  exit 1
}
name=$(wt list -j </dev/null | jq -r --arg top "$top" '.worktrees[] | select(.path == $top) | .name')
if [[ -z "$name" ]]; then
  echo "wt does not list the worktree at $top." >&2
  exit 1
fi

if ! out=$(wt meta unset "$name" child-pr-assign-id -j </dev/null); then
  jq -r '.message // .' <<<"$out" >&2
  exit 1
fi
jq -r '.meta["wt-id"]' <<<"$out"
