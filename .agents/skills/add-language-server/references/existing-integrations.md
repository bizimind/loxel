# Existing LSP Integrations

Quick reference for the quirks of the servers that existed before `docs/languages/`. Consult when the new integration needs behavior beyond the vanilla template. A new server records its own in `packages/loxel/docs/languages/<language>.md`, not here.

## Integration Matrix

| LSP                   | Binary Source | Scope    | Connection | Semantic Tokens | Full-text Sync | Spawn Args      | Init Options                  |
| --------------------- | ------------- | -------- | ---------- | --------------- | -------------- | --------------- | ----------------------------- |
| TypeScript (tsc)      | copy script   | worktree | eager      | enabled         | no             | `--lsp -stdio`  | preferences                   |
| YAML                  | Bun-built     | global   | always     | enabled         | no             | `--stdio`       | schema map (post-init)        |
| Docker                | source-built  | worktree | lazy       | disabled        | yes            | `start --stdio` | compose, telemetry, Scout off |
| Terraform             | downloaded    | worktree | lazy       | disabled        | no             | `serve`         | indexing ignore dirs          |
| Python (basedpyright) | Bun-built     | worktree | lazy       | enabled         | no             | `--stdio`       | interpreter, ruleset (pulled) |
| Python (ruff)         | downloaded    | worktree | lazy       | n/a             | no             | `server`        | `showSyntaxErrors` off        |
| Python (mypy)         | project env   | worktree | lazy       | n/a             | n/a            | in-process      | none                          |
| Astro                 | Bun-built     | worktree | lazy       | disabled        | no             | `--stdio`       | TypeScript SDK path           |
| XML (LemMinX)         | downloaded    | worktree | lazy       | enabled         | no             | `--stdio`       | none                          |
| TOML (Tombi)          | downloaded    | worktree | lazy       | disabled        | no             | `lsp`           | schema map (post-init)        |

## TypeScript — Do Not Use as Template

The most complex manager. Unique behaviors not found in other LSPs:

- Bidirectional URI translation (`loxel://HEAD/` <-> `file:///`; JSON files keep `file://`)
- LanguageId fixup: `tsx` -> `typescriptreact`, `jsx` -> `javascriptreact`
- Server-side filtering of non-TS files via `shouldDropForNonTsUri()`
- Inline `workspace/configuration` response (TypeScript blocks until answered)
- Per-file indentation for quick fixes: TypeScript has one format setting per server, so the manager switches it (`workspace/didChangeConfiguration`) to the requesting file's indentation, which the client reports with `loxel/documentIndentation`, before forwarding code action and completion requests
- Forwards watched files like basedpyright, ruff and Tombi; the base takes its watcher registrations out before `handleServerFrame` sees them

## YAML — Global Singleton

The only global LSP. Uses `attach(ws)` / `detach(ws)` instead of `createSession` / `destroySession`. Its client calls `createLspClient`'s `connect(null)` once (no `wt`) and never disconnects. In `server.ts`, the YAML route is handled separately from `worktreeLspManagers`.

## Docker — Three Non-Standard Behaviors

1. **`requiresFullTextSync = true`** — server overwrites entire document on incremental changes
2. **Panic swallowing** — `handleServerFrame` catches `-32803` errors from a known bug and returns null
3. **Config** — `getInitializationOptions()` disables compose support (YAML LSP handles compose files) and telemetry; `workspaceConfiguration()` disables Scout
4. **No network** — built from source without Docker's keys, inlay hints suppressed, spawned with a dead HTTP proxy

Also: serves two language IDs via array, overrides `resolveBinary()` for Windows `.exe`, uses `["start", "--stdio"]`.

## Terraform

Downloaded Go binary. Uses `["serve"]` spawn arg (not `--stdio`). Passes `indexing.ignoreDirectoryNames` via init options.

## Python (basedpyright)

The npm package ships one pre-bundled file; the build script compiles it through a wrapper entry that sets `__rootDirectory` and replaces `v8.getHeapStatistics` (a full heap walk under Bun that made completions and code actions take seconds), and copies the `typeshed-fallback` directory (also listed in electron-builder.yml extraResources and the release archive).

basedpyright reads only `disablePullDiagnostics` from `initializationOptions`; its settings come from `workspace/configuration`. The manager implements `workspaceConfiguration` to answer `python.pythonPath` from the shared Python environment resolution (`python-env.ts`) and the `basedpyright` section (`standard` ruleset), and re-announces config after each re-resolution it subscribes to (`subscribePythonEnv`: environment changes on disk, a new chosen interpreter). Its semantic tokens include `selfParameter`, `clsParameter` and `decorator`, which have rules in `monaco-theme.ts`. See LANGUAGE_SERVERS.md "Python environment".

## Ruff — Second Server for a Language

The pattern for a second server and for project-provided binaries is in `server-manager.md`. Runs next to basedpyright on the same `python` models: its own route, client and lazy connector, each client keeping its own diagnostics markers. `resolveBinary` is async: the `ruff` beside the resolved interpreter if it passes the environment trust rule and is at least 0.5.3, else the downloaded one. It picks again after each re-resolution of the environment and, when the pick changes, closes the socket with `LSP_RESTART_CLOSE_CODE` so the client reconnects to a new server. Suppresses its formatting (`suppressedFeatures`) so format on save stays the only Python formatter, and turns off syntax errors that basedpyright already reports.

## mypy — A Tool Without a Language Server

`mypy-lsp-manager.ts` is not a `StdioLspManager`: it speaks LSP over the WebSocket itself (handshake, open/close, `publishDiagnostics`, `window/showMessage`) and runs the project's `dmypy` per config root, so a CLI checker's results still go through the regular client pipeline. It mirrors the stdio managers' public surface (`createSession`, `destroySession`, `handleMessage`, `notifyWatchedFilesChanged`, `destroy`) so `server.ts` wires it like the others. It is basedpyright's `ExternalTypeChecker`: where it type-checks a file, `PythonLspManager` drops basedpyright's type errors. See LANGUAGE_SERVERS.md "basedpyright, ruff and mypy".

## Astro — Use as Template

Simplest worktree-scoped integration. Clean Bun.build (no plugins), standard client, standard lazy connector.

## XML (LemMinX)

Downloaded GraalVM native binary (Java compiled to native — no JRE at runtime). Download script hashes the zip before extraction and restricts unzip to the expected filename. Binary lives in `build/lemminx/lemminx` (subdirectory) because the zip contains a platform-suffixed name (`lemminx-osx-aarch_64`) that gets renamed. Uses `resolveBundledBinary("lemminx", devPath)` with explicit `devPath` since the binary isn't in `node_modules/.bin/`. XML is a Monaco built-in language — no registration or language configuration needed.

## TOML (Tombi) — Schemas Pushed as Editor Configuration

Downloaded Rust binary (tarball, or zip on Windows; static musl builds on Linux), like ruff. Spawned as `tombi lsp`. Gets the Settings > Schemas map like YAML, but per worktree: `updateSchemas()` pushes a `workspace/didChangeConfiguration` `tombi` section (globs converted by `toTombiPatterns`, catalogs and strict mode off) to every initialized session, then an empty `tombi/associateSchema` so Tombi drops its cached diagnostics and asks the client to pull again. Suppresses formatting (format on save owns it), disables semantic tokens (TextMate highlights TOML) and forwards watched files. Tombi asks for `workspace/workspaceFolders`, which the base class answers for every worktree-scoped server. See LANGUAGE_SERVERS.md "TOML (Tombi)".
