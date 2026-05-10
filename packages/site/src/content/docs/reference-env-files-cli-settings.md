---
title: Environment Variables & Settings
description: All environment variables, file locations, the loxel CLI, and settings sections.
order: 15
---

Reference material for configuring and understanding loxel's runtime behavior.

---

## Environment Variables

Most of these you set once in your shell profile. The `LOXEL_*` injection variables are set automatically by loxel in every terminal it opens — you don't configure them. See [Terminals](/docs/terminals) for how these are used in practice, and [TypeScript Intelligence](/docs/typescript-intelligence) for `LOXEL_TS_LSP`.

| Variable                     | What it does                                                  | Default                |
| ---------------------------- | ------------------------------------------------------------- | ---------------------- |
| `LOXEL_DEV`                  | Dev mode: separate state directory, port 7434 instead of 7433 | (unset = prod)         |
| `LOXEL_TS_LSP`               | TypeScript LSP backend: `tsgo` or `tsls`                      | `tsgo`                 |
| `LOXEL_STATIC_DIR`           | Override the frontend assets directory                        | Auto-detect            |
| `LOXEL_PORT`                 | Auto-injected in terminals: port of the running loxel server  | (injected)             |
| `LOXEL_WORKTREE`             | Auto-injected in terminals: worktree path for that terminal   | (injected)             |
| `LOXEL_WINDOW_ID`            | Auto-injected in terminals: Electron window ID                | (injected)             |
| `LOXEL`                      | Auto-injected in terminals: always `1`                        | (injected)             |
| `OPENROUTER_API_KEY`         | Required for the built-in coding agent                        | (none)                 |
| `OPENROUTER_MODEL_PLANNER`   | Model used for planning steps                                 | `z-ai/glm-5`           |
| `OPENROUTER_MODEL_EXECUTOR`  | Model used for execution steps                                | `moonshotai/kimi-k2.5` |
| `OPENROUTER_MODEL_FALLBACK`  | Fallback model                                                | `openrouter/auto`      |
| `OPENROUTER_WEBSEARCH_MODEL` | Model for the WebSearch tool (required to enable WebSearch)   | (none)                 |

> **Note:** Inside a loxel terminal, `LOXEL=1` is always set. You can use this in scripts and shell prompts to detect when you're running inside loxel.

---

## File Locations

All loxel state lives under `~/.local/state/loxel/`. Dev mode (`LOXEL_DEV` set) uses `loxel-dev/` instead.

| Path                               | Contents                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `projects.db`                      | SQLite — registered projects                                                                            |
| `stores.db`                        | SQLite — panel layouts and internal store                                                               |
| `comments/{repoHash}.db`           | SQLite — code review sessions and comments; one file per repo, shared across all worktrees of that repo |
| `detached/{projectHash}/{wtHash}/` | Draft markdown and excalidraw files                                                                     |
| `logs/server-{instanceId}.log`     | Server logs in NDJSON format; rotated at 5 MB                                                           |
| `updates/`                         | Downloaded update archives                                                                              |

Hashes are the first 12 hex characters of the SHA-256 of the relevant path (repo common dir, project path, or worktree path).

> **Review database sharing:** all worktrees of the same repo share one `comments/{repoHash}.db`. Review sessions and comments are not scoped to a worktree — they are repo-wide. Drafts, by contrast, are scoped per project + worktree.

---

## `loxel` CLI

The `loxel` CLI is introduced in [Terminals](/docs/terminals#the-loxel-cli-inside-a-terminal). Full reference:

```
loxel [file-path | url]
```

| Invocation          | Behavior                                                  |
| ------------------- | --------------------------------------------------------- |
| `loxel`             | Launch loxel if not running, or focus the existing window |
| `loxel src/app.ts`  | Open a file in the running loxel instance                 |
| `loxel https://...` | Open a URL in loxel's browser panel                       |

**Server detection:** `loxel` tries port 7433 (prod) then 7434 (dev), with a 1-second timeout on each. Inside a loxel terminal, `LOXEL_PORT` is already set and used directly — no detection needed. If no server is found, loxel launches and the CLI waits up to 15 seconds for it to become ready.

**Worktree resolution:** when opening a file, `loxel` runs `git rev-parse --show-toplevel` on the file's directory to identify the worktree. Inside a loxel terminal, it falls back to `LOXEL_WORKTREE` if the file path doesn't resolve to a git repo. If no worktree can be determined and no fallback is available, the command errors.

---

## Settings

Open settings with `Cmd+,`. Panel layout is persisted server-side in `stores.db`; other settings persist in browser localStorage.

| Section           | What you configure                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| General           | Auto-reveal active file in the file explorer when switching tabs                                                                         |
| Coding Agent      | Model profiles, default session mode (execute or plan), tool profile (execute / plan / minimal) — see [Coding Agent](/docs/coding-agent) |
| Models            | Model library — add or remove OpenRouter model entries with their API keys                                                               |
| Keybindings       | Per-action shortcut overrides — see [Keyboard Shortcuts](/docs/reference-keybindings)                                                    |
| Terminal          | Scrollback buffer size (1,000–100,000 lines; default 3,000), notification sequences — see [Terminals](/docs/terminals)                   |
| Editor            | Indentation, formatting per language or file extension, format-on-autosave — see [Editor](/docs/editor)                                  |
| File Associations | Glob-to-language mappings for custom file types                                                                                          |
| Schemas           | JSON and YAML schema mappings; `tsconfig.json`, `package.json`, GitHub workflow files, and `wt.yaml` are built in                        |
