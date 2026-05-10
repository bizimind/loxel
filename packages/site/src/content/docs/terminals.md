---
title: Terminals
description: Full PTY sessions, persistence, injected env vars, the loxel CLI, and TUI agents.
order: 12
---

Loxel's integrated terminals are full PTY sessions. Open as many as you need, run any CLI tool, and switch worktrees freely — your terminal sessions stay alive and exactly where you left them.

---

## Opening a terminal

Press `Cmd+T` to open a new terminal tab. There is no limit on the number of terminals. Like any panel, terminals can be docked, split, or moved anywhere in your layout.

---

## Session persistence

Terminal sessions survive context switches. When you switch to another worktree — or navigate away to a different panel — the underlying PTY process keeps running. Come back and the session is exactly where you left it, scrollback included.

The scrollback buffer is held server-side. Default: **3,000 lines**. Adjust it in **Settings > Terminal** — the valid range is 1,000 to 100,000 lines.

> **Note:** The scrollback setting takes effect for new terminal sessions. Existing sessions retain the buffer size they were started with.

---

## Theme

Terminal colors follow your dark/light mode setting automatically. No manual configuration needed.

---

## Injected environment variables

Every loxel terminal starts with four environment variables already set:

| Variable          | Value                                   |
| ----------------- | --------------------------------------- |
| `LOXEL`           | `1`                                     |
| `LOXEL_PORT`      | Port of the running loxel server        |
| `LOXEL_WORKTREE`  | Working directory path of this terminal |
| `LOXEL_WINDOW_ID` | Electron window ID (desktop app only)   |

`LOXEL=1` lets scripts detect they are running inside loxel. `LOXEL_PORT` and `LOXEL_WORKTREE` are the more useful ones — they are consumed by the `loxel` CLI and by TUI agents that want worktree context.

---

## The `loxel` CLI inside a terminal

From any loxel terminal, run `loxel` with a file path to open that file in the active loxel window:

```bash
loxel src/app.ts
loxel src/app.ts:42        # jump to line 42
loxel src/app.ts:42:8      # jump to line 42, column 8
```

It also accepts URLs:

```bash
loxel https://example.com
```

Because the terminal already has `LOXEL_PORT` set, the CLI locates the running server instantly — no detection timeout. Outside a loxel terminal, the CLI has to probe for the server; inside one, it connects immediately.

> For the full `loxel` CLI reference, including behavior when no server is running, see [Environment Variables & Settings](/docs/reference-env-files-cli-settings).

---

## TUI agents

Any terminal-based coding agent runs normally in loxel terminals. Claude Code, Codex, OpenCode, and Gemini CLI all work without special configuration. They inherit `LOXEL_WORKTREE`, which gives them the current worktree path as immediate context — no need to `cd` or pass a path manually.

These are distinct from loxel's built-in coding agent, which has a dedicated timeline UI and runs outside the terminal. If you want the timeline, human interaction overlays, and structured tool calls integrated into your layout, see [Coding Agent](/docs/coding-agent). If you have an existing TUI agent workflow or want full CLI control, run it in a terminal here.

---

## See also

- [Coding Agent](/docs/coding-agent) — the built-in agent alternative with a dedicated timeline UI and human interaction overlays
- [Panel Layout](/docs/panel-layout) — docking, splitting, and moving terminal panels
- [Environment Variables & Settings](/docs/reference-env-files-cli-settings) — full `loxel` CLI reference and terminal scrollback configuration
