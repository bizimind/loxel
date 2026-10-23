---
name: orchestrate
description: Runs this session as orchestrator of agents working on several PRs (delegation, tracking, overlap and dependencies, budget pacing, rate-limit recovery, talking to the user). Use when asked to orchestrate or coordinate agents across PRs.
argument-hint: "[what to orchestrate]"
---

Orchestrate: $ARGUMENTS

You talk to the user and own the plan, the registry, all waiting, the budget, and what one PR learns that another needs. Workers own the code in their own worktree. Don't write the PRs yourself unless asked. Scripts are in `.agents/skills/orchestrate/scripts/`.

## Workers

- **PRs:** `/quick-pr` peer sessions. Add to their prompt: run `/babysit-pr` after opening the PR; report to you with SendMessage (reply to the session that messaged you) when the PR opens, is ready, or is blocked; when told "hold pushes", commit and report "ready to push <sha>" instead. Find each peer with `ListAgents` and message it once so it knows who you are.
- **Bounded jobs** (assessment, research, one fix round): background subagents. They never wait on CI; you wait, then resume them with SendMessage and the findings.
- Put shared rules in `/tmp/orchestrate/<task>/common.md`. Give each worker its worktree, deliverable, the user's decisions and file fences ("another agent owns X").

Keep a registry in `/tmp/orchestrate/<task>/registry.md`: worker, worktree, PR, phase, depends-on, last state. `ListAgents` does not reliably list subagents, so the registry is the source of truth. A task notification means a worker stopped, not that it succeeded.

## Waiting

Only background commands, each of which returns within about an hour; re-run it if nothing changed:

- `.agents/skills/babysit-pr/scripts/pr-state.sh <pr> --wait`: a PR round finished.
- `budget.sh --alarm`: the budget mode changed.
- `budget.sh --until-reset`: a usage window reset.

## Coordination

- Two workers on the same files: give one ownership, and propose a merge order, least entangled first.
- The same problem hit twice (flaky test, vulnerable dependency, missing helper): one fix PR. The other workers wait for it, then merge main.
- Relay what one worker learned to another with SendMessage. When a dependency merges, tell its dependents to merge main.

## Budget

Agents and CI reviews share one subscription, and a review costs about 14% of the 5-hour window. A review that hits the limit fails and cannot resume, so pushes are the throttle. Run `review-cost.sh` once per session, and `budget.sh` before starting workers or a batch of pushes:

| Mode       | Do                                                                 |
| ---------- | ------------------------------------------------------------------ |
| `free`     | Work freely.                                                       |
| `watch`    | Check before each push batch; finish PRs before starting new ones. |
| `throttle` | Workers hold pushes; release `reviewSlots` at a time.              |
| `hold`     | No new work; workers stop at a commit point; run `--until-reset`.  |

Ask the user before anything unusually expensive.

## Recovery

After a reset, run `budget.sh` and read the registry. Send each stopped subagent a digest with SendMessage: what interrupted it, the current state of its worktree and PR, and what to do next. Rerun reviews that failed on the limit within `reviewSlots`, and resume in waves.

## The user

You are their single point of contact. Report at milestones with one table (PR | worker | phase | blocker | next), batch questions with a recommendation, and leave merges to them.
