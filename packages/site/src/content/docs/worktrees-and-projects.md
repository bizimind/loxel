---
title: Worktrees & Projects
description: How Loxel manages repositories, bare repos, and per-context layout persistence.
order: 4
---

Loxel tracks your repositories as **projects** and surfaces each worktree as a distinct **context** — with its own layout, open files, and editor state. This page explains how to add projects, when to use bare repos, and how loxel persists state per worktree.

---

## Adding a project

Click **Add project** in the worktree sidebar. The dialog has two tabs: **New Project** creates a new repository in a folder you choose, and **Import Existing** brings in a folder or a remote URL in one of the ways below.

When you choose multi-workspace (see [Clone](#clone)) for a new or imported repository, an extra step lets you list files to copy into each new worktree (such as `.env`) and setup commands to run in it. Loxel writes them to the repo-root `init.wt.sh` hook.

### Detect

Enter a path or browse to a folder on disk and loxel will inspect it. The result is one of four classifications: bare repo, regular repo, worktree (linked to a bare repo elsewhere), or a non-repo folder. No changes are made at this step — it's read-only.

### Add

After detection, confirm to register the repo with loxel. The project is added to loxel's project list in the worktree sidebar. This is the path for repos you've already set up locally.

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
- No existing linked worktrees

After conversion, the repo is restructured so worktrees can be created and managed through loxel's `wt` integration.

---

## Bare repos vs regular repos

Use a bare repo when you plan to run multiple parallel workstreams on the same repository. A bare repo has no working tree of its own — it holds the git object store and lets multiple worktrees coexist cleanly alongside it. Switching between tasks means switching worktrees, not stashing and checking out.

Use a regular repo for solo work or when you only ever need one working tree checked out at a time.

Loxel's configless `wt` integration handles branch planning and hook execution for managed worktrees in bare and regular repositories. When you create a worktree through loxel, `wt` sets up the branch, runs an optional repo-root `init.wt.sh` hook, and lets Git remain the source of truth.

> **Note:** You can convert a regular repo to bare at any time via the Convert path — but you'll need a clean working tree. Commit everything first.

---

## Dirty status across worktrees

Loxel tracks uncommitted changes in every worktree of the active project. In the [git graph](/docs/git#uncommitted-changes-row), each worktree with staged, modified, or untracked files gets its own uncommitted-changes row above its branch tip, with the counts.

This lets you see at a glance which worktrees have pending work — without switching to them.

---

## The worktree sidebar

The worktree sidebar lists your projects and their worktrees. Drag worktrees to reorder them. Right-click a worktree to copy its name, branch name, or absolute path, hide or show it, or remove it; on macOS the menu also has **Reveal in Finder** and **Open In** (installed terminals and editors). Hidden worktrees are left out of the collapsed rail and of the `Ctrl+Alt+1`–`0` numbering, and are dimmed in the expanded list. Removing a worktree asks for confirmation, offers to delete its branch, and warns when uncommitted or untracked files would be lost.

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

Layout state is persisted server-side in SQLite (`stores.db` in the [state directory](/docs/reference-env-files-cli-settings#file-locations)), keyed by worktree path. Loxel maintains two key namespaces per worktree:

- **Session key** — the live state for the current window. Updated continuously as you work.
- **Canonical key** — a snapshot taken when a window is closed. Represents the last confirmed layout.

On worktree switch, loxel restores from the session key if available, then falls back to the canonical key, then to a default layout.

This means your layout survives app restarts, and multiple windows don't clobber each other's state.

---

## Switching worktrees

Click a worktree in the sidebar to switch to it. Use `Ctrl+Alt+[` and `Ctrl+Alt+]` to go back and forward through the worktrees you visited (across all projects), or `Ctrl+Alt+1`–`8` to jump to one of the active project's worktrees by position (`Ctrl+Alt+9` is the last one, `Ctrl+Alt+0` the tenth; hidden worktrees are skipped). `Ctrl+Alt+N` starts a new worktree: type its name in the sidebar and press `Enter`.

The switch is immediate: loxel saves the outgoing layout, restores the incoming one, and resubscribes the WebSocket to the new worktree's data. No server round-trip is needed for the switch itself.

---

## See also

- [Getting Started](/docs/getting-started) — first-time walkthrough for adding a project and creating your first worktree
- [Panel Layout](/docs/panel-layout) — how per-worktree layout persistence works in detail
- [Coding Agent](/docs/coding-agent) — agent sessions are scoped per worktree
- [Drafts](/docs/drafts) — draft files are also scoped per project + worktree
