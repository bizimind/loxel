---
title: JavaScript
description: JavaScript projects, jsconfig.json, type checking plain JavaScript, and tool configuration files.
order: 13.5
---

<!-- Later headings go after "Type checking JavaScript", in this order: "Linters" (ESLint, oxlint, Biome), "Node version". "Tool configuration files" stays last. -->

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
- [Language Intelligence](/docs/language-intelligence) — the features every language server provides, and how servers start and stop per worktree
- [Repository Trust](/docs/repository-trust) — how a language feature asks before running a repository's code
