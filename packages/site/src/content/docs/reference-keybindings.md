---
title: Keyboard Shortcuts
description: Complete keyboard shortcut reference for all panels, navigation, and worktree switching.
order: 14
---

All shortcuts use the "Loxel Default" template and are fully customizable in Settings > Keybindings (`Cmd+,`). On Windows and Linux, `Cmd` = `Ctrl`.

For context on what each feature does, see [Terminals](/docs/terminals), [Drafts](/docs/drafts), [Coding Agent](/docs/coding-agent), [Editor](/docs/editor), [Worktrees & Projects](/docs/worktrees-and-projects), [Panel Layout](/docs/panel-layout), [Git](/docs/git), and [Diff Viewer](/docs/diff-viewer).

---

## Panel management

| Action                             | Shortcut                                                     |
| ---------------------------------- | ------------------------------------------------------------ |
| New terminal                       | `Cmd+T`                                                      |
| New markdown draft                 | `Cmd+Shift+M` or `Cmd+N`                                     |
| New drawing                        | `Cmd+Shift+D`                                                |
| New agent                          | `Cmd+Shift+A`                                                |
| New browser                        | `Cmd+Shift+B`                                                |
| New tab of the active panel's type | `Cmd+\` then `Enter`                                         |
| Close panel                        | `Cmd+W`                                                      |
| Next / previous tab                | `Cmd+Shift+]` / `Cmd+Shift+[`, `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Focus panel 1–9                    | `Cmd+1` – `Cmd+9`                                            |

---

## Splits

Splits are chords: press `Cmd+\`, release, then press the next key. The status bar shows the keys typed so far; `Esc` cancels.

| Action                                  | Shortcut                                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Split the active panel (same type)      | `Cmd+\` then an arrow                                                                           |
| Split as a new panel type               | `Cmd+\` then `T` terminal / `A` agent / `M` markdown / `D` drawing / `B` browser, then an arrow |
| Open a panel type as a tab in the group | `Cmd+\` then the type letter, then `Enter`                                                      |
| Move the active tab into a new split    | `Cmd+\` then `Shift+Arrow`                                                                      |

---

## Focus and panel movement

| Action                                                        | Shortcut           |
| ------------------------------------------------------------- | ------------------ |
| Move focus between groups, tool bars and the worktree sidebar | `Ctrl+Shift+Arrow` |
| Move the active tab to the adjacent group                     | `Ctrl+Cmd+Arrow`   |
| Collapse / expand the focused sidebar or panel                | `Ctrl+Shift+Space` |

---

## Navigation & global

| Action            | Shortcut      |
| ----------------- | ------------- |
| Quick Open (file) | `Cmd+P`       |
| Find in files     | `Cmd+Shift+F` |
| Command palette   | `Cmd+Shift+P` |
| Open settings     | `Cmd+,`       |
| Switch project    | `Cmd+Alt+P`   |
| Switch worktree   | `Cmd+Alt+W`   |
| Save              | `Cmd+S`       |

---

## Sidebar toggles

| Sidebar          | Shortcut       |
| ---------------- | -------------- |
| Project files    | `Cmd+Shift+E`  |
| Changes          | `Cmd+Shift+C`  |
| Git graph        | `Ctrl+Shift+G` |
| Comments         | `Ctrl+Shift+R` |
| Worktree sidebar | `Ctrl+Alt+B`   |

---

## Worktree switching

| Action                                   | Shortcut                                                |
| ---------------------------------------- | ------------------------------------------------------- |
| Back / forward through visited worktrees | `Ctrl+Alt+[` / `Ctrl+Alt+]`                             |
| New worktree                             | `Ctrl+Alt+N`                                            |
| Focus worktree 1–8, last, 10             | `Ctrl+Alt+1` – `Ctrl+Alt+8`, `Ctrl+Alt+9`, `Ctrl+Alt+0` |
| Delete worktree                          | unbound — command palette or right-click menu           |

Back/forward work like a browser's history, across all projects. Worktree numbers follow the sidebar order and skip hidden worktrees.

---

## File tree

| Action                    | Shortcut           |
| ------------------------- | ------------------ |
| Navigate                  | `↑` `↓` `←` `→`    |
| Toggle expand/collapse    | `Space`            |
| Open file / toggle folder | `Enter`            |
| Rename                    | `F2` or `Shift+F6` |
