---
title: Keyboard Shortcuts
description: Complete keyboard shortcut reference for all panels, navigation, and worktree switching.
section: "Reference"
order: 2
---

All shortcuts use the "Loxel Default" template and are fully customizable in Settings > Keybindings (`Cmd+,`). Shortcuts use macOS key names; `Cmd` is the Command key.

For what each feature does, see [Terminals](/docs/terminals), [Drafts](/docs/drafts), [Editor](/docs/editor), [Worktrees & Tasks](/docs/worktrees-and-tasks), [Browser](/docs/browser), [Panel Layout](/docs/panel-layout), [Git](/docs/git), and [Diff Viewer](/docs/diff-viewer).

---

## Panel management

| Action                              | Shortcut                                                     |
| ----------------------------------- | ------------------------------------------------------------ |
| New terminal                        | `Cmd+T` or `` Ctrl+Shift+` ``                                |
| New markdown draft                  | `Cmd+Shift+M` or `Cmd+N`                                     |
| New drawing                         | `Cmd+Shift+D`                                                |
| New browser                         | `Cmd+Shift+B`                                                |
| New tab of the active panel's type  | `Cmd+\` then `Enter`                                         |
| Close panel                         | `Cmd+W`                                                      |
| Reopen closed tab                   | `Cmd+Shift+T`                                                |
| Rename the active tab               | `Cmd+Shift+R`                                                |
| Maximize / restore the active group | `Ctrl+Shift+Enter`                                           |
| Hard refresh a browser tab          | `Cmd+Shift+R` while the browser tab has focus                |
| Bookmark a browser page             | `Cmd+D` while the browser tab has focus                      |
| Next / previous tab                 | `Cmd+Shift+]` / `Cmd+Shift+[`, `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Focus panel 1–9                     | `Cmd+1` – `Cmd+9`                                            |

`Cmd+Shift+R` depends on focus: in a browser tab, its page or its toolbar, it reloads the page and bypasses the cache; anywhere else it renames the active tab. Settings > Keybindings lists them as **Hard Refresh Browser Tab** and **Rename Tab**, and remapping one leaves the other on `Cmd+Shift+R`.

---

## Splits

Splits are chords: press `Cmd+\`, release, then press the next key. The status bar shows the keys typed so far; `Esc` cancels.

| Action                                  | Shortcut                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| Split the active panel (same type)      | `Cmd+\` then an arrow                                                               |
| Split as a new panel type               | `Cmd+\` then `T` terminal / `M` markdown / `D` drawing / `B` browser, then an arrow |
| Open a panel type as a tab in the group | `Cmd+\` then the type letter, then `Enter`                                          |
| Move the active tab into a new split    | `Cmd+\` then `Shift+Arrow`                                                          |

---

## Focus and panel movement

| Action                                                        | Shortcut           |
| ------------------------------------------------------------- | ------------------ |
| Move focus between groups, tool bars and the worktree sidebar | `Ctrl+Shift+Arrow` |
| Move the active tab to the adjacent group                     | `Ctrl+Cmd+Arrow`   |
| Collapse / expand the focused sidebar or panel                | `Ctrl+Shift+Space` |

---

## Navigation & global

| Action                                  | Shortcut                      |
| --------------------------------------- | ----------------------------- |
| Quick Open (file)                       | `Cmd+P`                       |
| Go to symbol in workspace               | `Cmd+Alt+O`                   |
| Find in files                           | `Cmd+Shift+F`                 |
| Command palette                         | `Cmd+Shift+P`                 |
| Open settings                           | `Cmd+,`                       |
| Quit and Keep Terminals                 | `Cmd+Alt+Q`                   |
| Restart Loxel                           | Loxel menu or command palette |
| Theme: Dark / Light / System            | unbound — command palette     |
| Reveal the active file in Project Files | `Cmd+Alt+E`                   |
| Go to the most recent notification      | `` Ctrl+` ``                  |
| Save                                    | `Cmd+S`                       |

`Cmd+Alt+Q` (Quit and Keep Terminals) belongs to the Loxel menu, like `Cmd+Q`, so Settings > Keybindings can't remap it. See [Terminals](/docs/terminals#quitting-without-ending-your-terminals) for what it and Restart Loxel keep running.

In a browser panel or terminal, `Cmd+F` opens a find bar for that panel; `Cmd+G` / `Cmd+Shift+G` (or `Enter` / `Shift+Enter` in the bar) step through the matches and `Esc` closes it. In a code editor, `Cmd+F` opens the editor's own find widget.

macOS window tiling shortcuts (macOS 15 and later) work in the editor, terminals and the rest of Loxel (in a browser tab, the page gets them first): `Fn+Ctrl+Arrow` moves the window to a half of the screen, `Fn+Ctrl+Shift+Arrow` arranges it with the window behind it, and `Fn+Ctrl+F` fills the screen. They are also listed under Window > Move & Resize in the menu bar. On Mac keyboards `Fn+Arrow` is `Home`, `End`, `Page Up` or `Page Down`, so binding one of those with `Ctrl` in Settings > Keybindings takes it from macOS.

---

## Tool panel toggles

| Panel            | Shortcut       |
| ---------------- | -------------- |
| Project Files    | `Cmd+Shift+E`  |
| Changes          | `Cmd+Shift+C`  |
| Git              | `Ctrl+Shift+G` |
| Comments         | `Ctrl+Shift+R` |
| Logs             | `Ctrl+Shift+L` |
| Worktree sidebar | `Ctrl+Alt+B`   |

---

## Worktree switching

| Action                                   | Shortcut                                                |
| ---------------------------------------- | ------------------------------------------------------- |
| Back / forward through visited worktrees | `Ctrl+Alt+[` / `Ctrl+Alt+]`                             |
| New worktree                             | `Ctrl+Alt+N`                                            |
| Focus worktree 1–8, last, 10             | `Ctrl+Alt+1` – `Ctrl+Alt+8`, `Ctrl+Alt+9`, `Ctrl+Alt+0` |
| Delete worktree                          | unbound — command palette or right-click menu           |
| Add project                              | unbound — command palette or worktree sidebar           |

Back/forward work like a browser's history, across all projects. Worktree numbers count the active project's worktrees in sidebar order and skip archived worktrees.

---

## Editor

| Action                     | Shortcut                                |
| -------------------------- | --------------------------------------- |
| Editor: Change Indentation | unbound — command palette or status bar |

---

## Languages

| Action                         | Shortcut                                |
| ------------------------------ | --------------------------------------- |
| Quick Fix…                     | `Cmd+.`                                 |
| Fix All                        | `Ctrl+Shift+.`                          |
| Organize Imports               | `Shift+Alt+O`                           |
| Source Action…                 | `Ctrl+Alt+S`                            |
| Refactor…                      | `Ctrl+Alt+R`                            |
| C#: Select Solution            | unbound — command palette or status bar |
| C/C++: Select Compile Database | unbound — command palette or status bar |
| Go: Select Toolchain           | unbound — command palette or status bar |
| Node: Select Version           | unbound — command palette or status bar |
| Python: Select Interpreter     | unbound — command palette or status bar |
| Java: Select JDK               | unbound — command palette or status bar |
| Rust: Select Toolchain         | unbound — command palette or status bar |
| Restart Language Servers       | unbound — command palette               |
| Manage Repository Trust        | unbound — command palette or status bar |

The code action shortcuts work in a code editor whose language server offers that kind of action, and the command palette lists them only then. When several servers offer one (Ruff and the type checker for Python), Fix All and Organize Imports apply the only fix offered or let you pick, and the others list every server's actions.

---

## File tree

| Action                    | Shortcut               |
| ------------------------- | ---------------------- |
| Navigate                  | `↑` `↓` `←` `→`        |
| First / last in folder    | `Cmd+↑` / `Cmd+↓`      |
| Jump to name              | Type its first letters |
| Toggle expand/collapse    | `Space`                |
| Open file / toggle folder | `Enter`                |
| Rename                    | `F2` or `Shift+F6`     |
