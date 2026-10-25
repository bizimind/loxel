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

An edit only ever changes your own text files in the current worktree. If it would touch anything else — a file outside the worktree, such as the Python standard library; anything under `node_modules`, `site-packages`, or `.git`, or in a Python environment kept in the project, such as `.venv`; or a file that isn't UTF-8 text — nothing is changed and a notification says why. If a file changes on disk while an edit is being applied, the edit stops there, and the notification says how many of its changes were applied.

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

### Python

Python files are checked by [basedpyright](https://docs.basedpyright.com), a type checker and language server built on Pyright. Besides diagnostics, hover, go-to-definition, references, rename and signature help, you get:

- **Semantic highlighting**: `self` and `cls`, decorators, builtins, modules, methods and constants are colored by what they are, not only by syntax.
- **Inlay hints**: inferred types of variables, return types of functions without an annotation, and parameter names at call sites, shown inline.
- **Auto-imports**: completions include names from the standard library and installed packages, and picking one adds its `import`.
- **Quick fixes** (`Cmd+.`): import an undefined name, or silence a rule on one line with `# pyright: ignore[<rule>]`.
- **Docs for compiled modules**: hover shows documentation for built-in modules such as `math` too.

#### Type-checking rules

Without a configuration file, Loxel checks with basedpyright's `standard` ruleset, the default of plain Pyright. To choose rules for a project, add a `[tool.basedpyright]` table to `pyproject.toml` or a `pyrightconfig.json` file (a `[tool.pyright]` table works too). Once a project has one, basedpyright's own defaults apply to everything it leaves out, including the stricter `recommended` ruleset, so set `typeCheckingMode` there:

```toml
[tool.basedpyright]
typeCheckingMode = "recommended" # or "basic", "standard", "strict", "all"
reportUnusedCallResult = "none"
```

See basedpyright's [configuration reference](https://docs.basedpyright.com/latest/configuration/config-files/) for every rule.

### Python environment

The Python server checks your code against the project's own Python environment, so imports of installed packages resolve and checks follow that Python version. For each worktree Loxel uses the first of:

1. The interpreter you chose for the worktree (see below).
2. The virtual environment that was active in the shell Loxel was started from, if it is inside the worktree.
3. A `.venv`, `venv` or `env` virtual environment at the worktree root (what uv, PDM and `python -m venv` create).
4. Pixi's default environment.
5. Poetry's environment, when the project has a `poetry.lock`.
6. `python3` on your shell's `PATH`.

Loxel never uses an interpreter that is committed to the repository, since running it would run the repository's code.

Creating or syncing an environment while Loxel is open, for example with `uv sync`, is picked up automatically, as are packages installed into it later.

#### Seeing and changing the interpreter

While a Python file is the active editor, the status bar shows the worktree's interpreter, for example `Python 3.12.13 (.venv)`. Hover it to see the interpreter's full path and how it was found.

Click it, or run **Python: Select Interpreter** from the command palette (`Cmd+Shift+P`), to choose another one:

- **Enter interpreter path…** takes the path of a Python executable or of an environment directory, such as `~/envs/py313`.
- **Use automatic detection** goes back to the order above.
- The rest of the list is every environment Loxel found: the ones above, plus `.venv`, `venv` and `env` environments and Pixi environments in project folders below the worktree root (folders with a `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`, `Pipfile` or `pixi.toml`), which is how you pick a sub-project's environment in a monorepo.

The choice is saved for that worktree and survives restarts. The language server switches to it right away, without a restart. If the chosen interpreter is later deleted, Loxel goes back to automatic detection and shows the status bar item in the warning color until you choose again.

A `venvPath` and `venv` setting in `pyrightconfig.json`, or in the `[tool.basedpyright]` (or `[tool.pyright]`) table of `pyproject.toml`, takes precedence over the interpreter Loxel passes to the language server, whether detected or chosen:

```toml
[tool.basedpyright]
venvPath = "."
venv = ".venv-py313"
```

---

## See also

- [Editor](/docs/editor) — the code editor, where TypeScript diagnostics appear inline
- [Environment Variables & Settings](/docs/reference-env-files-cli-settings) — runtime configuration reference
