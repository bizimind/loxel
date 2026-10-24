#!/usr/bin/env bash
# Measure how much of the shared Claude subscription a Claude Code Review run uses, from CI logs.
#
#   review-cost.sh [runs]    cache up to [runs] recent completed reviews (default 30), print stats
#   review-cost.sh --stats   print stats from the cache only (fast, no log downloads)
#
# Review logs expire after a few days, so each run's first and last rate-limit snapshot is cached
# once in $cache. A run's own snapshots also count every review running alongside it, so runs whose
# time spans overlap are grouped and each group's usage is split across its runs. Local sessions on
# the same subscription still move the windows, so the result is an upper bound.
set -euo pipefail

cache="${XDG_CACHE_HOME:-$HOME/.cache}/loxel-orchestrate/review-runs.jsonl"
mkdir -p "$(dirname "$cache")"
touch "$cache"

stats() {
  jq -s '
    def pct(p): sort | if length == 0 then null else .[((length - 1) * p | floor)] end;
    def summary: {median: pct(0.5), p95: pct(0.95)};
    def share(w): if all(w != null) and (map(w.reset) | unique | length) == 1
      then ((map(w.end) | max) - (map(w.start) | min)) / length * 10 | round / 10 else null end;
    (map(select(.v == 2 and (.skip | not) and .costUsd != null and .h5 != null))
     | sort_by(.createdAt) | .[-40:]) as $runs
    | (reduce $runs[] as $r ([];
        if length > 0 and $r.createdAt < .[-1].end and $r.h5.reset == .[-1].runs[0].h5.reset
        then .[-1].runs += [$r] | .[-1].end = ([.[-1].end, $r.updatedAt] | max)
        else . + [{runs: [$r], end: $r.updatedAt}] end)) as $groups
    # One entry per run, holding its share of its group.
    | [$groups[] | .runs | {h5: share(.h5), d7: share(.d7)} as $s | range(length) | $s] as $shares
    | {
        runs: ($runs | length),
        groups: ($groups | length),
        fiveHour: ($shares | map(.h5 | select(. != null)) | summary),
        sevenDay: ($shares | map(.d7 | select(. != null)) | summary),
        costUsd: ($runs | map(.costUsd) | summary),
        minutes: ($runs | map(.minutes | select(. != null)) | summary)
      }' "$cache"
}

if [[ "${1:-}" == "--stats" ]]; then
  stats
  exit 0
fi

trap 'rm -f "$cache.log" "$cache.err"' EXIT

count="${1:-30}"
[[ "$count" =~ ^[0-9]+$ ]] || { echo "usage: review-cost.sh [runs] | --stats" >&2; exit 2; }

repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
runs_json="$(gh run list --workflow claude-code-review.yml --limit 100 \
  --json databaseId,status,conclusion,createdAt,updatedAt)"

# Only successful runs: a cancelled or failed review stopped partway and would understate the cost.
for id in $(jq -r --argjson n "$count" \
  '[.[] | select(.status == "completed" and .conclusion == "success")][:$n][] | .databaseId' <<<"$runs_json"); do
  grep -q "\"run\":$id,\"v\":2" "$cache" && continue
  # Runs without usable data (no job, expired logs, too few events) are cached as skipped so they
  # are not downloaded again. Any other gh failure is transient: leave the run for the next call.
  skip() { echo "{\"run\":$id,\"v\":2,\"skip\":true}" >>"$cache"; }
  job="$(gh api "repos/$repo/actions/runs/$id/jobs" --jq '.jobs[0].id // empty')" || continue
  [[ -n "$job" ]] || { skip; continue; }
  if ! gh api --allow-escape-sequences "repos/$repo/actions/jobs/$job/logs" >"$cache.log" 2>"$cache.err"; then
    grep -q 'HTTP 410' "$cache.err" && skip
    continue
  fi
  # Log events are pretty-printed JSON blocks behind a timestamp prefix: join each block onto one
  # line and keep only what parses.
  events="$(sed -E 's/^.?[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z ?//' "$cache.log" |
    awk '/^\{$/ { b = 1; s = "" } b { s = s $0 " " } /^\}$/ { if (b) print s; b = 0 }' |
    jq -cR 'fromjson? | select(.type == "rate_limit_event" or .type == "result")')"
  if [[ "$(jq -s 'map(select(.type == "rate_limit_event")) | length' <<<"$events")" -lt 2 ]]; then
    skip
    continue
  fi
  jq -cs --argjson id "$id" --argjson runs "$runs_json" '
    ($runs | map(select(.databaseId == $id)) | first) as $run
    | (map(select(.type == "rate_limit_event") | .rate_limit_info.unifiedWindows)) as $w
    | (map(select(.type == "result")) | last) as $result
    # Utilization in percent at the first and last snapshot; null if the window reset mid-run.
    | def snap(k): try (if $w[0][k].resetsAt == $w[-1][k].resetsAt
        then {start: ($w[0][k].utilization * 100 | round), end: ($w[-1][k].utilization * 100 | round),
              reset: $w[-1][k].resetsAt} else null end) catch null;
    {run: $id, v: 2, createdAt: $run.createdAt, updatedAt: $run.updatedAt,
     h5: snap("five_hour"), d7: snap("seven_day"),
     costUsd: ($result.total_cost_usd // null),
     minutes: (if $result.duration_ms then ($result.duration_ms / 60000 | round) else null end)}
    ' <<<"$events" >>"$cache"
done

stats
