---
title: Language Intelligence
description: Per-worktree language servers, the features they provide, and how they start and stop.
order: 13
# Sections that moved to a language's own page; old links to them keep working.
movedAnchors:
  typescript-server: /docs/languages/typescript
  python: /docs/languages/python
  type-checking-rules: /docs/languages/python#type-checking-rules
  python-environment: /docs/languages/python#python-environment
  seeing-and-changing-the-interpreter: /docs/languages/python#seeing-and-changing-the-interpreter
  python-linting: /docs/languages/python#python-linting
  mypy: /docs/languages/python#mypy
  toml: /docs/languages/toml
---

Loxel runs language servers for TypeScript, Python, TOML and other languages and connects them to the editor. You get hover docs, go-to-definition, completions, rename, and more — isolated per worktree, with no cross-worktree interference.

---

## Per-worktree language servers

The active worktree gets its own language server processes; only the YAML server is shared. Switching worktrees stops them and starts fresh ones for the worktree you switch to, so expect a short warm-up after a switch. There is no shared server state between worktrees — if one worktree is using an older TypeScript config, a different Python environment or a different version of your packages, it does not affect any other worktree's language servers.

### When a language server stops

If a language server crashes, Loxel starts it again within a few seconds and the editor picks up where it left off: diagnostics, hover and completions come back for the files you have open. The same happens when Loxel itself restarts. A server that keeps crashing right after it starts is given a few tries, then left stopped, with a notification saying so.

Opening the same worktree in a second window moves its language servers to that window. The first window keeps editing normally, without language features for that worktree, and does not take them back on its own, so two windows never fight over them.

While a language server is stopped, for any of these reasons or because it could not start, the status bar shows it, for example `basedpyright stopped` or `TypeScript in another window`. Hover it to see why, and click it to start it again (or to take the servers back into this window). **Restart Language Servers** in the command palette restarts every language server of the current worktree and the shared YAML one, stopped or not.

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

These use Monaco's default keys (for example `F2` to rename); the code editor has no right-click menu. Code actions are also in the command palette: **Quick Fix…** (`Cmd+.`), **Fix All** (`Ctrl+Shift+.`), **Organize Imports** (`Shift+Alt+O`), **Source Action…** (`Ctrl+Alt+S`) and **Refactor…** (`Ctrl+Alt+R`), listed while a code editor has focus and its language server offers them; you can remap them in **Settings > Keybindings**. They work in editor tabs; the [diff viewer](/docs/diff-viewer) shows code without them.

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

## Other languages

Each language server is independent of the others. A language with more to say has its own page in the docs navigation, such as [TypeScript](/docs/languages/typescript), [JavaScript](/docs/languages/javascript), [Python](/docs/languages/python) and [TOML](/docs/languages/toml). These have none:

| Language  | When it starts             | File types                                                       |
| --------- | -------------------------- | ---------------------------------------------------------------- |
| YAML      | Always active              | `.yml`, `.yaml`                                                  |
| Terraform | First matching file opened | `.tf`, `.tfvars`, `.hcl`                                         |
| Docker    | First matching file opened | `Dockerfile`, `Containerfile`, `*.dockerfile`, `docker-bake.hcl` |
| Astro     | First matching file opened | `.astro`                                                         |
| XML       | First matching file opened | `.xml`, `.xsd`, `.xsl`, `.xslt`, `.plist`, and other XML formats |

YAML starts with Loxel and stays running. The others start the first time you open a matching file and stop automatically when no matching files remain open. You do not need to configure anything to get them; they are available whenever you open a supported file type.

The Docker language server itself sends nothing to Docker's services: no telemetry, crash reports, vulnerability scans or image lookups. Bake files get hover, completion and diagnostics. Dockerfile lint warnings come from `docker buildx` when the Docker CLI is installed; it runs with your own Docker setup, which can contact the registry of a base image (Docker Hub for most images), as `docker build` does. If your active builder is remote, the Dockerfile and build context go to that builder, also as with any `docker build`. Lint warnings are not available with a Docker daemon reached over TCP on another machine.

---

## Schemas a file names

A file can name its own schema: `$schema` in a JSON file, a `# yaml-language-server: $schema=` comment in YAML, a `#:schema` comment in TOML, or a schema or DTD in XML. Before Loxel downloads a schema at an address a file names, it shows a notification with the full address, so opening a project you just cloned does not contact hosts that project chooses. Files work normally until you answer, without checks and completions from that schema.

- **Allow** trusts this address. Loxel downloads the schema now and whenever it needs it again, along with files it references on the same site.
- **Don't fetch** skips this address, and Loxel does not ask about it again.
- **Never ask** stops downloading schemas named by files, including ones you trusted, with no further prompts.

Your choices last across restarts and apply to every project. To review or change them, open **Settings > Security**: remove an address to be asked about it again, or use the **Never fetch schemas named by files** switch.

Schemas in [**Settings > Schemas**](/docs/reference-env-files-cli-settings), including the built-in ones, are your own choice and do not ask. Loxel downloads one the first time you open a file that matches it. When Loxel does download a schema, the request goes from your machine to that address, which sees your IP address like any web request.

---

## See also

- [Editor](/docs/editor) — the code editor, where diagnostics appear inline, and format on save
- [Environment Variables & Settings](/docs/reference-env-files-cli-settings) — runtime configuration reference
