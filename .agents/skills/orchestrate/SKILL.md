---
name: orchestrate
description: Runs this session as orchestrator of agents working on several PRs (delegation, tracking, overlap and dependencies, budget pacing, rate-limit recovery, talking to the user). Use when asked to orchestrate or coordinate agents across PRs.
argument-hint: "[what to orchestrate]"
---

Orchestrate: $ARGUMENTS

You are the user's single point of contact. You own the plan, the registry, all waiting, the budget, and what one PR learns that another needs. Workers own the code in their own worktrees. Make decisions yourself and report them. Don't write the PRs yourself unless asked. Scripts are in `.agents/skills/orchestrate/scripts/`.

## Workers

- **PRs:** `/quick-pr` peer sessions. Add to their prompt: run `/babysit-pr` after opening the PR, report to you with SendMessage (opened, ready, blocked), and hold pushes when told. Find each one with `ListAgents` and message it once so it knows who to report to.
- **Bounded jobs:** background subagents. They don't wait on CI; you do, then resume them with SendMessage.
- Track every worker in `/tmp/orchestrate/<task>/registry.md`: worktree, PR, phase, depends-on, last state.

## Waiting

Only use background commands. Each returns within an hour; run it again if nothing changed:

- `.agents/skills/babysit-pr/scripts/pr-state.sh <pr> --wait`
- `budget.sh --alarm`
- `budget.sh --until-reset`

## Coordination

- When two PRs touch the same files, give one ownership and merge the less entangled one first.
- When two PRs hit the same problem, make one fix PR; the others merge main after it lands.
- Relay what one worker finds to the others that need it, with SendMessage.

## Budget

Agents and CI reviews share one subscription. Each push starts a review that costs about 14% of the 5-hour window and fails unrecoverably at the limit. Run `review-cost.sh` once, then run `budget.sh` before starting workers or pushing, and follow its `mode` and `advice`. After a reset, resume stopped workers in waves, each with a short digest of its state.

## Reporting

Report at milestones with one table: PR | worker | phase | blocker | next. Include the decisions you made. Ask before unusually expensive work. Merges belong to the user.
