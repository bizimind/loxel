---
title: Working on Parallel Tasks
description: Hand a task to an agent in its own worktree, keep working on something else, then review and commit what it did.
section: "Tasks & context"
order: 2
# Sections that moved; old links to them keep working.
movedAnchors:
  switch-back-to-your-previous-context: /docs/parallel-tasks#go-back-to-what-you-were-doing
  return-when-the-agent-is-done: /docs/parallel-tasks#come-back-when-the-agent-is-done
---

A feature request lands. You want an agent on it now, but you're in the middle of something and not about to drop it. Here's how that plays out in Loxel.

---

## Create a worktree for the task

Press `Ctrl+Alt+N` to open the New worktree dialog. Type a name — something like `user-invites` — and press `Enter`. Loxel creates the worktree and its branch with `wt`, and it appears in the sidebar. Click it to switch to the new task.

The task you left is saved as it was: same files open, same terminals, same layout.

---

## Hand off the task

With the new task active, press `Cmd+T` to open a terminal. It starts in the task's worktree, so start Claude Code, Codex, or whatever agent you use, and tell it what to build. See [Running Coding Agents](/docs/coding-agents) for notifications and the `loxel` skill.

Once the agent is running you don't need to stay here.

---

## Go back to what you were doing

Press `Ctrl+Alt+[` to go back to the task you came from. The layout snaps back — same open files, same panel arrangement. The agent keeps working in the background.

You're unblocked. Get on with your day.

---

## Come back when the agent is done

A dot on a worktree in the sidebar means one of its terminals raised a notification, and the commit graph shows an uncommitted-changes row for each worktree with pending changes. When you see work piling up in the task, or just want to check in, press `Ctrl+Alt+]` to switch back.

Switch to the agent's terminal tab to read what it said.

---

## Review the diff

Open the Changes panel (`Cmd+Shift+C`) to see what the agent produced: every changed file, with added and removed line counts. Double-click a file to open it in the diff viewer — side-by-side by default, with synchronized scrolling, gutter connectors between the two sides, and the changed characters highlighted within each line. See [Diff Viewer](/docs/diff-viewer) for details on modes.

---

## Leave comments

Open the Comments panel, create a review session (click **Reviews** in the header → new review icon → name → `Enter`), and go through the diff file by file. Select any span of code that raises a question and click **Add comment** in the gutter. Comments are anchored to content, not line numbers — they follow the code if the agent rewrites it. Leave intent-based questions ("is this the right abstraction boundary?") rather than line-level corrections. See [Code Review](/docs/code-review) for the full anchor system reference.

---

## Iterate if needed

Send a follow-up message to the agent in its terminal. Comments track through the rewrite. When the agent finishes, outdated comments keep the original lines under **"Original code at time of comment"** in the Comments panel — compare them with the new code to verify whether your concern was addressed.

---

## Commit, done

Once you are satisfied, commit from a terminal in the task (or ask the agent to). Your other tasks never noticed.
