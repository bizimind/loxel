---
name: babysit-pr
description: Loops an open PR to ready-to-merge (Claude Code Review comes back clean, threads resolved, CI green, no conflicts). Use when asked to babysit or monitor a PR, "loop until the review comes clean", or "get #N ready to merge".
argument-hint: "<pr number> [extra instructions]"
---

Get PR $ARGUMENTS to ready-to-merge: the Claude Code Review of the head commit says "No issues found", no unresolved threads, all checks green, no conflicts with main. The user merges; you never do.

## Loop

1. `.agents/skills/babysit-pr/scripts/pr-state.sh <pr>` prints the verdict and blockers. Stop when it says `ready`, `merged`, `closed` or `unsupported` (draft, bot PRs).
2. Fix every blocker, then push once, as soon as the fixes are ready. Each push starts a ~20 minute review; don't wait for or cancel a review that is still running, since it still posts its findings.
3. Watch the PR with a Monitor watch on `.agents/skills/babysit-pr/scripts/pr-events.sh <pr>` (timeout_ms 1800000). Re-arm it every time it expires or exits: it remembers what it reported, so nothing that changed in between is missed. Act on `round over` or any event that needs action. Without Monitor, run `pr-state.sh <pr> --wait` in the background instead.

## Rules

- Babysit only a settled idea. While the user is discussing a change of direction or design for this PR, a finished round gets a one-line status and no action until they approve the new direction; then resume the loop.
- One session per PR: if `ListAgents` shows another session on this PR's branch, agree on a single owner with SendMessage before pushing.
- Review threads: use `/fix-pr-comments`, which decides what to fix, rework, defer or skip without stopping to ask. Never leave a bug or security issue that this PR introduced.
- Vulnerability Check failures get their own PR via `/quick-pr`. Once it merges, merge main into this PR.
- Unrelated or flaky failures: rerun once, then `/quick-pr` a fix or comment on the existing issue.
- A review run that failed or was cancelled (often a usage limit): `gh run rerun <id> --failed`.
- Merge main only when the PR conflicts with it, or needs a fix that just landed there (like the Vulnerability Check fix above); a PR that is merely behind main stays as is, since each merge adds noise and starts a new review. Use `git fetch origin main && git merge origin/main`, and rebase only if the user asks.

When ready, record the decisions you made along the way in the PR body, and give the user a short summary: what was fixed, reworked, deferred (with issue links) and skipped.
