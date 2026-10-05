# Loxel

An IDE built for the agentic coding era. Designed around the reality that developers now work across multiple tasks in parallel — with AI agents exploring, writing, and iterating on code — while humans plan, review, and steer.

Loxel packages the things critical for agentic work into a single interface: fast project and worktree switching, planning and ideation tools, code review for AI-generated work, integrated terminals for running agents and commands, and an opinionated coding agent harness — all in a flexible, dockable panel system.

The user documentation lives in the site package ([`packages/site/src/content/docs/`](../site/src/content/docs/), published at https://bizimind.io/docs). This README is the entry point for working on the app itself.

## Why

Coding agents change how developers work. Instead of writing every line yourself, you direct agents across multiple workstreams in parallel. This demands a new kind of tool:

- **Isolation** — each task needs its own worktree so agents don't collide
- **Fast context switching** — jump between projects and worktrees instantly, with layout and state preserved per context
- **Orientation** — understand what changed, where you are, and what the agent did — fast
- **Review before commit** — inspect, comment on, and iterate on AI work before it becomes a PR
- **Planning** — sketch ideas, write plans, and (in the future) use AI to communicate them more clearly
- **Agent interaction** — run and monitor coding agents directly, with a UI built for their workflows

Loxel is built around these needs.

## Core Concepts

- **Projects and worktrees** — manage several repositories and their worktrees (bare or regular repos, managed by `wt` under `.worktrees/`) from one window and switch between them instantly. Each project + worktree combination keeps its own panel layout, and dirty status is visible across all worktrees of a repo. See [Worktrees & Projects](../site/src/content/docs/worktrees-and-projects.md).
- **Panels** — a Dockview layout with center panels (editors, diffs, markdown, Excalidraw, coding agent, terminals, browser), dockable side panels (project files, changes, branches, comments) and a bottom zone (git graph, terminals, logs). Everything is reachable from the keyboard and remappable. See [Panel Layout](../site/src/content/docs/panel-layout.md) and [Keyboard Shortcuts](../site/src/content/docs/reference-keybindings.md).
- **Planning** — a rich markdown editor (Milkdown) and an Excalidraw canvas, saved to disk with autosave. New files start as Drafts outside the repo and can be dragged into it. See [Drafts](../site/src/content/docs/drafts.md).
- **Coding agent** — a timeline UI for the built-in agent from `packages/coding-agent`, with inline questions and approvals. Sessions are scoped per project + worktree and keep running across navigation. See [Coding Agent](../site/src/content/docs/coding-agent.md).
- **Terminals** — xterm.js terminals backed by server-side PTYs, for CLI agents (Claude Code, Codex, etc.) and everyday commands. Sessions survive project and worktree switches. See [Terminals](../site/src/content/docs/terminals.md).
- **Code review** — local review sessions with comment threads anchored to code ranges that survive edits, stored per repo and shared across its worktrees. See [Code Review](../site/src/content/docs/code-review.md).
- **Diff viewer** — side-by-side (JetBrains-style synchronized scrolling), split and unified Monaco diffs with intra-line highlights. See [Diff Viewer](../site/src/content/docs/diff-viewer.md).
- **Git** — commit graph, changes panel, branches, commits, cherry-pick, revert, reset and stash from context menus and inline forms. See [Git](../site/src/content/docs/git.md).
- **Editor and file explorer** — Monaco with Quick Open, find in files, command palette, autosave, format on save with auto-detected project formatters, and conflict detection when files change on disk. Folders and files outside every project open in the file tree's Others section. See [Editor](../site/src/content/docs/editor.md).
- **Language intelligence** — TypeScript 7 (`tsc --lsp`) per worktree plus lazily started servers for other languages, proxied to Monaco over WebSockets. See [TypeScript Intelligence](../site/src/content/docs/typescript-intelligence.md); to add a language, follow the [add-language-server skill](../../.agents/skills/add-language-server/SKILL.md).
- **Browser panels** — web pages in `<webview>` tabs, with find in page and Touch ID passkeys on macOS.
- **macOS integration** — open files and folders from Finder or with `loxel <path>`, and Reveal in Finder / Open In from context menus.

## Architecture

Three processes:

- **Server** (Bun, `src/server/`, entry `src/server/index.ts`) — REST API and WebSocket (file watching, terminal I/O, agent events, log streaming, LSP proxies), git commands, PTY sessions, in-process coding agent sessions (`agent-manager.ts`, via the `@bizimind/coding-agent` `Session` API), language server subprocesses, SQLite storage, and static serving of the built renderer. One server per mode (port 7433 prod, 7434 dev) is shared by every window.
- **Renderer** (React 19, Vite, `src/`) — Zustand stores (`src/store/`) persisted to the server, TanStack Query for server data (`src/queries/`), shared request/response and WebSocket models (`src/api/`), Monaco, xterm.js, Dockview, Milkdown and Excalidraw components (`src/components/`).
- **Electron shell** (`src/electron/`) — spawns or reuses the server, opens windows on its URL, and handles native integrations. See [docs/ELECTRON.md](docs/ELECTRON.md).

The `loxel` CLI (`src/cli.ts`) talks to a running server to open files, folders and URLs.

Always-on performance monitors in all three processes (`src/lib/perf-monitor.ts`, `src/electron/main-perf-monitor.ts`, `src/server/server-perf-monitor.ts`) log summaries and anomalies with `cat: "perf"`; filter the Logs panel or the server log files by that category.

## Development

Run these from `packages/loxel` (or with `pnpm -C packages/loxel run <script>`). Dev and production instances can run side by side.

```bash
pnpm run dev              # Dev server (port 7434) + Vite HMR (port 5173)
pnpm run dev:server       # Dev server only, with --watch
pnpm run dev:client       # Vite only
pnpm run dev:app          # Electron window with Vite HMR

pnpm run build            # Build renderer + server to dist/
pnpm run start            # Run the built server (port 7433)
pnpm run prod             # build + start

pnpm run build:app        # Standalone server + renderer, packaged with electron-builder into release/
pnpm run build:app:local  # Same, unpacked arm64 macOS app only
pnpm run build:cli        # loxel CLI binary in build/

pnpm run test             # Unit tests (bun test)
pnpm run e2e              # Playwright tests against an isolated server
pnpm run typecheck
```

Dev mode (`LOXEL_DEV=1`, set by the dev scripts) uses its own state directory and port and shows a red "DEV" badge in the top bar. The server takes an optional repo path to register as a project: `bun src/server/index.ts /path/to/repo`.

### Environment variables

| Variable           | Purpose                                                                          |
| ------------------ | -------------------------------------------------------------------------------- |
| `LOXEL_DEV`        | `1` for dev mode: dev state directory and port 7434                              |
| `LOXEL_STATE_DIR`  | Override the state directory (see [Data storage](#data-storage))                 |
| `LOXEL_SERVE_PORT` | Override the server port (standalone server only; the app and CLI use 7433/7434) |
| `LOXEL_STATIC_DIR` | Directory of the built renderer the server serves (from source: `dist/`)         |

Shells opened in a Loxel terminal inherit the app's `LOXEL_STATIC_DIR`, which points at the installed renderer. When testing a local build from such a shell, set `LOXEL_STATIC_DIR=$PWD/dist`, and use `LOXEL_STATE_DIR` and `LOXEL_SERVE_PORT` to keep a throwaway instance away from your real state. Variables Loxel injects into its terminals (`LOXEL_PORT`, `LOXEL_WORKTREE`, `LOXEL_WINDOW_ID`) are documented on the site's [Environment Variables & Settings](../site/src/content/docs/reference-env-files-cli-settings.md) page.

### Releases

`release-loxel.yml` bumps the patch version, builds, signs and publishes on every merge to main that touches `packages/loxel/**`. For changes outside the package that still affect the app (for example the root lockfile or dependency overrides), run it manually with `gh workflow run release-loxel.yml --ref main`. After publishing, it dispatches `release-site.yml` so the site's download page shows the new version. The installed app updates its server and renderer in place; see [docs/ELECTRON.md](docs/ELECTRON.md#what-ships-where) for what needs a new app download, and [docs/RELEASE_SIGNING.md](docs/RELEASE_SIGNING.md) for signing and provisioning.

## Data storage

Server-side state lives under `~/.local/state/loxel/loxel/` (production) or `~/.local/state/loxel/loxel-dev/` (dev mode):

- `stores.db` — UI state and panel layouts per project + worktree, settings, and other client stores (SQLite)
- `projects.db` — registered projects
- `comments/{repo-hash}.db` — reviews and comments, shared across a repo's worktrees
- `detached/{project-hash}/{worktree-hash}/` — Drafts
- `localdb/{project-hash}/localdb.db` — data behind `:::localdb` blocks in markdown files
- `logs/server-{instanceId}.log` — server logs (NDJSON, rotated at 5 MB, stale files removed after 24 h)
- `updates/` — downloaded in-app updates

## Internal docs

Architecture, conventions and design rationale for contributors:

- [docs/ELECTRON.md](docs/ELECTRON.md) — Electron process model, what ships in the app bundle versus in-app updates, browser panels, macOS integration
- [docs/RELEASE_SIGNING.md](docs/RELEASE_SIGNING.md) — macOS code signing and the provisioning profile behind passkeys
- [docs/KEYBINDINGS.md](docs/KEYBINDINGS.md) — action registry, chords, focus navigation, find in panel, shortcuts inside webviews
- [docs/WATCHERS.md](docs/WATCHERS.md) — filesystem and git watchers, their ownership and the status refresh pipeline
- [docs/FILES_TREE.md](docs/FILES_TREE.md) — the shared `FilesTree` component: path identity, expansion, focus, reveal
- [docs/PROJECT_EXPLORER.md](docs/PROJECT_EXPLORER.md) — the project files panel: path model, Drafts and Others sections, reveal
- [docs/DIFF_VIEW_SPEC.md](docs/DIFF_VIEW_SPEC.md) — side-by-side diff spec: synchronized scrolling, intra-line highlights, gutter connectors
- [docs/SHARED_SERVER.md](docs/SHARED_SERVER.md) — shared server process: how all windows share one Bun server, discover-or-spawn, ownership, idle shutdown, and state scopes
