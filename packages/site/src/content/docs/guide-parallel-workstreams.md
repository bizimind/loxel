---
title: "Guide: Parallel Workstreams"
description: Running multiple agents on parallel worktrees from start to commit.
order: 16
---

A feature request lands. You want an agent on it immediately, but you're not willing to drop what you're doing. Here's how that plays out in loxel.

---

## Create a worktree for the task

Press `Ctrl+Alt+N` to create a new worktree. Type a name — something like `user-invites` — and press `Enter`. Loxel creates the worktree and sets up the branch via the `wt` integration. Click the new worktree in the sidebar to switch to it.

Your previous worktree's layout is saved automatically. It's waiting exactly as you left it.

---

## Hand off the task

With the new worktree active, you have two options depending on how you prefer to work.

**Coding agent:** Press `Cmd+Shift+A` to open a new agent panel. Describe the task. The agent runs in a dedicated timeline scoped to this worktree — tool calls, plan steps, and reasoning blocks all visible in sequence. See [Coding Agent](/docs/coding-agent) for setup and configuration.

**TUI agent:** Press `Cmd+T` to open a terminal. Start Claude Code, Codex, or whatever agent you use. The terminal already has `LOXEL_WORKTREE` set, so the agent picks up the right working directory immediately. See [Terminals](/docs/terminals) for details.

Either way, once the agent is running you don't need to stay here.

---

## Switch back to your previous context

Press `Ctrl+Alt+[` to go back to your main worktree. The layout snaps back — same open files, same panel arrangement. The agent keeps running in the background.

You are unblocked. Do your other work.

---

## Return when the agent is done

A dot on a worktree in the sidebar means one of its terminals raised a notification, and the git graph shows an uncommitted-changes row for each worktree with pending changes. When you see work accumulating in the task worktree, or when you want to check in, press `Ctrl+Alt+]` to switch back.

If you used the built-in agent, the event history is waiting for you — buffered (up to 5,000 events) and replayed. Scroll back through the timeline to see what the agent did and why.

If you used a TUI agent, switch to its terminal tab to check the output.

---

## Review the diff

Open the Changes panel (`Cmd+Shift+C`) to see what the agent produced: every changed file, with added and removed line counts. Double-click a file to open it in the diff viewer — side-by-side by default, with synchronized scrolling, gutter connectors between the two sides, and the changed characters highlighted within each line. See [Diff Viewer](/docs/diff-viewer) for details on modes.

---

## Leave comments

Open the Comments panel, create a review session (click **Reviews** in the header → new review icon → name → `Enter`), and go through the diff file by file. Select any span of code that raises a question and click **Add comment** in the gutter. Comments are anchored to content, not line numbers — they follow the code if the agent rewrites it. Leave intent-based questions ("is this the right abstraction boundary?") rather than line-level corrections. See [Code Review](/docs/code-review) for the full anchor system reference.

---

## Iterate if needed

Send a follow-up message in the agent session — in the coding agent panel or the terminal. Comments track through the rewrite. When the agent finishes, outdated comments keep the original lines under **"Original code at time of comment"** in the Comments panel — compare them with the new code to verify whether your concern was addressed.

---

## Commit, done

Once you are satisfied, commit from a terminal in the task worktree (or ask the agent to). Other worktrees are unaffected throughout.
