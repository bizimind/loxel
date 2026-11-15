---
title: Introduction
description: What Loxel is — an IDE where every task keeps its own context, built for running many coding agents at once while you stay the owner of the code.
section: "Start here"
order: 1
# Sections of the earlier introduction, and where their topics are now.
movedAnchors:
  parallel-workstreams: /docs/introduction#every-task-keeps-its-context
  planning-and-visibility: /docs/editor#data-widgets
  flexible-layout: /docs/introduction#a-browser-and-terminals-in-every-task
  git-and-code-review: /docs/introduction#and-the-rest-of-the-toolbox
  whats-in-the-docs: /docs/introduction#where-to-go-next
---

Loxel is an IDE for agentic coding. You run coding agents on many tasks at once, and every task keeps its own context: the terminals the agents run in, the browser tabs, the editors, the layout. Switch to a task and it's all there, right where you left it. Switch away and the agents keep going.

When agents write most of the code, your job changes. You decide what gets built, keep a dozen pieces of work moving, and own what ships. Loxel is built for that job.

---

## Every task keeps its context

A task in Loxel is a worktree: its own checkout and its own branch, so agents never trip over each other's changes. Everything you open while you're in it belongs to it: editors, terminals, browser tabs, diffs and the way you arranged them.

Click another worktree in the sidebar and the whole window turns into that task: its files and layout exactly as you left them, its terminals still running, its browser tabs back on their pages. `Ctrl+Alt+[` takes you back. There's no rebuilding your layout, no hunting for the terminal where the agent was running, no "which branch is this tab from?". Agents that split their work into sub-tasks can nest those worktrees under the parent, and a dot on a worktree tells you when something in it needs you.

---

## A real IDE, so you still own the code

Agents write the code and review much of it, at a pace no one can read line by line. You're still the one who ships it, so the tools for reading it are right here: a code editor with language servers for TypeScript, Python, Go, Rust, Java, C and C++, C# and more; a diff viewer with synchronized scrolling; a Git commit graph that shows every worktree's pending changes; and code review with comments that follow the code as agents rewrite it.

Sometimes one glance at a diff beats asking the agent to explain itself. Sometimes the code is critical enough that you want to read every line. Either way, the tools are right there in the task.

---

## Your agents, on your subscription

Loxel doesn't ship an agent of its own. It runs yours: Claude Code, Codex, OpenCode, Gemini CLI, or anything else that runs in a terminal, with your own account and your own settings. Press `Cmd+T` in a task, start the agent, and it's working in that task's worktree. When a better agent comes out, switch to it the same day.

---

## A browser and terminals in every task

Each task has its own terminals and its own browser tabs. The dev server for this branch, the PR the agent just opened, the logs of a test run: they live with the task, not in a pile of windows you have to sort through later. Terminals keep running when you switch away, scrollback and all, and browser panels are a full browser with DevTools, bookmarks, and logins shared across every task.

---

## `loxel`, for you and your agents

The `loxel` command opens files, pages and terminals in Loxel from any Loxel terminal. You use it to pull up a file without searching for it. Your agents use it, through the [`loxel` skill](/docs/coding-agents#teach-your-agent-about-loxel), to show you their work: the file to review, the dev server they started, another agent in a terminal of its own. Their opens land in the background, so they never yank you out of what you're doing.

```bash
loxel src/app.ts                          # open a file
loxel http://localhost:5173               # open a page in a browser panel
loxel terminal --split right -- pnpm dev  # run a command in a new split
```

---

## And the rest of the toolbox

- **Git** — an interactive commit graph with branch, author and date filters; cherry-pick, revert, reset and branch management, without leaving the task.
- **Code review** — named review sessions with comments anchored to the code. When an agent rewrites it, comments move with it, or are marked outdated with the original lines kept for comparison.
- **Drafts** — markdown notes (`Cmd+N`) and Excalidraw drawings (`Cmd+Shift+D`) that live outside the repo until you drag them in. Hand a draft to an agent as a spec, and keep it once it's worth keeping.
- **Data widgets** — a Table, Kanban, Calendar, Gantt, Graph or Form view right inside a markdown document, for task boards and decision logs (see [Data widgets](/docs/editor#data-widgets)).

---

## Install and launch

Download the latest release, open the disk image and drag Loxel to your Applications folder. Launch it from there: Loxel installs its updates in place, and if you open it from the disk image it offers to move itself to Applications first.

> **Note:** Loxel runs on macOS (Apple Silicon and Intel) and Linux (x64). Windows isn't supported yet.

---

## Where to go next

- **Start here** — [Getting Started](/docs/getting-started) takes you from install to an agent working on your first task, and [Core Concepts](/docs/core-concepts) explains the ideas behind it.
- **Tasks & context** — [Worktrees & Tasks](/docs/worktrees-and-tasks) · [Working on Parallel Tasks](/docs/parallel-tasks) · [Panel Layout](/docs/panel-layout) · [Drafts](/docs/drafts) · [Setting Up a New Project](/docs/guide-new-project)
- **Agents** — [Running Coding Agents](/docs/coding-agents) · [Loxel CLI](/docs/cli)
- **In the code** — [Editor](/docs/editor) · [Language Intelligence](/docs/language-intelligence) · [Terminals](/docs/terminals) · [Diff Viewer](/docs/diff-viewer) · [Browser](/docs/browser)
- **Review & Git** — [Code Review](/docs/code-review) · [Git](/docs/git) · [Guide: Reviewing Agent Code](/docs/guide-reviewing-agent-code)
- **Reference** — [Repository Trust](/docs/repository-trust) · [Keyboard Shortcuts](/docs/reference-keybindings) · [Environment Variables & Settings](/docs/reference-env-files-cli-settings)
