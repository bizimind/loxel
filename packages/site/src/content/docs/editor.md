---
title: Editor
description: Quick Open, Go to Symbol, Find in Files, autosave, formatter auto-detection, indentation, EditorConfig, Python files, conflict handling, and deleted or moved files.
order: 10
---

The editor is Monaco-based with a few Loxel-specific behaviors layered on top: fast file navigation, autosave with conflict detection, and formatter auto-detection that works across the languages and toolchains your project actually uses.

---

## Quick Open

Press `Cmd+P` to open Quick Open. Type any part of a file path and results filter with fuzzy matching. File icons reflect file type and language, so project structure is recognizable at a glance.

When the query is empty, Quick Open shows your 15 most recently opened files — useful for returning to files you were working in without retyping.

**Jump to a line:** append `:line` or `:line:col` to the filename. For example, `src/app.ts:42` opens `app.ts` and scrolls to line 42; `src/app.ts:42:8` positions the cursor at column 8 on that line. Line numbers are 1-indexed.

---

## Go to Symbol

Press `Cmd+Alt+O` (or run **Go to Symbol in Workspace** from the command palette) to find a class, function, method or other symbol anywhere in the worktree by name. Results filter with fuzzy matching as you type and show each symbol's kind, the class or module that contains it, and its file and line. Press `Enter` to open the file at the symbol.

Symbols come from the worktree's language servers, so what is searched follows what you have open: TypeScript symbols cover the projects of the TypeScript files you have open (in a monorepo, open a file in a package to include that package), and other languages whose language server supports symbol search, such as Python and Terraform, are searched once a file of that language is open. Among equally good matches, your project's own symbols are listed before those of installed packages. Results appear as each language server answers.

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

> **Note:** Format on save is per-language. If no formatter is detected for the current file type, `Cmd+S` saves without formatting. If a detected formatter isn't installed, can't start, or takes longer than 5 seconds, the file is saved unformatted and Loxel tells you once per session.

---

## Formatter auto-detection

Loxel detects which formatters are available in the active worktree by inspecting config files, `package.json` and `pyproject.toml`. Detection is per-worktree — switching worktrees picks up that worktree's toolchain.

Supported formatters:

| Formatter      | Detected from                                                            | Formats                                              |
| -------------- | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| `prettier`     | A Prettier config file or `prettier` key in `package.json`               | JS/TS, CSS, JSON, markdown, YAML, HTML, Vue, GraphQL |
| `oxfmt`        | An `.oxfmtrc.*` file or an `oxfmt` dependency                            | The same as Prettier, plus TOML                      |
| `rustfmt`      | `rustfmt.toml`                                                           | `.rs` files                                          |
| `ruff`         | `ruff.toml`, `.ruff.toml`, a `[tool.ruff]` table, or a `ruff` dependency | `.py` and `.pyi` files                               |
| `black`        | A `[tool.black]` table in `pyproject.toml`, or a `black` dependency      | `.py` and `.pyi` files                               |
| `clang-format` | `.clang-format`                                                          | C and C++ files                                      |
| `deno`         | `deno.json`                                                              | JS and TS files                                      |

When a project has both Prettier and oxfmt, Prettier wins for the languages it supports.

Python formatters are detected from the config closest to the file, so each project in a monorepo can use its own. Because ruff is often configured just for linting, black wins when a project configures or depends on both, unless the ruff config has a `format` section. A `pyproject.toml` that neither configures nor depends on ruff or black isn't formatted; add a manual override if you want it formatted anyway. Loxel runs ruff and black from the project's Python environment when they're installed there (and the environment isn't committed to git), so the version pinned in your dev dependencies is the one used: a sub-project's own `.venv`, `venv` or `env` first, then the worktree's [Python environment](/docs/languages/python#python-environment), including an interpreter you chose, and files your ruff config excludes are left as they are. The formatters found at the root of the current worktree are listed in **Settings > Editor**, where you can also add manual overrides that take precedence over detection.

---

## Indentation

Each file's indentation comes from the first of these that sets it:

1. A choice made for the file with **Editor: Change Indentation**, for as long as its tab is open.
2. The project's [`.editorconfig`](#editorconfig).
3. A **Per-Extension Override** in **Settings > Editor**.
4. The file's own content: an existing file keeps the style it's written in, so Enter and Tab don't mix 2-space indents into a 4-space file or spaces into a tab-indented one.
5. The language's convention, matching its formatter or official style guide: Python, Rust, C#, Kotlin, PHP and justfiles use 4 spaces, and Go and Makefiles use tabs. Makefiles get tabs even when the file's content is mostly indented with spaces, because make requires recipe lines to start with a tab.
6. **Default Indentation** in **Settings > Editor**, 2 spaces unless you change it.

Each property is looked up on its own, so an `.editorconfig` that only sets `indent_style = space` takes the size from the next source down. A project's `.editorconfig` wins over your per-extension overrides because it's the convention everyone working on the project, and its formatters, follow; your overrides apply wherever a project doesn't set one.

TypeScript and JavaScript quick fixes, such as **Implement interface**, indent the code they insert the same way as the file you apply them in.

While a code file is the active editor, the status bar shows its indentation (`Spaces: 4` or `Tab Size: 4`), where that came from, and its line endings (`LF` or `CRLF`). Hover it for details, including when the project's `.editorconfig` outranks one of your overrides. Click it, or run **Editor: Change Indentation** from the command palette, to indent the file with spaces or tabs at another size, convert its existing indentation to spaces or tabs, or go back to the automatic choice.

---

## EditorConfig

Loxel follows your project's [`.editorconfig`](https://editorconfig.org) files. For each file it reads the `.editorconfig` in the file's folder and in every folder above it, up to the worktree root (or the root of an [other folder](#other-folders)), and stops early at one that sets `root = true`. When several set the same property, the closest file wins.

| Property                                   | Effect                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| `indent_style`, `indent_size`, `tab_width` | Indentation as you type, over your settings (see [Indentation](#indentation)) |
| `max_line_length`                          | A vertical ruler at that column                                               |
| `trim_trailing_whitespace`                 | Trailing spaces and tabs are removed on save                                  |
| `insert_final_newline`                     | A missing final newline is added on save; `false` leaves the file as it is    |
| `end_of_line`                              | Line endings are converted to `lf` or `crlf` on save                          |

Changes made on save are a separate step in the undo history, so `Cmd+Z` brings them back, and the autosave after an undo leaves the file as you restored it. On autosave, whitespace at the end of the lines you're typing on is kept, so a space you just typed doesn't vanish; it's removed by a later save. Edits to an `.editorconfig` apply to open files right away.

A newly opened file can be edited once its `.editorconfig` has been read, at most half a second after it opens, so your first keystrokes already follow it. `charset` and `end_of_line = cr` aren't applied by the editor. When Prettier formats on save, it reads `.editorconfig` too, `max_line_length` included, just like the Prettier command line. Markdown files and drawings are saved in their editors' own formats and don't use `.editorconfig`, and neither do drafts or files opened from outside a project.

---

## Python files

Python source (`.py`), stub (`.pyi`), and `.pyw` files get highlighting and [Python language features](/docs/languages/python). Typing `"""` or `'''` adds the closing quotes, typing the closing quotes steps over them, and pressing Enter after `return`, `pass`, `break`, `continue`, or `raise` dedents the next line.

Project files are recognized too: `pyproject.toml`, `uv.lock`, `poetry.lock`, and `Pipfile` are highlighted as TOML, `Pipfile.lock` as JSON, and `requirements*.txt`, `requirements*.in`, `requirements/*.txt`, and `constraints*.txt` as pip requirements. In the file tree, `.venv`, `venv`, `__pycache__`, and Python tool cache folders show a distinct folder icon. To treat other files as a given language, add a glob in **Settings > File Associations**.

---

## Markdown files

Markdown files open in a live-preview markdown editor. Saving rewrites only the blocks you changed: untouched paragraphs, lists, and tables keep their original formatting, so editing one section doesn't reformat the rest of the file. Tables size their columns to their content and scroll horizontally when wide. `Shift+Enter` starts a new line within a paragraph and saves it as a plain line break, and line breaks already in the file show as new lines; pressing it twice starts a new paragraph. GitHub and most markdown renderers display a plain line break as a space. A trailing `\` or two trailing spaces keep the break visible everywhere, and Loxel keeps such breaks (writing them as `\` when you edit their paragraph). An empty line inside a paragraph can only be written as a `\` line, so Loxel saves it that way. `:::localdb` blocks render as [database widgets](/docs/introduction#planning-and-visibility); any other `:::name` or `::name` directive stays plain text, and text like `10:30am` is never treated as a directive.

---

## Conflict detection

If a file changes on disk while you have unsaved edits in the editor, a banner appears at the top of the file:

> **File changed on disk by another process.**

You have two choices:

- **Accept disk version** — discard your in-editor edits and load the version from disk
- **Keep my changes** — dismiss the banner and keep your current edits; the on-disk change is ignored until the next save

## Deleted files

If a file you have open is deleted outside Loxel (a `git checkout`, an agent cleaning up, `rm` in a terminal), the tab stays open but its name is struck through and dimmed, and a banner at the top of the editor says the file was deleted from disk. Your content stays in the editor and you can keep editing, but nothing is written while the file is gone: autosave does not quietly bring it back.

To restore the file from Loxel, press `Cmd+S` and confirm in the dialog, or click **Re-create file** in the banner. Either writes the editor's current content back to disk. If something else restores the file first, the tab returns to normal on its own: a clean editor reloads the new content, and an editor with unsaved edits merges them with the usual conflict detection.

---

## Moved and renamed files

When a file you have open is renamed or moved, by Loxel or by anything else (`mv`, `git mv`, an agent refactoring, another editor), its tab follows it: the tab takes the new name and keeps its place, and unsaved edits are saved to the new location. If the file was also changed at its new location, your edits are merged into that version; if they overlap, the tab stays where it was and shows as deleted, so neither side is lost. Moving a folder works the same way for every open file inside it.

If the move happened outside Loxel, a banner at the top of the editor shows where the file was and where it is now, so the changed tab doesn't come as a surprise. It stays until you click **Dismiss**. Renames and moves you make in Loxel don't show the banner, and other Loxel windows on the same worktree follow them too.

A file showing the [conflict banner](#conflict-detection) doesn't follow a move, because saving your side at the new location would overwrite the other change. Its tab stays where it was and shows as deleted, so you can copy what you need or re-create it.

A file moved to another disk, or into a folder Loxel doesn't watch (such as a git-ignored folder or one outside the project), can't be followed, so it shows as [deleted](#deleted-files) instead. The same applies to drafts and to files opened on their own from outside a project.

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

**Compare Files:** click a file, then right-click another file and choose **Compare Files** to open both in a diff, the first file on the left. Both sides stay editable. See [Comparing two files](/docs/diff-viewer#comparing-two-files).

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

Real-time errors and warnings from TypeScript appear inline in the editor as you type — no manual run required. The full language server feature set (hover, go-to-definition, completions, rename, and more) is covered in [Language Intelligence](/docs/language-intelligence), along with the language servers for Python and other languages.

---

## See also

- [Language Intelligence](/docs/language-intelligence) — per-worktree language servers, Python environments, completions, hover, go-to-definition, and more
- [Drafts](/docs/drafts) — draft files autosave on the same schedule as the code editor
- [Diff Viewer](/docs/diff-viewer) — viewing file changes in split or unified view
