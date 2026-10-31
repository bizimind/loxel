---
name: add-language-server
description: Add a new language server to loxel with full integration across all layers (build/download, server manager, server routing, client connection, Monaco registration, highlighting/icons, editor URI scheme, packaging). Use when adding support for a new programming language or file type that needs LSP features like completions, hover, diagnostics, or go-to-definition, including a second server for a language that already has one.
---

# Add Language Server

Integrate a new language server into loxel. A worktree-scoped server is new files plus one import and one entry in `src/server/language-servers.ts`; no other shared list. Architecture: `packages/loxel/docs/LANGUAGE_SERVERS.md`. References:

- `references/server-manager.md`: the manager's hooks, how a server gets its settings, project-provided binaries, and a second server for a language that already has one (basedpyright + ruff).
- `references/existing-integrations.md`: integration matrix and per-server quirks.

This skill covers LSP integration only, not TextMate grammars or monaco-lsp-client internals. Format on save is its own module plus one line in `src/server/language-formatters.ts`, see [Formatting](../../../packages/loxel/docs/LANGUAGE_SERVERS.md#formatting).

## Decision Points

Resolve these with the user before starting:

| Decision            | Default                                   | Alternatives                                                                                           |
| ------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Scope**           | Worktree (one subprocess per worktree)    | Global (YAML: one shared subprocess)                                                                   |
| **Connection**      | Lazy (spawned when matching models exist) | Eager (TypeScript: always connected, explicit in `monaco-env.ts`)                                      |
| **Binary source**   | Bun-built from NPM package                | Downloaded pre-built binary (Go/Rust servers); the project's own install (ruff)                        |
| **Settings**        | None                                      | Init options, pushed after `initialized`, or pulled with `workspace/configuration`                     |
| **Overlap**         | Only server for its languages             | A second server on the same languages (ruff next to basedpyright): suppress the features it duplicates |
| **Semantic tokens** | Enabled                                   | Disabled (`disableSemanticTokens = true`) if buggy or TextMate is better                               |
| **Text sync**       | Incremental                               | Full-text (`requiresFullTextSync = true`) if the server mishandles incremental                         |
| **Spawn args**      | `["--stdio"]`                             | `["serve"]` (terraform-ls), `["start", "--stdio"]` (docker-ls), `["server"]` (ruff), `["lsp"]` (Tombi) |

## Steps

All paths are under `packages/loxel/`.

1. **Binary.** Add `scripts/language-servers/<name>.json`: `{ "script": "download-<name>.ts", "resources": ["<binary>"] }` (`resources` are paths under `build/`, staged by base name next to `loxel-server`; add `"sign"` for an executable inside a resource directory). That manifest is all build, packaging and the release workflow need. The script is one of: `scripts/build-<name>.ts` bundles an NPM package with `Bun.build`, then `bun build --compile` into `build/` (add the package as a devDependency; `resolvePackage()` locates it; see the yaml-ls plugins and the basedpyright shims); `scripts/download-<name>.ts` downloads a release with per-platform SHA256 pins, hashed in memory before anything is written or extracted, extracting only the binary (a tarball or Windows zip needs only `downloadReleaseBinary` from `download-release-binary.ts`, as ruff and Tombi do); or a copy script (`copy-typescript.ts`). Run one with `pnpm run build:language-servers <manifest>`.
2. **Server manager.** `src/server/<name>-lsp-manager.ts`, from `astro-lsp-manager.ts` (the simplest): extend `WorktreeLspManager`, call `super("<name>-lsp")`, implement `resolveBinary` (usually `this.resolveBundledBinary("<binary>", devPath?)`). Everything else is an opt-in hook, see `references/server-manager.md`.
3. **Registration.** `src/server/language-servers.ts`: import the manager and add it to `worktreeLspManagers`, both sorted. Its name gives the route (`/ws/<name>-lsp?wt=`), dispatch, shutdown and log category. If GitHub reports a conflict on this file, `git merge origin/main` resolves it with no edits.
4. **Client.** `src/lib/<name>-lsp-client.ts`: `export default createLspClient({ route: "ws/<name>-lsp", name: "<Server name>", languageId: "<languageId>" | [...ids] })`. The file name is the registration: it connects lazily, its languages get `file://` URIs and its log category appears in the logs panel. The route also names the client's diagnostics marker owner; `name` is what crash and status-bar notices call the server. Reconnecting after a crash comes with it. A language configuration on top of Monaco's goes in a new `src/lib/<language>-language-config.ts` exporting `registerLanguageConfiguration()`; the file name is its registration too.
5. **Docs.** `docs/languages/<language>.md` for what is specific to the language (managers, settings, quirks) and the page `packages/site/src/content/docs/languages/<language>.md` (frontmatter `title`, `description`, `order: 13.5`; it joins the navigation by itself). Neither needs an index edit.

Only if the language needs it (Go, Rust, C/C++, C#, Java and Kotlin are already covered):

- **Monaco.** If Monaco lacks the language (json, xml, yaml, python and dockerfile are built in), add it with its language configuration to `LOXEL_LANGUAGES` in `src/lib/monaco-languages.ts`, reusing Monaco's built-in `conf` for the same syntax where one exists.
- **Highlighting and icons.** `src/lib/highlighter.ts` `BUNDLED_LANGUAGES` plus `EXT_TO_LANG` / `FILENAME_TO_LANG`; a Shiki ID that differs from Monaco's goes in `monaco-theme.ts` `LANG_MAP`. A semantic token type with no `DARK_SEMANTIC_RULES` rule keeps its TextMate color, so a rule is only for a deliberate choice. `src/lib/file-icons.tsx`: SVG in `public/icons/`, `EXT_MAP` / `FILE_NAME_MAP`.
- **Toolchain environment.** If the language's toolchain must reach terminals and the coding agent's commands (a chosen version on `PATH`, `RUSTUP_TOOLCHAIN`): `src/server/<language>-toolchain-env.ts` exporting a `ToolchainEnvContributor` (`python-toolchain-env.ts` is the example; the interface's comment says what a `PATH` entry must refuse; `PATH` characters are checked for every contributor), plus one import and one entry in `src/server/toolchain-envs.ts`.
- **Toolchain status item.** If the user should see, and usually choose, the toolchain in the status bar: add a descriptor to `src/api/<language>-*-model.ts` and list it in `src/api/toolchain-statuses.ts`; `src/server/<language>-toolchain-status.ts` exporting a `ToolchainStatusModule`, listed in `src/server/toolchain-statuses.ts`; `src/lib/<language>-toolchain-status.ts` exporting a `ToolchainStatusItem`, listed in `src/lib/toolchain-status-items.ts`. One import and one entry in each list; no other shared file. Python is the example, see [Toolchain status items](../../../packages/loxel/docs/LANGUAGE_SERVERS.md#toolchain-status-items). Add the command to the site's keybinding reference.
- **Update resource directory.** A resource directory the server ships whose stale files would cause harm (`typeshed-fallback`) goes in `UPDATE_RESOURCE_DIRS` in `src/electron/main.ts`.

## Checklist

- [ ] Manifest and binary script
- [ ] Manager with `resolveBinary`, flags and settings hooks, listed in `language-servers.ts`
- [ ] Client module with a default export
- [ ] Language registered, highlighted and iconed, if it was not already
- [ ] `docs/languages/<language>.md` and the site page
- [ ] `pnpm install` and `pnpm -C packages/loxel run typecheck` pass
