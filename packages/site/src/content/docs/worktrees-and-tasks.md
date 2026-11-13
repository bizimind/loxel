---
title: Worktrees & Tasks
description: How a task maps to a worktree, adding projects, bare repos, the worktree sidebar, and the layout each task keeps.
section: "Tasks & context"
order: 1
# Sections that moved; old links to them keep working.
movedAnchors:
  per-context-layout-persistence: /docs/worktrees-and-tasks#per-task-layouts
---

Loxel tracks your repositories as **projects**, and every task you work on is a **worktree** of one: its own checkout and branch on disk, plus its own layout, open files, terminals and browser tabs in Loxel. This page explains how to add projects, when to use bare repos, how to manage worktrees in the sidebar, and what each task keeps.

---

## Adding a project

Click **Add project** in the worktree sidebar, **Add Project** on the start screen when no project is open, or run **Add Project** from the command palette. Each opens the same dialog, with two tabs: **New Project** creates a new repository in a folder you choose, and **Import Existing** brings in a folder or a remote URL in one of the ways below. Once the project is added, Loxel switches to it.

When you choose multi-workspace (see [Clone](#clone)) for a new or imported repository, an extra step lets you list files to copy into each new worktree (such as `.env`) and setup commands to run in it. Loxel writes them to the repo-root `init.wt.sh` hook. Hooks run in [trusted](/docs/repository-trust) repositories. A new project starts trusted, so its hook runs right away; for a repository you import, Loxel asks before running it in the first worktree.

Loxel pre-fills both lists from what the repository contains: `.env` files, direnv and mise configuration, the install command for a JavaScript lockfile (Bun, pnpm, npm, Yarn), and one command that creates the worktree's Python environment:

| Project has                               | Suggested command                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| `uv.lock`                                 | `uv sync`                                                                                   |
| `poetry.lock`                             | `poetry install`                                                                            |
| `pdm.lock`                                | `pdm install`                                                                               |
| `Pipfile.lock`                            | `pipenv install --dev`                                                                      |
| `pyproject.toml` with a `[tool.uv]` table | `uv sync`                                                                                   |
| `requirements*.txt` files                 | `uv venv && uv pip install -r ...`, or with `python3 -m venv .venv` when uv isn't installed |

Every worktree gets its own Python environment, since a virtual environment can't be shared between checkouts. Once it exists, the [Python language servers](/docs/languages/python#python-environment) and new terminals in that worktree use it.

A .NET repository also gets `dotnet restore` when a solution or project sits at its root, and `dotnet tool restore` when it has a local tool manifest, since each worktree restores its own dependencies.

### Detect

Enter a path or browse to a folder on disk and Loxel will inspect it. The result is one of three classifications: bare repo, regular repo, or a non-repo folder. No changes are made at this step — it's read-only.

### Add

After detection, confirm to register the repo with Loxel. The project is added to Loxel's project list in the worktree sidebar. This is the path for repos you've already set up locally.

For a repository Loxel adds as it is, the dialog also shows what `wt doctor` finds in its setup, such as a bare clone that fetches no `origin/*` branches, no worktree for the default branch, or worktrees git lost track of. Each fix is a checkbox with the exact commands it runs, and the ones `wt init` recommends start checked. Loxel applies the checked fixes when you add the project; if one fails, for example because origin can't be reached, the project is still added and a notification says which fix failed. A worktree a fix creates runs the repository's `init.wt.sh` only once you [trust](/docs/repository-trust) the repository.

### Clone

Paste a remote URL and Loxel clones it for you. Before cloning, you choose the workspace mode:

- **Single-workspace** — clones as a regular repo. One working tree, one branch checked out at a time. Good for solo projects or repos where you don't need parallel tasks.
- **Multi-workspace** — clones as a bare repo set up the way `wt init <url>` does it: origin's branches fetched as `origin/*` and its default branch recorded, so new worktrees start from it, and that branch checked out as the first worktree. The right choice if you plan to run multiple agents in parallel on the same codebase.

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

Use a bare repo when you plan to work on several tasks in parallel on the same repository. A bare repo has no working tree of its own — it holds the git object store and lets multiple worktrees coexist cleanly alongside it. Switching between tasks means switching worktrees, not stashing and checking out.

Use a regular repo for solo work or when you only ever need one working tree checked out at a time.

Loxel creates worktrees with `wt` in both bare and regular repositories. When you create a worktree in Loxel, `wt` sets up its branch and runs the repo-root `init.wt.sh` hook if the repo has one, and removing a worktree runs `clean.wt.sh` first. Hooks run in trusted repositories: in one you haven't [trusted](/docs/repository-trust), Loxel says which hook won't run and offers to trust the repository and run it.

> **Note:** You can convert a regular repo to bare at any time via the Convert path — but you'll need a clean working tree. Commit everything first.

---

## Uncommitted changes across worktrees

Loxel tracks uncommitted changes in every worktree of the active project. In the [commit graph](/docs/git#uncommitted-changes-row), each worktree with staged, modified, or untracked files gets its own uncommitted-changes row above its branch tip, with the counts.

This lets you see at a glance which worktrees have pending work — without switching to them.

---

## The worktree sidebar

The worktree sidebar lists your projects and their worktrees, with paths in your home folder shown as `~/…` (hover for the full path). Drag worktrees to reorder them. Right-click a worktree to copy its name, branch name, or absolute path, archive it, or remove it; on macOS the menu also has **Reveal in Finder** and **Open In** (installed terminals and editors). Removing a worktree asks for confirmation, offers to delete its branch, and warns when uncommitted or untracked files would be lost. It also ends the worktree's terminals and forgets its layout and settings, so a new worktree at the same path starts fresh. The same happens when you remove it outside Loxel, with `wt rm` or `git worktree remove`, even from one of those terminals. The removal finishes, and terminals of a worktree removed outside Loxel end about a minute later. Renaming with `wt mv` is not a removal, and the programs in its terminals keep running. The left and right arrow keys fold and unfold projects and worktrees with nested ones, or move to the parent or the first nested worktree, as in the project explorer.

### Archive

Archive worktrees you are not working on to keep the list short: right-click and choose **Archive worktree**, hover a row and click its archive button, or drag it onto the project's **Archive** group at the bottom of its worktrees. Archiving moves a worktree together with the worktrees nested below it. The Archive group starts closed and shows how many worktrees it holds; open it to switch to an archived worktree, and choose **Unarchive worktree** or drag one back into the list to bring it back. Dragging a worktree onto **Add worktree** puts it at the end of the list. Archived worktrees are skipped by the `Ctrl+Alt+1`–`0` numbering.

### Nesting worktrees

Worktrees can be nested under the worktree they belong to, such as the worktrees a coding agent starts for parts of its task. A worktree and the worktrees nested below it form a group, indented under the parent. The knob on the parent icon's bottom-left corner folds the group away and then shows how many worktrees it holds; double-clicking the parent does the same, and Loxel remembers which worktrees you folded. A line runs down from the knob along the group: a faint bracket in the parent's color on the collapsed rail, a tree line in the expanded sidebar. A folded worktree shows its nested worktrees' notifications, and a dashed outline when the worktree you are in is folded inside it. The collapsed rail shows up to three levels of nesting and widens to fit the deepest level it shows; deeper worktrees are counted on their ancestor's knob, which expands the sidebar to show them. Nested worktrees are listed oldest first.

With nesting on, the worktree menu has:

- **New child worktree**: opens the New worktree dialog for a worktree whose branch starts at the parent's current commit, nested under it.
- **Edit title**: changes the title the sidebar shows for the worktree (its name until you give it one). Setting it back to the worktree name removes the title. The worktree's directory and branch keep their names.
- **Move to top level**: un-nests a nested worktree.

Drag a worktree onto the middle of another worktree's row to nest it there, or onto the top or bottom edge of a row to place it before or after that row, at that row's level: dragging a nested worktree next to a top-level one moves it to the top level. Dragging works the same on the collapsed rail. Removing a worktree that has nested worktrees asks whether to keep them, nested under the removed worktree's own parent (or at the top level), or to remove them too.

Nesting and titles are stored with each worktree in the repository's git config, so tools such as `wt` see them too: `wt add <name> --meta loxel-parent-wt=<wt-id>` creates a worktree nested under the one with that id (`wt meta get` shows a worktree's `wt-id`). This needs per-worktree git config. Loxel turns it on for every multi-workspace project you create, clone, initialize or convert, and the add dialog offers it, checked, for a repository you import. Repositories you set up some other way don't have it by default: until it is on, the sidebar is flat and the worktree and project menus offer **Enable worktree nesting**, which shows what it changes in the repository and turns it on (the same as `wt init --worktree-metadata on`) once you confirm.

---

## Per-task layouts

Every task has its own saved layout. When you switch tasks, Loxel saves the current layout and restores the one belonging to the task you're switching to.

**What's saved per task:**

- Full panel state: panels, groups, sizes, orientations, and which panel is active in each group
- Search filters
- Commit graph column sizing and selected commits
- Expanded folders in the Project Files tree
- Branch list state

**Across windows and restarts:**

Each window keeps its own layout for every worktree, saved as you work, so two windows open on the same worktree don't overwrite each other. When you close a window, its layout becomes the one a new window starts from. A worktree you have never opened starts with the default layout from **Settings > Layout**. Layouts are saved in `stores.db` in the [state directory](/docs/reference-env-files-cli-settings#file-locations), so they survive app restarts.

---

## Switching worktrees

Click a worktree in the sidebar to switch to it. Use `Ctrl+Alt+[` and `Ctrl+Alt+]` to go back and forward through the worktrees you visited (across all projects), or `Ctrl+Alt+1`–`8` to jump to one of the active project's worktrees by its position in the sidebar, counting nested worktrees except those you folded away (`Ctrl+Alt+9` is the last one, `Ctrl+Alt+0` the tenth; archived worktrees are skipped). `Ctrl+Alt+N`, or **Add worktree** at the end of a project's worktrees, opens the New worktree dialog. Type a title and the name (the worktree's directory and branch) follows it, in lowercase with dashes; edit the name directly to set it yourself. The title is shown in the sidebar instead of the name, and needs worktree nesting on (see above); without it the dialog asks only for a name. If the branch already exists, the dialog asks whether to use it or recreate it. Once you click **Create worktree**, the dialog closes and the new worktree appears in the sidebar with a spinner while it is created, which includes running the repo's `init.wt.sh` hook; it becomes clickable when it is ready. If creating it fails, a message says why.

The switch is immediate: Loxel saves the outgoing worktree's layout and restores the incoming one.

---

## See also

- [Getting Started](/docs/getting-started) — first-time walkthrough for adding a project and starting your first task
- [Working on Parallel Tasks](/docs/parallel-tasks) — a task from creating its worktree to committing the result
- [Panel Layout](/docs/panel-layout) — the layout zones, rearranging panels, and keyboard navigation
- [Running Coding Agents](/docs/coding-agents) — running a coding agent in each task
- [Drafts](/docs/drafts) — draft files are also scoped per project + worktree
