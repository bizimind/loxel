---
title: TypeScript Intelligence
description: Per-worktree language servers, supported features, and other language servers.
order: 13
---

Loxel runs a dedicated language server per worktree and wires it directly into Monaco. You get hover docs, go-to-definition, completions, rename, and more — isolated per context, with no cross-worktree interference.

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

These use Monaco's default keys (for example `F2` to rename and `Cmd+.` for quick fixes); the code editor has no right-click menu.

---

## Navigation

`Cmd+Click` on any symbol — or press `F12` — to jump to its definition. The target opens in an editor tab, reusing the file's tab if it is already open. There is no inline peek; definitions always open as a full tab.

---

## Unused symbols

Symbols flagged as unused by the language server are dimmed in the editor, and deprecated ones are struck through. This uses Monaco's `MarkerTag.Unnecessary` and `MarkerTag.Deprecated` — the same visual treatment as VS Code. TypeScript emits these diagnostics automatically; no extra configuration required.

---

## TypeScript server

Loxel uses the official TypeScript 7 native compiler and language server (`tsc --lsp -stdio`).
The same runtime provides diagnostics, completions, navigation, refactors, and other editor features.

---

## Other language servers

Loxel runs language servers for six other languages. Each one is independent of the TypeScript server.

| Language  | When it starts             | File types                                                       |
| --------- | -------------------------- | ---------------------------------------------------------------- |
| YAML      | Always active              | `.yml`, `.yaml`                                                  |
| Terraform | First matching file opened | `.tf`, `.tfvars`, `.hcl`                                         |
| Docker    | First matching file opened | `Dockerfile`, `Containerfile`, `*.dockerfile`, `docker-bake.hcl` |
| Python    | First matching file opened | `.py`                                                            |
| Astro     | First matching file opened | `.astro`                                                         |
| XML       | First matching file opened | `.xml`, `.xsd`, `.xsl`, `.xslt`, `.plist`, and other XML formats |

YAML starts with loxel and stays running. The other servers are lazy — they spawn the first time you open a matching file and disconnect automatically when no matching files remain open. You do not need to configure anything to get them; they are available whenever you open a supported file type.

---

## See also

- [Editor](/docs/editor) — Monaco editor that surfaces TypeScript diagnostics as inline markers
- [Environment Variables & Settings](/docs/reference-env-files-cli-settings) — runtime configuration reference
