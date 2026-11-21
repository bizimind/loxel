#!/usr/bin/env bash
# Install the repo's git hooks from .githooks into a private copy inside the git directory and point
# core.hooksPath at it (an absolute path). git then runs the copy made from the tree this script ran
# in, not whatever .githooks the currently checked-out branch carries, so switching to a branch can
# never run hooks that branch added. `pnpm install` runs this through `prepare`; rerun it to pick up
# hook changes.
#
# With per-worktree config on (extensions.worktreeConfig, as wt sets up), each worktree gets its
# own copy and setting, so installing in one worktree never changes the hooks of another. Otherwise
# the copy and setting are shared by the whole repository.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd -P)"
# Only act on the checkout this script belongs to (not, say, a copy unpacked inside another repo).
toplevel="$(git -C "$root" rev-parse --show-toplevel 2>/dev/null)" || exit 0
[[ "$(cd "$toplevel" && pwd -P)" == "$root" && -d "$root/.githooks" ]] || exit 0

# Copy .githooks into $1, replacing what was there so a removed hook stops running too.
install_copy() {
  rm -rf "$1"
  mkdir -p "$1"
  local hook
  for hook in "$root"/.githooks/*; do
    [[ -f "$hook" ]] || continue
    install -m 0755 "$hook" "$1/$(basename "$hook")"
  done
}

shared="$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)/loxel-hooks"

if [[ "$(git -C "$root" config --bool extensions.worktreeConfig || true)" != "true" ]]; then
  install_copy "$shared"
  git -C "$root" config --local core.hooksPath "$shared"
  exit 0
fi

own="$(git -C "$root" rev-parse --absolute-git-dir)/loxel-hooks"
install_copy "$own"
git -C "$root" config --worktree core.hooksPath "$own"

# Worktrees that have not run this script yet fall back to the shared setting. Older versions set it
# to the relative `.githooks`, which resolves inside whatever branch is checked out; replace it.
current="$(git -C "$root" config --local core.hooksPath || true)"
if [[ -n "$current" && "$current" != /* ]]; then
  install_copy "$shared"
  git -C "$root" config --local core.hooksPath "$shared"
fi
