#!/usr/bin/env bash
# Stream one line per change in a PR, for a Monitor watch.
#
#   pr-events.sh <pr> [watcher-id]
#
# Polls every 30s and prints what changed since the last reported state. That state and a log of
# every event are kept on disk per watcher (default: one per working directory, so an agent and an
# orchestrator watching the same PR each get every event), and a re-armed watch first reports
# whatever changed while no watch was running. Reports head moves (new commits, or rewritten
# history from a force-push, amend, rebase or squash), every force-push in the PR timeline, review
# runs, new threads, replies, comments and reviews, check results, conflicts, the end of a round and
# verdict changes. Exits when the PR is merged or closed.
set -euo pipefail

pr="${1:?usage: pr-events.sh <pr> [watcher-id]}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
watcher="${2:-$(pwd | shasum | cut -c1-8)}"
dir="${XDG_STATE_HOME:-$HOME/.local/state}/pr-events/${repo//\//-}-$pr-$watcher"
mkdir -p "$dir"
last="$dir/last.json"
log="$dir/events.log"
errors="$dir/poll-errors.log"

emit() {
  local line
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    echo "#$pr $line"
    echo "$(date -u +%FT%TZ) $line" >>"$log"
  done
}

# Timeline items (force-pushes, comments, reviews) and the newest comment of each review thread.
activity() {
  # shellcheck disable=SC2016 # GraphQL variables, not shell expansions
  gh api graphql -F number="$pr" -f owner="${repo%/*}" -f name="${repo#*/}" -f query='
    query($owner: String!, $name: String!, $number: Int!) {
      viewer { login }
      repository(owner: $owner, name: $name) { pullRequest(number: $number) {
        timelineItems(itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT, ISSUE_COMMENT, PULL_REQUEST_REVIEW], last: 100) { nodes {
          __typename
          ... on HeadRefForcePushedEvent { id actor { login } beforeCommit { abbreviatedOid } afterCommit { abbreviatedOid } }
          ... on IssueComment { id author { login } }
          ... on PullRequestReview { id author { login } state body } } }
        reviewThreads(last: 100) { nodes { id path line comments(last: 1) { nodes { id author { login } } } } } } } }' \
    --jq '.data as $d | {viewer: $d.viewer.login,
      items: [$d.repository.pullRequest.timelineItems.nodes[] | {
        id, type: .__typename, who: ((.actor // .author).login // "unknown"),
        before: .beforeCommit.abbreviatedOid, after: .afterCommit.abbreviatedOid, state, body}],
      threads: [$d.repository.pullRequest.reviewThreads.nodes[]
        | {id, path, line, lastComment: .comments.nodes[0].id, who: (.comments.nodes[0].author.login // "unknown")}]}'
}

failures=0
while true; do
  # The PR's state, not this checkout's unpushed commits.
  if ! state="$(PR_STATE_REMOTE_ONLY=1 "$here/pr-state.sh" "$pr" 2>>"$errors")" || ! act="$(activity 2>>"$errors")"; then
    failures=$((failures + 1))
    # Report a persistent failure once instead of looking healthy while seeing nothing.
    if (( failures == 5 )); then echo "poll failing: $(tail -1 "$errors")" | emit; fi
    sleep 30
    continue
  fi
  failures=0

  if [[ ! -f "$last" ]]; then
    jq -r '"watching: verdict \(.verdict), head \(.pr.head[0:7]), \(.unresolvedThreads | length) unresolved thread(s)"
      + (if (.blockers | length) > 0 then ", blockers: \(.blockers | join("; "))" else "" end)' <<<"$state" | emit
  else
    head="$(jq -r .pr.head <<<"$state")"
    prev_head="$(jq -r .state.pr.head "$last")"
    relation=""
    if [[ "$head" != "$prev_head" ]]; then
      # ahead: new commits on top; diverged or behind: history was rewritten.
      relation="$(gh api "repos/$repo/compare/$prev_head...$head" --jq '"\(.status) \(.ahead_by)"' 2>/dev/null || echo "unknown 0")"
    fi
    # Mergeability is recomputed after every push and main merge; while GitHub reports UNKNOWN,
    # keep the last known merge state so the watch does not report a flap. The round's verdict
    # carries over only for the same head: a new head starts a new round.
    state="$(jq --slurpfile l "$last" '$l[0].state as $o
      | if .pr.mergeable == "UNKNOWN" or .pr.mergeStateStatus == "UNKNOWN" then
          .pr.mergeable = $o.pr.mergeable | .pr.mergeStateStatus = $o.pr.mergeStateStatus
          | if .pr.head == $o.pr.head then .verdict = $o.verdict | .roundOver = $o.roundOver
            else .verdict = "waiting" | .roundOver = false end
        else . end' <<<"$state")"

    jq -rn --slurpfile l "$last" --argjson n "$state" --argjson a "$act" --arg relation "$relation" '
      $l[0] as $last | $last.state as $o | ($relation | split(" ")) as $r
      | [$a.items[] | select(.id as $id | $last.seen | index($id) | not)] as $new
      | ($last.threads | map({(.id): .lastComment}) | add // {}) as $lastComment
      | def run: .review.run | if . then {id: .databaseId, status, conclusion, sha: .headSha} else null end;
      [
        (if $n.pr.head != $o.pr.head
            and ([$new[] | select(.type == "HeadRefForcePushedEvent" and .after == $n.pr.head[0:7])] | length) == 0 then
          "head: \($o.pr.head[0:7]) -> \($n.pr.head[0:7]), " + (
            if $r[0] == "ahead" then "\($r[1]) new commit(s)"
            elif $r[0] == "unknown" then "head moved (relation unknown)"
            else "history rewritten (force-push, amend, rebase or squash)" end)
         else empty end),
        ($new[] | select(.type == "HeadRefForcePushedEvent")
          | "force-push by \(.who): \(.before) -> \(.after) (history rewritten)"),
        (($n | run) as $nr | ($o | run) as $or
          | if $nr == null then empty
            elif ($or == null or $nr.id != $or.id) and $nr.status != "completed" then "review: started for \($nr.sha[0:7])"
            elif $nr.status == "completed" and ($or == null or $nr.id != $or.id or $or.status != "completed")
            then "review: finished (\($nr.conclusion)) for \($nr.sha[0:7])"
            else empty end),
        (if $n.review.cleanComment != null and $o.review.cleanComment == null then "review: No issues found for \($n.pr.head[0:7])" else empty end),
        (($o.unresolvedThreads | map(.threadId)) as $seen
          | [$n.unresolvedThreads[] | select(.threadId as $t | $seen | index($t) | not)]
          | if length > 0 then "threads: \(length) new: \(map("\(.path):\(.line // "file")") | join(", "))" else empty end),
        ($a.threads[] | select(($lastComment[.id] // null) != null and $lastComment[.id] != .lastComment and .who != $a.viewer)
          | "reply by \(.who) on \(.path):\(.line // "file")"),
        ($new[] | select(.type == "IssueComment" and .who != $a.viewer) | "comment by \(.who)"),
        ($new[] | select(.type == "PullRequestReview" and .who != $a.viewer and (.state != "COMMENTED" or (.body // "") != ""))
          | "review by \(.who): \(.state | ascii_downcase)"),
        (($o.failedChecks | map(.link)) as $seen
          | $n.failedChecks[] | select(.link as $c | $seen | index($c) | not) | "check failed: \(.workflow) / \(.name)"),
        (if ($n.failedChecks | length) == 0 and ($n.pendingChecks | length) == 0
            and (($o.failedChecks | length) > 0 or ($o.pendingChecks | length) > 0) then "checks: all passed" else empty end),
        (if $n.pr.mergeable != $o.pr.mergeable and ($n.pr.mergeable == "CONFLICTING" or $o.pr.mergeable == "CONFLICTING")
         then "merge: \(if $n.pr.mergeable == "CONFLICTING" then "conflicts with main" else "conflicts resolved" end)" else empty end),
        (if $n.roundOver and (($o.roundOver | not) or $n.pr.head != $o.pr.head or (($n | run).id != ($o | run).id))
         then "round over: verdict \($n.verdict)" else empty end),
        (if $n.verdict != $o.verdict then "verdict: \($o.verdict) -> \($n.verdict)" else empty end),
        (if $n.pr.state != "OPEN" then "pr: \($n.pr.state | ascii_downcase)" else empty end)
      ] | .[]' | emit
  fi

  # Saved only after the events are printed: an interrupted watch repeats an event, never loses one.
  previous='{}'
  [[ -f "$last" ]] && previous="$(cat "$last")"
  jq -n --argjson s "$state" --argjson a "$act" --argjson l "$previous" \
    '{state: $s, seen: ((($l.seen // []) + ($a.items | map(.id))) | unique), threads: $a.threads}' >"$last.tmp"
  mv "$last.tmp" "$last"

  [[ "$(jq -r .pr.state <<<"$state")" == OPEN ]] || exit 0
  sleep 30
done
