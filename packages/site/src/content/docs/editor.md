---
title: Editor
description: Quick Open, Find in Files, autosave, formatter auto-detection, and conflict handling.
order: 10
---

The editor is Monaco-based with a few loxel-specific behaviors layered on top: fast file navigation, autosave with conflict detection, and formatter auto-detection that works across the languages and toolchains your project actually uses.

---

## Quick Open

Press `Cmd+P` to open Quick Open. Type any part of a file path and results filter with fuzzy matching. File icons follow JetBrains conventions, so project structure is recognizable at a glance.

When the query is empty, Quick Open shows your 15 most recently opened files — useful for returning to files you were working in without retyping.

**Jump to a line:** append `:line` or `:line:col` to the filename. For example, `src/app.ts:42` opens `app.ts` and scrolls to line 42; `src/app.ts:42:8` positions the cursor at column 8 on that line. Line numbers are 1-indexed.

---

## Find in Files

Press `Cmd+Shift+F` to search across your project. Results show the matched line in context and navigate to the exact line and column when you click through.

Toggle controls in the search bar:

- **Regex** — treat the query as a regular expression
- **Case-sensitive** — disable case folding
- **Whole word** — match only at word boundaries

Use the scope filter to narrow results by package, directory, or file extension. Search has a 300ms debounce — results update as you type without hammering the backend on every keystroke.

---

## Autosave

Loxel autosaves 250ms after you stop typing, with a maximum 5s wait. You never have to remember to save during normal work.

Press `Cmd+S` to save immediately. Explicit save is the trigger for format on save — by default, the formatter runs only on `Cmd+S`, not on autosave. If you want the formatter to also run on autosave, enable **Format on autosave** in Settings > Editor.

> **Note:** Format on save is per-language. If no formatter is detected for the current file type, `Cmd+S` saves without formatting.

---

## Formatter auto-detection

Loxel detects which formatters are available in the active worktree by inspecting config files and `package.json`. Detection is per-worktree — switching worktrees picks up that worktree's toolchain.

Supported formatters:

| Formatter  | How it runs                                     |
| ---------- | ----------------------------------------------- |
| `prettier` | Loaded as a library — no per-file process spawn |
| `oxfmt`    | Persistent LSP subprocess — no spawn overhead   |
| `rustfmt`  | Detected and invoked on `.rs` files             |
| `ruff`     | Detected and invoked on `.py` files             |
| `yamlfmt`  | Detected and invoked on `.yaml`/`.yml` files    |

Loxel also detects other formatters from common config files. The full list of formatters found in the current worktree is visible in **Settings > Editor**.

---

## Conflict detection

If a file changes on disk while you have unsaved edits in the editor, a banner appears at the top of the file:

> **File changed on disk by another process.**

You have two choices:

- **Accept disk version** — discard your in-editor edits and load the version from disk
- **Keep my changes** — dismiss the banner and keep your current edits; the on-disk change is ignored until the next save

---

## File tree

The file tree supports keyboard-only navigation:

| Key                | Action                                                  |
| ------------------ | ------------------------------------------------------- |
| `↑` / `↓`          | Move between rows                                       |
| `→`                | Expand folder, or focus first child if already expanded |
| `←`                | Collapse folder, or jump to parent                      |
| `Space`            | Toggle expand/collapse                                  |
| `Enter`            | Open file / toggle folder                               |
| `F2` or `Shift+F6` | Rename                                                  |

**Git status coloring** is applied to every file and folder:

- **Modified** — amber/yellow
- **Untracked** — green
- **Ignored** — muted/gray

**Drag and drop:** files and folders can be dragged within the project tree to reorganize them. See [Drafts](/docs/drafts) for dragging draft files into the project.

---

## TypeScript diagnostics

Real-time errors and warnings from TypeScript appear as inline Monaco markers as you type — no manual run required. The full language server feature set (hover, go-to-definition, completions, rename, and more) is covered in [TypeScript Intelligence](/docs/typescript-intelligence).

---

## See also

- [TypeScript Intelligence](/docs/typescript-intelligence) — per-worktree language server, completions, hover, go-to-definition, and more
- [Drafts](/docs/drafts) — draft files autosave on the same schedule as the code editor
- [Diff Viewer](/docs/diff-viewer) — viewing file changes in split or unified view
