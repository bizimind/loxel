---
title: Environment Variables & Settings
description: All environment variables, file locations, the loxel CLI, and settings sections.
order: 15
---

Reference for the environment variables, files, CLI, and settings that configure Loxel.

---

## Environment Variables

The variables you set are read from the environment Loxel starts in; a Loxel launched from Finder or the Dock doesn't see your shell profile's variables. The `LOXEL_*` injection variables are set automatically by Loxel in every terminal it opens — you don't configure them. See [Terminals](/docs/terminals) for how these are used in practice.

| Variable                              | What it does                                                                                                                 | Default                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `LOXEL_DEV`                           | Set to `1` for dev mode: separate state directory, port 7434 instead of 7433                                                 | (unset = prod)                        |
| `LOXEL_SERVE_PORT`                    | Server port when running the server on its own, such as in tests; the desktop app and the `loxel` CLI always use 7433 / 7434 | `7433` (dev: `7434`)                  |
| `LOXEL_STATE_DIR`                     | Override the state directory                                                                                                 | See [File Locations](#file-locations) |
| `LOXEL_STATIC_DIR`                    | Override the frontend assets directory                                                                                       | Auto-detect                           |
| `LOXEL_PORT`                          | Auto-injected in terminals: port of the running Loxel server                                                                 | (injected)                            |
| `LOXEL_WORKTREE`                      | Auto-injected in terminals: worktree path for that terminal                                                                  | (injected)                            |
| `LOXEL_WINDOW_ID`                     | Auto-injected in terminals: ID of the Loxel window                                                                           | (injected)                            |
| `LOXEL`                               | Auto-injected in terminals: always `1`                                                                                       | (injected)                            |
| `OPENROUTER_API_KEY`                  | Coding agent API key, used when Settings > Models has none                                                                   | (none)                                |
| `OPENROUTER_MODEL_PLANNER`            | Coding agent fallback: model used for planning steps                                                                         | `z-ai/glm-5`                          |
| `OPENROUTER_MODEL_EXECUTOR`           | Coding agent fallback: model used for execution steps                                                                        | `moonshotai/kimi-k2.5`                |
| `OPENROUTER_MODEL_FALLBACK`           | Coding agent fallback: fallback model                                                                                        | `openrouter/auto`                     |
| `OPENROUTER_MODEL_JUDGE`              | Coding agent fallback: judge model                                                                                           | `anthropic/claude-3-haiku`            |
| `OPENROUTER_WEBSEARCH_MODEL`          | Coding agent fallback: model for the WebSearch tool                                                                          | (none)                                |
| `OPENROUTER_WEBSEARCH_FALLBACK_MODEL` | Coding agent fallback: WebSearch fallback model                                                                              | (none)                                |

> **Note:** Inside a Loxel terminal, `LOXEL=1` is always set. You can use this in scripts and shell prompts to detect when you're running inside Loxel.

---

## File Locations

All Loxel state lives under `~/.local/state/loxel/loxel/`. Dev mode (`LOXEL_DEV=1`) uses `~/.local/state/loxel/loxel-dev/` instead, and `LOXEL_STATE_DIR` overrides both.

| Path                               | Contents                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `projects.db`                      | SQLite — registered projects                                                                            |
| `stores.db`                        | SQLite — panel layouts, settings, keybindings and other UI state                                        |
| `comments/{repoHash}.db`           | SQLite — code review sessions and comments; one file per repo, shared across all worktrees of that repo |
| `detached/{projectHash}/{wtHash}/` | Draft markdown and Excalidraw files                                                                     |
| `logs/server-{instanceId}.log`     | Server logs in NDJSON format; rotated at 5 MB                                                           |
| `updates/`                         | Downloaded update archives                                                                              |

Draft folder names are the first 12 hex characters of the SHA-256 of the project path and the worktree path. A review database's name is the first 32 hex characters of the SHA-256 of the repo's shared `.git` directory.

> **Review database sharing:** all worktrees of the same repo share one `comments/{repoHash}.db`. Review sessions and comments are not scoped to a worktree — they are repo-wide. Drafts, by contrast, are scoped per project + worktree.

---

## `loxel` CLI

The `loxel` CLI is introduced in [Terminals](/docs/terminals#the-loxel-cli-inside-a-terminal), which also shows how to [teach your coding agent to use it](/docs/terminals#teach-your-agent-about-loxel). Full reference:

```
loxel [file-path | folder-path | url]
loxel terminal [--cwd <dir>] [--title <name>] [--] [command...]
```

| Invocation                              | Behavior                                                  |
| --------------------------------------- | --------------------------------------------------------- |
| `loxel`                                 | Launch Loxel if not running, or focus the existing window |
| `loxel src/app.ts`                      | Open a file in an editor (see below)                      |
| `loxel ~/notes`                         | Reveal a folder in the file tree (see below)              |
| `loxel https://...`                     | Open a URL in Loxel's browser panel                       |
| `loxel terminal`                        | Open a terminal panel in the current directory            |
| `loxel terminal -- claude "Fix the CI"` | Open a terminal and run a command in it (see below)       |

**Finding Loxel:** inside a Loxel terminal, `loxel` connects through `LOXEL_PORT`. Elsewhere it looks for a running Loxel on port 7433 (prod), then 7434 (dev). If no server is found, Loxel launches and the CLI waits up to 15 seconds for it to become ready.

**Files and folders:** `loxel <path>` goes to the window you are working in: the window of the Loxel terminal it runs in, or else the most recently focused Loxel window. Other windows are left alone. A file or folder inside one of your projects' worktrees opens in that worktree, switching to it if needed (a folder is revealed in the file tree). Anything else opens in the [Others section](/docs/editor#other-folders) of that window's active worktree, so files don't need to be inside a git repository. If Loxel is still starting, the CLI prints `waiting for a Loxel window...` and waits up to 30 seconds for a window to connect. Files and folders opened from Finder take the same path (see [Opening files from Finder](/docs/editor#opening-files-from-finder)).

**URLs:** `loxel <url>` opens in the windows showing the worktree that contains the current directory. Inside a Loxel terminal, it falls back to `LOXEL_WORKTREE` when the current directory isn't in a git repository; otherwise the command errors.

**Terminals:** `loxel terminal` opens a new terminal panel in the same window as a file would: the window of the Loxel terminal it runs in, or else the most recently focused window. The shell starts in the current directory, or in `--cwd <dir>`. A directory inside one of your worktrees opens the panel in that worktree, switching to it if needed; any other directory gets a panel in the window's active worktree. `--title <name>` names the tab. Everything after the flags (or after `--`) is a command typed into the shell once it starts, exactly as if you had entered it: your login shell, aliases and history all apply, and the shell stays open after the command exits. A single argument is a shell command line (`loxel terminal 'cd src && make'`); several arguments are passed as one command with each argument quoted where needed, so `loxel terminal -- claude "Fix the failing tests"` types `claude 'Fix the failing tests'` and an alias for `claude` still applies. Put `--` before commands that have flags of their own. The CLI returns as soon as the request reaches a Loxel window; it does not wait for the command. The command is typed before your shell finishes starting, so a startup script that reads from the terminal would consume it. Since `terminal` is a subcommand, open a file or folder of that name as `loxel ./terminal`.

A typical use is starting an agent in a fresh worktree right after creating it:

```bash
wt add feat/retry-uploads
loxel terminal --cwd .worktrees/feat/retry-uploads --title claude -- claude "Add retries to the upload client"
```

---

## Settings

Open settings with `Cmd+,`. Settings and keybindings are saved in `stores.db` in the state directory and shared by every window. Panel layouts are saved there too, but [each window keeps its own](/docs/worktrees-and-projects).

| Section           | What you configure                                                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General           | Version and updates (check, download, install and restart); auto-reveal the active file in Project Files when switching tabs                                            |
| Coding Agent      | Base model and per-function overrides, default session mode (execute or plan), default tool profile (execute / plan / minimal) — see [Coding Agent](/docs/coding-agent) |
| Models            | Model library — add or remove OpenRouter model entries with their API keys                                                                                              |
| Keybindings       | Per-action shortcut overrides — see [Keyboard Shortcuts](/docs/reference-keybindings)                                                                                   |
| Layout            | Which panels each side zone (left, bottom, right) holds and opens by default, and the zone sizes; applies to new worktree layouts                                       |
| Terminal          | Scrollback buffer size (1,000–100,000 lines; default 50,000), notification sequences — see [Terminals](/docs/terminals)                                                 |
| Editor            | Indentation and per-extension overrides, format on save and on autosave, formatter auto-detection and manual formatter overrides — see [Editor](/docs/editor)           |
| File Associations | Glob-to-language mappings for custom file types                                                                                                                         |
| Schemas           | JSON and YAML schema mappings; `tsconfig.json`, `package.json`, and GitHub workflow files are built in                                                                  |
