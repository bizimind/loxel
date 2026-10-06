---
title: Core Concepts
description: The four foundational ideas behind how Loxel organizes your work.
order: 2
---

Before diving into specific features, it helps to understand the four ideas that shape how Loxel organizes your work. Everything else builds on these.

---

## Contexts

Your unit of focus in Loxel is a **context**: one project plus one worktree. When you switch worktrees, Loxel restores exactly the state you left behind — open files, panel sizes and positions, agent sessions, search filters, and commit graph selection. Nothing resets.

Context state is saved by Loxel, so it survives reloads, restarts, and multiple windows. Each worktree has its own completely independent workspace.

Click a worktree in the sidebar to switch to it. Use `Ctrl+Alt+[` / `Ctrl+Alt+]` to go back and forward through the ones you visited.

---

## Worktrees as isolation

Branches alone don't give you parallel workstreams — you can only have one checked-out state at a time. Worktrees do. Each worktree is a separate working directory pointing at a different branch, and they coexist without interfering.

Loxel is built around bare repos for this reason. A bare repo has no working tree of its own; it exists only to hold worktrees. This keeps the structure clean when you have many parallel branches in flight.

If you're working on a single branch and don't need parallelism, a regular repo works fine. But if you're directing multiple agents across concurrent tasks, a bare repo with one worktree per task is the right setup.

---

## Drafts vs. repo files

Not everything belongs in the repo immediately. Loxel has a **Drafts** section in the Project Files panel where you can create markdown notes and Excalidraw drawings that don't live inside any repo. These are called **drafts**.

Drafts are scoped per project + worktree — they're stored in Loxel's [state directory](/docs/reference-env-files-cli-settings#file-locations) and are not shared across worktrees. A draft you create while working on a feature branch stays with that worktree context.

When a draft is ready to become part of the repo, drag it from the Drafts section into any folder in the project file tree. Loxel moves the file and updates any open editors. The typical flow: sketch a design doc or architecture diagram as a draft, hand it to the coding agent, then move it into the repo once it's worth keeping.

---

## Review as a first-class workflow

Code review isn't an afterthought in Loxel — it's built into the editor. You can start a named **review session**, leave comments anchored to specific lines in a diff, and those comments track through code changes.

Each comment remembers the lines it was left on and the code around them. When the code changes, Loxel finds where those lines went — at the same spot, nearby, or elsewhere in the file. If the code has been edited but context lines still match, the comment is marked `outdated` and keeps the original lines so you can compare. Only if the code is gone entirely does a comment become `lost`.

This is particularly useful when reviewing AI-generated code across multiple agent iterations. Leave comments that capture intent — questions, concerns, design rationale — and they'll follow the code through rewrites rather than becoming stale line-number artifacts.

Review sessions belong to the repo (not to a worktree), so all worktrees of the same repository share the same review history.

---

## See also

- [Worktrees & Projects](/docs/worktrees-and-projects) — how Loxel manages projects, bare repos, and per-context layout persistence
- [Drafts](/docs/drafts) — full reference for creating, storing, and moving draft files
- [Code Review](/docs/code-review) — anchor system, sessions, threads, and export
- [Getting Started](/docs/getting-started) — apply these concepts to a real project in minutes
