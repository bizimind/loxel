---
title: Panel Layout
description: The five fixed zones, panel rearrangement, keyboard navigation, and per-context persistence.
order: 5
---

Loxel's workspace is divided into five fixed zones. Within those zones, panels are free-form: you can move them between groups, split areas horizontally or vertically, and resize everything. The layout for each worktree is saved automatically and restored when you switch back.

---

## The five zones

### Left sidebar

The left sidebar holds dockable panels for navigating your project:

- **Project files** — the file tree for the active worktree
- **Changes** — staged, unstaged, and untracked files; becomes a commit diff viewer when a commit is selected in the git graph
- **Branches** — branch list with upstream tracking, create/rename/delete/checkout
- **Comments** — code review sessions and comment threads
- **Projects** — all projects registered with loxel
- **Worktrees** — worktrees for the active project with dirty status indicators

Toggle any of these panels without touching the mouse:

| Panel         | Shortcut       |
| ------------- | -------------- |
| Project files | `Cmd+Shift+E`  |
| Changes       | `Cmd+Shift+C`  |
| Git graph     | `Ctrl+Shift+G` |
| Comments      | `Ctrl+Shift+R` |
| Projects      | `Cmd+Shift+B`  |
| Worktrees     | `Cmd+Alt+B`    |

### Center

The center area is the main content area. Every editor and interactive view opens here by default:

- **Diff viewer** — side-by-side or unified diff for commits and working tree changes
- **Code editor** — Monaco-based editor with LSP, format on save, and autosave
- **Markdown editor** — live preview markdown editing for repo files and drafts
- **Excalidraw** — whiteboard and diagram editor
- **Coding agent** — the built-in agent's timeline UI
- **Standalone terminals** — full-featured terminal tabs

### Right sidebar

The right sidebar accepts any dockable panel. Use it to keep a secondary view alongside your main editor — for example, a terminal or the changes panel while reviewing code.

### Bottom

The bottom zone holds views that benefit from a full-width horizontal strip:

- **Git graph** — the interactive commit DAG with branch and tag labels
- **Terminal container** — tabbed terminal sessions (`Cmd+T` for a new tab)
- **Server logs** — the loxel server's NDJSON log stream

### Status bar

The status bar runs across the bottom edge of the window and is always visible. It shows:

- **Active branch** — the current branch name for the active worktree
- **Upstream tracking** — `↑ X ↓ Y` (commits ahead / behind the upstream)
- **Working tree counts** — staged, modified, and untracked file counts
- **Terminal launcher** — click to open a new terminal tab

---

## Rearranging panels

Grab any panel tab and drag it to:

- A different group to move it there
- The edge of an existing group to split that group horizontally or vertically
- A zone boundary to move it between zones

You can also split the current panel from the keyboard:

| Action      | Shortcut      |
| ----------- | ------------- |
| Split right | `Cmd+\`       |
| Split down  | `Cmd+Shift+\` |

---

## Keyboard panel navigation

Move focus between panels without the mouse.

**Focus a specific panel by position:**

`Cmd+1` through `Cmd+9` focus the panels in the order they appear across the layout. The numbering follows left-to-right, top-to-bottom group order.

**Cycle through open panels:**

- `Ctrl+Tab` — next panel
- `Ctrl+Shift+Tab` — previous panel

**Move a panel to an adjacent group:**

`Ctrl+Cmd+Arrow` moves the active panel into the neighboring group in the arrow direction.

**Move a panel into a new split:**

`Ctrl+Cmd+Shift+Arrow` splits the current group in the arrow direction and moves the active panel into the new split.

**Move focus without moving the panel:**

`Ctrl+Shift+Arrow` moves keyboard focus to the panel group in the arrow direction, leaving the panel itself in place.

---

## Per-context persistence

Every aspect of the layout — panel positions, group splits, sizes, orientations, and the active panel in each group — is saved per worktree context. When you switch to a different worktree, loxel saves the current layout and restores the layout from the last time you were in the destination worktree.

Layout state is stored server-side in SQLite, not in the browser. This means it survives window closes and is consistent across windows pointing at the same loxel server. See the [Worktrees & Projects](/docs/worktrees-and-projects) page for details on how context state is keyed and restored.

---

## Error boundaries

Every panel has its own error boundary. If a panel's component throws a render error, that panel displays an inline error fallback — a message and a reload button. The rest of the layout continues to work normally. A crash in the diff viewer does not affect your terminal or the file tree.
