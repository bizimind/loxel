#!/usr/bin/env bash
# List the worktrees nested under the one holding the cwd (`loxel-parent-wt` set to its
# wt-id), one compact `wt list -j` entry per line.
set -euo pipefail

id=$("$(dirname "$0")/wt-id.sh")
wt list -j </dev/null |
  jq -c --arg id "$id" '.worktrees[] | select(.meta["loxel-parent-wt"] == $id)'
