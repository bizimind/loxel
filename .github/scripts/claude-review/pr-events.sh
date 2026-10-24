#!/usr/bin/env bash
# Monitor watch for the review session: prints one line each time the PR head moves.
#
# Polls the PR every 30s and compares the head with the last head it reported, which it keeps in
# $RUNNER_TEMP/review-head, so a re-armed watch also reports a move made while no watch ran. Says
# whether the move added commits or rewrote history (force-push, amend, rebase, squash). Exits by
# itself after 9 minutes, under the 10 minute limit for a watch in a headless run.
set -uo pipefail

state="$RUNNER_TEMP/review-head"
deadline=$(( $(date +%s) + 9 * 60 ))

while (( $(date +%s) < deadline )); do
  reported="$(cat "$state" 2>/dev/null)"
  # A failed poll is skipped, never reported as a move.
  head="$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR" --jq .head.sha 2>/dev/null)" || head=""
  if [[ -n "$head" && -n "$reported" && "$head" != "$reported" ]]; then
    read -r status ahead < <(gh api "repos/$GITHUB_REPOSITORY/compare/$reported...$head" \
      --jq '"\(.status) \(.ahead_by)"' 2>/dev/null || echo "unknown 0")
    case "$status" in
      ahead) how="$ahead new commit(s)" ;;
      unknown) how="relation unknown" ;;
      *) how="history rewritten (force-push, amend, rebase or squash)" ;;
    esac
    echo "PR head moved from $reported to $head: $how"
    echo "$head" >"$state"
  fi
  sleep 30
done
