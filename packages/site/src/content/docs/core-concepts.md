---
title: Core Concepts
description: The four foundational ideas behind how Loxel organizes your work.
section: "Start here"
order: 3
# Sections that moved; old links to them keep working.
movedAnchors:
  contexts: /docs/core-concepts#tasks-and-their-context
---

Before diving into specific features, it helps to understand the four ideas that shape how Loxel organizes your work. Everything else builds on these.

---

## Tasks and their context

Your unit of focus in Loxel is a **task**: a worktree of one of your projects, plus everything you have open in it. All of that is the task's context: its editors and open files, its terminals and the agents running in them, its browser tabs, the panel layout, search filters and commit graph selection. When you switch tasks, Loxel puts the one you're going to back the way you left it: same files, same layout, terminals still running, browser tabs reopened on their pages.

Task context is saved by Loxel, so it survives reloads, restarts, and multiple windows. Terminals keep running while you're in another task, until you quit Loxel, so an agent you started an hour ago is still at it when you come back. [Quit and Keep Terminals](/docs/terminals#quitting-without-ending-your-terminals) keeps them running even while Loxel is closed.

Click a worktree in the sidebar to switch to its task. Use `Ctrl+Alt+[` / `Ctrl+Alt+]` to go back and forward through the ones you visited.

---

## Worktrees as isolation

Branches alone don't let you work on tasks in parallel — you can only have one checked-out state at a time. Worktrees do. Each worktree is a separate working directory pointing at a different branch, and they coexist without interfering.

Loxel is built around bare repos for this reason. A bare repo has no working tree of its own; it exists only to hold worktrees. This keeps the structure clean when you have many parallel branches in flight.

If you're working on a single branch and don't need parallelism, a regular repo works fine. But if you're directing multiple agents across concurrent tasks, a bare repo with one worktree per task is the right setup.

---

## Drafts vs. repo files

Not everything belongs in the repo immediately. Loxel has a **Drafts** section in the Project Files panel where you can create markdown notes and Excalidraw drawings that don't live inside any repo. These are called **drafts**.

Drafts are scoped per project + worktree — they're stored in Loxel's [state directory](/docs/reference-env-files-cli-settings#file-locations) and are not shared across worktrees. A draft you create while working on a feature branch stays with that task.

When a draft is ready to become part of the repo, drag it from the Drafts section into any folder in the project file tree. Loxel moves the file and updates any open editors. The typical flow: sketch a design doc or architecture diagram as a draft, hand it to the coding agent, then move it into the repo once it's worth keeping.

---

## Review as a first-class workflow

Code review isn't an afterthought in Loxel — it's built into the editor. You can start a named **review session**, leave comments anchored to specific lines in a diff, and those comments track through code changes.

Each comment remembers the lines it was left on and the code around them. When the code changes, Loxel finds where those lines went — at the same spot, nearby, or elsewhere in the file. If the code has been edited but context lines still match, the comment is marked `outdated` and keeps the original lines so you can compare. Only if the code is gone entirely does a comment become `lost`.

This is particularly useful when reviewing AI-generated code across multiple agent iterations. Leave comments that capture intent — questions, concerns, design rationale — and they'll follow the code through rewrites rather than becoming stale line-number artifacts.

Review sessions belong to the repo (not to a worktree), so all worktrees of the same repository share the same review history.

---

## See also

- [Worktrees & Tasks](/docs/worktrees-and-tasks) — how Loxel manages projects, bare repos, and the layout each task keeps
- [Drafts](/docs/drafts) — full reference for creating, storing, and moving draft files
- [Code Review](/docs/code-review) — anchor system, sessions, threads, and export
- [Getting Started](/docs/getting-started) — apply these concepts to a real project in minutes
