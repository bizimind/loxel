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
| `AI_AGENT`                            | Auto-injected in the commands Loxel's coding agent runs: `loxel`, so tools like the `loxel` CLI know an agent ran them       | (injected)                            |
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
| `zsh-python-env/`                  | zsh startup files Loxel uses to activate Python environments in terminals; rewritten by Loxel           |

Draft folder names are the first 12 hex characters of the SHA-256 of the project path and the worktree path. A review database's name is the first 32 hex characters of the SHA-256 of the repo's shared `.git` directory.

> **Review database sharing:** all worktrees of the same repo share one `comments/{repoHash}.db`. Review sessions and comments are not scoped to a worktree — they are repo-wide. Drafts, by contrast, are scoped per project + worktree.

---

## `loxel` CLI

The `loxel` CLI is introduced in [Terminals](/docs/terminals#the-loxel-cli-inside-a-terminal), which also shows how to [teach your coding agent to use it](/docs/terminals#teach-your-agent-about-loxel). Full reference:

```
loxel [open flags] <file-path | folder-path | url>
loxel terminal [--cwd <dir>] [--title <name>] [open flags] [--] [command...]

open flags: [--split left|right|up|down | --replace] [--group <tab>] [--focus | --no-focus]
```

| Invocation                              | Behavior                                                  |
| --------------------------------------- | --------------------------------------------------------- |
| `loxel`                                 | Launch Loxel if not running, or focus the existing window |
| `loxel src/app.ts`                      | Open a file in an editor (see below)                      |
| `loxel ~/notes`                         | Reveal a folder in the file tree (see below)              |
| `loxel https://...`                     | Open a URL in Loxel's browser panel                       |
| `loxel terminal`                        | Open a terminal panel in the current directory            |
| `loxel terminal -- claude "Fix the CI"` | Open a terminal and run a command in it (see below)       |
| `loxel --split right src/app.ts`        | Open a file in a new split beside the active tab          |
| `loxel terminal --group server`         | Open a terminal in the same group as the `server` tab     |
| `loxel --no-focus src/app.ts`           | Open a file in the background, leaving your view as it is |

**Finding Loxel:** inside a Loxel terminal, `loxel` connects through `LOXEL_PORT`. Elsewhere it looks for a running Loxel on port 7433 (prod), then 7434 (dev), and, when the open takes focus (see **Focus** below), brings Loxel to the front. If no server is found, Loxel launches and the CLI waits up to 15 seconds for it to become ready.

**Files and folders:** `loxel <path>` goes to the window you are working in: the window of the Loxel terminal it runs in, or else the most recently focused Loxel window. Other windows are left alone. A file or folder inside one of your projects' worktrees opens in that worktree, switching to it if needed when the open takes focus (see **Focus** below) (a folder is revealed in the file tree). Anything else opens in the [Others section](/docs/editor#other-folders) of that window's active worktree, so files don't need to be inside a git repository. If Loxel is still starting, the CLI prints `waiting for a Loxel window...` and waits up to 30 seconds for a window to connect. Files and folders opened from Finder take the same path (see [Opening files from Finder](/docs/editor#opening-files-from-finder)).

**URLs:** `loxel <url>` opens in the windows showing the worktree that contains the current directory. Inside a Loxel terminal, it falls back to `LOXEL_WORKTREE` when the current directory isn't in a git repository; otherwise the command errors. Layout flags apply only in the window you are working in; other windows showing the worktree get the page as a new tab.

**Terminals:** `loxel terminal` opens a new terminal panel in the same window as a file would: the window of the Loxel terminal it runs in, or else the most recently focused window. The shell starts in the current directory, or in `--cwd <dir>`. A directory inside one of your worktrees opens the panel in that worktree, switching to it if needed when the open takes focus (see **Focus** below); any other directory gets a panel in the window's active worktree. `--title <name>` names the tab. Everything after the flags (or after `--`) is a command typed into the shell once it starts, exactly as if you had entered it: your login shell, aliases and history all apply, and the shell stays open after the command exits. A single argument is a shell command line (`loxel terminal 'cd src && make'`); several arguments are passed as one command with each argument quoted where needed, so `loxel terminal -- claude "Fix the failing tests"` types `claude 'Fix the failing tests'` and an alias for `claude` still applies. Put `--` before commands that have flags of their own. The CLI returns as soon as the request reaches a Loxel window; it does not wait for the command. The command is typed before your shell finishes starting, so a startup script that reads from the terminal would consume it. Since `terminal` is a subcommand, open a file or folder of that name as `loxel ./terminal`.

**Layout flags:** by default a file, URL or terminal opens as a new tab in the group of the active tab. Layout flags choose another spot, in the layout of the worktree the panel opens in:

- `--split left|right|up|down` opens the panel in a new split on that side of the active tab, like the split shortcuts in [Panel Layout](/docs/panel-layout#rearranging-panels).
- `--replace` puts the panel in the active tab's place and closes that tab. It can't be combined with `--split`.
- `--group <tab>` opens the panel in the group holding another tab instead of the active one: a file open in a tab (`--group src/app.ts`, relative to the current directory) or a tab's title as shown on the tab (`--group "Terminal 2"`, or a name you gave with `--title`). If several tabs have that title, the active one wins, then one that is visible in its group. With `--split` the new split goes beside that tab, and with `--replace` that tab is the one replaced. If no open tab matches, the panel opens next to the active tab and Loxel shows a message.

If the file is already open, its tab moves to the requested spot instead of opening a second copy. Without layout flags, an open file's tab is just focused where it is. Folders are revealed in the file tree, so layout flags don't apply to them: the folder still opens, and the CLI prints a warning. For `loxel <path>` the flags can go before or after the path, and a path that starts with `-` goes after `--`. For `loxel terminal` they go before the command.

**Focus:** with focus, an open shows you what it opened: Loxel comes to the front when you run `loxel` outside it, the window switches to the worktree the panel belongs to, and the new tab becomes the active one. Without focus, your view stays as it is: Loxel is not brought to the front (only launched if it isn't running), the window stays on its worktree, and the panel is added as a background tab, or as a new split that doesn't take the cursor. Replacing the tab you are on with `--replace` still shows its replacement in its place. A panel for another worktree is waiting there when you next switch to it, and a terminal's command starts running right away, even though you haven't looked at it yet. An already-open file isn't activated, though layout flags still move its tab. A folder can only be revealed with focus, so without it nothing opens and the CLI prints a warning.

`--focus` and `--no-focus` choose explicitly (they can't be combined). Without either, the default depends on who runs the command: you get focus, and a coding agent doesn't, so an agent's opens never pull you away from what you are doing. The CLI recognizes coding agents by the environment variables they set for the commands they run: `CLAUDECODE` (Claude Code), `CODEX_SANDBOX`, `CODEX_CI` or `CODEX_THREAD_ID` (Codex), `GEMINI_CLI` (Gemini CLI), `CURSOR_AGENT` (Cursor), `OPENCODE_CLIENT` (opencode), `AUGMENT_AGENT` (Augment), `ANTIGRAVITY_AGENT` (Antigravity), `CLAUDE_CODE`, and the cross-agent `AI_AGENT`, which Loxel's own [coding agent](/docs/coding-agent) sets for its commands.

A typical use is starting an agent in a fresh worktree right after creating it:

```bash
wt add feat/retry-uploads
loxel terminal --cwd .worktrees/feat/retry-uploads --title claude -- claude "Add retries to the upload client"
```

Or keeping a dev server and its tests side by side:

```bash
loxel terminal --title dev --split down -- pnpm dev
loxel terminal --group dev --split right -- pnpm test --watch
```

---

## Settings

Open settings with `Cmd+,`. Settings and keybindings are saved in `stores.db` in the state directory and shared by every window. Panel layouts are saved there too, but [each window keeps its own](/docs/worktrees-and-projects).

| Section           | What you configure                                                                                                                                                                                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General           | Version and updates (check, download, install and restart); auto-reveal the active file in Project Files when switching tabs                                                                                                                                                                                         |
| Coding Agent      | Base model and per-function overrides, default session mode (execute or plan), default tool profile (execute / plan / minimal) — see [Coding Agent](/docs/coding-agent)                                                                                                                                              |
| Models            | Model library — add or remove OpenRouter model entries with their API keys                                                                                                                                                                                                                                           |
| Keybindings       | Per-action shortcut overrides — see [Keyboard Shortcuts](/docs/reference-keybindings)                                                                                                                                                                                                                                |
| Layout            | Which panels each side zone (left, bottom, right) holds and opens by default, and the zone sizes; applies to new worktree layouts                                                                                                                                                                                    |
| Terminal          | Scrollback buffer size (1,000–100,000 lines; default 50,000), notification sequences, Python environment activation in new terminals (on by default) — see [Terminals](/docs/terminals)                                                                                                                              |
| Editor            | Default indentation (Python, Rust, and Go have built-in defaults, and a file keeps the indentation it's written in) and per-extension overrides, both outranked by a project's `.editorconfig`, format on save and on autosave, formatter auto-detection and manual formatter overrides — see [Editor](/docs/editor) |
| File Associations | Glob-to-language mappings for custom file types                                                                                                                                                                                                                                                                      |
| Schemas           | JSON and YAML schema mappings; `tsconfig.json`, `package.json`, and GitHub workflow files are built in                                                                                                                                                                                                               |
