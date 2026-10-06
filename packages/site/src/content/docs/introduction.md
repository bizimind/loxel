---
title: Introduction
description: An overview of Loxel — the IDE built for directing AI agents across parallel workstreams.
order: 1
---

Loxel is an IDE for directing AI agents across parallel workstreams. It combines git management, code review, a built-in coding agent, terminals, a markdown editor with embedded data widgets, an Excalidraw canvas, a browser panel, and TypeScript intelligence — all in a single interface built around fast context switching. If you're running multiple agents at once, each on its own branch, each mid-task, Loxel gives you the visibility and layout flexibility to keep everything moving.

## Parallel workstreams

The core workflow: create a worktree per task, hand it to an agent, switch to something else while it runs. Loxel treats the worktree as the unit of focus — each one has its own panel layout, open files, and agent sessions. Switch worktrees from the sidebar, then `Ctrl+Alt+[` takes you back — your previous context is waiting exactly as you left it.

Running three or four agents in parallel requires visibility into what each one is doing, review tooling that survives repeated rewrites, and context switching that doesn't cost you 30 seconds of layout reconstruction. That's the problem Loxel is built to solve.

## Planning and visibility

Loxel ships with two planning tools that live in the same layout as your code and terminals.

The **Excalidraw canvas** (`Cmd+Shift+D`) gives you a drawing surface for architecture diagrams, flow sketches, and rough planning. No separate app, no copy-pasting screenshots — just another panel.

The **markdown editor** (`Cmd+N`) supports embedded data widgets via the `:::localdb` directive. Insert a Table, Kanban, Calendar, Gantt, Graph, or Form view directly in any document — task tracking, decision logs, sprint boards. Widget data is stored per project and updates live across open editors. Add one via the block menu: Data > Database Widget.

Drafts live outside the repo until you're ready to commit them. Drag a file from the Drafts section into any project folder and Loxel moves it into the repo, no editor disruption.

## Flexible layout

Loxel's panel system lets you place any panel wherever it fits your workflow — side by side, stacked, in its own group. That goes for agents too.

The **built-in coding agent** has a dedicated timeline UI: user messages, assistant responses, reasoning blocks, tool calls, and plan steps all visible at once. It connects to OpenRouter; add your models and API keys in Settings > Models.

If you prefer a TUI agent — Claude Code, Codex, OpenCode, Gemini CLI, or anything else that runs in a terminal — open one in a Loxel terminal with `Cmd+T` and run it there. Both workflows coexist. Put a coding agent panel next to your editor, or run two TUI agents in split terminals. Layout is yours to configure.

Press `Cmd+Shift+B` to open a browser panel. It's a full web browser inside Loxel — use it to view your local dev server, browse GitHub, or read a tutorial. Works like any other panel: drag it next to a coding agent, split it below your editor, or pop it into its own group. Press `Cmd+F` to find text in the page. From a Loxel terminal, `loxel https://example.com` opens any URL directly in this panel.

## Git and code review

The Git panel shows an interactive commit graph with multi-select, branch filtering, author filtering, and date presets. Cherry-pick, revert, reset with confirmation, discard changes, and manage branches — all without leaving the IDE.

Code review is built in. Start a named review session, add comments anchored to specific lines of a diff, and Loxel tracks those comments as the code changes — relocating them when code moves, marking them outdated when the lines change. Comments survive repeated agent iterations, which is exactly when you need them to.

## Install and launch

Download the latest release and run the installer. Launch Loxel from your Applications folder (macOS) or app launcher.

Once Loxel is running, use the `loxel` CLI inside any Loxel terminal to open files and URLs in it:

```bash
loxel src/app.ts          # open a file in the active window
loxel https://example.com # open a URL in the browser panel
```

> **Note:** The installer doesn't add the `loxel` CLI to your system PATH yet, so it only works from inside a Loxel terminal.

> **Note:** Loxel runs on macOS (Apple Silicon and Intel) and Linux (x64). Windows isn't supported yet.

## What's in the docs

- [Core Concepts](/docs/core-concepts) — the mental model: contexts, worktrees, drafts, and why review is built in

- [Getting Started](/docs/getting-started) — add your first project, tour the layout, create a worktree

- **Features** — detailed coverage of every panel and capability:
  [Worktrees & Projects](/docs/worktrees-and-projects) · [Panel Layout](/docs/panel-layout) · [Git](/docs/git) · [Code Review](/docs/code-review) · [Coding Agent](/docs/coding-agent) · [Diff Viewer](/docs/diff-viewer) · [Editor](/docs/editor) · [Drafts](/docs/drafts) · [Terminals](/docs/terminals) · [TypeScript Intelligence](/docs/typescript-intelligence)

- **Reference** — [Keyboard Shortcuts](/docs/reference-keybindings) · [Env Vars / File Locations / CLI / Settings](/docs/reference-env-files-cli-settings)

- **Guides** — [Parallel Workstreams](/docs/guide-parallel-workstreams) · [Reviewing Agent Code](/docs/guide-reviewing-agent-code) · [New Project](/docs/guide-new-project)
