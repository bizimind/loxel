---
name: orchestrate
description: Runs this session as orchestrator of agents working on several PRs (delegation, tracking, overlap and dependencies, budget pacing, rate-limit recovery, talking to the user). Use when asked to orchestrate or coordinate agents across PRs.
argument-hint: "[what to orchestrate]"
---

# orchestrate

Task: $ARGUMENTS

You are the orchestrator. The user talks to you; you turn their intent into work for other agents, keep those agents unblocked and out of each other's way, and bring their PRs to ready-to-merge. Do not write the PRs yourself unless the user asks.

| You own                                                  | Workers own                                               |
| -------------------------------------------------------- | --------------------------------------------------------- |
| The conversation with the user and every scope decision  | The code in their own worktree                            |
| The registry of workers and PRs                          | Verification: fmt, lint, typecheck, tests                 |
| The budget, and when pushes (and so CI reviews) start    | Commits, pushes when allowed, replies on their PR threads |
| All waiting: CI, reviews, merges, limit resets           | Their report when a round ends                            |
| Cross-PR knowledge: overlaps, shared fixes, dependencies |                                                           |

## Workers

| Work                                                                  | Worker                                                                                                                                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A PR, especially one the user may want to steer                       | A `/quick-pr` peer session in a Loxel terminal, running `/babysit-pr` itself. It survives you, the user can talk to it, and it continues on its own after a usage reset. |
| A bounded job: an assessment, research, one fix round, a branch split | A background subagent (Agent tool). It is cheap and isolated, and `SendMessage` resumes it with its full context.                                                        |

Write the rules every worker shares once, in `/tmp/orchestrate/<task>/common.md`, and give each worker a short prompt that points to it, plus its own context:

- its worktree;
- its deliverable;
- the user's decisions;
- file fences when siblings overlap ("another agent owns `X`; stop and report if you need to change it");
- the report format;
- feedback from this conversation that applies to it, such as headless Electron testing.

State facts and decisions and let the worker explore; do not hand it guessed solutions.

Peer sessions need three more rules in `common.md`, because `/quick-pr` alone stops at opening the PR:

```markdown
- After opening the PR, run `/babysit-pr <number>` until it is ready to merge.
- Report to the orchestrator with SendMessage (reply to the session that messaged you) when the PR opens, when it is ready to merge, and when you are blocked or need a decision.
- When the orchestrator says "hold pushes", commit locally, report "ready to push <sha>", and push only when it releases you.
```

After starting a peer session, find its name with `ListAgents` (the worktree name plus a suffix) and `SendMessage` it once to introduce yourself. Ask it to report to you, the sender, when it opens the PR, when it is ready to merge, and when it is blocked or needs a decision.

Subagents work in bounded rounds: implement or fix, verify, commit, push only if allowed, reply on and resolve threads, report, then stop. Never ask a subagent to wait on CI or poll. Past subagents that did burned the shared budget on sleeps and stalled. You do the waiting, and you resume the subagent with the findings.

## Registry

Keep `/tmp/orchestrate/<task>/registry.md`, one row per worker:

- the worker's agent id or peer name, and its kind;
- worktree and branch;
- PR;
- phase;
- depends-on;
- last known state, with a time.

Update it on every report and notification. It is how you recover after a compaction, a usage limit or a new session, and it is the source of truth: `ListAgents` does not reliably list subagents.

A task notification means the worker stopped, not that it succeeded. Read the result: "has not reported yet", "terminated early due to an API error" and "stalled" each need you to act.

## Waiting

Every wait is a background Bash command (`run_in_background: true`) that exits when there is something to act on. Never sleep in the foreground.

```bash
.agents/skills/babysit-pr/scripts/pr-state.sh <pr> --wait               # a PR round is over
until gh pr view <pr> --json state -q .state | grep -qxE 'MERGED|CLOSED'; do sleep 120; done   # a dependency merged
.agents/skills/orchestrate/scripts/budget.sh --alarm                    # the budget mode changes
.agents/skills/orchestrate/scripts/budget.sh --until-reset              # a limit window reset
```

## Coordination

- **Overlap.** Compare `git -C <worktree> diff --name-only origin/main...` and `git -C <worktree> status --porcelain` across workers. When two touch the same files, give one ownership and warn the other. Propose a merge order to the user, least entangled first. After each merge, tell only the PRs that now conflict to merge main.
- **One fix for a shared problem.** When a second worker hits the same flaky test, vulnerable dependency or missing helper, it gets one fix, not two. First check `gh pr list --search` and `gh issue list --search`. Then start a `/quick-pr` for the fix (or file an issue for a flake), and tell every affected worker to leave it alone and merge main once it lands. If several PRs need the same new helper, land it as its own PR first.
- **Bridging.** When one worker learns something another needs, relay it with `SendMessage` as a self-contained message: what, where, and what to do. For back-and-forth on a shared interface, give the two workers each other's names and let them message directly, with you copied on the outcome.
- **Dependencies.** Record them in the registry and wait for the merge in the background. Then tell each dependent what to do: for a stacked PR, `git rebase --onto origin/main <old-base-tip>`; otherwise, merge main.

## Budget

Local agents and CI reviews draw on the same subscription. A review costs about 14 points of the 5-hour window (p95 about 25) and about 2 points of the week. A review that hits the limit fails and cannot be resumed, and a rerun starts over. A local agent at the limit only pauses. So when budget is tight, throttle pushes first, since every push starts a review, and keep local work light while reviews run.

Run `.agents/skills/orchestrate/scripts/budget.sh` (paths in this skill are from the repo root) at these points:

- when you start;
- before starting workers or a batch of pushes;
- whenever an alarm fires.

It prints the mode, both windows, the reviews in flight, and `reviewSlots`, the number of new reviews that fit. At the start of a session, run `.agents/skills/orchestrate/scripts/review-cost.sh` once to refresh the measured review cost. CI logs expire after a few days, so it caches what it reads.

| Mode       | What to do                                                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `free`     | Work freely; budget only needs a glance at milestones.                                                                                                                                                                                           |
| `watch`    | Check before each push batch, and finish PRs before starting new ones.                                                                                                                                                                           |
| `throttle` | Have workers commit, report "ready to push `<sha>`" and hold. Release at most `reviewSlots` pushes at a time, oldest PR first. With 0 slots, wait for in-flight reviews to finish. Run workers one or two at a time, and keep `--alarm` running. |
| `hold`     | No new pushes or workers. Ask running workers to reach a commit point and stop, then run `--until-reset`. The hold lines (90% of 5 hours, 95% of the week) keep enough reserve for you to recover.                                               |

Before anything unusually expensive, such as a large fan-out or re-running a big job, show the user the estimated cost against the current budget and ask.

## Recovery after a limit

1. If the limit hits anyway, your interactive session continues on its own after the reset; if it does not, the user will say "continue". Peer sessions continue themselves. Subagents and CI reviews do not.
2. On waking, whether `--until-reset` finished or the session continued, run `budget.sh` and read the registry.
3. For each stopped subagent, gather the ground truth: `git status`, unpushed commits, and the PR's head, checks and threads. Then send it a digest with `SendMessage`: "A usage limit interrupted you and has now reset. State: …. Next: …. Report: …". Start a new agent on the same worktree only if `SendMessage` fails.
4. For PRs that subagents own, rerun reviews of the current head that failed on the limit with `gh run rerun <id> --failed`, within `reviewSlots`, oldest first. Peers rerun their own through `/babysit-pr`, so tell them how many slots they have instead of rerunning for them.
5. Resume in waves, not all at once, and tell the user what you resumed.

## Talking to the user

- You are the single point of contact. Relay the user's decisions to workers instead of having each worker ask, unless the user is talking to a peer session directly.
- Report at milestones: a PR opened, one ready to merge, a blocker, a change of budget mode. Use one compact table (PR | worker | phase | blocker | next). Skip updates that say nothing new.
- Batch your questions, and bring each decision with a recommendation.
- Merging, closing and approving PRs belong to the user. Give them `! gh pr merge <n> --squash` lines, and never route those actions through a worker.

## Not covered

- Babysitting a single PR in this session; use `/babysit-pr`.
- Choosing what to build; the user decides scope, and you propose.
