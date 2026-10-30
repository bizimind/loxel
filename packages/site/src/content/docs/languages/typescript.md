---
title: TypeScript
description: The TypeScript language server, its diagnostics, completions and refactors, and how outside changes reach it.
order: 13.5
---

Loxel uses the official TypeScript 7 native compiler and language server. It provides diagnostics, completions, navigation, refactors, and other editor features.

Changes made outside the editor reach it without a restart: a `git checkout`, an agent's edits, and packages you install, upgrade or remove with npm, pnpm, yarn or bun, including in a monorepo's per-package `node_modules`. Imports of a newly installed package resolve, and auto-imports offer it, about a second after the install finishes.

## Scripts without an extension

A file with no extension gets the same features when its first line names a JavaScript or TypeScript runner, as in `bin/www`: `#!/usr/bin/env node`, `#!/usr/bin/env -S node --no-warnings`, `nodejs` and `bun` open as JavaScript, and `tsx` and `ts-node`, including through `npx`, as TypeScript. A file association in [settings](/docs/reference-env-files-cli-settings) works for any other name.

## Types come from what you install

Loxel never downloads dependencies or type packages for you. It works from what is in the project, so install them yourself, and the types arrive as soon as the install finishes:

```bash
npm install
npm install --save-dev @types/express @types/node
```

In a JavaScript project:

- A package that ships its own types works as soon as it is installed.
- A package without types is `any`, and hovering its names shows nothing, until you install its `@types` package. A `jsconfig.json` with `maxNodeModuleJsDepth` makes TypeScript infer types from the package's JavaScript in `node_modules` instead.
- Node.js globals such as `process` and `Buffer` are `any`, and a file with `// @ts-check` reports them as errors, until you install `@types/node` and name it in a `jsconfig.json`, since TypeScript 7 loads no global types by default:

```json
{ "compilerOptions": { "types": ["node"] } }
```

---

## See also

- [Language Intelligence](/docs/language-intelligence) — the features every language server provides, and how servers start and stop per worktree
