---
title: Getting Started
description: From a fresh install to your first commit and worktree in a few minutes.
order: 3
---

This page gets you from a fresh install to your first commit and worktree in a few minutes.

---

## Add your first project

Open the Projects panel and click **Add project**. There are five paths:

1. **Detect** — browse to a folder on disk. Loxel identifies whether it's a bare repo, a regular repo, an existing worktree, or a non-repo folder.
2. **Add** — after detection, confirm to register the repo in loxel's project list.
3. **Clone** — paste a remote URL. Choose single-workspace (regular clone) or multi-workspace (bare repo + first worktree) before confirming.
4. **Init** — initialize git in an existing folder that isn't yet a repo. Same single/multi choice as Clone.
5. **Convert** — turn an existing regular repo into a bare repo with worktrees. Requires no uncommitted changes and no existing `wt.yaml`.

For most cases, Detect + Add is the fastest path. If you're planning to run multiple parallel workstreams on the same repo, choose the multi-workspace option during Clone or Init — it sets up a bare repo from the start. See [Worktrees & Projects](/docs/worktrees-and-projects) for the full breakdown.

---

## Panel layout overview

Loxel's interface is divided into five areas:

- **Left sidebar** — file explorer, changes, git graph, comments, and worktree list. Toggle each with `Cmd+Shift+E`, `Cmd+Shift+C`, `Ctrl+Shift+G`, and `Ctrl+Shift+R`.
- **Center** — editors, diff views, terminals, and agent panels. This is your main workspace.
- **Right sidebar** — additional panels docked to the right (optional; drag any panel here).
- **Bottom** — secondary panels, often terminals or output views.
- **Status bar** — active branch, upstream tracking (`↑ X ↓ Y`), and context info.

Panels are fully rearrangeable by drag and drop. Use `Cmd+1`–`9` to focus a specific panel, `Ctrl+Tab` / `Ctrl+Shift+Tab` to cycle through open panels. See [Panel Layout](/docs/panel-layout) for details on persistence and keyboard navigation.

---

## Open a file, make a change, and commit

### Open a file

Press `Cmd+P` to open Quick Open. Type any part of a file path — results filter with fuzzy matching. Press `Enter` to open the file.

To jump to a specific line, append `:line` to the filename: for example, type `app.ts:42` to land on line 42.

### Make a change

Loxel autosaves 250ms after you stop typing, with a maximum 5s delay. Press `Cmd+S` to save immediately. Format-on-save runs on explicit save by default.

### Stage your changes

- **File-level**: in the Changes panel (`Cmd+Shift+C`), right-click any file and choose **Stage**.
- **Hunk-level**: open the file's diff in unified view. Each hunk has a **Stage hunk** button — use this to stage only part of a file's changes.

### Commit

In the Changes panel, type a commit message in the input at the top and press `Enter` or click **Commit**. Loxel commits all staged changes to the current worktree's branch.

---

## Create a worktree for a new task

When you're ready to start a parallel task without touching your current working state, create a new worktree.

- Click the **+** button in the worktrees sidebar.
- Press `Ctrl+Alt+N` from anywhere in the app.

Loxel prompts you for a branch name. After creation, the new worktree appears in the sidebar and becomes the active context — with a clean working tree, its own editor layout, and its own agent sessions.

Switch back to your previous worktree by clicking it in the sidebar, or use `Ctrl+Alt+←` / `Ctrl+Alt+→` to cycle. Your layout and open files are restored exactly as you left them.

See [Worktrees & Projects](/docs/worktrees-and-projects) for branch planning, dirty-status tracking, and the `wt` integration.
