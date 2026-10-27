---
name: add-language-server
description: Add a new language server to loxel with full integration across all layers (build/download, server manager, server routing, client connection, Monaco registration, highlighting/icons, editor URI scheme, packaging). Use when adding support for a new programming language or file type that needs LSP features like completions, hover, diagnostics, or go-to-definition, including a second server for a language that already has one.
---

# Add Language Server

Integrate a new language server into loxel: 7 layers plus packaging. Architecture: `packages/loxel/docs/LANGUAGE_SERVERS.md`. References:

- `references/server-manager.md`: the manager's hooks, how a server gets its settings, project-provided binaries, and a second server for a language that already has one (basedpyright + ruff).
- `references/existing-integrations.md`: integration matrix and per-server quirks.

This skill covers LSP integration only, not formatters, TextMate grammars or monaco-lsp-client internals.

## Decision Points

Resolve these with the user before starting:

| Decision            | Default                                   | Alternatives                                                                                           |
| ------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Scope**           | Worktree (one subprocess per worktree)    | Global (YAML: one shared subprocess)                                                                   |
| **Connection**      | Lazy (spawned when matching models exist) | Eager (TypeScript: always connected)                                                                   |
| **Binary source**   | Bun-built from NPM package                | Downloaded pre-built binary (Go/Rust servers); the project's own install (ruff)                        |
| **Settings**        | None                                      | Init options, pushed after `initialized`, or pulled with `workspace/configuration`                     |
| **Overlap**         | Only server for its languages             | A second server on the same languages (ruff next to basedpyright): suppress the features it duplicates |
| **Semantic tokens** | Enabled                                   | Disabled (`disableSemanticTokens = true`) if buggy or TextMate is better                               |
| **Text sync**       | Incremental                               | Full-text (`requiresFullTextSync = true`) if the server mishandles incremental                         |
| **Spawn args**      | `["--stdio"]`                             | `["serve"]` (terraform-ls), `["start", "--stdio"]` (docker-ls), `["server"]` (ruff), `["lsp"]` (Tombi) |

## Layers

All paths are under `packages/loxel/`.

1. **Binary.** One of: `scripts/build-<name>.ts` bundles an NPM package with `Bun.build`, then `bun build --compile` into `build/` (add the package as a devDependency; `resolvePackage()` locates it; see the yaml-ls plugins and the basedpyright shims); `scripts/download-<name>.ts` downloads a release with per-platform SHA256 pins, hashed in memory before anything is written or extracted, extracting only the binary (a tarball or Windows zip needs only `downloadReleaseBinary` from `download-release-binary.ts`, as ruff and Tombi do); or a copy script (`copy-typescript.ts`). Add a `build:<name>` / `download:<name>` script and chain it in `build:server:standalone`.
2. **Server manager.** `src/server/<name>-lsp-manager.ts`, from `astro-lsp-manager.ts` (the simplest): extend `WorktreeLspManager`, call `super("<name>-lsp")`, implement `resolveBinary` (usually `this.resolveBundledBinary("<binary>", devPath?)`). Everything else is an opt-in hook, see `references/server-manager.md`.
3. **Registration.** `src/server/server-state.ts`: add `| WorktreeLspData<"<name>-lsp">` to `WsData`. `src/server/server.ts`: instantiate at module level, add to `worktreeLspManagers` and the `worktreeLspTypes` array (route `/ws/<name>-lsp?wt=`), wire `open`/`close`/`message`, `.destroy()` in `shutdown()`. `src/api/log-entry-model.ts`: add `"<name>-lsp"` to `LOG_CATEGORIES`.
4. **Client.** `src/lib/<name>-lsp-client.ts`: `createWorktreeLspClient("ws/<name>-lsp", "<languageId>" | [...ids])`, exporting `connect<Name>Lsp` / `disconnect<Name>Lsp`. The route also names the client's diagnostics marker owner.
5. **Monaco.** If Monaco lacks the language (json, xml, yaml, python and dockerfile are built in), add it with its language configuration to `LOXEL_LANGUAGES` in `src/lib/monaco-languages.ts`, reusing Monaco's built-in `conf` for the same syntax where one exists. In `src/lib/monaco-env.ts`, add `createLazyLspConnector({ languageIds, connect, disconnect })`.
6. **Highlighting and icons.** `src/lib/highlighter.ts` `BUNDLED_LANGUAGES` plus `EXT_TO_LANG` / `FILENAME_TO_LANG`; a Shiki ID that differs from Monaco's goes in `monaco-theme.ts` `LANG_MAP`, and each semantic token type the server emits needs a `DARK_SEMANTIC_RULES` rule or it loses its TextMate color. `src/lib/file-icons.tsx`: SVG in `public/icons/`, `EXT_MAP` / `FILE_NAME_MAP`.
7. **URI scheme.** `src/components/code-editor/CodeEditorPanel.tsx`: add the language to `useFileScheme`. Servers need `file://` URIs; only TypeScript translates `loxel://HEAD/` server-side.
8. **Packaging.** `electron-builder.yml` `extraResources` (`from: build/<binary>`); `.github/workflows/release-loxel.yml` ad-hoc codesign and staging copy next to the other LSP binaries; a resource directory the server ships (`typeshed-fallback`) goes in `UPDATE_RESOURCE_DIRS` in `src/electron/main.ts`.

## Checklist

- [ ] Binary script chained in `build:server:standalone`
- [ ] Manager with `resolveBinary`, flags and settings hooks
- [ ] `server-state.ts`, `server.ts` (instance, route, handlers, destroy), `log-entry-model.ts`
- [ ] Client module and lazy connector; language registered and configured if not built in
- [ ] `highlighter.ts`, semantic token rules, file icons
- [ ] `useFileScheme` in `CodeEditorPanel.tsx`
- [ ] `electron-builder.yml` and release workflow
- [ ] LANGUAGE_SERVERS.md (managers table, routes, client modules, registered languages), `references/existing-integrations.md`, the language on the site page `packages/site/src/content/docs/language-intelligence.md`
- [ ] `pnpm install` and `pnpm -C packages/loxel run typecheck` pass
