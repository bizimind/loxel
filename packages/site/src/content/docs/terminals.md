---
title: Terminals
description: Full PTY sessions, persistence, injected env vars, the loxel CLI, and TUI agents.
order: 12
---

Loxel's integrated terminals are full PTY sessions. Open as many as you need, run any CLI tool, and switch worktrees freely — your terminal sessions stay alive and exactly where you left them.

---

## Opening a terminal

Press `Cmd+T` (or `` Ctrl+Shift+` ``) to open a new terminal tab. There is no limit on the number of terminals. Like any panel, terminals can be docked, split, or moved anywhere in your layout.

To rename a terminal, double-click its tab title, or right-click the tab and choose **Rename**. The name is saved with the layout.

---

## Session persistence

Terminal sessions survive context switches. When you switch to another worktree — or navigate away to a different panel — the shell and the programs in it keep running. Come back and the session is exactly where you left it, scrollback included.

Scrollback defaults to **50,000 lines**. Adjust it in **Settings > Terminal** — the valid range is 1,000 to 100,000 lines.

> **Note:** The scrollback setting takes effect for new terminal sessions. Existing sessions retain the buffer size they were started with.

---

## Find

Press `Cmd+F` in a terminal to search its output and scrollback. Matches are highlighted as you type; `Enter` / `Shift+Enter` (or `Cmd+G` / `Cmd+Shift+G`) jump to the next / previous match, and `Esc` closes the find bar. Reopening it keeps your last search.

---

## Links

`Cmd`-click a file path in terminal output to open it in the editor. Paths starting with `/`, `./`, `../` or `~/` are always clickable; bare names like `src/index.ts` are clickable when they match a file in the project. A `:line` or `:line:col` suffix jumps to that position. `Cmd`-click a URL to open it in a Loxel browser panel; a plain click opens it in your default browser.

---

## Notifications

Terminal programs can raise Loxel notifications with the OSC 9 (iTerm2), OSC 777 (rxvt-unicode) and OSC 99 (Kitty) escape sequences; choose which ones Loxel listens to in **Settings > Terminal**. Notifications appear under the bell in the top bar and as a dot on the worktree in the sidebar. Press `` Ctrl+` `` to jump to the panel that raised the most recent one.

---

## Theme

Terminal colors follow your dark/light mode setting automatically. No manual configuration needed.

---

## Injected environment variables

Every Loxel terminal starts with four environment variables already set:

| Variable          | Value                                     |
| ----------------- | ----------------------------------------- |
| `LOXEL`           | `1`                                       |
| `LOXEL_PORT`      | Port of the running Loxel server          |
| `LOXEL_WORKTREE`  | Working directory path of this terminal   |
| `LOXEL_WINDOW_ID` | ID of the Loxel window (desktop app only) |

`LOXEL=1` lets scripts detect they are running inside Loxel. `LOXEL_PORT` and `LOXEL_WORKTREE` are the more useful ones — they are consumed by the `loxel` CLI and by TUI agents that want worktree context.

---

## The `loxel` CLI inside a terminal

From any Loxel terminal, run `loxel` with a file path to open that file in the window that terminal belongs to:

```bash
loxel src/app.ts
```

Pass a folder to reveal it in the file tree. A folder outside every project opens in the [Others section](/docs/editor#other-folders):

```bash
loxel ~/notes
```

It also accepts URLs:

```bash
loxel https://example.com
```

Because the terminal already has `LOXEL_PORT` set, the CLI connects to the running Loxel immediately.

> For the full `loxel` CLI reference, including behavior when no server is running, see [Environment Variables & Settings](/docs/reference-env-files-cli-settings).

---

## TUI agents

Any terminal-based coding agent runs normally in Loxel terminals. Claude Code, Codex, OpenCode, and Gemini CLI all work without special configuration. They inherit `LOXEL_WORKTREE`, which gives them the current worktree path as immediate context — no need to `cd` or pass a path manually. `Shift+Enter` and `Ctrl+Enter` send the modified-Enter sequences these agents use to insert a newline instead of submitting.

These are distinct from Loxel's built-in coding agent, which has a dedicated timeline UI and runs outside the terminal. If you want the timeline, human interaction overlays, and structured tool calls integrated into your layout, see [Coding Agent](/docs/coding-agent). If you have an existing TUI agent workflow or want full CLI control, run it in a terminal here.

---

## See also

- [Coding Agent](/docs/coding-agent) — the built-in agent alternative with a dedicated timeline UI and human interaction overlays
- [Panel Layout](/docs/panel-layout) — docking, splitting, and moving terminal panels
- [Environment Variables & Settings](/docs/reference-env-files-cli-settings) — full `loxel` CLI reference and terminal scrollback configuration
