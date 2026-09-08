# wt shell integration -- source this from your ~/.zshrc or ~/.bashrc:
#
#     source /path/to/wt/wt.sh
#
# Defines wta / wtv / wtr / wtm. These are functions, not aliases, for two
# reasons: arguments have to reach `wt` rather than land after the `cd`, and a
# `cd` can only be done by the shell itself -- which is the whole point of
# `wtm`, since no CLI can fix its parent shell's working directory.
#
# Lives in the package beside the CLI so the wrappers and the -j output shapes
# they parse stay versioned together. Works in zsh and bash. Requires jq.

# The CLI to call: `wt` on PATH, the installed standalone binary. Override
# before sourcing to point at something else, e.g. a locally built binary:
# WT_BIN=/path/to/loxel/packages/wt/dist/wt (kept to one word).
: "${WT_BIN:=wt}"

_wt_preflight() {
  if ! command -v jq >/dev/null 2>&1; then
    printf 'wt.sh: jq is required by the wt shell helpers\n' >&2
    return 1
  fi
  if ! command -v "$WT_BIN" >/dev/null 2>&1; then
    printf 'wt.sh: %s not found -- install it on PATH or set WT_BIN\n' "$WT_BIN" >&2
    return 1
  fi
}

# Run wt, capturing stdout into _wt_out. In -j mode errors arrive as
# {"error":true,"message":"..."} on *stdout*, so capturing it would otherwise
# swallow them and the helper would fail silently -- re-print the message on
# stderr instead. Progress and prompts already go to stderr, so they reach the
# terminal untouched.
_wt_capture() {
  _wt_out="$("$@")" && return 0
  _wt_rc=$?
  _wt_msg="$(printf '%s' "$_wt_out" | jq -r '.message // empty' 2>/dev/null)"
  [ -n "$_wt_msg" ] || _wt_msg="$_wt_out"
  [ -n "$_wt_msg" ] && printf 'error: %s\n' "$_wt_msg" >&2
  return "$_wt_rc"
}

# _wt_is_under <path> <dir> -- true if <path> is <dir> or sits inside it.
_wt_is_under() {
  [ -n "$2" ] || return 1
  [ "$1" = "$2" ] && return 0
  case "$1" in "$2"/*) return 0 ;; *) return 1 ;; esac
}

# _wt_jump <subcommand> [args...] -- run it, then cd to the .path it reports.
_wt_jump() {
  _wt_preflight || return 1
  _wt_cmd="$1"
  shift
  _wt_capture "$WT_BIN" "$_wt_cmd" -j "$@" || return
  _wt_path="$(printf '%s' "$_wt_out" | jq -r '.path // empty')"
  # Empty guard: a bare `cd` would silently send you home. Also covers the
  # {"aborted":true} shape you get from cancelling a prompt.
  [ -n "$_wt_path" ] && cd "$_wt_path"
}

wta() { _wt_jump add "$@"; }
wtv() { _wt_jump view "$@"; }
wtr() { "$WT_BIN" remove "$@"; }

# Rename a worktree and its branch: `wtm <new>` renames the one you're standing
# in, `wtm <old> <new>` renames another, `wtm` prompts for both.
#
# When the rename moves the directory out from under this shell, cd to the
# matching spot under the new path -- keeping whatever subdirectory you were in,
# so `.worktrees/old/src/deep` becomes `.worktrees/new/src/deep`. WT_SHELL_WRAPPER
# tells the CLI to skip its "run cd yourself" warning. Other terminals and
# processes sitting in the old path still have to move themselves; nothing here
# can reach them.
wtm() {
  _wt_preflight || return 1
  # Capture the cwd first -- once the directory is renamed it can't be resolved.
  _wt_cur="$(pwd -P)"
  _wt_capture env WT_SHELL_WRAPPER=1 "$WT_BIN" mv -j "$@" || return
  _wt_old="$(printf '%s' "$_wt_out" | jq -r '.oldPath // empty')"
  _wt_new="$(printf '%s' "$_wt_out" | jq -r '.path // empty')"
  # Nothing moved (cancelled at a prompt), so there is nowhere to follow.
  [ -n "$_wt_new" ] || return 0
  printf '%s' "$_wt_out" | jq -r '
    if .branchRenamed
    then "renamed \(.oldName) → \(.name) (branch \(.oldBranch) → \(.branch))"
    else "renamed \(.oldName) → \(.name) (branch \(.branch) unchanged)" end' >&2
  if _wt_is_under "$_wt_cur" "$_wt_old"; then
    # The subdirectory can disappear (a rename hook may rebuild the tree), so
    # fall back to the worktree root rather than leaving the shell stranded.
    cd "$_wt_new${_wt_cur#"$_wt_old"}" 2>/dev/null || cd "$_wt_new"
  fi
}
