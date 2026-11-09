#!/usr/bin/env bash
# Measure how much of the shared Claude subscription a Claude Code Review run uses, from CI logs.
#
#   review-cost.sh [runs]    cache up to [runs] recent completed reviews (default 30), print stats
#   review-cost.sh --stats   print stats from the cache only (fast, no log downloads)
#
# Review logs expire after a few days, so each run's "review-metrics" line (its cost and its first
# and last weekly rate-limit snapshot) is cached once in $cache. A run's own snapshots also count every review running alongside it, so runs whose
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
    (map(select(.v == 2 and (.skip | not) and .costUsd != null and .d7 != null))
     | sort_by(.createdAt) | .[-40:]) as $runs
    | (reduce $runs[] as $r ([];
        if length > 0 and $r.createdAt < .[-1].end and $r.d7.reset == .[-1].runs[0].d7.reset
        then .[-1].runs += [$r] | .[-1].end = ([.[-1].end, $r.updatedAt] | max)
        else . + [{runs: [$r], end: $r.updatedAt}] end)) as $groups
    # One entry per run, holding its share of its group.
    | [$groups[] | .runs | {d7: share(.d7)} as $s | range(length) | $s] as $shares
    | {
        runs: ($runs | length),
        groups: ($groups | length),
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
  # Runs without usable data (no job, expired logs, no metrics line) are cached as skipped so they
  # are not downloaded again. Any other gh failure is transient: leave the run for the next call.
  skip() { echo "{\"run\":$id,\"v\":2,\"skip\":true}" >>"$cache"; }
  job="$(gh api "repos/$repo/actions/runs/$id/jobs" --jq '.jobs[0].id // empty')" || continue
  [[ -n "$job" ]] || { skip; continue; }
  if ! gh api --allow-escape-sequences "repos/$repo/actions/jobs/$job/logs" >"$cache.log" 2>"$cache.err"; then
    grep -q 'HTTP 410' "$cache.err" && skip
    continue
  fi
  # Each review run prints one "review-metrics <json>" line with its cost and window usage.
  metrics="$(sed -E 's/^.?[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z ?//' "$cache.log" | grep -m1 '^review-metrics ' | cut -d' ' -f2- || true)"
  if [[ -z "$metrics" || "$(jq -r '.d7 // empty' <<<"$metrics")" == "" ]]; then
    skip
    continue
  fi
  jq -c --argjson id "$id" --argjson runs "$runs_json" '
    ($runs | map(select(.databaseId == $id)) | first) as $run
    | {run: $id, v: 2, createdAt: $run.createdAt, updatedAt: $run.updatedAt,
       d7, costUsd, minutes}' <<<"$metrics" >>"$cache"
done

stats
