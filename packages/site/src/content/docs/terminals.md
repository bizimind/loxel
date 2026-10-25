---
title: Terminals
description: Full PTY sessions, persistence, Python environments, injected env vars, the loxel CLI, and TUI agents.
order: 12
---

Loxel's integrated terminals are full PTY sessions. Open as many as you need, run any CLI tool, and switch worktrees freely — your terminal sessions stay alive and exactly where you left them.

---

## Opening a terminal

Press `Cmd+T` (or `` Ctrl+Shift+` ``) to open a new terminal tab. There is no limit on the number of terminals. Like any panel, terminals can be docked, split, or moved anywhere in your layout.

To rename a terminal, double-click its tab title, right-click the tab and choose **Rename**, or press `Cmd+Shift+R` while it is the active tab. The name is saved with the layout.

---

## Session persistence

Terminal sessions survive context switches. When you switch to another worktree — or navigate away to a different panel — the shell and the programs in it keep running. Come back and the session is exactly where you left it, scrollback included.

Scrollback defaults to **50,000 lines**. Adjust it in **Settings > Terminal** — the valid range is 1,000 to 100,000 lines. Scrollback is kept by the Loxel server for every open terminal, visible or not, so with many long-running, chatty terminals a lower setting saves memory: a 200-column terminal that has filled all 50,000 lines can hold around 120 MB.

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

## Python environments

When a worktree has a Python environment, new terminals in it start with that environment active, as if you had run `source .venv/bin/activate`: its `python`, `pip` and installed tools come first on `PATH`, and `VIRTUAL_ENV` is set. It is the environment the [Python language server](/docs/typescript-intelligence#python-environment) uses, such as a `.venv` that `uv sync` created. Terminals opened before the environment existed keep running without it; open a new terminal to get it.

If your shell setup activates a virtual environment itself (direnv, mise, or your own startup files), that one wins. In zsh, the macOS default, the environment stays first on `PATH` even after your startup files rearrange `PATH`. In other shells it is still on `PATH`, but startup files that rebuild `PATH`, as macOS does for login shells, can put system directories ahead of it.

To start terminals without it, turn off **Activate Python Environment** in **Settings > Terminal**.

---

## Theme

Terminal colors follow your dark/light mode setting automatically. No manual configuration needed.

---

## Injected environment variables

Every Loxel terminal starts with four environment variables already set:

| Variable          | Value                                         |
| ----------------- | --------------------------------------------- |
| `LOXEL`           | `1`                                           |
| `LOXEL_PORT`      | Port of the running Loxel server              |
| `LOXEL_WORKTREE`  | Path of the worktree this terminal belongs to |
| `LOXEL_WINDOW_ID` | ID of the Loxel window (desktop app only)     |

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

And it can open more terminals, optionally running a command in them. The new tab opens in the worktree that contains the directory, switching to it if needed (when you run it; see below for agents), and the command is typed into your shell as if you had entered it, so the shell stays open when it finishes:

```bash
loxel terminal                                   # a shell in the current directory
loxel terminal --cwd ../other-worktree -- claude  # start an agent in another worktree
loxel terminal --split right -- pnpm dev          # in a new split beside the active tab
```

The same `--split`, `--replace` and `--group` layout flags work for files and URLs too. When a coding agent runs `loxel`, it opens things in the background instead: no worktree switch and no stolen cursor, unless the agent passes `--focus` (see [Focus](/docs/reference-env-files-cli-settings#loxel-cli)).

Because the terminal already has `LOXEL_PORT` set, the CLI connects to the running Loxel immediately.

> For the full `loxel` CLI reference, including behavior when no server is running, see [Environment Variables & Settings](/docs/reference-env-files-cli-settings).

---

## TUI agents

Any terminal-based coding agent runs normally in Loxel terminals. Claude Code, Codex, OpenCode, and Gemini CLI all work without special configuration. They inherit `LOXEL_WORKTREE`, which gives them the current worktree path as immediate context — no need to `cd` or pass a path manually. `Shift+Enter` and `Ctrl+Enter` send the modified-Enter sequences these agents use to insert a newline instead of submitting.

These are distinct from Loxel's built-in coding agent, which has a dedicated timeline UI and runs outside the terminal. If you want the timeline, human interaction overlays, and structured tool calls integrated into your layout, see [Coding Agent](/docs/coding-agent). If you have an existing TUI agent workflow or want full CLI control, run it in a terminal here.

### Teach your agent about Loxel

The [`loxel` agent skill](https://github.com/bizimind/loxel/tree/main/skills/loxel) tells Claude Code, or any other agent that supports skills, that it is running inside Loxel and how to use the `loxel` CLI: opening the files it wants you to review, showing the dev server or PR it just started in a browser panel, and starting long-running commands or other agents in their own terminals. The agent needs the `loxel` CLI on its `PATH`. To install the skill for Claude Code (run it again to update):

```bash
mkdir -p ~/.claude/skills/loxel
curl -fsSL https://raw.githubusercontent.com/bizimind/loxel/main/skills/loxel/SKILL.md -o ~/.claude/skills/loxel/SKILL.md
```

Or link it from a clone of the repository, so `git pull` there keeps it current:

```bash
git clone https://github.com/bizimind/loxel.git ~/src/loxel
mkdir -p ~/.claude/skills && rm -rf ~/.claude/skills/loxel
ln -s ~/src/loxel/skills/loxel ~/.claude/skills/loxel
```

For other agents, put the `skills/loxel` folder in their skills directory.

---

## See also

- [Coding Agent](/docs/coding-agent) — the built-in agent alternative with a dedicated timeline UI and human interaction overlays
- [Panel Layout](/docs/panel-layout) — docking, splitting, and moving terminal panels
- [Environment Variables & Settings](/docs/reference-env-files-cli-settings) — full `loxel` CLI reference and terminal scrollback configuration
