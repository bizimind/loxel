#!/usr/bin/env bash
# Report how much Claude subscription budget is left for agents and CI reviews, as JSON.
#
#   budget.sh                  snapshot now
#   budget.sh --alarm          poll every 5 min, print once the mode changes (e.g. watch -> throttle)
#   budget.sh --until-reset    sleep until the exhausted weekly window resets, then snapshot
#
# Both background modes return within an hour (background commands get killed after longer), printing
# the current snapshot; if it still says exhausted, run them again.
#
# Only the weekly window limits the subscription (there is no 5-hour window). Low budget narrows
# concurrency, down to one task with one review at a time ("single"), but never stops work: the
# budget is there to be used up by the reset. Only a weekly window at its limit ("exhausted")
# pauses work until it resets.
#
# Local agents and the CI reviewer share the subscription. `reviewSlots` is how many more review
# runs (pushes to PRs) to start now, counting the ones already in flight.
# Background modes exit non-zero after repeated endpoint failures (e.g. an expired login) instead of
# looping silently, so the orchestrator always gets a notification.
set -euo pipefail

# Single line: from here on, run one task and one review at a time.
single_7d=95
here="$(cd "$(dirname "$0")" && pwd)"

fetch_usage() {
  # The OAuth token goes to curl on stdin, never on the command line.
  local creds
  if command -v security >/dev/null; then
    creds="$(security find-generic-password -s "Claude Code-credentials" -w)"
  else
    creds="$(cat "$HOME/.claude/.credentials.json")"
  fi
  jq -r '"Authorization: Bearer " + .claudeAiOauth.accessToken' <<<"$creds" |
    curl -sf --max-time 15 -H @- -H "anthropic-beta: oauth-2025-04-20" -H "User-Agent: claude-code" \
      https://api.anthropic.com/api/oauth/usage
}

snapshot() {
  local usage reviews in_flight
  usage="$(fetch_usage)" || { echo "budget.sh: usage endpoint failed (an expired login is refreshed by any claude session)" >&2; return 1; }
  reviews="$("$here/review-cost.sh" --stats)"
  # A failed lookup fails the snapshot: reporting 0 reviews in flight would over-admit pushes.
  in_flight="$(gh run list --workflow claude-code-review.yml --limit 30 --json status \
    --jq 'map(select(.status != "completed")) | length')" || { echo "budget.sh: could not list review runs" >&2; return 1; }
  jq -n --argjson u "$usage" --argjson r "$reviews" --argjson inFlight "$in_flight" \
    --argjson single7 "$single_7d" '
    def epoch: if type == "string" then sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | fromdateiso8601 else null end;
    # A window that has not started yet (nothing used since the last reset) has no reset time.
    def window: {pct: (.utilization // 0), resetsAt: .resets_at,
      minutesToReset: ((.resets_at | epoch) as $e | if $e then (($e - now) / 60 | floor | [., 0] | max) else null end)};
    # Measured per-review cost when the cache has enough runs, else the Oct 2026 measurements.
    # A zero median (sub-1% reviews recorded at whole-percent resolution) is not a real measurement.
    (if $r.runs >= 5 and ($r.sevenDay.median // 0) > 0
     then {d7: $r.sevenDay.median, d7p95: $r.sevenDay.p95, source: "measured"}
     else {d7: 1, d7p95: 2, source: "defaults"} end) as $cost
    | (($u.seven_day // {}) | window) as $d7
    # In-flight reviews get a full median on top of what they already spent: deliberately conservative.
    | ($d7.pct + $inFlight * $cost.d7) as $projected7
    # Weekly pace: points used beyond an even spread over the 7 days.
    | (if $d7.minutesToReset then ($d7.pct - (100 * (1 - $d7.minutesToReset / (7 * 24 * 60))) | round) else 0 end) as $aheadOfPace
    # Reviews that fit at median cost, keeping one p95 overrun of margin below the single line.
    | (($single7 - $projected7 - ($cost.d7p95 - $cost.d7)) / ([$cost.d7, 0.1] | max) | floor | [., 0] | max) as $slots
    | (if $d7.pct >= 100 then "exhausted"
       elif $d7.pct >= $single7 then "single"
       elif $projected7 >= 85 then "throttle"
       elif $projected7 >= 70 or $aheadOfPace > 15 then "watch"
       else "free" end) as $mode
    | {
        mode: $mode,
        sevenDay: ($d7 + {aheadOfPace: $aheadOfPace}),
        # Other active limits, e.g. a per-model weekly allowance.
        otherLimits: [$u.limits[]? | select(.kind != "session" and .kind != "weekly_all")
                      | {kind, group, pct: .percent, resetsAt: .resets_at}],
        reviewsInFlight: $inFlight,
        reviewCost: $cost,
        # A single review at a time always runs, so low budget slows work down but never stops it.
        reviewSlots: (if $mode == "exhausted" then 0
                      elif $mode == "single" or $slots == 0 then (if $inFlight == 0 then 1 else 0 end)
                      else $slots end),
        advice: (if $mode == "exhausted" then "The weekly window is at its limit: let workers reach a commit point, run budget.sh --until-reset in the background, then resume one worker at a time."
                 elif $mode == "single" then "Run one worker on the most important task, one push and review at a time; the others wait. Keep going until the weekly window is exhausted."
                 elif $slots == 0 and $inFlight > 0 then "Wait for the in-flight reviews to finish before the next push."
                 else {
                   free: "Work freely; check again at milestones.",
                   watch: "Usage is ahead of an even weekly pace or nearing the throttle line: check before each push batch; prefer finishing PRs over starting new ones.",
                   throttle: "Admit at most reviewSlots pushes; run workers one or two at a time; keep budget.sh --alarm running."
                 }[$mode] end)
      }'
}

# Retry a snapshot up to 3 times, a minute apart.
snapshot_retry() {
  local attempt
  for attempt in 1 2 3; do
    snapshot && return 0
    (( attempt < 3 )) && sleep 60
  done
  return 1
}

# Background modes stop by this wall-clock deadline, leaving room for the final snapshot.
deadline=$(( $(date +%s) + 55 * 60 ))

case "${1:-}" in
  "")
    snapshot
    ;;
  --alarm)
    start_mode="$(snapshot_retry | jq -r .mode)"
    while (( $(date +%s) + 300 < deadline )); do
      sleep 300
      state="$(snapshot_retry)" || exit 1
      if [[ "$(jq -r .mode <<<"$state")" != "$start_mode" ]]; then
        echo "$state"
        exit 0
      fi
    done
    echo "$state"
    ;;
  --until-reset)
    state="$(snapshot_retry)" || exit 1
    minutes="$(jq -r '.sevenDay.minutesToReset // 0' <<<"$state")"
    target=$(( $(date +%s) + (minutes + 2) * 60 ))
    if (( target > deadline )); then
      # The reset is past this command's deadline: wake anyway and say so, so it gets run again.
      sleep $(( deadline - $(date +%s) ))
      { snapshot_retry || echo '{}'; } | jq '. + {reset: false, note: "the window has not reset yet; run --until-reset again"}'
      exit 0
    fi
    sleep $(( target - $(date +%s) ))
    # After a long sleep the stored login may have expired; the woken session refreshes it.
    if state="$(snapshot_retry)"; then
      jq '. + {reset: true}' <<<"$state"
    else
      echo '{"reset": true, "note": "window reset; usage endpoint unavailable, run budget.sh again"}'
    fi
    ;;
  *)
    echo "usage: budget.sh [--alarm | --until-reset]" >&2
    exit 2
    ;;
esac
