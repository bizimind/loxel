---
name: babysit-pr
description: Loops an open PR to ready-to-merge (Claude Code Review comes back clean, threads resolved, CI green, no conflicts). Use when asked to babysit or monitor a PR, "loop until the review comes clean", or "get #N ready to merge".
argument-hint: "<pr number> [extra instructions]"
---

Get PR $ARGUMENTS to ready-to-merge: the Claude Code Review of the head commit says "No issues found", no unresolved threads, all checks green, no conflicts with main. The user merges; you never do.

## Loop

1. `.agents/skills/babysit-pr/scripts/pr-state.sh <pr>` prints the verdict and blockers. Stop when it says `ready`, `merged` or `closed`.
2. Fix every blocker, then push once. Each push starts a ~20 minute review.
3. Run `pr-state.sh <pr> --wait` in the background and end your turn. It exits when the round is over, and its notification starts the next round.

## Rules

- Review threads: use `/fix-pr-comments`, which decides what to fix, rework, defer or skip without stopping to ask. Never leave a bug or security issue that this PR introduced.
- Vulnerability Check failures get their own PR via `/quick-pr`. Once it merges, merge main into this PR.
- Unrelated or flaky failures: rerun once, then `/quick-pr` a fix or comment on the existing issue.
- A review run that failed or was cancelled (often a usage limit): `gh run rerun <id> --failed`.
- Merging main: `git fetch origin main && git merge origin/main`. Rebase only if the user asks.

When ready, record the decisions you made along the way in the PR body, and give the user a short summary: what was fixed, reworked, deferred (with issue links) and skipped.
