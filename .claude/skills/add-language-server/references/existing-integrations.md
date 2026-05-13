# Existing LSP Integrations

Quick reference for per-LSP quirks. Consult when the new integration needs behavior beyond the vanilla template.

## Integration Matrix

| LSP                    | Binary Source | Scope    | Connection | Semantic Tokens | Full-text Sync | Spawn Args                 | Init Options            |
| ---------------------- | ------------- | -------- | ---------- | --------------- | -------------- | -------------------------- | ----------------------- |
| TypeScript (tsgo/tsls) | copy script   | worktree | eager      | enabled         | no             | `--lsp -stdio` / `--stdio` | preferences             |
| YAML                   | Bun-built     | global   | always     | enabled         | no             | `--stdio`                  | schema map (post-init)  |
| Docker                 | downloaded    | worktree | lazy       | disabled        | yes            | `start --stdio`            | compose=off (post-init) |
| Terraform              | downloaded    | worktree | lazy       | disabled        | no             | `serve`                    | indexing ignore dirs    |
| Python (Pyright)       | Bun-built     | worktree | lazy       | enabled         | no             | `--stdio`                  | analysis settings       |
| Astro                  | Bun-built     | worktree | lazy       | disabled        | no             | `--stdio`                  | TypeScript SDK path     |

## TypeScript — Do Not Use as Template

The most complex manager. Unique behaviors not found in other LSPs:

- Bidirectional URI translation (`loxel://HEAD/` <-> `file:///`)
- LanguageId fixup: `tsx` -> `typescriptreact`, `jsx` -> `javascriptreact`
- Server-side filtering of non-TS files via `shouldDropForNonTsUri()`
- Inline `workspace/configuration` response (tsgo blocks until answered)
- Backend selection between `tsgo` and `tsls` via `LOXEL_TS_LSP` env var

## YAML — Global Singleton

The only global LSP. Uses `attach(ws)` / `detach(ws)` instead of `createSession` / `destroySession`. Client is custom (doesn't use `createWorktreeLspClient`). In `index.ts`, the YAML route is handled separately from the `worktreeLspTypes` array.

## Docker — Three Non-Standard Behaviors

1. **`requiresFullTextSync = true`** — server overwrites entire document on incremental changes
2. **Panic swallowing** — `handleServerFrame` catches `-32803` errors from a known bug and returns null
3. **Post-init config** — `onClientInitialized()` disables compose support (YAML LSP handles compose files)

Also: serves two language IDs via array, overrides `resolveBinary()` for Windows `.exe`, uses `["start", "--stdio"]`.

## Terraform

Downloaded Go binary. Uses `["serve"]` spawn arg (not `--stdio`). Passes `indexing.ignoreDirectoryNames` via init options.

## Python (Pyright)

Build script patches webpack dynamic require and copies `typeshed-fallback` directory (also listed in electron-builder.yml extraResources).

## Astro — Use as Template

Simplest worktree-scoped integration. Clean Bun.build (no plugins), standard client, standard lazy connector.
