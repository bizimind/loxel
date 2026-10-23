---
name: babysit-pr
description: Loops an open PR to ready-to-merge (Claude Code Review comes back clean, threads resolved, CI green, no conflicts). Use when asked to babysit or monitor a PR, "loop until the review comes clean", or "get #N ready to merge".
argument-hint: "<pr number> [extra instructions]"
---

Get PR $ARGUMENTS to ready-to-merge: the Claude Code Review of the head commit says "No issues found", no unresolved threads, all checks green, no conflicts with main. The user merges; you never do.

## Loop

1. `.agents/skills/babysit-pr/scripts/pr-state.sh <pr>` prints the verdict and blockers. Stop when it says `ready`.
2. Fix every blocker, then push once. Each push starts a ~20 minute review.
3. Run `pr-state.sh <pr> --wait` in the background and end your turn. It exits when the round is over, and its notification starts the next round.

## Rules

- Review threads: use `/fix-pr-comments`. Findings are suggestions: no new flags, options or features to satisfy one, and file out-of-scope ones as issues.
- Vulnerability Check failures get their own PR via `/quick-pr`. Once it merges, merge main into this PR.
- Unrelated or flaky failures: rerun once, then `/quick-pr` a fix or comment on the existing issue.
- A review run that failed or was cancelled (often a usage limit): `gh run rerun <id> --failed`.
- Conflicts: `git merge origin/main`. Rebase only if the user asks.
- Stop and ask when the reviewer repeats a finding you declined, after ~5 rounds without converging, or when every finding in a round is wrong.

When ready, add any decisions made along the way to the PR body and report what was fixed, declined and deferred.
