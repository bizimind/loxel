---
title: Setting Up a New Project
description: Ways to bring a project into Loxel — new, add, clone, init, or convert.
section: "Tasks & context"
order: 5
---

Click **Add project** at the bottom of the worktree sidebar (or **Add Project** on the start screen, or in the command palette). The **New Project** tab creates a new folder and repository from scratch; the **Import Existing** tab covers the three paths below. Which path you take depends on where your code lives right now and whether you want to work on parallel tasks from the start.

---

## Choose your path

| Situation                                   | Path                     |
| ------------------------------------------- | ------------------------ |
| Repo already exists on disk                 | Add (Detect + confirm)   |
| Starting from a remote URL, solo or simple  | Clone — single-workspace |
| Starting from a remote URL, parallel agents | Clone — multi-workspace  |
| Folder of code, no git history yet          | Init                     |
| Existing regular repo, want parallel tasks  | Convert                  |

---

## Path 1 — Add an existing repo

Use this when the repo is already on disk and initialized. In **Import Existing**, enter or browse to the folder, and confirm.

Loxel detects whether the folder is a bare repo or a regular repo, and lists anything `wt doctor` would flag in its setup with a checkbox for each fix, the recommended ones checked. Detection is read-only — nothing changes until you confirm, and then only the fixes you left checked.

---

## Path 2 — Clone a remote

Use this when you're starting from a GitHub, GitLab, or other remote URL. Paste the URL and pick a workspace mode before cloning:

**Single-workspace** clones as a regular repo — standard `git clone`. One working tree, one branch at a time. The right choice for solo projects or repos where you won't run multiple agents in parallel.

**Multi-workspace** clones as a bare repo, fetches origin's branches as `origin/*` so new worktrees start from its default branch, and checks that branch out as the first worktree, as `wt init <url>` does. Optional setup choices are written to a repo-root `init.wt.sh` lifecycle hook, which runs in [trusted](/docs/repository-trust) repositories; for a new clone, Loxel asks before running it. Choose this if you plan to run parallel tasks from day one. You can always convert later, but starting bare is cleaner.

> **Tip:** The dialog defaults to multi-workspace for URLs, new projects, and folders without git, and to single-workspace for repos already on disk. If you're unsure, single-workspace is the simpler start — you can convert to bare later, as long as you have a clean working tree.

---

## Path 3 — Init or convert

### No git history yet

If you have a folder of code with no git history, use **Init**. The same single/multi workspace choice applies. Single-workspace runs `git init` and registers the project. Multi-workspace on a folder with files also commits everything as "Initial commit", converts the repo to bare, and creates a `main` worktree.

### Existing regular repo, want to go multi-workspace

Choose multi-workspace on a detected regular repo to **Convert** it into a bare + worktrees layout. Three preconditions:

- Clean working tree (no uncommitted changes)
- A checked-out branch (not a detached HEAD)
- No existing linked worktrees

Commit everything first, then convert. Loxel handles the restructuring in-place.

---

## Single-workspace vs multi-workspace

The choice comes down to one question: do you need multiple worktrees to coexist on the same repo?

A **regular repo** has one working tree. Switching tasks means checking out a different branch — disturbing your current state.

A **bare repo** has no working tree of its own. Each worktree is an independent checkout in its own directory. You switch tasks by switching worktrees — no checkout conflicts, and each worktree has its own layout and terminals in Loxel.

If you're running agents on several tasks in parallel, bare is the right structure. See [Worktrees & Tasks](/docs/worktrees-and-tasks) for the full mechanics.

---

## Next steps

- [Getting Started](/docs/getting-started) — panel tour, your first change, and your first task with an agent
- [Working on Parallel Tasks](/docs/parallel-tasks) — running agents on parallel tasks
- [Running Coding Agents](/docs/coding-agents) — running your coding agents in Loxel
