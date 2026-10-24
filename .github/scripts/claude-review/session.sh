#!/usr/bin/env bash
# Keep one Claude Code Review session per PR across workflow runs.
#
#   session.sh prepare   restore the PR's session and decide how this run reviews (step outputs)
#   session.sh save      store the session and review state, and summarize this run's cost
#
# Sessions live in private storage ($STORE, an s3:// prefix on R2). Without it every run starts a
# new session and nothing is stored. state.json holds the session id, the last commit the session
# worked on, the last commit it finished reviewing, and the cost the last run reported.
#
# Env: PR, HEAD_SHA, GITHUB_REPOSITORY, GITHUB_WORKSPACE, RUNNER_TEMP, GITHUB_OUTPUT,
# GITHUB_STEP_SUMMARY, STORE (optional); for save also MODE, SESSION_ID, OUTCOME, EXECUTION_FILE.
set -euo pipefail

# Claude Code keeps transcripts under a directory named after the working directory.
projects="$HOME/.claude/projects/${GITHUB_WORKSPACE//[^a-zA-Z0-9]/-}"
state_file="$RUNNER_TEMP/review-state.json"
target_file="$RUNNER_TEMP/review-target"

fetch() { [[ -n "${STORE:-}" ]] && aws s3 cp --quiet "$STORE/$1" "$2"; }
store() { [[ -z "${STORE:-}" ]] || aws s3 cp --quiet "$1" "$STORE/$2"; }

prepare() {
  : "${HEAD_SHA:?}" "${PR:?}"
  fetch state.json "$state_file" || echo '{}' >"$state_file"
  local session last reviewed mode prompt
  session="$(jq -r '.sessionId // ""' "$state_file")"
  last="$(jq -r '.lastSha // ""' "$state_file")"
  reviewed="$(jq -r '.reviewedSha // ""' "$state_file")"

  # The hook moves this forward when the PR head moves during the review.
  echo "$HEAD_SHA" >"$target_file"
  echo 0 >"$RUNNER_TEMP/review-moves"
  # The hook runs from outside the working tree, which it may check out at a newer commit.
  cp "$(dirname "$0")/hook.sh" "$RUNNER_TEMP/review-hook.sh"

  if [[ "$reviewed" == "$HEAD_SHA" ]]; then
    mode=skip
  elif [[ -n "$session" ]] && fetch session.tgz "$RUNNER_TEMP/session.tgz" \
    && mkdir -p "$projects" && tar -xzf "$RUNNER_TEMP/session.tgz" -C "$projects" \
    && [[ -f "$projects/$session.jsonl" ]]; then
    # Restored files keep old mtimes; keep Claude Code's cleanup from treating them as stale.
    find "$projects" -exec touch {} +
    mode=resume
  else
    # No usable transcript (none stored, corrupt, or from a run that died early): start over.
    mode=new
    session="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen | tr "[:upper:]" "[:lower:]")"
  fi

  local review="/code-review Code review $GITHUB_REPOSITORY/pull/$PR at commit $HEAD_SHA"
  if [[ "$mode" == resume ]]; then
    # With a shallow clone the earlier commit has to be fetched before it can be diffed.
    if [[ -n "$last" ]] && git fetch --quiet --depth=1 origin "$last" 2>/dev/null; then
      prompt="$review. You reviewed this PR before: its head moved from $last to $HEAD_SHA since you last worked on it, and the working tree is now at $HEAD_SHA. Review the whole PR as one unit again: reuse your earlier research and findings, re-check each earlier finding against $HEAD_SHA, give fresh attention to what changed (git diff $last $HEAD_SHA), and do not repeat comments already posted on the PR."
    else
      prompt="$review. You reviewed this PR before, but it changed since (the earlier commit is no longer reachable, e.g. after a force-push), and the working tree is now at $HEAD_SHA. Review the whole PR as one unit again: reuse what still applies from your earlier research and findings, and do not repeat comments already posted on the PR."
    fi
  else
    prompt="$review"
  fi

  local args="--session-id $session"
  [[ "$mode" == resume ]] && args="--resume $session"
  {
    echo "mode=$mode"
    echo "session_id=$session"
    echo "claude_args=$args"
    echo "prompt<<PROMPT_EOF"
    echo "$prompt"
    echo "PROMPT_EOF"
  } >>"$GITHUB_OUTPUT"
}

save() {
  : "${MODE:?}" "${SESSION_ID:?}" "${OUTCOME:?}"
  local target total prev reviewed
  target="$(cat "$target_file")"
  [[ -f "$state_file" ]] || echo '{}' >"$state_file"
  # What the previous run of this session reported, shown next to this run's figure so the job
  # summaries tell whether a resumed session reports its cost cumulatively.
  prev=""
  [[ "$MODE" == resume ]] && prev="$(jq -r '.reportedCostUsd // empty' "$state_file")"
  total=""
  if [[ -f "${EXECUTION_FILE:-}" ]]; then
    total="$(jq -r '[.[] | select(.type == "result")] | last | .total_cost_usd // empty' "$EXECUTION_FILE")"
  fi
  # Only a finished review counts as reviewed; an interrupted one is resumed by the next run. The
  # action can also succeed without running Claude (it skips PRs that change this workflow), so a
  # successful step is not enough: the execution file must hold a result that is not an error.
  reviewed="$(jq -r '.reviewedSha // ""' "$state_file")"
  if [[ "$OUTCOME" == success && -f "${EXECUTION_FILE:-}" ]] &&
    jq -e '[.[] | select(.type == "result")] | last | .is_error == false' "$EXECUTION_FILE" >/dev/null; then
    reviewed="$target"
  fi

  jq -n --arg session "$SESSION_ID" --arg last "$target" --arg reviewed "$reviewed" \
    --argjson cost "${total:-null}" \
    '{sessionId: $session, lastSha: $last, reviewedSha: $reviewed, reportedCostUsd: $cost}' >"$state_file"

  if [[ -f "$projects/$SESSION_ID.jsonl" ]]; then
    local members=("$SESSION_ID.jsonl")
    [[ -d "$projects/$SESSION_ID" ]] && members+=("$SESSION_ID")
    tar -czf "$RUNNER_TEMP/session.tgz" -C "$projects" "${members[@]}"
    store "$RUNNER_TEMP/session.tgz" session.tgz
  fi
  store "$state_file" state.json

  {
    echo "### Claude Code Review"
    echo "- Session: $MODE (\`$SESSION_ID\`), outcome: $OUTCOME"
    echo "- Commit: \`${target:0:7}\`"
    if [[ -n "$total" ]]; then
      jq -r --arg prev "$prev" '[.[] | select(.type == "result")] | last
        | "- Reported cost: $\(.total_cost_usd * 100 | round / 100)"
          + (if $prev != "" then " (previous run of this session reported $\($prev | tonumber * 100 | round / 100))" else "" end)
          + ", \(.num_turns) turns, \(.duration_ms / 60000 | round) min"' \
        "$EXECUTION_FILE"
    fi
    [[ -n "$total" ]] || echo "- Claude did not finish a review in this run; see the review step's log."
    [[ -n "${STORE:-}" ]] || echo "- Session storage is not configured: the next run starts a new session."
  } >>"$GITHUB_STEP_SUMMARY"
}

case "${1:-}" in
  prepare) prepare ;;
  save) save ;;
  *) echo "usage: session.sh prepare|save" >&2; exit 2 ;;
esac
