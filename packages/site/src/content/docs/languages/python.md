---
title: Python
description: Python language features from basedpyright, Ruff and mypy, Python environments and the interpreter picker.
order: 13.5
---

The Python servers start the first time you open a `.py`, `.pyi` or `.pyw` file and stop when none remain open.

Python files are checked by [basedpyright](https://docs.basedpyright.com), a type checker and language server built on Pyright (or by [mypy](#mypy), in projects that use it). Besides diagnostics, hover, go-to-definition, references, rename and signature help, you get:

- **Semantic highlighting**: `self` and `cls`, decorators, builtins, modules, methods and constants are colored by what they are, not only by syntax.
- **Inlay hints**: inferred types of variables, return types of functions without an annotation, and parameter names at call sites, shown inline.
- **Auto-imports**: completions include names from the standard library and installed packages, and picking one adds its `import`.
- **Quick fixes** (`Cmd+.`): import an undefined name, or silence a rule on one line with `# pyright: ignore[<rule>]`.
- **Docs for compiled modules**: hover shows documentation for built-in modules such as `math` too.

## Type-checking rules

Without a configuration file, Loxel checks with basedpyright's `standard` ruleset, the default of plain Pyright. To choose rules for a project, add a `[tool.basedpyright]` table to `pyproject.toml` or a `pyrightconfig.json` file (a `[tool.pyright]` table works too). Once a project has one, basedpyright's own defaults apply to everything it leaves out, including the stricter `recommended` ruleset, so set `typeCheckingMode` there:

```toml
[tool.basedpyright]
typeCheckingMode = "recommended" # or "basic", "standard", "strict", "all"
reportUnusedCallResult = "none"
```

See basedpyright's [configuration reference](https://docs.basedpyright.com/latest/configuration/config-files/) for every rule.

## Python environment

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

## Seeing and changing the interpreter

While a Python file is the active editor, the status bar shows the worktree's interpreter, for example `Python 3.12.13 (.venv)`. Hover it to see the interpreter's full path and how it was found.

Click it, or run **Python: Select Interpreter** from the command palette (`Cmd+Shift+P`), to choose another one:

- **Enter interpreter path…** takes the path of a Python executable or of an environment directory, such as `~/envs/py313`.
- **Use automatic detection** goes back to the order above.
- The rest of the list is every environment Loxel found: the ones above, plus `.venv`, `venv` and `env` environments and Pixi environments in project folders below the worktree root (folders with a `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`, `Pipfile` or `pixi.toml`), which is how you pick a sub-project's environment in a monorepo.

The choice is saved for that worktree and survives restarts. The language servers switch to it right away, without a restart, and new terminals start with it. If the chosen interpreter is later deleted, Loxel goes back to automatic detection and shows the status bar item in the warning color until you choose again.

A `venvPath` and `venv` setting in `pyrightconfig.json`, or in the `[tool.basedpyright]` (or `[tool.pyright]`) table of `pyproject.toml`, takes precedence over the interpreter Loxel passes to the type checker, whether detected or chosen:

```toml
[tool.basedpyright]
venvPath = "."
venv = ".venv-py313"
```

The type checker only reads that environment's installed packages and never runs its interpreter; Ruff, format on save and terminals are not affected by this setting.

## Python linting

Python files also get [Ruff](https://docs.astral.sh/ruff/)'s linter, alongside type checking:

- Lint problems are underlined as you type, and `Cmd+.` offers Ruff's quick fixes, including disabling a rule for one line with a `# noqa` comment.
- **Organize Imports** (`Shift+Alt+O`) sorts the file's imports.
- **Fix All** (`Ctrl+Shift+.`, or from the command palette) applies every automatic fix in the file.

Ruff reads its settings from the `ruff.toml`, `.ruff.toml` or `pyproject.toml` closest to each file, so each project in a monorepo keeps its own rules, and edits to those files apply right away. Without any Ruff configuration, Ruff's default rules apply.

If Ruff 0.5.3 or newer is installed in the project's Python environment (see above, including an interpreter you chose), Loxel uses that one, so the version pinned in your dev dependencies applies. Otherwise it uses the Ruff that ships with Loxel. When the environment changes, for example when `uv sync` installs the project's Ruff after a Python file was opened, or you upgrade Ruff or choose another interpreter, the linter restarts with the new Ruff. Syntax errors come from the type checker only, and formatting stays with [format on save](/docs/editor#formatter-auto-detection).

## mypy

Projects that type-check with [mypy](https://mypy.readthedocs.io) get mypy's errors in the editor instead of basedpyright's. Loxel recognizes a project as using mypy by its configuration: a `mypy.ini` or `.mypy.ini`, a `[tool.mypy]` table in `pyproject.toml`, or a `[mypy]` section in `setup.cfg`. The configuration closest to each file applies, so each project in a monorepo keeps its own.

Loxel runs the mypy installed in the project's Python environment (see above, including an interpreter you chose), so your pinned version, settings and plugins (Django, pydantic, SQLAlchemy and others) apply, exactly as when you run mypy yourself:

- mypy's errors are underlined, marked `mypy`, and their error code links to its explanation in the mypy docs.
- Files are checked when you open them and whenever a Python file is saved or changes on disk, for example after `git checkout` or an agent's edits. mypy reads files from disk, so unsaved changes are checked once saved. Loxel keeps a mypy daemon running per project, so re-checks after the first are quick.
- When your configuration lists what to check (`files`, `modules` or `packages`), Loxel checks the project as configured, which is what your CI checks too. Otherwise it checks the files you have open.
- Editing the mypy configuration, or a change to the Python environment such as installing packages or choosing another interpreter, restarts mypy.

While mypy checks a file, basedpyright stops reporting type errors there, so you only see the errors your project's checker reports. That covers the files your configuration's `files`, `modules` or `packages` name, plus any other file mypy reports an error in after following an import into it. Files outside those that mypy reports nothing in keep basedpyright's type checking, and so does every file while mypy cannot check the project. basedpyright still provides completions, hover, go-to-definition, rename, quick fixes and the other features above, and still reports syntax errors and fades unused and unreachable code. To see both checkers' type errors, configure basedpyright in the project too, with a `pyrightconfig.json` or a `[tool.basedpyright]` (or `[tool.pyright]`) table in `pyproject.toml`.

If mypy is configured but not installed in the project's environment, Loxel says so once and basedpyright keeps checking types; add mypy to your dev dependencies (for example `uv add --dev mypy`) to switch. If mypy cannot check the project, for example because of an error in its configuration or a plugin that fails to load, Loxel shows mypy's message.

---

## See also

- [Language Intelligence](/docs/language-intelligence) — the features every language server provides, and how servers start and stop per worktree
- [Editor](/docs/editor) — format on save
- [Terminals](/docs/terminals) — new terminals start with the worktree's Python environment active
- [Repository Trust](/docs/repository-trust) — how a language feature asks before running a repository's code
