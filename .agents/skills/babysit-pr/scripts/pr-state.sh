#!/usr/bin/env bash
# Print a JSON snapshot of how close a PR is to ready-to-merge.
#
#   pr-state.sh <pr>                  snapshot now
#   pr-state.sh <pr> --wait [min]     poll every 30s until the round is over, then snapshot
#
# A round is over when the Claude Code Review run for the PR head has completed and no check is
# pending, or the PR conflicts with main. It does not end early on a failed check: fixing CI while
# the review runs would start a second review. --wait gives up after [min] minutes (default 55, since
# background commands are killed after an hour) and prints the snapshot anyway, so a background run
# always exits and notifies; run it again if the round is not over. Transient gh errors during --wait are retried.
set -euo pipefail

pr="${1:?usage: pr-state.sh <pr> [--wait [minutes]]}"

if [[ "${2:-}" == "--wait" ]]; then
  deadline=$(( $(date +%s) + ${3:-55} * 60 ))
  while true; do
    # Snapshot in a child process so its errexit applies; a failed snapshot is retried.
    if state="$("$0" "$pr")" && { [[ "$(jq -r .roundOver <<<"$state")" == "true" ]] || (( $(date +%s) >= deadline )); }; then
      echo "$state"
      exit 0
    fi
    if (( $(date +%s) >= deadline )); then
      echo "pr-state.sh: gave up after repeated gh errors" >&2
      exit 1
    fi
    sleep 30
  done
fi

repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
owner="${repo%/*}"
name="${repo#*/}"

pr_json="$(gh pr view "$pr" --json number,url,state,isDraft,headRefName,headRefOid,mergeable,mergeStateStatus)"
# gh accepts a URL or branch too; the REST and GraphQL calls below need the number.
pr="$(jq -r .number <<<"$pr_json")"
head="$(jq -r .headRefOid <<<"$pr_json")"
branch="$(jq -r .headRefName <<<"$pr_json")"

# Review runs on the branch, newest first. The workflow has no concurrency group, so a slower run
# for an older commit can still be running, and posting, after a newer push.
runs_json="$(gh run list --workflow claude-code-review.yml --branch "$branch" --limit 20 \
  --json databaseId,headSha,status,conclusion,createdAt,updatedAt,url)"

clean_comments_json="$(gh api --paginate "repos/$repo/issues/$pr/comments" \
  --jq '.[] | select(.user.login == "claude[bot]" and (.body | contains("No issues found"))) | {created_at, url: .html_url}' |
  jq -s .)"

# last: 100 because unresolved threads are usually the newest.
# shellcheck disable=SC2016 # GraphQL variables, not shell expansions
threads_json="$(gh api graphql \
  -f query='query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) {
      reviewThreads(last: 100) { nodes { id isResolved isOutdated path line
        comments(first: 1) { nodes { databaseId url author { login } createdAt body } } } } } } }' \
  -f owner="$owner" -f name="$name" -F number="$pr" |
  jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)
      | {threadId: .id, path, line, isOutdated, commentId: .comments.nodes[0].databaseId,
         author: .comments.nodes[0].author.login, createdAt: .comments.nodes[0].createdAt,
         url: .comments.nodes[0].url, body: (.comments.nodes[0].body | .[0:300])}]')"

# With --json, gh pr checks exits 0 even when checks fail or are pending; its one non-zero case is
# "no checks reported", which prints nothing on stdout — hence the || true and the array guard below.
checks_err="$(mktemp)"
trap 'rm -f "$checks_err"' EXIT
checks_json="$(gh pr checks "$pr" --json name,workflow,bucket,state,link 2>"$checks_err" || true)"
if ! jq -e 'type == "array"' <<<"$checks_json" >/dev/null 2>&1; then
  grep -q "no checks reported" "$checks_err" || { cat "$checks_err" >&2; exit 1; }
  checks_json='[]'
fi

local_head=""
local_relation=""
# PR_STATE_REMOTE_ONLY skips comparing with this checkout (pr-events.sh reports the PR, not local work).
if [[ -z "${PR_STATE_REMOTE_ONLY:-}" && "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" == "$branch" ]]; then
  local_head="$(git rev-parse HEAD)"
  # The PR head may have been pushed from elsewhere (e.g. a committed suggestion); fetch it to compare.
  git fetch -q origin "$branch" 2>/dev/null || true
  if [[ "$local_head" == "$head" ]]; then
    local_relation="same"
  elif git merge-base --is-ancestor "$head" "$local_head" 2>/dev/null; then
    local_relation="ahead"
  elif git merge-base --is-ancestor "$local_head" "$head" 2>/dev/null; then
    local_relation="behind"
  else
    local_relation="diverged"
  fi
fi

jq -n \
  --argjson pr "$pr_json" --argjson runs "$runs_json" --argjson cleans "$clean_comments_json" \
  --argjson threads "$threads_json" --argjson checks "$checks_json" \
  --arg localHead "$local_head" --arg localRelation "$local_relation" '
  ($runs | map(select(.headSha == $pr.headRefOid)) | first) as $run
  | ($run != null and $run.status == "completed") as $reviewDone
  # A clean comment belongs to the first run that completed after it was posted. It counts only
  # when that run is the head run, so an older run finishing late cannot clear the new head.
  | (if $reviewDone and $run.conclusion == "success" then
      [$cleans[] | select(.created_at >= $run.createdAt) as $c
        | ($runs | map(select(.status == "completed" and .updatedAt >= $c.created_at))
           | min_by(.updatedAt)) as $owner
        | select($owner.databaseId == $run.databaseId) | $c] | last
    else null end) as $clean
  | ($checks | map(select(.bucket == "fail" or .bucket == "cancel"))) as $failed
  | ($checks | map(select(.bucket == "pending"))) as $pending
  | ($pr.mergeStateStatus == "UNKNOWN" or $pr.mergeable == "UNKNOWN") as $mergeUnknown
  | ([
      (if $localRelation == "ahead" then "local branch is ahead of the PR head: push it"
       elif $localRelation == "behind" then "local branch is behind the PR head: pull before working"
       elif $localRelation == "diverged" then "local branch and PR head diverged: if you force-pushed and GitHub missed it, push an empty commit; otherwise ask the user"
       else empty end),
      (if $pr.isDraft then "PR is a draft: the review does not run until it is marked ready" else empty end),
      (if $pr.isDraft then empty
       elif $run == null and ($pending | length) == 0 then "no review run for this PR (bot PR or the workflow never ran): not covered by babysit-pr"
       elif $run == null then empty
       elif $reviewDone and $run.conclusion == "skipped" then "review was skipped for this PR (bot or fork PR): not covered by babysit-pr"
       elif $reviewDone and $run.conclusion != "success" and $run.conclusion != "skipped" then "review run \($run.conclusion): rerun it \($run.url)"
       elif $reviewDone and $clean == null then "review of head reported findings: push fixes for a new review, or stop if every finding was declined"
       else empty end),
      (if ($threads | length) > 0 then "\($threads | length) unresolved review thread(s)" else empty end),
      ($failed[] | "check \(.bucket): \(.workflow) / \(.name) \(.link)"),
      (if $pr.mergeable == "CONFLICTING" then "conflicts with main" else empty end)
    ]) as $blockers
  | {
      pr: ($pr | {number, url, state, isDraft, headRefName, head: .headRefOid, mergeable, mergeStateStatus}),
      review: {run: $run, cleanComment: $clean, done: $reviewDone},
      unresolvedThreads: $threads,
      failedChecks: $failed,
      pendingChecks: ($pending | map("\(.workflow) / \(.name)")),
      blockers: $blockers,
      roundOver: ($pr.state != "OPEN" or $pr.mergeable == "CONFLICTING"
        or $pr.isDraft or ($reviewDone and ($pending | length) == 0 and ($mergeUnknown | not))),
      verdict: (
        if $pr.state != "OPEN" then ($pr.state | ascii_downcase)
        elif $pr.isDraft or any($blockers[]; contains("not covered")) then "unsupported"
        elif ($blockers | length) > 0 then "needs-work"
        elif $clean != null and ($pending | length) == 0 and ($pr.mergeStateStatus == "CLEAN" or $pr.mergeStateStatus == "HAS_HOOKS") then "ready"
        else "waiting" end)
    }'
