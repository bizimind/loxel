---
title: "Guide: Parallel Workstreams"
description: Running multiple agents on parallel worktrees from start to commit.
order: 16
---

A feature request lands. You want an agent on it immediately, but you're not willing to drop what you're doing. Here's how that plays out in loxel.

---

## Create a worktree for the task

Press `Ctrl+Alt+N` to create a new worktree. Give it a name that matches the branch — something like `feat/user-invites`. Loxel creates the worktree, sets up the branch via the `wt` integration, and switches your context to it.

Your previous worktree's layout is saved automatically. It's waiting exactly as you left it.

---

## Hand off the task

With the new worktree active, you have two options depending on how you prefer to work.

**Coding agent:** Press `Cmd+Shift+A` to open a new agent panel. Describe the task. The agent runs in a dedicated timeline scoped to this worktree — tool calls, plan steps, and reasoning blocks all visible in sequence. See [Coding Agent](/docs/coding-agent) for setup and configuration.

**TUI agent:** Press `Cmd+T` to open a terminal. Start Claude Code, Codex, or whatever agent you use. The terminal already has `LOXEL_WORKTREE` set, so the agent picks up the right working directory immediately. See [Terminals](/docs/terminals) for details.

Either way, once the agent is running you don't need to stay here.

---

## Switch back to your previous context

Press `Ctrl+Alt+←` to go back to your main worktree. The layout snaps back — same open files, same panel arrangement, same cursor positions. The agent keeps running in the background.

You are unblocked. Do your other work.

---

## Return when the agent is done

The sidebar shows a live dirty-status count for every worktree in the project. When you see changes accumulating in the task worktree, or when you want to check in, press `Ctrl+Alt+→` to switch back.

If you used the built-in agent, the full event history is waiting for you — buffered and replayed from the start of the session. Scroll back through the timeline to see what the agent did and why.

If you used a TUI agent, switch to its terminal tab to check the output.

---

## Review the diff

Open the Changes panel (`Cmd+Shift+C`) to see what the agent produced. Staged and unstaged changes are listed by file. Click a file to open it in the diff viewer — side-by-side by default, with synchronized scrolling and gutter connectors between the two sides.

If you want to stage individual hunks rather than whole files, switch the diff to unified view and stage from there. See [Diff Viewer](/docs/diff-viewer) for details on modes and hunk staging.

---

## Leave comments

Open the Comments panel, create a review session (click **Reviews** in the header → new review icon → name → `Enter`), and go through the diff file by file. Select any span of code that raises a question and click **Add comment** in the gutter. Comments are anchored to content, not line numbers — they follow the code if the agent rewrites it. Leave intent-based questions ("is this the right abstraction boundary?") rather than line-level corrections. See [Code Review](/docs/code-review) for the full anchor system reference.

---

## Iterate if needed

Send a follow-up message in the agent session — in the coding agent panel or the terminal. Comments track through the rewrite. When the agent finishes, outdated comments show a mini-diff of the original under **"Original code at time of comment"** — use that to verify whether your concern was addressed.

---

## Stage, commit, done

Once you are satisfied, stage the changes and commit. Other worktrees are unaffected throughout.
