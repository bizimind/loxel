#!/usr/bin/env bash
# Print the wt-id of the worktree holding the cwd, for `wt add --meta loxel-parent-wt=<id>`.
# Fails with the reason when there is none: the cwd is in no worktree, or worktree metadata is
# off (`wt init --worktree-metadata on`).
#
# A worktree created before metadata was turned on has no id until its metadata is first
# written, so this unsets a key that is never set: a write that changes nothing but assigns
# the id. Switch to `wt meta id` once #769 lands.
set -euo pipefail

# wt's own error for a bare repo root would name the key as a missing worktree.
if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "Not inside a worktree, so there is nothing to nest under." >&2
  exit 1
fi

# No name: wt resolves the worktree by the cwd's path, which a name could not do for an
# unmanaged worktree (the main one) whose directory name matches a managed worktree's.
if ! out=$(wt meta unset child-pr-assign-id -j </dev/null); then
  jq -r '.message // .' <<<"$out" >&2
  exit 1
fi
jq -r '.meta["wt-id"]' <<<"$out"
