---
title: Drafts
description: Markdown and Excalidraw files outside your repo, and how to move them in.
order: 11
---

Drafts let you sketch a design doc or architecture diagram before deciding where it lives in your repo. They exist outside any git tree — no branch, no staging, no tracking — until you explicitly move them in.

---

## What drafts are

A draft is a markdown (`.md`) or excalidraw (`.excalidraw`) file stored in loxel's own state directory, outside your project. Drafts appear in a **Detached** section at the top of the project files panel, visually separate from repo files.

They behave identically to their repo-file counterparts:

- `.md` drafts open in the markdown editor (Milkdown-based rich editor)
- `.excalidraw` drafts open in the full drawing canvas

Both autosave on the same schedule as the code editor.

---

## Creating a draft

| Action                 | Shortcut      |
| ---------------------- | ------------- |
| New markdown draft     | `Cmd+N`       |
| New excalidraw drawing | `Cmd+Shift+D` |

Drafts are named sequentially: "Note 1.md", "Note 2.md", and so on. Rename them via `F2` or `Shift+F6` in the file tree.

---

## Where drafts are stored

```
~/.local/state/loxel/detached/<projectHash>/<worktreeHash>/
```

Drafts are scoped per project + worktree. Switching to a different worktree shows that worktree's own Detached section — drafts are not shared across worktrees.

> **Note:** Hashes are the first 12 hex characters of the SHA-256 of the respective path.

---

## Autosave

Drafts autosave on the same schedule as the code editor (250ms debounce, 5s maximum wait). Press `Cmd+S` to save immediately. See [Editor](/docs/editor#autosave) for details.

---

## Moving a draft into the repo

When a draft is ready to become part of the project, drag it from the Detached section into any folder in the project file tree.

Loxel moves the file, updates the editor's internal path, and the editor keeps working — no need to reopen it. After the move, the file is a regular repo file, tracked by git like any other.

> **Note:** Drag-to-project is a one-way operation. There is no drag-back to Detached — once a file is in the repo, treat it as a repo file.

---

## Workflow example

A common pattern when working with the coding agent:

1. `Cmd+N` — open a markdown draft and outline the approach
2. Hand the draft to the agent as context for the task
3. When the design is settled, drag the doc into `docs/` in the project tree
4. Commit it alongside the implementation

The same works for architecture diagrams: `Cmd+Shift+D`, sketch the system, drag it into the repo when it's worth keeping.

---

## See also

- [Editor](/docs/editor) — autosave behavior that applies equally to drafts; format on save
- [Coding Agent](/docs/coding-agent) — handing draft context documents to the agent
- [Worktrees & Projects](/docs/worktrees-and-projects) — drafts are scoped per project + worktree, just like layout state
