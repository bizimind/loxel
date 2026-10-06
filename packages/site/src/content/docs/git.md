---
title: Git
description: Commit graph, Changes panel, branch operations, cherry-pick, revert, and reset.
order: 6
---

Loxel's git tooling is split across two panels that work together: the **Git panel**, with the interactive **commit graph** and the **branch list** (branch operations), and the **Changes panel** (working tree and commit diffs). Together they cover everything from discarding a file's changes to cherry-picking a range of commits.

Open the Git panel with `Ctrl+Shift+G`. The Changes panel is `Cmd+Shift+C`.

---

## Commit graph

The graph shows the full commit history for the active worktree, with branch and tag labels on each ref.

### Selecting commits

Click a commit to select it. The Changes panel updates immediately to show what changed in that commit.

- `Cmd`-click (macOS) or `Ctrl`-click (Linux) — add or remove individual commits from the selection
- `Shift`-click — select a contiguous range from the last-clicked commit to the one you shift-clicked

Multi-select is useful for cherry-picking or reverting a group of commits, and for reviewing the combined diff across a range.

### Uncommitted changes row

A row sits just above a branch tip whenever the worktree that has it checked out has staged, modified, or untracked files — one row for each such worktree of the project. It shows:

- An edit icon indicating it represents work in progress
- An italic summary: "X staged, Y modified, Z untracked"

This row has no context menu and cannot be checked out. Select it to see the working tree diff in the Changes panel, the same as selecting no commit at all.

### Filtering the graph

Use the filter controls in the graph toolbar to narrow what's displayed.

| Filter             | Options                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| **Branch**         | Multi-select dropdown — show commits reachable from any selected branch |
| **Author**         | Multi-select — limit to commits by specific authors                     |
| **Date**           | "All time", "Today", "Last 7 days", "Last 30 days"                      |
| **Display preset** | "All branches", "Current + main", "Recent N days"                       |

Branch and author filters are both multi-select — you can pin several branches or authors at once.

### Context menu operations

Right-click a selected commit (or range) for available operations:

| Operation                   | Single commit | Multi-select |
| --------------------------- | ------------- | ------------ |
| Checkout                    | Yes           | No           |
| Create branch               | Yes           | No           |
| Cherry-pick                 | Yes           | Yes          |
| Revert                      | Yes           | Yes          |
| Reset (soft / mixed / hard) | Yes           | No           |
| Copy commit hash            | Yes           | No           |

**Reset always shows a confirmation dialog** before executing. See [Reset](#reset) below for the three modes.

---

## Changes panel

The Changes panel shows different content depending on your selection in the commit graph.

**No commit selected:** shows your local changes — every file that differs from HEAD, staged or not, in one tree with added/removed line counts.

**One or more commits selected:** shows the diff for that commit or range. A dropdown in the panel header lets you switch between:

- **Local changes** — your working tree diff
- **All branch changes** — all changes from the branch tip back to the merge base with the repository's default branch (for example `origin/main`)
- A specific commit or range from the current selection

In either case, click a file to show its diff in the diff viewer, or double-click it (or press `Enter`) to also bring the diff viewer to the front. The arrow keys and typing a name move the keyboard cursor without changing the diff. The file being shown stays highlighted, also when you step through files with the diff viewer's previous/next buttons.

---

## Changes panel actions

Right-click a file or folder in the Changes panel for:

- **Open Diff** and **Open File**
- **Reveal in Project Explorer**
- **Copy Name**, **Copy Relative Path**, and **Copy Absolute Path**
- **Reveal in Finder** and **Open In** (macOS)
- **Discard Changes** — revert the file, or every changed file under the folder, to HEAD; new files are deleted and renames are undone. Shown while the panel lists local changes, and always asks for confirmation first.

Loxel has no staging or commit UI; stage and commit from a terminal (or let your agent do it).

---

## Branch operations

The branch list in the Git panel shows all local (and optionally remote) branches. Operations are available via the context menu on any branch row, or via the buttons in the panel header.

| Operation    | How to trigger                         | Notes                                                             |
| ------------ | -------------------------------------- | ----------------------------------------------------------------- |
| **Create**   | Button in panel header or context menu | Enter a name; the branch is created from the current HEAD         |
| **Checkout** | Context menu                           | Disabled when the branch is already current                       |
| **Rename**   | Context menu                           | Shows a prompt dialog with the current name pre-filled            |
| **Delete**   | Context menu                           | Includes a force-delete option for branches with unmerged changes |
| **Favorite** | Star icon on the branch row            | Favorites are pinned to the top of the branch list                |

**Upstream tracking** is displayed in the status bar as `↑ X ↓ Y` — commits ahead of upstream on the left, commits behind on the right. The current branch name appears next to it.

---

## Reset

Reset moves the current branch pointer to a selected commit. There are three modes:

| Mode      | Label         | Effect on staged and working tree changes              |
| --------- | ------------- | ------------------------------------------------------ |
| **Soft**  | "Keep staged" | Staged changes remain staged; working tree unchanged   |
| **Mixed** | "Unstage"     | Staged changes become unstaged; working tree unchanged |
| **Hard**  | "Discard all" | Both staged and unstaged changes are discarded         |

> **Note:** A confirmation dialog always appears before a reset executes, regardless of mode. Hard reset is irreversible — Loxel does not offer an undo for it.

---

## Cherry-pick and revert

Both cherry-pick and revert work on single or multi-select.

**Cherry-pick** applies the selected commits to the current branch in order. Select the commits in the graph, right-click, and choose Cherry-pick.

**Revert** creates new commits that invert the selected commits. Reverting a range creates one revert commit per selected commit.

---

## Keyboard shortcuts

Git operations in Loxel are mouse-driven — there are no dedicated keyboard shortcuts for individual git actions. Use the panel shortcuts to keep your hands on the keyboard while navigating:

| Action             | Shortcut       |
| ------------------ | -------------- |
| Open Git panel     | `Ctrl+Shift+G` |
| Open Changes panel | `Cmd+Shift+C`  |

---

Once you have a diff open, see [Code Review](/docs/code-review) to leave anchored comments on the changes.

---

## See also

- [Diff Viewer](/docs/diff-viewer) — full reference for split/unified modes, synchronized scrolling, and intra-line highlights
- [Code Review](/docs/code-review) — starting a review session and leaving anchored comments after viewing a diff
