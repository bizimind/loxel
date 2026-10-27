---
title: Panel Layout
description: The five fixed zones, panel rearrangement, keyboard navigation, and per-context persistence.
order: 5
---

Loxel's workspace is divided into five fixed zones. Within those zones, panels are free-form: you can move them between groups, split areas horizontally or vertically, and resize everything. The layout for each worktree is saved automatically and restored when you switch back.

---

## The five zones

### Left sidebar

The left sidebar holds dockable tool panels. By default it has:

- **Project Files** — the file tree for the active worktree
- **Changes** — your uncommitted changes; shows a commit's or range's files when commits are selected in the commit graph

Every tool panel has an icon in the tool bars at the window's left and right edges; click an icon to show or hide its panel, or drag it to another zone's tool bar. Toggle panels without touching the mouse:

| Panel            | Shortcut       |
| ---------------- | -------------- |
| Project Files    | `Cmd+Shift+E`  |
| Changes          | `Cmd+Shift+C`  |
| Git              | `Ctrl+Shift+G` |
| Comments         | `Ctrl+Shift+R` |
| Logs             | `Ctrl+Shift+L` |
| Fork Tree        | `Ctrl+Shift+K` |
| Worktree sidebar | `Ctrl+Alt+B`   |

The **worktree sidebar** to the far left lists your projects and their worktrees. Collapsed, it is a narrow rail of worktree icons; expanded, drag its right edge to resize it (double-click the edge to reset the width).

**Settings > Layout** sets which panels each zone holds and opens by default, and the zones' sizes, for new worktree layouts.

### Center

The center area is the main content area. Every editor and interactive view opens here by default:

- **Diff viewer** — side-by-side or unified diff for commits and working tree changes
- **Code editor** — Monaco-based editor with language server features, format on save, and autosave
- **Markdown editor** — live preview markdown editing for repo files and drafts
- **Excalidraw** — whiteboard and diagram editor
- **Coding agent** — the built-in agent's timeline UI
- **Terminals** — full-featured terminal tabs
- **Browser** — web pages, see [Browser panels](#browser-panels)
- **Media viewer** — images, SVGs, and videos

Double-click a terminal or file tab's title, right-click the tab and choose **Rename**, or press `Cmd+Shift+R` (**Rename Tab** in the command palette) to rename the active tab; renaming a file tab renames the file. Press `Enter` to apply the new name or `Esc` to cancel, and focus returns to the panel you were working in. The tab menu also copies a file's name or path, closes other tabs, and on macOS offers **Reveal in Finder** and **Open In**.

### Right sidebar

The right sidebar accepts any tool panel. By default it holds **Comments** (code review sessions and comment threads) and the **Fork Tree** of coding agent sessions.

### Bottom

The bottom zone holds views that benefit from a full-width horizontal strip. By default it has:

- **Git** — the interactive commit graph with branch and tag labels, and the branch list
- **Logs** — the Loxel server's log stream

### Status bar

The status bar runs across the bottom edge of the window and is always visible. It shows:

- **Active branch** — the current branch name for the active worktree
- **Upstream tracking** — `↑ X ↓ Y` (commits ahead / behind) and the upstream branch name
- **Working tree counts** — staged, modified, untracked, and conflicted file counts
- **Indentation and line endings** — while a code file is the active editor, its indentation and where it came from, and `LF` or `CRLF`; click the indentation to change it (see [Indentation](/docs/editor#indentation))
- **Python interpreter** — while a Python file is the active editor, the worktree's interpreter; click it to choose another (see [Python environment](/docs/language-intelligence#python-environment))
- **Chord progress** — the keys typed so far while a chord shortcut such as `Cmd+\` is waiting for its next key
- **New panel buttons** — open a new agent, markdown editor, drawing, browser, or terminal

---

## Browser panels

A browser panel (`Cmd+Shift+B`) is a full web view with back, forward, reload, an address bar, and DevTools. A new blank panel starts with the cursor in the address bar, so you can type a URL or a search right away. `Cmd+F` finds text in the page.

A plain click on a link opens it in the same tab. Links you open in a new tab or window become browser tabs right after the current one, in the same group:

- **`Cmd`-click or middle-click** opens the link in a background tab and keeps you on the current page, so you can hold `Cmd` and click several links in a row. The new tabs keep the order you clicked them in.
- **`Cmd+Shift`-click** opens the link in a new tab and switches to it.
- **Links that open a new window** (`target="_blank"`, or a page opening a window when you click something) open in a new tab and switch to it. Windows a page tries to open without you clicking or typing are blocked, and each click opens at most one tab.

Right-click in a page for a context menu that matches what you clicked:

- **Link** — open it in a new tab (next to the current one, in the background), open it in your default browser, or copy its address.
- **Image** — open it in a new tab, save it, copy it, or copy its address.
- **Selected text** — copy it or search the web for it. In a text field you can also cut, paste and select all.
- **Page** — back, forward, reload, or view the page source in a new tab.

Every menu ends with **Inspect Element**, which opens DevTools on the element you clicked.

All browser panels share one persistent session, so cookies and logins carry across panels and restarts. In the signed macOS app, sites can create and use passkeys with Touch ID. Open a URL in a browser panel with `loxel <url>` from a terminal, or by `Cmd`-clicking a link in terminal output.

When a page calls `alert()`, `confirm()`, or `prompt()`, the dialog opens over that page and names the site that asked. Only that browser panel waits for your answer; the rest of Loxel stays usable. `Enter` confirms and `Esc` cancels. Starting from a page's second dialog, you can check **Don't allow this page to show more dialogs** to silence it until it reloads or navigates. Reloading or navigating also dismisses any dialog that is open.

---

## Rearranging panels

Grab any panel tab and drag it to:

- A different group to move it there
- The edge of an existing group to split that group horizontally or vertically
- A zone boundary to move it between zones

You can also split the current panel from the keyboard:

| Action                    | Shortcut                                                          |
| ------------------------- | ----------------------------------------------------------------- |
| Split (same panel type)   | `Cmd+\` then an arrow                                             |
| Split as a new panel type | `Cmd+\` then `T` / `A` / `M` / `D` / `B`, then an arrow           |
| New tab in the group      | `Cmd+\` then `Enter` (same type), or the type letter then `Enter` |

---

## Keyboard panel navigation

Move focus between panels without the mouse.

**Focus a specific panel by position:**

`Cmd+1` through `Cmd+9` focus the first through ninth panel in the center area, counting each group's tabs in turn.

**Cycle through open panels:**

- `Ctrl+Tab` or `Cmd+Shift+]` — next panel
- `Ctrl+Shift+Tab` or `Cmd+Shift+[` — previous panel

**Move a panel to an adjacent group:**

`Ctrl+Cmd+Arrow` moves the active panel into the neighboring group in the arrow direction.

**Move a panel into a new split:**

`Cmd+\` then `Shift+Arrow` splits the current group in the arrow direction and moves the active panel into the new split.

**Move focus without moving the panel:**

`Ctrl+Shift+Arrow` moves keyboard focus to the panel group in the arrow direction, leaving the panel itself in place. Past the center's edge it continues into the side tool bars and the worktree sidebar, and down into an open bottom panel. `Ctrl+Shift+Space` collapses or expands the sidebar or panel that holds focus.

---

## Per-context persistence

Every aspect of the layout — panel positions, group splits, sizes, orientations, and the active panel in each group — is saved per worktree context. When you switch to a different worktree, Loxel saves the current layout and restores the layout from the last time you were in the destination worktree.

Layouts are saved by Loxel, not by the window, so they survive closing windows and restarting the app. See [Worktrees & Projects](/docs/worktrees-and-projects#per-context-layout-persistence) for how layouts behave across multiple windows.

---

## When a panel fails

If a panel hits an error, it shows an error message and a reload button in place of its content. The rest of the layout continues to work normally. A crash in the diff viewer does not affect your terminal or the file tree.
