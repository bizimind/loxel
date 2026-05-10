---
title: TypeScript Intelligence
description: Per-worktree language servers, supported features, backend selection, and other language servers.
order: 13
---

Loxel runs a dedicated language server per worktree and wires it directly into Monaco. You get hover docs, go-to-definition, completions, rename, and more — isolated per context, with no cross-worktree interference.

---

## Per-worktree language server

Each worktree gets its own language server subprocess. Switching worktrees switches language servers. There is no shared server state between worktrees — if one worktree is using an older TypeScript config or a different version of your packages, it does not affect any other worktree's language server.

---

## Supported features

| Feature          | Description                                  |
| ---------------- | -------------------------------------------- |
| Hover            | Type information and JSDoc for any symbol    |
| Go-to-definition | Jump to the declaration of any symbol        |
| Find references  | List all usages across the project           |
| Completions      | Context-aware autocompletion as you type     |
| Rename           | Rename a symbol and update all references    |
| Code actions     | Quick fixes, imports, and refactors          |
| Inlay hints      | Inline type annotations and parameter names  |
| Signature help   | Function parameter hints while typing a call |
| Document symbols | Symbol outline for the current file          |
| Folding ranges   | Collapse functions, blocks, and regions      |

---

## Navigation

`Cmd+Click` on any symbol — or press `F12` — to jump to its definition. The target opens in a new editor tab. There is no inline peek; definitions always open as a full tab.

---

## Unused symbols

Symbols flagged as unused by the language server are dimmed in the editor. This uses Monaco's `MarkerTag.Unnecessary` — the same visual treatment as VS Code. `tsgo` emits these diagnostics automatically; no extra configuration required.

---

## Backend selection

The TypeScript language server backend is set with the `LOXEL_TS_LSP` environment variable:

| Value            | Package                      | Notes                                                 |
| ---------------- | ---------------------------- | ----------------------------------------------------- |
| `tsgo` (default) | `@typescript/native-preview` | Faster startup                                        |
| `tsls`           | `typescript-language-server` | Adds semantic token highlighting (more syntax colors) |

Set this before starting loxel:

```bash
LOXEL_TS_LSP=tsls loxel
```

> **Tip:** `tsls` produces richer syntax coloring via semantic tokens — individual local variables, parameters, and type aliases get distinct colors beyond what TextMate grammar rules provide. Use it if you prefer that style; the tradeoff is slightly slower startup compared to `tsgo`.

---

## Other language servers

Loxel runs language servers for four other languages. Each one is independent of the TypeScript backend.

| Language  | When it starts                                | File types                 |
| --------- | --------------------------------------------- | -------------------------- |
| YAML      | Always active (global singleton)              | `.yml`, `.yaml`            |
| Terraform | First `.tf`, `.tfvars`, or `.hcl` file opened | `.tf`, `.tfvars`, `.hcl`   |
| Docker    | First dockerfile opened                       | `dockerfile`, `dockerbake` |
| Python    | First `.py` or `.pyi` file opened             | `.py`, `.pyi`              |

YAML is a singleton that starts with loxel and stays running. The Terraform, Docker, and Python servers are lazy — they spawn the first time you open a matching file and disconnect automatically when no matching files remain open. You do not need to configure anything to get them; they are available whenever you open a supported file type.

---

## See also

- [Editor](/docs/editor) — Monaco editor that surfaces TypeScript diagnostics as inline markers
- [Environment Variables & Settings](/docs/reference-env-files-cli-settings) — `LOXEL_TS_LSP` for switching between `tsgo` and `tsls` backends
