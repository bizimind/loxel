---
title: Terminals
description: Full PTY sessions that keep running across task switches, find, links, Python, Node and JDK environments, and the variables every terminal starts with.
section: "In the code"
order: 3
# Sections that moved; old links to them keep working.
movedAnchors:
  notifications: /docs/coding-agents#notifications
  the-loxel-cli-inside-a-terminal: /docs/cli
  tui-agents: /docs/coding-agents
  teach-your-agent-about-loxel: /docs/coding-agents#teach-your-agent-about-loxel
---

Loxel's integrated terminals are full PTY sessions. Open as many as you need, run any CLI tool or coding agent, and switch tasks freely — your terminal sessions stay alive and exactly where you left them.

---

## Opening a terminal

Press `Cmd+T` (or `` Ctrl+Shift+` ``) to open a new terminal tab. There is no limit on the number of terminals. Like any panel, terminals can be docked, split, or moved anywhere in your layout.

To rename a terminal, double-click its tab title, right-click the tab and choose **Rename**, or press `Cmd+Shift+R` while it is the active tab. The name is saved with the layout.

---

## Session persistence

Terminal sessions survive task switches. When you switch to another task — or navigate away to a different panel — the shell and the programs in it keep running. Come back and the session is exactly where you left it, scrollback included. A terminal ends when you close it, when its [worktree is removed](/docs/worktrees-and-tasks#the-worktree-sidebar), or when you quit Loxel. With every window closed and Loxel still running, terminals keep running for 5 minutes, so they are back when you open a window again. A crash doesn't end them either: if Loxel or its background server stops unexpectedly, your shells keep running, and reconnect with their scrollback when Loxel is back, as long as that is within 10 minutes.

Scrollback defaults to **50,000 lines**. Adjust it in **Settings > Terminal** — the valid range is 1,000 to 100,000 lines. Scrollback is kept by the Loxel server for every open terminal, visible or not, so with many long-running, chatty terminals a lower setting saves memory: a 200-column terminal that has filled all 50,000 lines can hold around 120 MB.

---

## Find

Press `Cmd+F` in a terminal to search its output and scrollback. Matches are highlighted as you type; `Enter` / `Shift+Enter` (or `Cmd+G` / `Cmd+Shift+G`) jump to the next / previous match, and `Esc` closes the find bar. Reopening it keeps your last search.

---

## Links

`Cmd`-click a file path in terminal output to open it in the editor. Paths starting with `/`, `./`, `../` or `~/` are always clickable; bare names like `src/index.ts` are clickable when they match a file in the project. A `:line` or `:line:col` suffix jumps to that position. `Cmd`-click a URL to open it in a Loxel [browser panel](/docs/browser); a plain click opens it in your default browser.

---

## Python environments

When a worktree has a Python environment and you [trust the repository](/docs/repository-trust), new terminals in it start with that environment active, much like after `source .venv/bin/activate`: its `python`, `pip` and installed tools come first on `PATH`, and in zsh `VIRTUAL_ENV` is set (your prompt and the `deactivate` command are not changed). Loxel finds the environment the same way as for the [Python language server](/docs/languages/python#python-environment), for example a `.venv` that `uv sync` created or the interpreter you chose for the worktree, and never activates an environment that is committed to the repository; a `venv` setting in `pyrightconfig.json` applies to the type checker only. Terminals opened before the environment existed keep running without it; open a new terminal to get it.

If your shell setup activates a virtual environment itself (direnv, mise, or your own startup files), that one wins. In zsh, the macOS default, the environment stays first on `PATH` even after your startup files rearrange `PATH`. In other shells it is still on `PATH`, but startup files that rebuild `PATH`, as macOS does for login shells, can put system directories ahead of it, so Loxel does not set `VIRTUAL_ENV` there; run the environment's `activate` script (for example `source .venv/bin/activate.fish`) to activate it fully.

To start terminals without it, turn off **Activate Python Environment** in **Settings > Terminal**.

---

## Node version

When a worktree pins a [Node version](/docs/languages/javascript#node-version), or you chose an installed one for it, new terminals in it start with that version's `node`, `npm` and `npx` first on `PATH`. If Loxel is using the `node` on your `PATH`, found or chosen, nothing changes. Loxel never adds `node_modules/.bin`, and never uses a version committed to the repository. Terminals already open keep what they started with; open a new terminal after changing the pin or your choice.

Your shell's startup runs after that, so it can still change which `node` you get. A version manager's hook in your startup files (nvm, fnm) switches `node` as it normally would, and startup files that rebuild `PATH`, as macOS does for login shells, can put system directories ahead of the worktree's version, including Homebrew's. If `node --version` differs from the status bar, run `which node` to see which one won, and `nvm use` or your version manager's equivalent to switch.

---

## Java JDK

When you [choose a JDK](/docs/languages/java#seeing-and-changing-the-jdk) for a worktree, new terminals in it start with `JAVA_HOME` set to that JDK and its `bin` first on `PATH`. Without a choice nothing changes, even when Loxel's Java features detected a JDK: your terminal keeps your own `JAVA_HOME` and `java`. A JDK inside the worktree reaches terminals only once you [trust the repository](/docs/repository-trust), and one committed to it never does. Terminals already open keep what they started with; open a new terminal after changing your choice.

Your shell's startup runs after that, so it can still change what you get. A `JAVA_HOME` exported in your startup files, for example `~/.zshenv`, or set by a version manager, replaces the chosen one. If `echo $JAVA_HOME` differs from the status bar, look there first. On macOS, a login shell's startup also moves system directories ahead of the JDK's `bin`, so `which java` prints `/usr/bin/java`. That launcher follows `JAVA_HOME`, so `java` still runs the chosen JDK, as long as `JAVA_HOME` holds.

---

## Theme and font

Terminal colors come from the theme of the current mode, which you choose in **Settings > Appearance > Color Themes**: its 16 ANSI colors, text, cursor and selection, on the theme's editor surface. Open terminals switch at once when you change themes or the mode switches between light and dark. To use other terminal colors, make a theme of your own and take its ANSI colors from an iTerm2, Windows Terminal or VS Code file. See [Themes](/docs/themes).

Terminals use the code font until you pick a terminal font of their own in **Settings > Appearance**, and open terminals switch to a new font at once. See [Fonts](/docs/editor#fonts).

---

## Injected environment variables

Every Loxel terminal starts with four environment variables already set:

| Variable          | Value                                         |
| ----------------- | --------------------------------------------- |
| `LOXEL`           | `1`                                           |
| `LOXEL_PORT`      | Port of the running Loxel server              |
| `LOXEL_WORKTREE`  | Path of the worktree this terminal belongs to |
| `LOXEL_WINDOW_ID` | ID of the Loxel window (desktop app only)     |

`LOXEL=1` lets scripts detect they are running inside Loxel. `LOXEL_PORT` and `LOXEL_WORKTREE` are the more useful ones — they are consumed by the `loxel` CLI and by agents that want to know which worktree they're in.

---

## Coding agents

Claude Code, Codex and every other terminal agent run in Loxel terminals as they are. [Running Coding Agents](/docs/coding-agents) covers running one per task, notifications when an agent needs you, `Shift+Enter` for multi-line prompts, and the `loxel` skill.

---

## The `loxel` CLI

Every Loxel terminal has the `loxel` CLI, already connected to its window: `loxel src/app.ts` opens a file, `loxel https://example.com` a page in a browser panel, and `loxel terminal -- pnpm dev` a new terminal running a command. See [Loxel CLI](/docs/cli) for every command and flag.

---

## See also

- [Panel Layout](/docs/panel-layout) — docking, splitting, and moving terminal panels
- [Running Coding Agents](/docs/coding-agents) — an agent in every task, and notifications when one needs you
- [Loxel CLI](/docs/cli) — open files, pages and terminals from the command line
- [Environment Variables & Settings](/docs/reference-env-files-cli-settings) — environment variables and the Terminal settings
