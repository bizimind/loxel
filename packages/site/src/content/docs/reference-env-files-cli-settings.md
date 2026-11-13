---
title: Environment Variables & Settings
description: All environment variables, file locations, and settings sections.
section: "Reference"
order: 3
# Sections that moved; old links to them keep working.
movedAnchors:
  loxel-cli: /docs/cli
---

Reference for the environment variables, files, and settings that configure Loxel. The `loxel` command has a page of its own: [Loxel CLI](/docs/cli).

---

## Environment Variables

The variables you set are read from the environment Loxel starts in; a Loxel launched from Finder or the Dock doesn't see your shell profile's variables. The tools Loxel starts for you (language servers, formatters, and worktree hooks) do get your login shell's variables, re-read (at most every few minutes) when a language server or formatter isn't found, so something you install later is picked up without restarting Loxel. The `LOXEL_*` injection variables are set automatically by Loxel in every terminal it opens — you don't configure them. See [Terminals](/docs/terminals) for how these are used in practice.

| Variable            | What it does                                                                                                                 | Default                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `LOXEL_DEV`         | Set to `1` for dev mode: separate state directory, port 7434 instead of 7433                                                 | (unset = prod)                        |
| `LOXEL_SERVE_PORT`  | Server port when running the server on its own, such as in tests; the desktop app and the `loxel` CLI always use 7433 / 7434 | `7433` (dev: `7434`)                  |
| `LOXEL_STATE_DIR`   | Override the state directory                                                                                                 | See [File Locations](#file-locations) |
| `LOXEL_STATIC_DIR`  | Override the frontend assets directory                                                                                       | Auto-detect                           |
| `LOXEL_PORT`        | Auto-injected in terminals: port of the running Loxel server                                                                 | (injected)                            |
| `LOXEL_WORKTREE`    | Auto-injected in terminals: worktree path for that terminal                                                                  | (injected)                            |
| `LOXEL_WINDOW_ID`   | Auto-injected in terminals: ID of the Loxel window                                                                           | (injected)                            |
| `LOXEL_TERMINAL_ID` | Auto-injected in terminals: ID of the terminal                                                                               | (injected)                            |
| `LOXEL_AGENT_TOKEN` | Auto-injected in terminals: authenticates Claude Code's hooks from that terminal to Loxel                                    | (injected)                            |
| `LOXEL`             | Auto-injected in terminals: always `1`                                                                                       | (injected)                            |

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
| `zsh-python-env/`                  | zsh startup files Loxel uses to activate Python environments in terminals; rewritten by Loxel           |

Draft folder names are the first 12 hex characters of the SHA-256 of the project path and the worktree path. A review database's name is the first 32 hex characters of the SHA-256 of the repo's shared `.git` directory.

> **Review database sharing:** all worktrees of the same repo share one `comments/{repoHash}.db`. Review sessions and comments are not scoped to a worktree — they are repo-wide. Drafts, by contrast, are scoped per project + worktree.

---

## Settings

Open settings with `Cmd+,`. Settings and keybindings are saved in `stores.db` in the state directory and shared by every window. Panel layouts are saved there too, but [each window keeps its own](/docs/worktrees-and-tasks#per-task-layouts).

| Section           | What you configure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| General           | Version and updates (check, download, install and restart; an update replaces the whole app, and restarting ends open terminals); check for updates automatically when Loxel starts (on by default; when off, Loxel contacts the update server only when you choose Check for updates); auto-reveal the active file in Project Files when switching tabs                                                                                                                                                                                                     |
| Appearance        | Theme: Dark (the default), Light, or System (follows your Mac's appearance), which also applies to Loxel's menus, dialogs and the pages in browser panels (the command palette's **Theme: Dark**, **Theme: Light** and **Theme: System** switch it too); the color theme for each mode, built in or your own, with an editor and theme.json export and import — see [Themes](/docs/themes); the code, terminal and markdown fonts and their sizes, from the fonts installed on your Mac — see [Fonts](/docs/editor#fonts)                                    |
| Keybindings       | Per-action shortcut overrides — see [Keyboard Shortcuts](/docs/reference-keybindings)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Layout            | Which panels each side zone (left, bottom, right) holds and opens by default, and the zone sizes; applies to new worktree layouts                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Terminal          | Scrollback buffer size (1,000–100,000 lines; default 50,000), [notification sequences](/docs/coding-agents#notifications), Python environment activation in new terminals (on by default) — see [Terminals](/docs/terminals)                                                                                                                                                                                                                                                                                                                                 |
| Editor            | Default indentation (languages with a clear convention, such as Python, Go and Makefiles, have [built-in defaults](/docs/editor#indentation), and a file keeps the indentation it's written in) and per-extension overrides, both outranked by a project's `.editorconfig`, [inlay hints](/docs/editor#inlay-hints) (on, off, or only while holding or not holding `Ctrl+Alt`), format on save and on autosave, formatter auto-detection and manual formatter overrides, [markdown output markers](/docs/editor#markdown-files) — see [Editor](/docs/editor) |
| File Associations | Glob-to-language mappings for custom file types                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Schemas           | JSON, YAML and TOML schema mappings; `tsconfig.json`, `package.json`, [JavaScript tool configs](/docs/languages/javascript#tool-configuration-files), GitHub workflow files, `pyproject.toml`, `Cargo.toml`, and other common TOML files are built in                                                                                                                                                                                                                                                                                                        |
| Security          | Which repositories you trust, declined or haven't decided on, and what is restricted in each; trust, stop trusting or forget an answer — see [Repository Trust](/docs/repository-trust#managing-trust-in-settings); which schema addresses named by project files may be downloaded, and a switch to never download them — see [Language Intelligence](/docs/language-intelligence#schemas-a-file-names)                                                                                                                                                     |
