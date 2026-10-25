---
title: TypeScript Intelligence
description: Per-worktree language servers, supported features, and other language servers.
order: 13
---

Loxel runs a dedicated TypeScript language server per worktree and connects it to the editor. You get hover docs, go-to-definition, completions, rename, and more — isolated per context, with no cross-worktree interference.

---

## Per-worktree language server

The active worktree gets its own TypeScript language server process. Switching worktrees stops it and starts a fresh one for the worktree you switch to, so expect a short warm-up after a switch. There is no shared server state between worktrees — if one worktree is using an older TypeScript config or a different version of your packages, it does not affect any other worktree's language server.

---

## Supported features

| Feature          | Description                                  |
| ---------------- | -------------------------------------------- |
| Hover            | Type information and JSDoc for any symbol    |
| Go-to-definition | Jump to the declaration of any symbol        |
| Find references  | Jump to the usages of a symbol               |
| Completions      | Context-aware autocompletion as you type     |
| Rename           | Rename a symbol and update all references    |
| Code actions     | Quick fixes, imports, and refactors          |
| Signature help   | Function parameter hints while typing a call |
| Document symbols | Symbol outline for the current file          |
| Folding ranges   | Collapse functions, blocks, and regions      |

These use Monaco's default keys (for example `F2` to rename and `Cmd+.` for quick fixes); the code editor has no right-click menu. They work in editor tabs; the [diff viewer](/docs/diff-viewer) shows code without them.

---

## Edits across files

Renaming a symbol updates every reference the language server finds, including in files you don't have open. Renaming a module path, such as the path in a TypeScript import, renames the file and updates the imports that point at it. Quick fixes and other code actions can edit, create, rename, or delete files the same way. Files open in a tab change in the tab, where `Cmd+Z` undoes the change. Files that aren't open are written to disk directly, unformatted, and the editor can't undo that change; revert it with Git if needed. Created, renamed, and deleted files go through the same operations as the file tree: open tabs follow a renamed file, a deleted file's tab closes, and `Cmd+Z` in the file tree undoes them.

An edit only ever changes files of the current worktree. If it would touch anything else — a file outside the worktree, such as the Python standard library, or anything under `node_modules`, `site-packages`, or `.git` — nothing is changed and a notification says why. If a file changes on disk while an edit is being applied, the edit stops there, and the notification says how many of its changes were applied.

---

## Navigation

`Cmd`-click any symbol — or press `F12` — to jump to its definition. The target opens in an editor tab, reusing the file's tab if it is already open. This works in every language with a language server, including definitions outside the project such as the Python standard library. There is no inline peek; definitions always open as a full tab.

---

## Unused symbols

Symbols flagged as unused by the language server are dimmed in the editor, and deprecated ones are struck through. This is the same visual treatment as VS Code. TypeScript emits these diagnostics automatically; no extra configuration required.

---

## TypeScript server

Loxel uses the official TypeScript 7 native compiler and language server. It provides diagnostics, completions, navigation, refactors, and other editor features.

---

## Other language servers

Loxel runs language servers for six other languages. Each one is independent of the TypeScript server.

| Language  | When it starts             | File types                                                       |
| --------- | -------------------------- | ---------------------------------------------------------------- |
| YAML      | Always active              | `.yml`, `.yaml`                                                  |
| Terraform | First matching file opened | `.tf`, `.tfvars`, `.hcl`                                         |
| Docker    | First matching file opened | `Dockerfile`, `Containerfile`, `*.dockerfile`, `docker-bake.hcl` |
| Python    | First matching file opened | `.py`, `.pyi`, `.pyw`                                            |
| Astro     | First matching file opened | `.astro`                                                         |
| XML       | First matching file opened | `.xml`, `.xsd`, `.xsl`, `.xslt`, `.plist`, and other XML formats |

YAML starts with Loxel and stays running. The others start the first time you open a matching file and stop automatically when no matching files remain open. You do not need to configure anything to get them; they are available whenever you open a supported file type.

### Python environment

The Python server checks your code against the project's own Python environment, so imports of installed packages resolve and checks follow that Python version. For each worktree Loxel uses the first of:

1. The virtual environment that was active in the shell Loxel was started from, if it is inside the worktree.
2. A `.venv`, `venv` or `env` virtual environment at the worktree root (what uv, PDM and `python -m venv` create).
3. Pixi's default environment.
4. Poetry's environment, when the project has a `poetry.lock`.
5. `python3` on your shell's `PATH`.

Creating or syncing an environment while Loxel is open, for example with `uv sync`, is picked up automatically, as are packages installed into it later.

To use a different environment, set `venvPath` and `venv` in `pyrightconfig.json`, or in the `[tool.pyright]` table of `pyproject.toml`. That setting takes precedence over the detected environment:

```toml
[tool.pyright]
venvPath = "."
venv = ".venv-py313"
```

---

## See also

- [Editor](/docs/editor) — the code editor, where TypeScript diagnostics appear inline
- [Environment Variables & Settings](/docs/reference-env-files-cli-settings) — runtime configuration reference
