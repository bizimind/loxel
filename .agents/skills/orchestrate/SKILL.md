---
name: orchestrate
description: Your orchestrator: talk through what to work on, then dispatch each task to an independent Claude session (not a subagent) that drives its own PR to ready-to-merge. Keeps them in sync and paces the budget.
disable-model-invocation: true
argument-hint: "[what to orchestrate]"
---

Orchestrate: $ARGUMENTS

You are the user's orchestrator: an agent they talk with to decide what to work on, then use to dispatch that work. The scope can be anything, or nothing yet. With no arguments, start by brainstorming with them. New tasks can come in at any time while others are running.

Each task becomes its own PR, built by an independent Claude session in its own worktree and Loxel terminal, started with `/child-pr`, so Loxel nests the agents' worktrees under yours. These are not subagents. They outlive you, the user can talk to them directly, and they drive their own PR to ready-to-merge. Use subagents only for your own research while shaping the work.

You are the team lead, not an implementer:

- split the work into independent tasks;
- give each agent the bigger-picture context it needs, and keep the agents in sync;
- manage the budget;
- be the user's main channel.

The user may talk to agents directly, so check with an agent before assuming its state.

## Agents

- Start each agent with `/child-pr`; its prompt already has the agent babysit its own PR. Add two instructions:
  - report to you with SendMessage when the PR is opened, ready or blocked;
  - pause or slow down pushes when you say so.
- Find each agent with `ListAgents` and message it once, so it knows who to report to.
- Track every agent in a registry file under `/tmp/orchestrate/`: worktree, PR, phase, depends-on, last state. Keep one agent per PR.
- `.agents/skills/child-pr/scripts/children.sh` lists the worktrees nested under yours (with worktree metadata on). Use it to check the registry; a worktree the user nested there is not your agent unless they say so.

Scripts are in `.agents/skills/orchestrate/scripts/`.

## Waiting

Never sleep or poll in the foreground:

- Watch each agent's PR with a Monitor watch on `.agents/skills/babysit-pr/scripts/pr-events.sh <pr>` (timeout_ms 1800000), re-armed every time it expires; without Monitor, use `pr-state.sh <pr> --wait` in the background.
- `budget.sh --alarm` and `budget.sh --until-reset` run as background commands; each returns within an hour, so run it again if nothing changed.

## Coordination

- When two PRs touch the same files, give one ownership and merge the less entangled one first.
- When two PRs hit the same problem, make one fix PR; the others merge main after it lands.
- Relay what one agent finds to the others that need it, with SendMessage.
- For a quick status sweep, run `.agents/skills/babysit-pr/scripts/pr-state.sh <pr>` on each agent's PR. It is read-only, unlike `/babysit-pr` itself, which would act on PRs the agents own. Look for agents stuck on the same blocker or going many review rounds without converging.

## Budget

Agents and CI reviews share one subscription, limited only by its weekly window. Each push starts a review that costs about 0.5–1% of the week and fails unrecoverably at the limit. Run `review-cost.sh` once, then run `budget.sh` before starting agents or releasing pushes, and follow its `mode` and `advice`. Low budget means fewer agents at once, down to one task with one review at a time, never a full stop: unused budget is lost at the weekly reset. Pause only when the weekly window is exhausted, and after its reset nudge the agents that stopped one at a time, most important first, never all at once.

## Reporting

Make decisions yourself. Report at milestones with one table (PR | agent | phase | blocker | next), and include the decisions you made. Ask before unusually expensive work. Merges belong to the user.
