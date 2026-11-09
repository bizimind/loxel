#!/usr/bin/env bash
# Print the wt-id of the worktree holding the cwd, for `wt add --meta loxel-parent-wt=<id>`.
# Fails with the reason when there is none: the cwd is in no worktree, or the worktree has no
# id because metadata is off or the id was never filled in (`wt init --worktree-metadata on`
# fixes both).
set -euo pipefail

# wt's own error for a bare repo root would name the key as a missing worktree.
if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "Not inside a worktree, so there is nothing to nest under." >&2
  exit 1
fi

# No name: wt resolves the worktree by the cwd's path, which a name could not do for an
# unmanaged worktree (the main one) whose directory name matches a managed worktree's.
if ! out=$(wt meta get wt-id -j </dev/null); then
  jq -r '.message // .' <<<"$out" >&2
  exit 1
fi
id=$(jq -r '.value // empty' <<<"$out")
if [[ -z "$id" ]]; then
  echo "This worktree has no wt-id: worktree metadata is off, or its id was never filled in. Run: wt init --worktree-metadata on" >&2
  exit 1
fi
echo "$id"
