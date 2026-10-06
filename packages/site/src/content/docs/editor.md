---
title: Editor
description: Quick Open, Find in Files, autosave, formatter auto-detection, and conflict handling.
order: 10
---

The editor is Monaco-based with a few Loxel-specific behaviors layered on top: fast file navigation, autosave with conflict detection, and formatter auto-detection that works across the languages and toolchains your project actually uses.

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

Use the scope filter to narrow results by package, directory, or file extension. Results update as you type.

---

## Autosave

Loxel autosaves 250ms after you stop typing, with a maximum 5s wait. You never have to remember to save during normal work.

Press `Cmd+S` to save immediately. Explicit save is the trigger for format on save — by default, the formatter runs only on `Cmd+S`, not on autosave. If you want the formatter to also run on autosave, enable **Also format on auto-save** in Settings > Editor.

> **Note:** Format on save is per-language. If no formatter is detected for the current file type, `Cmd+S` saves without formatting.

---

## Formatter auto-detection

Loxel detects which formatters are available in the active worktree by inspecting config files and `package.json`. Detection is per-worktree — switching worktrees picks up that worktree's toolchain.

Supported formatters:

| Formatter      | Detected from                                              | Formats                                              |
| -------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| `prettier`     | A Prettier config file or `prettier` key in `package.json` | JS/TS, CSS, JSON, markdown, YAML, HTML, Vue, GraphQL |
| `oxfmt`        | An `.oxfmtrc.*` file or an `oxfmt` dependency              | The same as Prettier, plus TOML                      |
| `rustfmt`      | `rustfmt.toml`                                             | `.rs` files                                          |
| `ruff`         | `pyproject.toml`                                           | `.py` files                                          |
| `clang-format` | `.clang-format`                                            | C and C++ files                                      |
| `deno`         | `deno.json`                                                | JS and TS files                                      |

When a project has both Prettier and oxfmt, Prettier wins for the languages it supports. The formatters found in the current worktree are listed in **Settings > Editor**, where you can also add manual overrides that take precedence over detection.

---

## Markdown files

Markdown files open in a live-preview markdown editor. Saving rewrites only the blocks you changed: untouched paragraphs, lists, and tables keep their original formatting, so editing one section doesn't reformat the rest of the file. Tables size their columns to their content and scroll horizontally when wide. `:::localdb` blocks render as [database widgets](/docs/introduction#planning-and-visibility); any other `:::name` or `::name` directive stays plain text, and text like `10:30am` is never treated as a directive.

---

## Conflict detection

If a file changes on disk while you have unsaved edits in the editor, a banner appears at the top of the file:

> **File changed on disk by another process.**

You have two choices:

- **Accept disk version** — discard your in-editor edits and load the version from disk
- **Keep my changes** — dismiss the banner and keep your current edits; the on-disk change is ignored until the next save

---

## File tree

The file tree in the Project Files panel supports keyboard-only navigation:

| Key                | Action                                                  |
| ------------------ | ------------------------------------------------------- |
| `↑` / `↓`          | Move between rows                                       |
| `Cmd+↑` / `Cmd+↓`  | Jump to the first / last entry in the current folder    |
| `→`                | Expand folder, or focus first child if already expanded |
| `←`                | Collapse folder, or jump to parent                      |
| `Space`            | Toggle expand/collapse                                  |
| `Enter`            | Open file / toggle folder                               |
| `F2` or `Shift+F6` | Rename                                                  |

Type the start of a name to jump to the next visible entry that starts with it. Typing one letter repeatedly steps through the entries starting with that letter; letters typed in quick succession build up a longer prefix.

Clicking an entry focuses it, so keyboard navigation continues from there.

**Git status coloring** is applied to every file and folder:

- **Modified** — amber/yellow
- **Untracked** — green
- **Ignored** — muted/gray

**Drag and drop:** files and folders can be dragged within the project tree to reorganize them. See [Drafts](/docs/drafts) for dragging draft files into the project.

**Context menu:** right-click a file or folder for New File, New Directory, Rename, Cut, Copy, Paste, Delete, Copy Name, Copy Relative Path, and Copy Absolute Path; on macOS also **Reveal in Finder** and **Open In** (the apps macOS offers for a file; installed terminals and editors for a folder). A modified file or folder also gets **Git Restore**.

**Reveal the active file:** press `Cmd+Alt+E` to show the active editor's file in the tree. To do this automatically whenever you switch tabs, turn on auto-reveal in **Settings > General**.

### Other folders

Folders outside every project can be opened in the **Others** section at the bottom of the file tree, next to files opened from outside the worktree. Open one with `loxel <folder>` (see [the `loxel` CLI](/docs/reference-env-files-cli-settings#loxel-cli)), or by `Cmd`-clicking a folder path in a terminal or a folder link in a markdown file. If the folder is inside a project's worktree instead, Loxel switches to that worktree and reveals the folder in its tree.

A folder that contains one of your projects can't be opened this way, nor can the filesystem root or your home folder (they are too large to watch); open a folder inside them instead. Other folders belong to the worktree they were opened in and are remembered across restarts, until the worktree is removed. A folder opened in several worktrees stays in sync across all of them. They work like the project tree — open, edit and save files with conflict detection, create, rename, delete, cut/copy/paste and drag within the folder, undo with `Cmd+Z` — with these differences:

- No git status coloring, and file operations never use git, even if the folder sits inside a repo
- Files and folders can't be moved or copied between the project and an other folder
- Format on save does not apply, since formatters are detected per worktree
- Quick Open, full-text search and project diagnostics cover the worktree only
- Language features come from the active worktree's language servers, so results depend on how each server handles files outside its workspace

Right-click a folder's root row and choose **Remove from Others** to close it; nothing is deleted from disk.

### Opening files from Finder

On macOS, Loxel appears in Finder's **Open With** menu for text and source files and `.excalidraw` drawings. You can also drop files and folders on Loxel's Dock icon, or open them with `open -a Loxel <path>`. Loxel never takes over a file type another app already opens: to open, say, markdown files with Loxel on double-click, select one, choose **File → Get Info**, pick Loxel under **Open with**, and click **Change All…**. File types no other installed app handles, such as `.excalidraw`, open in Loxel on double-click.

An opened file or folder goes to the most recently focused Loxel window, launching Loxel or opening a window first if needed. If it is inside one of your projects' worktrees, Loxel switches to that worktree and opens it there; anything else opens in the active worktree's [Others section](#other-folders), which needs a project to be open. Files open in the editor for their type — markdown, Excalidraw or code.

---

## TypeScript diagnostics

Real-time errors and warnings from TypeScript appear inline in the editor as you type — no manual run required. The full language server feature set (hover, go-to-definition, completions, rename, and more) is covered in [TypeScript Intelligence](/docs/typescript-intelligence).

---

## See also

- [TypeScript Intelligence](/docs/typescript-intelligence) — per-worktree language server, completions, hover, go-to-definition, and more
- [Drafts](/docs/drafts) — draft files autosave on the same schedule as the code editor
- [Diff Viewer](/docs/diff-viewer) — viewing file changes in split or unified view
