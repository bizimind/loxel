---
title: Getting Started
description: From a fresh install to your first task with an agent working in it, in a few minutes.
section: "Start here"
order: 2
---

This page gets you from a fresh install to your first task, with an agent working in it, in a few minutes.

---

## Add your first project

Click **Add project** at the bottom of the worktree sidebar (or **Add Project** on the start screen). The dialog has two tabs: **New Project** creates a new folder and repository, and **Import Existing** brings in something you already have:

- **Detect** — enter a path or browse to a folder on disk. Loxel identifies whether it's a bare repo, a regular repo, or a non-repo folder.
- **Add** — after detection, confirm to register the repo in Loxel's project list, along with any setup fixes you choose from what `wt doctor` finds.
- **Clone** — paste a remote URL. Choose single-workspace (regular clone) or multi-workspace (bare repo + first worktree) before confirming.
- **Init** — initialize git in an existing folder that isn't yet a repo. Same single/multi choice as Clone.
- **Convert** — choose multi-workspace on a detected regular repo to turn it into a bare repo with worktrees. Requires a clean working tree, a checked-out branch, and no existing linked worktrees.

For most cases, Detect + Add is the fastest path. If you're planning to work on several tasks in parallel on the same repo, choose the multi-workspace option during Clone or Init — it sets up a bare repo from the start. See [Worktrees & Tasks](/docs/worktrees-and-tasks) for the full breakdown.

---

## Panel layout overview

Loxel's interface is divided into five areas:

- **Left sidebar** — the Project Files and Changes panels (`Cmd+Shift+E`, `Cmd+Shift+C`). The worktree sidebar with your projects and worktrees sits to its left (`Ctrl+Alt+B`).
- **Center** — editors, diff views, terminals, and browsers. This is your main workspace.
- **Right sidebar** — the Comments panel (`Ctrl+Shift+R`); drag any tool panel here.
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

Every task gets its own worktree: a separate checkout and branch, with its own editors, terminals and layout. When you're ready to start one without touching what you have open, create a worktree.

- Click **Add worktree** under the project in the worktree sidebar.
- Press `Ctrl+Alt+N` from anywhere in the app.

Type a name for the worktree and press `Enter`. The new worktree appears in the sidebar; click it to switch to it — it has a clean working tree, its own editor layout, and its own terminals.

Switch back to your previous task by clicking its worktree in the sidebar, or use `Ctrl+Alt+[` / `Ctrl+Alt+]` to go back and forward through the worktrees you visited. Your layout and open files are restored exactly as you left them.

See [Worktrees & Tasks](/docs/worktrees-and-tasks) for bare repos, uncommitted changes across worktrees, and the worktree sidebar.

---

## Start your agent

Now give the task to an agent. Switch to the new worktree and press `Cmd+T`: the terminal opens in the task's worktree. Run Claude Code, Codex, or any other agent that works in a terminal, on your own subscription as usual:

```bash
claude
```

Tell it what to do, and go back to your other task while it works. Its terminal keeps running, and if your agent sends terminal notifications, a dot on the worktree in the sidebar tells you when it needs you.

Then teach your agent about Loxel. The `loxel` skill shows it how to open files for you to review, show its dev server or PR in a browser panel, and start commands in terminals of their own. For Claude Code, install it with:

```bash
mkdir -p ~/.claude/skills/loxel
curl -fsSL https://raw.githubusercontent.com/bizimind/loxel/main/skills/loxel/SKILL.md -o ~/.claude/skills/loxel/SKILL.md
```

See [Running Coding Agents](/docs/coding-agents) for other agents, notifications and multi-line prompts, and [Working on Parallel Tasks](/docs/parallel-tasks) for the rest of the loop: reviewing what the agent did and committing it.
