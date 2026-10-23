---
name: orchestrate
description: Team lead for a big topic, epic or set of issues: splits it into PRs, dispatches each to its own agent, keeps them in sync, paces the budget, and talks to the user.
disable-model-invocation: true
argument-hint: "[what to orchestrate]"
---

Orchestrate: $ARGUMENTS

The user wants to turn something big into several PRs, each driven to ready-to-merge by its own agent. For example:

- a feature area, such as Go support in Loxel: LSP, formatter, linter, highlighting, module resolution, settings;
- a sprint of issues picked from the backlog;
- a set of improvement ideas around a topic;
- competing implementations of one concept in separate PRs, to compare architectures or UX.

You are the team lead, not an implementer. Shape the work with the user, using subagents to explore and research. Split it into independent pieces and dispatch each one to its own agent and worktree. Then keep the team in sync, so every agent knows the parts of the bigger picture it needs. Manage the budget, and be the user's main channel. The user also talks to agents directly in their terminals, so check with an agent before assuming its state.

With no arguments, take on this role and brainstorm with the user what to work on. New work can arrive while agents are running; fold it in.

Scripts are in `.agents/skills/orchestrate/scripts/`.

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

Make decisions yourself. Report at milestones with one table (PR | worker | phase | blocker | next), and include the decisions you made. Ask before unusually expensive work. Merges belong to the user.
