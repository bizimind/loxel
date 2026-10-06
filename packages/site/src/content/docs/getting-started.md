---
title: Getting Started
description: From a fresh install to your first change and worktree in a few minutes.
order: 3
---

This page gets you from a fresh install to your first change and worktree in a few minutes.

---

## Add your first project

Click **Add project** at the bottom of the worktree sidebar. The dialog has two tabs: **New Project** creates a new folder and repository, and **Import Existing** brings in something you already have:

- **Detect** — enter a path or browse to a folder on disk. Loxel identifies whether it's a bare repo, a regular repo, or a non-repo folder.
- **Add** — after detection, confirm to register the repo in Loxel's project list.
- **Clone** — paste a remote URL. Choose single-workspace (regular clone) or multi-workspace (bare repo + first worktree) before confirming.
- **Init** — initialize git in an existing folder that isn't yet a repo. Same single/multi choice as Clone.
- **Convert** — choose multi-workspace on a detected regular repo to turn it into a bare repo with worktrees. Requires a clean working tree, a checked-out branch, and no existing linked worktrees.

For most cases, Detect + Add is the fastest path. If you're planning to run multiple parallel workstreams on the same repo, choose the multi-workspace option during Clone or Init — it sets up a bare repo from the start. See [Worktrees & Projects](/docs/worktrees-and-projects) for the full breakdown.

---

## Panel layout overview

Loxel's interface is divided into five areas:

- **Left sidebar** — the Project Files and Changes panels (`Cmd+Shift+E`, `Cmd+Shift+C`). The worktree sidebar with your projects and worktrees sits to its left (`Ctrl+Alt+B`).
- **Center** — editors, diff views, terminals, browsers, and agent panels. This is your main workspace.
- **Right sidebar** — the Comments panel (`Ctrl+Shift+R`) and the agent Fork Tree; drag any tool panel here.
- **Bottom** — the Git panel with the commit graph (`Ctrl+Shift+G`) and the Logs panel.
- **Status bar** — active branch, upstream tracking (`↑ X ↓ Y`), and working tree counts.

Panels are fully rearrangeable by drag and drop. Use `Cmd+1`–`9` to focus a specific panel, `Ctrl+Tab` / `Ctrl+Shift+Tab` to cycle through open panels. See [Panel Layout](/docs/panel-layout) for rearranging panels and keyboard navigation.

---

## Open a file and make a change

### Open a file

Press `Cmd+P` to open Quick Open. Type any part of a file path — results filter with fuzzy matching. Press `Enter` to open the file.

To jump to a specific line, append `:line` to the filename: for example, type `app.ts:42` to land on line 42.

### Make a change

Loxel autosaves 250ms after you stop typing, with a maximum 5s delay. Press `Cmd+S` to save immediately. Format-on-save runs on explicit save by default.

### Review and commit

Open the Changes panel (`Cmd+Shift+C`) to see every changed file; double-click one (or press `Enter`) to open its diff. Loxel has no staging or commit UI, so commit from a terminal (`Cmd+T`) — or let your agent do it.

---

## Create a worktree for a new task

When you're ready to start a parallel task without touching your current working state, create a new worktree.

- Click **Add worktree** under the project in the worktree sidebar.
- Press `Ctrl+Alt+N` from anywhere in the app.

Type a name for the worktree and press `Enter`. The new worktree appears in the sidebar; click it to switch to it — it has a clean working tree, its own editor layout, and its own agent sessions.

Switch back to your previous worktree by clicking it in the sidebar, or use `Ctrl+Alt+[` / `Ctrl+Alt+]` to go back and forward through the worktrees you visited. Your layout and open files are restored exactly as you left them.

See [Worktrees & Projects](/docs/worktrees-and-projects) for bare repos, uncommitted changes across worktrees, and the worktree sidebar.
