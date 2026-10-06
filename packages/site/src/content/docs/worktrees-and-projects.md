---
title: Worktrees & Projects
description: How Loxel manages repositories, bare repos, and per-context layout persistence.
order: 4
---

Loxel tracks your repositories as **projects** and surfaces each worktree as a distinct **context** — with its own layout, open files, and editor state. This page explains how to add projects, when to use bare repos, and how Loxel persists state per worktree.

---

## Adding a project

Click **Add project** in the worktree sidebar. The dialog has two tabs: **New Project** creates a new repository in a folder you choose, and **Import Existing** brings in a folder or a remote URL in one of the ways below.

When you choose multi-workspace (see [Clone](#clone)) for a new or imported repository, an extra step lets you list files to copy into each new worktree (such as `.env`) and setup commands to run in it. Loxel writes them to the repo-root `init.wt.sh` hook.

### Detect

Enter a path or browse to a folder on disk and Loxel will inspect it. The result is one of four classifications: bare repo, regular repo, worktree (linked to a bare repo elsewhere), or a non-repo folder. No changes are made at this step — it's read-only.

### Add

After detection, confirm to register the repo with Loxel. The project is added to Loxel's project list in the worktree sidebar. This is the path for repos you've already set up locally.

### Clone

Paste a remote URL and Loxel clones it for you. Before cloning, you choose the workspace mode:

- **Single-workspace** — clones as a regular repo. One working tree, one branch checked out at a time. Good for solo projects or repos where you don't need parallel workstreams.
- **Multi-workspace** — clones as a bare repo and creates the first worktree. The right choice if you plan to run multiple agents in parallel on the same codebase.

### Init

Initialize git in an existing folder that isn't yet a repo. The same single/multi choice applies — regular or bare + first worktree.

### Convert

Convert an existing regular repo to a bare + worktrees layout. Loxel performs the conversion in-place.

Three preconditions must be met before Loxel will proceed:

- No uncommitted changes (clean working tree)
- A checked-out branch (not a detached HEAD)
- No existing linked worktrees

After conversion, you can create and manage worktrees for the repo in Loxel.

---

## Bare repos vs regular repos

Use a bare repo when you plan to run multiple parallel workstreams on the same repository. A bare repo has no working tree of its own — it holds the git object store and lets multiple worktrees coexist cleanly alongside it. Switching between tasks means switching worktrees, not stashing and checking out.

Use a regular repo for solo work or when you only ever need one working tree checked out at a time.

Loxel creates worktrees with `wt` in both bare and regular repositories. When you create a worktree in Loxel, `wt` sets up its branch and runs the repo-root `init.wt.sh` hook if the repo has one.

> **Note:** You can convert a regular repo to bare at any time via the Convert path — but you'll need a clean working tree. Commit everything first.

---

## Uncommitted changes across worktrees

Loxel tracks uncommitted changes in every worktree of the active project. In the [commit graph](/docs/git#uncommitted-changes-row), each worktree with staged, modified, or untracked files gets its own uncommitted-changes row above its branch tip, with the counts.

This lets you see at a glance which worktrees have pending work — without switching to them.

---

## The worktree sidebar

The worktree sidebar lists your projects and their worktrees. Drag worktrees to reorder them. Right-click a worktree to copy its name, branch name, or absolute path, hide or show it, or remove it; on macOS the menu also has **Reveal in Finder** and **Open In** (installed terminals and editors). Hidden worktrees are left out of the collapsed rail and of the `Ctrl+Alt+1`–`0` numbering, and are dimmed in the expanded list. Removing a worktree asks for confirmation, offers to delete its branch, and warns when uncommitted or untracked files would be lost.

---

## Per-context layout persistence

Every worktree has its own saved layout. When you switch worktrees, Loxel saves the current layout and restores the one belonging to the worktree you're switching to.

**What's saved per context:**

- Full panel state: panels, groups, sizes, orientations, and which panel is active in each group
- Search filters
- Commit graph column sizing and selected commits
- Expanded folders in the Project Files tree
- Branch list state

**Across windows and restarts:**

Each window keeps its own layout for every worktree, saved as you work, so two windows open on the same worktree don't overwrite each other. When you close a window, its layout becomes the one a new window starts from. A worktree you have never opened starts with the default layout from **Settings > Layout**. Layouts are saved in `stores.db` in the [state directory](/docs/reference-env-files-cli-settings#file-locations), so they survive app restarts.

---

## Switching worktrees

Click a worktree in the sidebar to switch to it. Use `Ctrl+Alt+[` and `Ctrl+Alt+]` to go back and forward through the worktrees you visited (across all projects), or `Ctrl+Alt+1`–`8` to jump to one of the active project's worktrees by position (`Ctrl+Alt+9` is the last one, `Ctrl+Alt+0` the tenth; hidden worktrees are skipped). `Ctrl+Alt+N` starts a new worktree: type its name in the sidebar and press `Enter`.

The switch is immediate: Loxel saves the outgoing worktree's layout and restores the incoming one.

---

## See also

- [Getting Started](/docs/getting-started) — first-time walkthrough for adding a project and creating your first worktree
- [Panel Layout](/docs/panel-layout) — the layout zones, rearranging panels, and keyboard navigation
- [Coding Agent](/docs/coding-agent) — agent sessions are scoped per worktree
- [Drafts](/docs/drafts) — draft files are also scoped per project + worktree
