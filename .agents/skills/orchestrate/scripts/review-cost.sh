#!/usr/bin/env bash
# Measure how much of the shared Claude subscription a Claude Code Review run uses, from CI logs.
#
#   review-cost.sh [runs]    cache up to [runs] recent completed reviews (default 30), print stats
#   review-cost.sh --stats   print stats from the cache only (fast, no log downloads)
#
# Review logs expire after a few days, so each run's numbers are cached once in $cache. Deltas are
# percentage points of the 5h and 7d windows between a run's first and last rate-limit snapshot.
# Local sessions on the same subscription move those windows too, so deltas are upper bounds;
# "solo" stats use only runs that no other review run overlapped.
set -euo pipefail

cache="${XDG_CACHE_HOME:-$HOME/.cache}/loxel-orchestrate/review-runs.jsonl"
mkdir -p "$(dirname "$cache")"
touch "$cache"

stats() {
  jq -s '
    def pct(p): sort | if length == 0 then null else .[((length - 1) * p | floor)] end;
    def summary: {median: pct(0.5), p95: pct(0.95)};
    (map(select(.skip | not)) | sort_by(.createdAt) | .[-40:]) as $runs
    | ($runs | map(select(.solo))) as $solo
    | {
        runs: ($runs | length),
        soloRuns: ($solo | length),
        fiveHour: (($runs | map(.h5Delta | select(. != null)) | summary)
          + {soloMedian: ($solo | map(.h5Delta | select(. != null)) | pct(0.5))}),
        sevenDay: ($runs | map(.d7Delta | select(. != null)) | summary),
        costUsd: ($runs | map(.costUsd | select(. != null)) | summary),
        minutes: ($runs | map(.minutes | select(. != null)) | summary)
      }' "$cache"
}

if [[ "${1:-}" == "--stats" ]]; then
  stats
  exit 0
fi

repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
runs_json="$(gh run list --workflow claude-code-review.yml --limit 100 \
  --json databaseId,status,conclusion,createdAt,updatedAt)"

for id in $(jq -r --argjson n "${1:-30}" \
  '[.[] | select(.status == "completed" and .conclusion != "skipped")][:$n][] | .databaseId' <<<"$runs_json"); do
  grep -q "\"run\":$id," "$cache" && continue
  # Runs without usable data are cached as skipped so they are not downloaded again.
  skip() { echo "{\"run\":$id,\"skip\":true}" >>"$cache"; }
  job="$(gh api "repos/$repo/actions/runs/$id/jobs" --jq '.jobs[0].id')" || { skip; continue; }
  # Expired logs return HTTP 410. Log events are pretty-printed JSON blocks behind a timestamp prefix:
  # join each block onto one line and keep only what parses.
  events="$(gh api --allow-escape-sequences "repos/$repo/actions/jobs/$job/logs" 2>/dev/null |
    sed -E 's/^.?[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z ?//' |
    awk '/^\{$/ { b = 1; s = "" } b { s = s $0 " " } /^\}$/ { if (b) print s; b = 0 }' |
    jq -cR 'fromjson? | select(.type == "rate_limit_event" or .type == "result")')" || { skip; continue; }
  if [[ "$(jq -s 'map(select(.type == "rate_limit_event")) | length' <<<"$events")" -lt 2 ]]; then
    skip
    continue
  fi
  jq -cs --argjson id "$id" --argjson runs "$runs_json" '
    ($runs | map(select(.databaseId == $id)) | first) as $run
    | ($runs | any(.databaseId != $id and .conclusion != "skipped"
        and .createdAt < $run.updatedAt and .updatedAt > $run.createdAt)) as $overlapped
    | (map(select(.type == "rate_limit_event") | .rate_limit_info.unifiedWindows)) as $w
    | (map(select(.type == "result")) | last) as $result
    # A window that reset mid-run, or that the logs do not report, has no meaningful delta.
    | def delta(k): try (if $w[0][k].resetsAt == $w[-1][k].resetsAt
        then (($w[-1][k].utilization - $w[0][k].utilization) * 100 | round) else null end) catch null;
    {run: $id, createdAt: $run.createdAt, solo: ($overlapped | not),
       h5Delta: delta("five_hour"), d7Delta: delta("seven_day"),
       costUsd: ($result.total_cost_usd // null),
       minutes: (if $result.duration_ms then ($result.duration_ms / 60000 | round) else null end)}
    ' <<<"$events" >>"$cache"
done

stats
