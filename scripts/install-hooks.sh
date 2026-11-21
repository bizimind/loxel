#!/usr/bin/env bash
# Install the repo's git hooks from .githooks into a private copy inside the git directory and point
# core.hooksPath at it (an absolute path). git then runs the copy made from the tree this script ran
# in, not whatever .githooks the currently checked-out branch carries, so switching to a branch can
# never run hooks that branch added. `pnpm install` runs this through `prepare`; rerun it to pick up
# hook changes.
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0 # not a git checkout (e.g. a tarball)
dest="$(git rev-parse --path-format=absolute --git-common-dir)/loxel-hooks"

# Replace the whole directory so a hook removed from .githooks stops running too.
rm -rf "$dest"
mkdir -p "$dest"
for hook in "$root"/.githooks/*; do
  [[ -f "$hook" ]] || continue
  install -m 0755 "$hook" "$dest/$(basename "$hook")"
done
git config core.hooksPath "$dest"
