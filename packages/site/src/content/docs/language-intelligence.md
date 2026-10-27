---
title: Language Intelligence
description: Per-worktree language servers for TypeScript, Python, TOML and more, Python environments and the interpreter picker.
order: 13
---

Loxel runs language servers for TypeScript, Python, TOML and other languages and connects them to the editor. You get hover docs, go-to-definition, completions, rename, and more — isolated per worktree, with no cross-worktree interference.

---

## Per-worktree language servers

The active worktree gets its own language server processes; only the YAML server is shared. Switching worktrees stops them and starts fresh ones for the worktree you switch to, so expect a short warm-up after a switch. There is no shared server state between worktrees — if one worktree is using an older TypeScript config, a different Python environment or a different version of your packages, it does not affect any other worktree's language servers.

---

## Supported features

The TypeScript server provides all of these; the [other language servers](#other-languages) provide the ones their language supports.

| Feature           | Description                                                             |
| ----------------- | ----------------------------------------------------------------------- |
| Hover             | Type information and JSDoc for any symbol                               |
| Go-to-definition  | Jump to the declaration of any symbol                                   |
| Find references   | List the usages of a symbol across files                                |
| Completions       | Context-aware autocompletion as you type                                |
| Rename            | Rename a symbol and update all references                               |
| Code actions      | Quick fixes, imports, and refactors                                     |
| Signature help    | Function parameter hints while typing a call                            |
| Document symbols  | Symbol outline for the current file                                     |
| Workspace symbols | [Go to Symbol](/docs/editor#go-to-symbol) in the projects of open files |
| Folding ranges    | Collapse functions, blocks, and regions                                 |

These use Monaco's default keys (for example `F2` to rename and `Cmd+.` for quick fixes); the code editor has no right-click menu. They work in editor tabs; the [diff viewer](/docs/diff-viewer) shows code without them.

---

## Edits across files

Renaming a symbol updates every reference the language server finds, including in files you don't have open. Renaming a module path, such as the path in a TypeScript import, renames the file and updates the imports that point at it. Quick fixes and other code actions can edit, create, rename, or delete files the same way. Files open in a tab change in the tab, where `Cmd+Z` undoes the change. Files that aren't open are written to disk directly, unformatted, and the editor can't undo that change; revert it with Git if needed. Created, renamed, and deleted files go through the same operations as the file tree: open tabs follow a renamed file, a deleted file's tab closes, and `Cmd+Z` in the file tree undoes them.

Files open in a tab can always be edited this way, wherever they are, as typing in them can. Other changes only ever reach your own text files in the current worktree. If an edit would change anything else on disk — a file outside the worktree, such as the Python standard library; anything under `node_modules`, `site-packages`, or `.git`, or in a Python environment kept in the project, such as `.venv`; or a file that isn't UTF-8 text — nothing is changed and a notification says why. If a file changes on disk while an edit is being applied, the edit stops there, and the notification says how many of its changes were applied.

---

## Navigation

`Cmd`-click any symbol — or press `F12` — to jump to its definition. The target opens in an editor tab, reusing the file's tab if it is already open. This works in every language with a language server, including definitions outside the project such as the Python standard library. When a symbol has several definitions, a peek lists them instead.

Press `Shift+F12` to find a symbol's references. A peek opens below the line, listing every usage grouped by file, with a preview of the selected one. `Alt+F12` peeks at a definition and `Cmd+Shift+F12` at implementations without leaving the file. Press `Enter` or double-click a usage to open it in a tab, which closes the peek; `Escape` closes it. Files that aren't open, including ones outside the project, are read-only in the preview; open the file to edit it. Files open in a tab can be edited right in the peek.

---

## Unused symbols

Symbols flagged as unused by the language server are dimmed in the editor, and deprecated ones are struck through. This is the same visual treatment as VS Code. TypeScript emits these diagnostics automatically; no extra configuration required.

---

## TypeScript server

Loxel uses the official TypeScript 7 native compiler and language server. It provides diagnostics, completions, navigation, refactors, and other editor features.

---

## Other languages

Loxel runs language servers for seven other languages. Each one is independent of the TypeScript server.

| Language  | When it starts             | File types                                                       |
| --------- | -------------------------- | ---------------------------------------------------------------- |
| YAML      | Always active              | `.yml`, `.yaml`                                                  |
| Terraform | First matching file opened | `.tf`, `.tfvars`, `.hcl`                                         |
| Docker    | First matching file opened | `Dockerfile`, `Containerfile`, `*.dockerfile`, `docker-bake.hcl` |
| Python    | First matching file opened | `.py`, `.pyi`, `.pyw`                                            |
| Astro     | First matching file opened | `.astro`                                                         |
| XML       | First matching file opened | `.xml`, `.xsd`, `.xsl`, `.xslt`, `.plist`, and other XML formats |
| TOML      | First matching file opened | `.toml`, `Pipfile`, `Cargo.lock`, `poetry.lock`, `uv.lock`       |

YAML starts with Loxel and stays running. The others start the first time you open a matching file and stop automatically when no matching files remain open. You do not need to configure anything to get them; they are available whenever you open a supported file type.

---

## Python

Python files are checked by [basedpyright](https://docs.basedpyright.com), a type checker and language server built on Pyright. Besides diagnostics, hover, go-to-definition, references, rename and signature help, you get:

- **Semantic highlighting**: `self` and `cls`, decorators, builtins, modules, methods and constants are colored by what they are, not only by syntax.
- **Inlay hints**: inferred types of variables, return types of functions without an annotation, and parameter names at call sites, shown inline.
- **Auto-imports**: completions include names from the standard library and installed packages, and picking one adds its `import`.
- **Quick fixes** (`Cmd+.`): import an undefined name, or silence a rule on one line with `# pyright: ignore[<rule>]`.
- **Docs for compiled modules**: hover shows documentation for built-in modules such as `math` too.

### Type-checking rules

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
2. The virtual environment or conda environment that was active in the shell Loxel was started from, if it is inside the worktree.
3. The environment set by uv's `UV_PROJECT_ENVIRONMENT`, or a `.venv`, `venv` or `env` virtual environment at the worktree root (what uv, PDM and `python -m venv` create).
4. Pixi's default environment.
5. Poetry's environment, when the project has a `poetry.lock`, or Pipenv's, when it has a `Pipfile.lock`.
6. In a monorepo without an environment at the root, the virtual environment of the one project folder below the root that has one. When several do, choose one as described below.
7. `python3`, or else `python`, on your shell's `PATH`.

Loxel never uses an interpreter that is committed to the repository, since running it would run the repository's code.

Creating or syncing an environment while Loxel is open, for example with `uv sync`, is picked up automatically, as are packages installed into it later.

### Seeing and changing the interpreter

While a Python file is the active editor, the status bar shows the worktree's interpreter, for example `Python 3.12.13 (.venv)`. Hover it to see the interpreter's full path and how it was found.

Click it, or run **Python: Select Interpreter** from the command palette (`Cmd+Shift+P`), to choose another one:

- **Enter interpreter path…** takes the path of a Python executable or of an environment directory, such as `~/envs/py313`.
- **Use automatic detection** goes back to the order above.
- The rest of the list is every environment Loxel found: the ones above, plus `.venv`, `venv` and `env` environments and Pixi environments in project folders below the worktree root (folders with a `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`, `Pipfile` or `pixi.toml`), which is how you pick a sub-project's environment in a monorepo.

The choice is saved for that worktree and survives restarts. The language servers switch to it right away, without a restart. If the chosen interpreter is later deleted, Loxel goes back to automatic detection and shows the status bar item in the warning color until you choose again.

A `venvPath` and `venv` setting in `pyrightconfig.json`, or in the `[tool.basedpyright]` (or `[tool.pyright]`) table of `pyproject.toml`, takes precedence over the interpreter Loxel passes to the type checker, whether detected or chosen:

```toml
[tool.basedpyright]
venvPath = "."
venv = ".venv-py313"
```

The type checker only reads that environment's installed packages and never runs its interpreter; Ruff, format on save and terminals are not affected by this setting.

### Python linting

Python files also get [Ruff](https://docs.astral.sh/ruff/)'s linter, alongside type checking:

- Lint problems are underlined as you type, and `Cmd+.` offers Ruff's quick fixes, including disabling a rule for one line with a `# noqa` comment.
- `Shift+Option+O` organizes the file's imports.
- **Fix All** (press `F1` and search for it) applies every automatic fix in the file.

Ruff reads its settings from the `ruff.toml`, `.ruff.toml` or `pyproject.toml` closest to each file, so each project in a monorepo keeps its own rules, and edits to those files apply right away. Without any Ruff configuration, Ruff's default rules apply.

If Ruff 0.5.3 or newer is installed in the project's Python environment (see above, including an interpreter you chose), Loxel uses that one, so the version pinned in your dev dependencies applies. Otherwise it uses the Ruff that ships with Loxel. When the environment changes, for example when `uv sync` installs the project's Ruff after a Python file was opened, or you upgrade Ruff or choose another interpreter, the linter restarts with the new Ruff. Syntax errors come from the type checker only, and formatting stays with [format on save](/docs/editor#formatter-auto-detection).

---

## TOML

TOML files are checked by [Tombi](https://tombi-toml.github.io/tombi/). It underlines syntax errors and values that do not match the file's JSON Schema, and the schema also drives completions and hover documentation for keys and values. You also get the document outline, folding, go-to-definition and quick fixes.

Schemas come from **Settings > Schemas**, the same mappings JSON and YAML files use. These files have built-in schemas from [SchemaStore](https://www.schemastore.org):

- `pyproject.toml`, including tool tables such as `[tool.ruff]` and `[tool.uv]`
- `Cargo.toml` and `.cargo/config.toml`
- `ruff.toml` and `.ruff.toml`
- `uv.toml`
- `rustfmt.toml` and `.rustfmt.toml`

Turn a built-in schema off to stop checking files against it, or add your own mapping: a glob ending in `.toml` and the schema's URL or local path. Your mappings take precedence over the built-in ones for the same file. A TOML glob with wildcards, such as `config/*.toml`, applies only to files inside the project, and its `*` also matches files in subfolders. Schemas are downloaded when a file first needs them and cached for a day.

A `#:schema` comment at the top of a file picks its schema directly, by URL or by a path relative to the file, and takes precedence over the settings:

```toml
#:schema ./schemas/app.schema.json
name = "demo"
```

Projects that configure Tombi themselves, with a `tombi.toml` or `.tombi.toml` file or a `[tool.tombi]` table in `pyproject.toml`, use that configuration instead of the Schemas settings, so the editor agrees with the `tombi` command line. A `~/.config/tombi/config.toml` of your own does the same for every project. Formatting stays with [format on save](/docs/editor#formatter-auto-detection).

---

## See also

- [Editor](/docs/editor) — the code editor, where diagnostics appear inline, and format on save
- [Terminals](/docs/terminals) — new terminals start with the worktree's Python environment active
- [Environment Variables & Settings](/docs/reference-env-files-cli-settings) — runtime configuration reference
