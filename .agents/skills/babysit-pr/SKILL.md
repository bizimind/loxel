---
name: babysit-pr
description: Loops an open PR to ready-to-merge (Claude Code Review comes back clean, threads resolved, CI green, no conflicts). Use when asked to babysit or monitor a PR, "loop until the review comes clean", or "get #N ready to merge".
argument-hint: "<pr number> [extra instructions]"
---

# babysit-pr

Arguments: $ARGUMENTS (the PR number, then any extra instructions, which take precedence over this skill). Bring the PR to ready-to-merge, which means every gate holds at once:

- The Claude Code Review run for the PR head posted "No issues found" after it started
- Zero unresolved review threads
- Every check passes (CI, Vulnerability Check, Secret Scan, CodeQL, site preview, ...)
- No conflicts with main (`mergeStateStatus` is `CLEAN`). PRs are squash-merged, so merge commits on the branch are fine.
- The PR body records any extras or decisions made during the iterations

The user merges, closes and approves; you never do.

## The loop

`.agents/skills/babysit-pr/scripts/pr-state.sh` (run it from the repo root) prints a JSON snapshot with a `verdict` (`ready`, `waiting`, `needs-work`, `merged`, `closed`), the `blockers`, the unresolved threads with their `threadId`/`commentId`, failed checks with log links, and merge state. Every round:

1. Run `pr-state.sh <pr>`. If the verdict is `ready`, go to [Finishing](#finishing).
2. Work through every blocker (below), verify locally, and push all of the round's fixes as one push. Each push starts a new 10–55 minute review, so do not push fix by fix.
3. Run `pr-state.sh <pr> --wait` as a background Bash command (`run_in_background: true`) and end your turn. It returns when a check fails or when the head's review and all checks finish, and always within 70 minutes. A non-zero exit means `gh` kept failing: run the wait again. Its completion notification wakes you: the wait follows when the review actually lands, not a timer. Do not sleep in the foreground, poll its output, or schedule timed wakeups.
4. When the notification arrives, start the next round from step 1.

Each round starts from a fresh snapshot, so after any interruption (usage limit, "continue", a new session) just run step 1 again. No `/loop` is needed. If you were started under `/loop`, call `ScheduleWakeup` with `stop: true` when you finish.

## Blockers

**Review threads**: invoke `/fix-pr-comments`. It verifies each finding against the current code, fixes the valid ones, then replies on and resolves every thread. A slow review of an older commit can post after a newer push, so its findings are handled like any other thread. Treat findings as suggestions, not requirements. Do not add new flags, options or features to satisfy one, and do not let fixes pile complexity onto the PR's intent. Past loops did both, and the user later reverted them. File an issue for anything out of scope, reply with its link, and resolve the thread. Security findings are the exception: the repo is public, so fix them in the PR or tell the user, never file a public issue.

**"review of head reported findings"** with no unresolved threads left: you declined every finding without pushing, so no new review will run. Push if you changed anything; otherwise this is a stopping point (see [Finishing](#finishing)).

**"review run failure" or "review run cancelled"**: check `gh run view <id> --log | grep -iE '429|rate limit|usage limit'`, then retry with `gh run rerun <id> --failed` (failed) or `gh run rerun <id>` (cancelled). If GitHub refuses a rerun, push `git commit --allow-empty -m "chore: retrigger checks"`.

**Failed check**: read the log with `gh run view <run> --job <job> --log-failed`.

| Failure                                                          | Action                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Caused by the PR                                                 | Fix it in the PR.                                                                                                                                                                                                                                                                                                                 |
| Flaky or unrelated: also fails on main, or matches an open issue | `gh run rerun <run> --failed` once. If it is a real bug outside the PR, comment on the existing issue or `/quick-pr` a fix. Never fix it in this PR.                                                                                                                                                                              |
| Vulnerability Check (Trivy dependency audit)                     | Always a separate PR (see below). Check `gh pr list --search <package>` for a fix already in flight. If there is none, `/quick-pr bump <package> to <fixed version> to clear <CVE>, flagged in <job url>`. Once it merges, merge main into this PR; do not just rerun.                                                            |
| Secret Scan (gitleaks)                                           | Reproduce with `gitleaks git --log-opts="$(git merge-base HEAD origin/main)..HEAD" --no-banner`. Every commit in the PR is scanned, so a false positive in an old commit needs a history rewrite or an allowlist: ask the user which. If it is a real secret, stop and tell the user; do not mention it in PR comments or issues. |

For a Vulnerability Check failure, the Trivy table names the package, CVE and fixed version:

```bash
gh run view <run> --job <job> --log-failed | grep -E '│|Total'
```

Keep the gates honest: never use `--no-verify` or skip or disable tests to go green. Judge local verification by exit codes, not by grepping output.

**Conflicts with main**: main keeps moving while you loop, so check this every round.

```bash
git fetch origin main
git merge-tree --write-tree --name-only HEAD origin/main   # preview conflicting files
git merge --no-edit origin/main                            # default: merge commit, plain push
```

Rebase and `git push --force-with-lease` only when the user asks for a rebase, or when the PR is stacked on a base that has since merged. In that case use `git rebase --onto origin/main <old-base-tip>` and remove the "Stacked on" line from the PR body. After either, run fmt, lint, typecheck and the tests of affected packages: semantic conflicts, like a type that main removed, only show up there.

**Local branch differs from the PR head**: the blocker says whether to push or pull. After a force-push that GitHub missed (no new checks start, the PR head stays on the old commit), push an empty commit to retrigger.

## Finishing

On `ready`: update the PR body (`gh pr edit <pr> --body-file`) with any extras or decisions that came out of the iterations. Then report:

- The number of rounds
- Findings fixed, declined (with reasons) and deferred (with issue links)
- Any `/quick-pr` PRs started
- Final state: "ready to merge"

Stop and ask the user, with a summary of where things stand, when:

- the reviewer raises a finding again after you declined it;
- five review rounds have not converged, for example because each round finds a new hole in the same code (one past PR ran about ten rounds before the user stopped it);
- every finding in a round is wrong, which is a valid stopping point;
- a fix needs a product or scope decision, or a history rewrite;
- the only remaining blocker is a separate fix PR waiting to be merged.

## Not covered

Creating the PR; merging, closing or approving it; draft, dependabot and fork PRs, where the review does not run; babysitting several PRs in one session. Run one session per PR, and stagger pushes across PRs: the CI reviewer has a limited token budget, and pushing many PRs at once exhausts it.
