# JavaScript

JavaScript shares the TypeScript server and manager, see [typescript.md](typescript.md). Shared language-server architecture: [LANGUAGE_SERVERS.md](../LANGUAGE_SERVERS.md). This file covers what is specific to JavaScript projects.

## Tool config files

Each tool's own parser decides how Loxel treats its config, in `FILENAME_TO_LANG` in [highlighter.ts](../../src/lib/highlighter.ts):

- `jsonc`, so [json-strict-validator.ts](../../src/lib/json-strict-validator.ts) adds no markers, for tools that accept comments: `.eslintrc` and `.eslintrc.json` (ESLint strips comments, then parses as YAML and `JSON.parse` respectively), `.babelrc`, `.babelrc.json` and `babel.config.json` (JSON5), `.jshintrc`, `.mocharc.json`, `.swcrc`, `.oxlintrc.json`, `.oxfmtrc.json`, `lerna.json`, `bun.lock`. Monaco has no comments-only or JSON5 mode, so `jsonc` is the closest for `.eslintrc.json`, which rejects trailing commas, and Babel, which also takes unquoted keys.
- `json` for parsers that reject comments: `.c8rc`, `.nycrc`, and by extension `biome.json` (Biome allows comments only in `biome.jsonc` by default), `.prettierrc.json`.
- `yaml` for extensionless files read with a YAML parser: `.prettierrc`, `.lintstagedrc`, `.releaserc`, `.commitlintrc`. JSON is valid there too, so both forms are clean, while `json` would mark every line of the YAML form.

An `.eslintrc` can also be YAML, but stays `jsonc`: the JSON form is the common one and relies on `//` comments, which YAML would reject.

`.nvmrc` and `.node-version` have icons and no language, as with `.python-version`: they hold a version string.

## Built-in schemas

`BUILTIN_SCHEMA_DEFAULTS` in [settings-store.ts](../../src/store/settings-store.ts) only points at `json.schemastore.org`, the host the privacy policy names, and `settings-store.test.ts` enforces that. Tools whose schema lives elsewhere (Biome, oxlint, SWC, Turborepo) rely on the file's own `$schema`, which also keeps a versioned schema in step with the project's tool.

A tool has one row, with one glob covering its file names (`**/.prettierrc{,.json,.yml,.yaml}`), so it has one toggle and the JSON route fetches its schema once. A glob without a final extension routes to JSON, YAML and TOML (see [Schemas and JSON validation](../LANGUAGE_SERVERS.md#schemas-and-json-validation)); the server for the file's language is the one that applies it.

ESLint's schema is YAML-only (`**/.eslintrc.{yml,yaml}`): it `$ref`s the sibling `partial-eslint-plugins.json`, which the YAML server fetches itself, while Monaco gets schemas inline with requests off and would report the reference on every file.
