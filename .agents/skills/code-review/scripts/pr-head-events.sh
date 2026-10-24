#!/usr/bin/env bash
# Monitor watch for a PR review: prints a line when the PR head is not the commit being reviewed.
#
#   pr-head-events.sh <pr>
#
# The commit being reviewed is the one checked out here, so the watch keeps reporting a move until
# the reviewer checks out the new head, including a move made while no watch was running. Says
# whether the PR gained commits or its history was rewritten (force-push, amend, rebase, squash).
# Exits after 9 minutes, under the 10 minute limit for a watch in a headless run; re-arm it.
set -uo pipefail

pr="${1:?usage: pr-head-events.sh <pr>}"
# The reviewer may check out a commit where this file differs; run from a stable copy.
if [[ "${PR_HEAD_EVENTS_COPY:-}" != 1 ]]; then
  copy="$(mktemp)"
  cp "$0" "$copy"
  PR_HEAD_EVENTS_COPY=1 exec bash "$copy" "$@"
fi
trap 'rm -f "$0"' EXIT

repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)" || exit 1
top="$(git rev-parse --show-toplevel)" || exit 1
deadline=$(( $(date +%s) + 9 * 60 ))
reported=""

while (( $(date +%s) < deadline )); do
  reviewing="$(git -C "$top" rev-parse HEAD)"
  # A failed poll is skipped, never reported as a move.
  head="$(gh api "repos/$repo/pulls/$pr" --jq .head.sha 2>/dev/null)" || head=""
  if [[ -n "$head" && "$head" != "$reviewing" && "$head" != "$reported" ]]; then
    read -r status ahead < <(gh api "repos/$repo/compare/$reviewing...$head" \
      --jq '"\(.status) \(.ahead_by)"' 2>/dev/null || echo "unknown 0")
    case "$status" in
      ahead) how="$ahead new commit(s)" ;;
      unknown) how="relation unknown" ;;
      *) how="history rewritten (force-push, amend, rebase or squash)" ;;
    esac
    echo "PR head moved: reviewing $reviewing, PR head is now $head ($how)"
    reported="$head"
  fi
  sleep 30
done
