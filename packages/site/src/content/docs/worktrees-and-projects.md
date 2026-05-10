---
title: Worktrees & Projects
description: How Loxel manages repositories, bare repos, and per-context layout persistence.
order: 4
---

Loxel tracks your repositories as **projects** and surfaces each worktree as a distinct **context** — with its own layout, open files, and editor state. This page explains how to add projects, when to use bare repos, and how loxel persists state per worktree.

---

## Adding a project

There are five ways to bring a repository into loxel.

### Detect

Browse to a folder on disk and loxel will inspect it. The result is one of four classifications: bare repo, regular repo, worktree (linked to a bare repo elsewhere), or a non-repo folder. No changes are made at this step — it's read-only.

### Add

After detection, confirm to register the repo with loxel. The project is added to loxel's project list and becomes available in `Cmd+Alt+P` (Switch project). This is the path for repos you've already set up locally.

### Clone

Paste a remote URL and loxel clones it for you. Before cloning, you choose the workspace mode:

- **Single-workspace** — clones as a regular repo. One working tree, one branch checked out at a time. Good for solo projects or repos where you don't need parallel workstreams.
- **Multi-workspace** — clones as a bare repo and creates the first worktree. The right choice if you plan to run multiple agents in parallel on the same codebase.

### Init

Initialize git in an existing folder that isn't yet a repo. The same single/multi choice applies — regular or bare + first worktree.

### Convert

Convert an existing regular repo to a bare + worktrees layout. Loxel performs the conversion in-place.

Two preconditions must be met before loxel will proceed:

- No uncommitted changes (clean working tree)
- No existing `wt.yaml` in the repo

After conversion, the repo is restructured so worktrees can be created and managed through loxel's `wt` integration.

---

## Bare repos vs regular repos

Use a bare repo when you plan to run multiple parallel workstreams on the same repository. A bare repo has no working tree of its own — it holds the git object store and lets multiple worktrees coexist cleanly alongside it. Switching between tasks means switching worktrees, not stashing and checking out.

Use a regular repo for solo work or when you only ever need one working tree checked out at a time.

Loxel's `wt` integration handles branch planning and hook execution for managed worktrees. When you create a worktree through loxel, `wt` sets up the branch, runs the configured lifecycle hooks, and registers the worktree with the project.

> **Note:** You can convert a regular repo to bare at any time via the Convert path — but you'll need a clean working tree. Commit everything first.

---

## Dirty status across worktrees

The sidebar shows a live summary of uncommitted changes for every worktree in the active project. Loxel queries all worktrees and displays per-worktree counts of staged files, modified files, and untracked files.

This lets you see at a glance which worktrees have pending work — without switching to them.

---

## Per-context layout persistence

Every worktree has its own saved layout. When you switch worktrees, loxel saves the current layout and restores the one belonging to the worktree you're switching to.

**What's saved per context:**

- Full panel state: panels, groups, sizes, orientations, and which panel is active in each group
- Search filters
- Git graph column sizing and selected commits
- Expanded folders in the file tree
- Branch panel state

**How it's stored:**

Layout state is persisted server-side in SQLite (`~/.local/state/loxel/stores.db`), keyed by worktree path. Loxel maintains two key namespaces per worktree:

- **Session key** — the live state for the current window. Updated continuously as you work.
- **Canonical key** — a snapshot taken when a window is closed. Represents the last confirmed layout.

On worktree switch, loxel restores from the session key if available, then falls back to the canonical key, then to a default layout.

This means your layout survives app restarts, and multiple windows don't clobber each other's state.

---

## Switching worktrees

Use `Ctrl+Alt+→` and `Ctrl+Alt+←` to move between worktrees, or `Ctrl+Alt+1`–`9` to jump to a specific one by position. `Cmd+Alt+W` opens the worktree switcher. `Ctrl+Alt+N` creates a new worktree.

The switch is immediate: loxel saves the outgoing layout, restores the incoming one, and resubscribes the WebSocket to the new worktree's data. No server round-trip is needed for the switch itself.

---

## See also

- [Getting Started](/docs/getting-started) — first-time walkthrough for adding a project and creating your first worktree
- [Panel Layout](/docs/panel-layout) — how per-worktree layout persistence works in detail
- [Coding Agent](/docs/coding-agent) — agent sessions are scoped per worktree
- [Drafts](/docs/drafts) — draft files are also scoped per project + worktree
