---
title: TypeScript
description: The TypeScript language server, its diagnostics, completions and refactors, and how outside changes reach it.
order: 13.5
---

Loxel uses the official TypeScript 7 native compiler and language server. It provides diagnostics, completions, navigation, refactors, and other editor features.

Changes made outside the editor reach it without a restart: a `git checkout`, an agent's edits, and packages you install, upgrade or remove with npm, pnpm, yarn or bun, including in a monorepo's per-package `node_modules`. Imports of a newly installed package resolve, and auto-imports offer it, about a second after the install finishes.

---

## See also

- [Language Intelligence](/docs/language-intelligence) — the features every language server provides, and how servers start and stop per worktree
- [Repository Trust](/docs/repository-trust) — how a language feature asks before running a repository's code
