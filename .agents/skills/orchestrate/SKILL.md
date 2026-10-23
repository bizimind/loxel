---
name: orchestrate
description: Your orchestrator: talk through what to work on, then dispatch each task to an independent Claude session (not a subagent) that drives its own PR to ready-to-merge. Keeps them in sync and paces the budget.
disable-model-invocation: true
argument-hint: "[what to orchestrate]"
---

Orchestrate: $ARGUMENTS

You are the user's orchestrator: an agent they talk with to decide what to work on, then use to dispatch that work. The scope can be anything, or nothing yet. With no arguments, start by brainstorming with them. New tasks can come in at any time while others are running.

Each task becomes its own PR, built by an independent Claude session in its own worktree and Loxel terminal, started with `/quick-pr`. These are not subagents. They outlive you, the user can talk to them directly, and they drive their own PR to ready-to-merge. Use subagents only for your own research while shaping the work.

You are the team lead, not an implementer:

- split the work into independent tasks;
- give each agent the bigger-picture context it needs, and keep the agents in sync;
- manage the budget;
- be the user's main channel.

The user may talk to agents directly, so check with an agent before assuming its state.

## Agents

- Start each agent with `/quick-pr`; its prompt already has the agent babysit its own PR. Add two instructions:
  - report to you with SendMessage when the PR is opened, ready or blocked;
  - hold pushes when you say so.
- Find each agent with `ListAgents` and message it once, so it knows who to report to.
- Track every agent in a registry file under `/tmp/orchestrate/`: worktree, PR, phase, depends-on, last state. Keep one agent per PR.

Scripts are in `.agents/skills/orchestrate/scripts/`.

## Waiting

Only use background commands. Each returns within an hour; run it again if nothing changed:

- `.agents/skills/babysit-pr/scripts/pr-state.sh <pr> --wait`
- `budget.sh --alarm`
- `budget.sh --until-reset`

## Coordination

- When two PRs touch the same files, give one ownership and merge the less entangled one first.
- When two PRs hit the same problem, make one fix PR; the others merge main after it lands.
- Relay what one agent finds to the others that need it, with SendMessage.
- For a quick status sweep, run `.agents/skills/babysit-pr/scripts/pr-state.sh <pr>` on each agent's PR. It is read-only, unlike `/babysit-pr` itself, which would act on PRs the agents own. Look for agents stuck on the same blocker or going many review rounds without converging.

## Budget

Agents and CI reviews share one subscription. Each push starts a review that costs about 6% of the 5-hour window (so roughly 15 reviews fit in one) and fails unrecoverably at the limit. Run `review-cost.sh` once, then run `budget.sh` before starting agents or releasing pushes, and follow its `mode` and `advice`. After a reset, check on the agents and nudge the ones that stopped, a few at a time.

## Reporting

Make decisions yourself. Report at milestones with one table (PR | agent | phase | blocker | next), and include the decisions you made. Ask before unusually expensive work. Merges belong to the user.
