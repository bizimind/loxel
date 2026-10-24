---
name: quick-pr
description: Kick off a PR in a fresh git worktree and hand it to a detached Claude session in a new Loxel terminal. Use when the user says "quick pr", "quick-pr this", "spin up a PR for X", "open a worktree and have claude fix/add X", or wants to delegate a task to an independent Claude session in its own worktree.
---

# quick-pr

Delegate a PR to an independent Claude session: create a worktree with `wt`, write the task prompt to a file, open a Loxel terminal in the worktree, and start `claude` there with the prompt piped in. This session only sets things up; the spawned session does the work, opens the PR and babysits it.

## 1. Pick the worktree name

Pattern: `{fix,feat,chore}/<short-kebab-name>`. Branch and worktree share the name. Check `wt list -j` for collisions first.

| Task                                           | Name                              |
| ---------------------------------------------- | --------------------------------- |
| "the terminal tab title is wrong after rename" | `fix/terminal-title-after-rename` |
| "add a --json flag to code-analysis loc"       | `feat/code-analysis-loc-json`     |
| "bump oxlint and fix new warnings"             | `chore/bump-oxlint`               |

## 2. Create the worktree on latest `origin/main`

`wt add` branches from `origin/main` as of the last fetch and never fetches itself, so fetch first:

```bash
git fetch origin main
wt add fix/terminal-title-after-rename -j   # prints {"path": ...}
```

Use the `.path` from the JSON output for the next steps. Skip the fetch and pass `--base <ref>` only when the user asks for a different base, e.g. a stacked PR on top of another branch:

```bash
wt add feat/part-two --base feat/part-one -j
```

## 3. Write the prompt to a file

Write the prompt with the Write tool (no shell quoting involved), one file per PR under `/tmp`, named after the worktree: `/tmp/quick-pr-fix-terminal-title-after-rename.md`. Keep it a file rather than piping a heredoc: `loxel terminal` types its command into the new shell as keystrokes, so the typed command must stay a one-liner.

```markdown
Fix: the terminal tab title is not updated after `wt mv` renames the worktree.

Context from the conversation:

- Repro: open a terminal in a worktree, run `wt mv old new` from another shell; the tab still shows `old`.
- The user wants the title to follow the current worktree name.

Start by exploring: read the relevant docs and code, find where the title comes from and how worktree renames are observed, and validate the repro before changing anything.

You are in worktree `fix/terminal-title-after-rename`, already created from latest origin/main. Do not create another worktree. Follow the repo workflow in CLAUDE.md through to opening the PR. Right after creating it, run `loxel --split right <pr-url>` once so the PR page opens in Loxel beside the active tab. Then run `/babysit-pr <pr-number>` to bring the PR to ready-to-merge, and do not reopen the page during its rounds.
```

The prompt is the whole handoff, the new session has none of this conversation. Include: the task in one line, every concrete detail the user gave (repro steps, constraints, decisions already made), an explicit nudge to explore and validate first, and the closing paragraph above naming the worktree, the expected deliverable, the one-time `loxel --split right <pr-url>` call and the `/babysit-pr` step. Drop the `/babysit-pr` step when the target repo has no such skill or the user wants to stop at the opened PR. State facts, not guesses: pass on file names or root causes only when the user gave them or you verified them, otherwise leave the investigation to the new session, which has the task as its sole focus and will explore it better than you. Leave out the repo conventions the target repo's CLAUDE.md already covers.

## 4. Open the terminal and start claude

Pass a single shell command line so the pipe is typed into the shell as-is:

```bash
loxel terminal --cwd <path from wt add> \
  --title fix/terminal-title-after-rename \
  'cat /tmp/quick-pr-fix-terminal-title-after-rename.md | claude'
```

`loxel terminal` returns as soon as the panel opens; it does not wait for claude. Add `--permission-mode` or other `claude` flags after `claude` when the user asks for them.

## 5. Report and stop

Tell the user the worktree path, branch, terminal title and prompt file, then stop. The spawned session owns the work; do not poll it, do not edit files in the new worktree, and do not run the task yourself.

## Why the spawned session is independent

The Loxel server spawns the terminal shell from its own environment, so nothing from this session's Bash environment (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, ...) reaches it. The new `claude` is a normal top-level session with its own transcript that the user can talk to in the terminal.

## Not covered

Reviewing or merging the resulting PR (the spawned session babysits it; this session does not); creating worktrees for anything other than a Claude-driven PR; starting `claude` outside a Loxel terminal.
