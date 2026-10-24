#!/usr/bin/env bash
# Claude Code hook for the review session: tells the reviewer when the PR head moves mid-review.
#
# Runs before the reviewer posts to the PR (PreToolUse on Bash) and when it tries to finish (Stop).
# If the PR head moved past the commit under review, it checks the new head out and blocks the
# action with instructions to re-check, so nothing is posted or finished against a stale commit.
# After two moves it lets the review finish; the run queued by the latest push resumes from there.
# Any error lets the action through: the hook must never wedge a review.
set -uo pipefail

input="$(cat)"
[[ -n "${PR:-}" && -n "${RUNNER_TEMP:-}" && -n "${GITHUB_REPOSITORY:-}" ]] || exit 0
event="$(jq -r '.hook_event_name // ""' <<<"$input")"
target_file="$RUNNER_TEMP/review-target"
moves_file="$RUNNER_TEMP/review-moves"

if [[ "$event" == PreToolUse ]]; then
  command="$(jq -r '.tool_input.command // ""' <<<"$input")"
  # Only commands that write to the PR: gh pr comment/review, or gh api with fields on PR comments.
  if ! grep -qE 'gh pr (comment|review)' <<<"$command"; then
    grep -qE 'pulls/[0-9]+/(comments|reviews)' <<<"$command" || exit 0
    grep -qE '(^|[[:space:]])(-f|-F|--field|--raw-field|--input|-X[[:space:]]*POST|--method[[:space:]]+POST)([[:space:]=]|$)' <<<"$command" || exit 0
  fi
fi

# Posts can run in parallel; one hook at a time updates the target and the working tree.
exec 9>"$RUNNER_TEMP/review-hook.lock"
flock 9 || exit 0
cd "${GITHUB_WORKSPACE:-.}" || exit 0
target="$(cat "$target_file" 2>/dev/null)" || exit 0
head="$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR" --jq .head.sha 2>/dev/null)" || exit 0
[[ -n "$head" && "$head" != "$target" ]] || exit 0
moves="$(cat "$moves_file" 2>/dev/null || echo 0)"
(( moves < 2 )) || exit 0
if ! { git fetch --quiet --depth=1 origin "$head" && git checkout --quiet --detach "$head"; }; then
  echo "review-hook: could not check out $head; continuing at $target" >&2
  exit 0
fi
echo "$head" >"$target_file"
echo $(( moves + 1 )) >"$moves_file"

moved="The PR head moved from $target to $head during your review, and the working tree is now at $head."
if [[ "$event" == PreToolUse ]]; then
  reason="$moved Before posting, re-check your validated findings against $head (git diff $target $head): drop the ones it fixed, update line numbers, and review what it changed as part of the whole PR. Then post against commit $head."
  jq -n --arg r "$reason" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
else
  reason="$moved Review what changed (git diff $target $head) as part of the whole PR and re-check the findings you posted. Post only new findings, against commit $head, without repeating posted ones; if the PR is clean at $head, post the No issues found comment for $head."
  jq -n --arg r "$reason" '{decision: "block", reason: $r}'
fi
