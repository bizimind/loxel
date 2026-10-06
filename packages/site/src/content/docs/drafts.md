---
title: Drafts
description: Markdown and Excalidraw files outside your repo, and how to move them in.
order: 11
---

Drafts let you sketch a design doc or architecture diagram before deciding where it lives in your repo. They exist outside any git tree — no branch, no staging, no tracking — until you explicitly move them in.

---

## What drafts are

A draft is a file — usually markdown (`.md`) or Excalidraw (`.excalidraw`) — stored in Loxel's own state directory, outside your project. Drafts appear in a **Drafts** section at the top of the Project Files panel, shown once you have at least one, with their names in muted italics to set them apart from repo files.

They behave identically to their repo-file counterparts:

- `.md` drafts open in the live-preview markdown editor
- `.excalidraw` drafts open in the full drawing canvas

Both autosave on the same schedule as the code editor.

---

## Creating a draft

| Action                 | Shortcut                 |
| ---------------------- | ------------------------ |
| New markdown draft     | `Cmd+N` or `Cmd+Shift+M` |
| New Excalidraw drawing | `Cmd+Shift+D`            |

New drafts get the first free name: "Note 1.md", "Note 2.md", and so on for markdown, "Drawing 1.excalidraw" for drawings. Rename them via `F2` or `Shift+F6` in the file tree, or by double-clicking the editor tab.

---

## Where drafts are stored

```
~/.local/state/loxel/loxel/detached/{projectHash}/{wtHash}/
```

Drafts are scoped per project + worktree. Switching to a different worktree shows that worktree's own Drafts section — drafts are not shared across worktrees.

The path is inside Loxel's state directory; see [File Locations](/docs/reference-env-files-cli-settings#file-locations) for how the hashed folder names are derived.

---

## Autosave

Drafts autosave on the same schedule as the code editor (250ms after you stop typing, at most 5s). Press `Cmd+S` to save immediately. See [Editor](/docs/editor#autosave) for details.

---

## Moving a draft into the repo

When a draft is ready to become part of the project, drag it from the Drafts section into any folder in the active worktree's file tree (drop it on empty space for the worktree root). You can also cut it (`Cmd+X`) and paste it (`Cmd+V`) into a folder, or copy and paste to keep the draft as well. The move fails if a file with the same name already exists there.

Loxel moves the file and any open editor for it keeps working — no need to reopen it. After the move, the file is a regular repo file, tracked by git like any other.

> **Note:** Moving a draft into the project is one-way. There is no drag-back to Drafts — once a file is in the repo, treat it as a repo file. Deleting a draft can't be undone.

---

## Workflow example

A common pattern when working with the coding agent:

1. `Cmd+N` — open a markdown draft and outline the approach
2. Point the agent at the draft — paste its contents or its path into the prompt
3. When the design is settled, drag the doc into `docs/` in the project tree
4. Commit it alongside the implementation

The same works for architecture diagrams: `Cmd+Shift+D`, sketch the system, drag it into the repo when it's worth keeping.

---

## See also

- [Editor](/docs/editor) — autosave behavior that applies equally to drafts; format on save
- [Coding Agent](/docs/coding-agent) — handing draft context documents to the agent
- [Worktrees & Projects](/docs/worktrees-and-projects) — drafts are scoped per project + worktree, just like layout state
