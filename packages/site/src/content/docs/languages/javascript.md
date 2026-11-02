---
title: JavaScript
description: JavaScript projects, jsconfig.json, type checking plain JavaScript, ESLint, the Node version, and tool configuration files.
order: 13.5
---

<!-- Later subsections go in "Linters", after ESLint: oxlint, Biome. "Tool configuration files" stays last. -->

JavaScript files use the same language server as [TypeScript](/docs/languages/typescript), so `.js`, `.mjs`, `.cjs` and `.jsx` files get the same hover, navigation, completions and refactors. Types for your packages come from what is installed: install your dependencies, and the `@types` packages of those that ship no types.

---

## Projects and jsconfig

Without a config file, the server only knows the files you have open and what they import, so **Go to Symbol** in the workspace and **Find references** miss the rest of the project. Add a `jsconfig.json` to fix that:

```json
{ "include": ["src"] }
```

Each file uses the nearest `jsconfig.json` or `tsconfig.json` above it, so subdirectories can have their own.

With a `jsconfig.json` at the project root, Loxel also checks the whole project and shows the errors in the code editor and on both sides of a diff. A root `tsconfig.json` takes priority. Options TypeScript 7 removed show as errors on the `jsconfig.json`; remove them first, because this check reports no type errors until you do.

`baseUrl` no longer resolves imports in TypeScript 7. Use `paths` instead, with paths relative to the config file:

```json
{ "compilerOptions": { "paths": { "lib/*": ["./lib/*"] } } }
```

---

## Type checking JavaScript

JavaScript is not type checked by default: you see syntax errors, and unused symbols are marked. Turn checking on per file or per project:

- `// @ts-check` at the top of a file checks that file, and `// @ts-nocheck` turns checking off for it, including in a checked project.
- `"checkJs": true` under `compilerOptions` in a `jsconfig.json` checks the project.

There is no global setting, because TypeScript 7 offers none.

TypeScript 7 turns `strict` on by default, so `checkJs` alone flags every untyped parameter. Add `"strict": false` to keep real type errors without those:

```json
{ "compilerOptions": { "checkJs": true, "strict": false } }
```

Constructor functions (`function Dog() {}` with `Dog.prototype.bark = ...`) are not understood by TypeScript 7: `new Dog()` has the type `any`, so it gets no completions or checks. Classes are.

---

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

## Scripts without an extension

A file with no extension gets the same features when its first line names a JavaScript or TypeScript runner, as in `bin/www`: `#!/usr/bin/env node`, `#!/usr/bin/env -S node --no-warnings`, `nodejs` and `bun` open as JavaScript, and `tsx` and `ts-node`, including through `npx`, as TypeScript. A file association in [settings](/docs/reference-env-files-cli-settings) works for any other name.

---

## Linters

### ESLint

In a [trusted repository](/docs/repository-trust), JavaScript and TypeScript files in a project that uses ESLint show its problems in the editor as you type, with quick fixes for fixing a problem or disabling a rule for a line or a file. **Fix All** applies everything fixable in the file. Loxel runs the ESLint your project has installed, with your config and plugins, so the results match running it in a terminal.

A file is linted when both of these hold:

- An ESLint config lies in its folder or above it, up to the worktree root: `eslint.config.js` (or `.cjs`, `.mjs`, `.ts`, `.mts`, `.cts`), `.eslintrc` in any form, or an `eslintConfig` key in `package.json`.
- ESLint is installed in `node_modules` there or above it. In a Yarn Plug'n'Play project, set `nodeLinker: node-modules`.

Each package of a monorepo uses its own config, and a package without one uses the root's.

Loxel never installs ESLint. If a project has a config and no ESLint, a notification says what to run, for example `npm install`. ESLint runs on the [Node version](#node-version) the worktree uses; without any Node, a notification says to install one. Until you trust a repository, ESLint doesn't run in it, and the status bar shows **Restricted** once you open a file in a project that uses it.

Changes to a config file apply right away, and so does installing or upgrading packages. Formatting stays with [format on save](/docs/editor#formatter-auto-detection), even when ESLint has fixable formatting rules.

---

## Node version

While a JavaScript or TypeScript file is the active editor, the status bar shows the Node version the worktree uses, for example `Node 22.11.0 (nvm)`. Hover it to see the full path and how it was found.

Loxel picks the first of these that applies:

1. The version you chose for this worktree.
2. The version the worktree's root folder pins, matched against what your version managers have installed. A partial pin such as `22` takes the highest installed match.
3. `node` on your login-shell `PATH`.

If a project has several pin files, the first one in this list counts:

- `.nvmrc`, for example `22`, `v22.1.0`, `lts/*`, `lts/iron` or `node`
- `.node-version`
- a `nodejs` line in `.tool-versions`
- `node` under `[tools]` in `mise.toml`, then `.mise.toml`
- `volta.node` in `package.json`

The `engines` field in `package.json` does not select a version. Pins apply to the whole worktree: a subfolder's own pin file is not read.

Versions are found for nvm, fnm, Volta, asdf, mise and n, including custom locations set with their environment variables such as `NVM_DIR` or `FNM_DIR`. Installing a version or editing a pin file updates the status bar right away, with no restart.

Loxel never installs Node. If the pinned version is not installed, the status bar item turns to its warning color, Loxel uses `node` from `PATH`, and the tooltip says what to run in a terminal, for example `nvm install 22`.

Click the item, or run **Node: Select Version** from the command palette (`Cmd+Shift+P`), to choose an installed version for this worktree, or to go back to automatic detection. The list shows what your version managers have installed and the `node` on `PATH`.

New [terminals](/docs/terminals#node-version) use this version when it comes from a pin or an installed version you chose. When it is the `node` on your `PATH`, found or chosen, they are left as they are.

---

## Tool configuration files

Config files are treated the way their tool reads them:

- **Comments are fine** in `.eslintrc`, `.eslintrc.json`, `.babelrc`, `.babelrc.json`, `babel.config.json`, `.jshintrc`, `.mocharc.json`, `.swcrc`, `.oxlintrc.json`, `.oxfmtrc.json`, `lerna.json` and `jsconfig.json`.
- **Comments are errors** in `biome.json`, `.prettierrc.json`, `.nycrc`, `.c8rc` and `package.json`, whose tools reject them. Biome accepts them in `biome.jsonc`.
- **JSON or YAML both work** in `.prettierrc`, `.lintstagedrc`, `.releaserc` and `.commitlintrc`, which open as YAML.

To use a different language for a file, add a mapping in **Settings > File Associations**.

These JSON files have built-in schemas from [SchemaStore](https://www.schemastore.org), for completions, hover documentation and validation:

- `jsconfig.json`
- `package.json` and `tsconfig.json`
- `.babelrc`, `.babelrc.json` and `babel.config.json`
- `lerna.json`
- `.lintstagedrc.json`
- `.prettierrc.json`

Turn one off in **Settings > Schemas** to stop checking files against it. Other JSON configs, such as `biome.json`, `.swcrc` and `turbo.json`, get theirs from a `$schema` field in the file, which can match the version of the tool you use.

---

## See also

- [TypeScript](/docs/languages/typescript) — the shared language server and how outside changes reach it
- [Terminals](/docs/terminals#node-version) — new terminals start with the worktree's Node version first on `PATH`
- [Language Intelligence](/docs/language-intelligence) — the features every language server provides, and how servers start and stop per worktree
- [Repository Trust](/docs/repository-trust) — how a language feature asks before running a repository's code
