# Language Servers and Language Intelligence

How Loxel provides language features: language-server subprocesses bridged to Monaco over WebSockets, project-wide TypeScript diagnostics, formatting, JSON/YAML schemas and syntax highlighting.

To add a new language server, follow the [add-language-server skill](../../../.agents/skills/add-language-server/SKILL.md) and its [per-server quirks reference](../../../.agents/skills/add-language-server/references/existing-integrations.md). This doc is the architecture that skill assumes; it does not repeat the checklist. For the end-user view see the site's [TypeScript Intelligence](../../site/src/content/docs/typescript-intelligence.md) page.

## Data flow

```
Monaco model ──(MonacoLspClient, JSON-RPC over WS)──▶ /ws/<lang>-lsp[?wt=<path>]
   ▲                                                       │ server.ts routes by ws.data.type
   │                                                       ▼
   └──────── providers / markers ◀── WS ◀── <Lang>LspManager (StdioLspManager subclass)
                                                           │ Content-Length framed stdio
                                                           ▼
                                                 language-server subprocess (cwd = worktree)
```

The server is a thin proxy. It owns process lifetime, framing and a small set of message rewrites (initialize parameters, URI translation, capability scrubbing). All LSP feature logic on the client lives in the `monaco-lsp-client` fork, which registers Monaco providers from the server's advertised capabilities.

## Server side

### `StdioLspManager` base class

[stdio-lsp-manager.ts](../src/server/stdio-lsp-manager.ts) bridges one WebSocket to one subprocess. Public API: `handleMessage(ws, data)`, `detach(ws)` (kill and forget), `destroy()` (kill all, used on server shutdown). Subclasses add their own entry points (`createSession(ws, wtPath)` / `destroySession(ws)` for worktree-scoped managers, `attach(ws)` for YAML) that call the protected `startSession(ws, context)`.

- **Session model.** `sessions: Map<ServerWebSocket, TSession>`. `BaseLspSession` holds the `ws`, the `proc`, the stdout reassembly buffer and `documentContents` (used only for full-text sync). `WtLspSession` adds `wtPath`.
- **Dedup by key.** `getSessionKey(context)` returns a key (worktree managers return `wtPath`; YAML returns `null`). `startSession` keeps at most one live session per key: if another WebSocket already owns the key, that session is detached and its socket closed with code `4000` ("Replaced by newer connection"). A missing binary closes the socket with `4001`.
- **Spawn.** `Bun.spawn([resolveBinary(), ...spawnArgs()])` with piped stdio, `cwd` from `spawnOptions(context)` and `NODE_OPTIONS` cleared in the environment. Default args are `["--stdio"]`.
- **Framing.** `writeToStdin` adds the `Content-Length` header and flushes the `FileSink` per message. `drainMessages` parses frames out of stdout and hands each body to `handleServerFrame`.
- **`initialize` rewriting.** When `getSessionWorkspace(session)` returns a path, missing `rootUri` / `rootPath` / `workspaceFolders` are filled in (client values win). `getInitializationOptions(session)` is merged one level deep into the client's `initializationOptions` (client values win). Config that the server only accepts by push goes in `onClientInitialized`, which runs after the client's `initialized` notification is forwarded and typically sends `workspace/didChangeConfiguration`.
- **`disableSemanticTokens`.** Strips the semantic-tokens client capability from `initialize`, deletes `semanticTokensProvider` from the initialize response, and filters semantic-token entries out of `client/registerCapability` (answering the server directly when nothing is left).
- **`requiresFullTextSync`.** The base tracks text from `didOpen`, applies incremental `didChange` ranges locally (clamped), and forwards a single full-text change. A `didChange` for an untracked URI is forwarded unchanged with a warning.
- **Errors.** JSON-RPC error responses from the server are logged at info level before forwarding.
- **stderr.** Each session reads stderr line by line through a token bucket from [stderr-throttle.ts](../src/server/stderr-throttle.ts) (burst 200 lines, refill 50 lines/s, "suppressed N" summary every 5 s and on exit) so a chatty server cannot flood the shared log ring buffer. The last 20 lines are kept regardless and logged as a warning if the process exits non-zero.

### Per-language managers

| Manager                                                            | Binary                                                                        | Args            | Scope                        | Flags and config                                                                                                              |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- | --------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [ts-lsp-manager.ts](../src/server/ts-lsp-manager.ts)               | TypeScript 7 `tsc` via [typescript-path.ts](../src/server/typescript-path.ts) | `--lsp -stdio`  | worktree                     | Overrides `handleClientData` / `handleServerFrame` entirely (see below)                                                       |
| [python-lsp-manager.ts](../src/server/python-lsp-manager.ts)       | `pyright-langserver`                                                          | `--stdio`       | worktree                     | init options: `python.analysis` (`openFilesOnly`, auto search paths, library types)                                           |
| [astro-lsp-manager.ts](../src/server/astro-lsp-manager.ts)         | `astro-ls`                                                                    | `--stdio`       | worktree                     | semantic tokens off; init options: `typescript.tsdk` = worktree `node_modules/typescript/lib`                                 |
| [docker-lsp-manager.ts](../src/server/docker-lsp-manager.ts)       | `docker-language-server`                                                      | `start --stdio` | worktree                     | semantic tokens off, full-text sync; swallows the known `-32803` panic; pushes config disabling compose support and telemetry |
| [terraform-lsp-manager.ts](../src/server/terraform-lsp-manager.ts) | `terraform-ls`                                                                | `serve`         | worktree                     | semantic tokens off; init options: `indexing.ignoreDirectoryNames`                                                            |
| [xml-lsp-manager.ts](../src/server/xml-lsp-manager.ts)             | `lemminx`                                                                     | `--stdio`       | worktree                     | none                                                                                                                          |
| [yaml-lsp-manager.ts](../src/server/yaml-lsp-manager.ts)           | `yaml-language-server`                                                        | `--stdio`       | per connection, no workspace | pushes the schema map on `initialized` and on every `updateSchemas()`                                                         |

The TypeScript manager is the outlier. It always overwrites `rootUri` / `workspaceFolders` / `initializationOptions` (it does not use the base merge), answers `workspace/configuration` and `window/workDoneProgress/create` itself because TypeScript blocks on them, pushes completion preferences after `initialized`, rewrites `languageId` to `typescriptreact` / `javascriptreact` for `.tsx` / `.jsx`, drops `textDocument/*` messages whose URI does not have a TS/JS/JSON extension, and translates URIs (see [URI schemes](#uri-schemes)). It deliberately forwards `client/registerCapability` so Monaco sees TypeScript's dynamic semantic-tokens registration.

### Binary resolution and packaging

`resolveBundledBinary(name, devPath?)` checks, in order: a sibling of `process.execPath` (the packaged layout, where `loxel-server` and all servers are copied side by side), then `devPath` if given (downloaded binaries under `build/`) or else `node_modules/.bin/<name>`, then `PATH`. TypeScript uses its own resolver: `typescript-lib/tsc` next to the executable when packaged, else the `@typescript/native` Node shim in dev.

`build:server:standalone` in [package.json](../package.json) produces every binary under `build/`, and [electron-builder.yml](../electron-builder.yml) `extraResources` copies them next to `loxel-server` (plus Pyright's `typeshed-fallback` and the whole `typescript-lib/`, since the native compiler reads its sibling `lib.*.d.ts`). The scripts fall into three kinds:

- Bun-compiled from npm packages: [build-yaml-lsp.ts](../scripts/build-yaml-lsp.ts), [build-pyright-lsp.ts](../scripts/build-pyright-lsp.ts), [build-astro-ls.ts](../scripts/build-astro-ls.ts) (bundle with `Bun.build`, using plugins where UMD or webpack chunk loading defeats the bundler, then `bun build --compile`; packages located with [resolve-package.ts](../scripts/resolve-package.ts)).
- Downloaded native binaries with per-platform SHA256 pins verified before writing or extracting: [download-docker-lsp.ts](../scripts/download-docker-lsp.ts), [download-terraform-ls.ts](../scripts/download-terraform-ls.ts), [download-xml-lsp.ts](../scripts/download-xml-lsp.ts) (GraalVM-native LemMinX, no JRE).
- Copied: [copy-typescript.ts](../scripts/copy-typescript.ts) copies the platform `@typescript/typescript-<platform>-<arch>` `lib/` directory, so TypeScript ships in lockstep with the server.

Packaging and signing of these extra binaries is covered in [ELECTRON.md](ELECTRON.md) and [RELEASE_SIGNING.md](RELEASE_SIGNING.md).

### WebSocket routes

[server.ts](../src/server/server.ts) creates one instance of each manager at startup. In `fetch`, `/ws/yaml-lsp` upgrades with `data: { type: "yaml-lsp" }`. The `worktreeLspTypes` array (`ts-lsp`, `docker-lsp`, `terraform-lsp`, `python-lsp`, `astro-lsp`, `xml-lsp`) maps `/ws/<type>` to an upgrade with `data: { type, wtPath }`, rejecting requests without `?wt=` with 400. `WorktreeLspType` is derived from the `WsData` union in [server-state.ts](../src/server/server-state.ts), so adding a type there and to the array is what makes a route exist. The `websocket.open` / `close` / `message` handlers dispatch on `ws.data.type` to `createSession` / `destroySession` / `handleMessage`; only string frames are forwarded.

### Lifecycle

- **Spawn** happens when a client opens the socket. **Kill** happens when the socket closes (client disposed its transport), when a newer socket claims the same worktree key, or in `shutdown()`.
- **Worktree switch** is driven by the client: it disposes the old transport and connects with the new `wt`, which kills the old subprocess via the close handler.

## Client side

- [lsp-client.ts](../src/lib/lsp-client.ts) `createWorktreeLspClient(wsPath, languageId)` returns an idempotent `connect(wtPath)` / `disconnect()` pair around one `WebSocketTransport` and one `MonacoLspClient`. It guards against a double spawn while a connect is in flight and discards a transport that resolves after the path changed.
- The per-language modules ([ts-lsp-client.ts](../src/lib/ts-lsp-client.ts), [python-lsp-client.ts](../src/lib/python-lsp-client.ts), [astro-lsp-client.ts](../src/lib/astro-lsp-client.ts), [docker-lsp-client.ts](../src/lib/docker-lsp-client.ts), [terraform-lsp-client.ts](../src/lib/terraform-lsp-client.ts), [xml-lsp-client.ts](../src/lib/xml-lsp-client.ts)) only bind a route and Monaco language IDs. TypeScript binds `typescript`, `javascript`, `tsx`, `jsx`, `json`, `jsonc`; Docker binds `dockerfile` and `dockerbake`. [yaml-lsp-client.ts](../src/lib/yaml-lsp-client.ts) is separate: one connection per renderer, no `wt`, no disconnect.
- [monaco-env.ts](../src/lib/monaco-env.ts) is the single wiring point, imported for its side effects. It disables all of Monaco's built-in TS/JS features (no TS worker; the JSON, CSS and HTML workers stay), registers the language IDs Monaco does not ship (`terraform`, `astro`, `tsx`, `jsx`, `dockerbake`), and connects the servers. YAML connects at load. TypeScript is eager: it connects to the active worktree and reconnects whenever `activeWorktreePath` changes. Every other server goes through `createLazyLspConnector`, which counts live models of its languages in the active worktree (plus live-editor models of files outside every project, served by the active worktree's server) and connects on the first one, disconnecting at zero. Diff and history models are not counted. It also registers the editor opener that turns go-to-definition results with a `loxel:` URI into `dispatchOpenFile`.
- [packages/monaco-lsp-client](../../monaco-lsp-client/README.md) is a fork of `@vscode/monaco-lsp-client` consumed as TypeScript source. Its main local change for Loxel is the `languageId` option: `TextDocumentSynchronizer` only syncs models whose language is in the set, which is what lets several servers coexist on one Monaco instance. Diagnostics from the server become Monaco markers under owner `lsp`.
- [ws-shim.ts](../src/lib/ws-shim.ts) is aliased to `ws` in [vite.config.ts](../vite.config.ts) because `@hediet/json-rpc-websocket` imports the Node `ws` package; the browser uses the native `WebSocket`.

## URI schemes

[CodeEditorPanel.tsx](../src/components/code-editor/CodeEditorPanel.tsx) picks the model URI per Monaco language. `useFileScheme` (yaml, json, dockerfile, dockerbake, terraform, astro, xml) gives `file://<abs path>`, which those servers need for schema matching and workspace indexing. Every other language gets `loxel://HEAD/<abs path>`. Diff views ([diff/EditorPanel.tsx](../src/components/diff/EditorPanel.tsx)) use `loxel://<ref or HEAD>/<repo-relative path>#<side>`.

Only the TypeScript manager translates: client-to-server it replaces `loxel://head/` (case-insensitive) with `file:///`; server-to-client it replaces every `file:///` with `loxel://HEAD/`. No other manager rewrites URIs. Besides the TS translation, the `loxel:` scheme is what the editor opener and the lazy connector's live-editor check key on.

## Diagnostics

There are two TypeScript diagnostic paths:

- **Live, per file.** The TS LSP publishes diagnostics, which `monaco-lsp-client` turns into `lsp` markers.
- **Project-wide snapshot.** `GET /api/diagnostics?wt=&ref=&worktree=` ([routes.ts](../src/server/routes.ts) `handleDiagnostics`) calls `getDiagnostics` in [diagnostics.ts](../src/server/diagnostics.ts), which runs `tsc --noEmit --pretty false` (30 s timeout) and parses lines into `TypeScriptDiagnostic` from [diagnostics-model.ts](../src/api/diagnostics-model.ts) (repo-relative file, 1-based line and column, code, severity, `node_modules` excluded). The code editor and the diff view apply these as `typescript` markers.

For the working tree (no `ref`) `tsc` runs directly in the worktree and nothing is cached on the server. For a `ref` the server validates it against `REF_PATTERN`, deduplicates concurrent requests, creates a detached temporary worktree named `${INTERNAL_WORKTREE_PREFIX}diag-<sha8>` in a `mktemp -d` directory, symlinks `node_modules` from the source checkout, runs `tsc`, caches the result by ref in memory for the server's lifetime, and force-removes the worktree. `INTERNAL_WORKTREE_PREFIX` ([worktree-utils.ts](../src/server/worktree-utils.ts)) hides these worktrees from worktree lists, and `pruneOrphanedTempWorktrees` in `server.ts` force-removes all of them when a project is initialized, to clean up after crashes.

On the client the snapshot is a TanStack query under `queryKeys.diagnostics(...)`.

## Formatting

Formatting runs on the server as part of `POST /api/file-write` when the request carries `format: true` and valid `formattingSettings` ([FormattingSettings](../src/lib/formatting-model.ts)). Editors set `saveOptionsRef` (explicit save) and `autoSaveOptionsRef` (auto-save, only when `formatOnAutoSave`) through [use-disk-synced-content.ts](../src/hooks/use-disk-synced-content.ts); [save-editor-content.ts](../src/lib/save-editor-content.ts) sends them, and the response's formatted `content` is merged back into the editor as a programmatic "format-echo" edit (see [EDITOR.md](EDITOR.md#disk-synced-content) for the save state machine). Only files inside the worktree's own tree are formatted; Others folders, drafts and external files are written as-is.

[format-service.ts](../src/server/format-service.ts) `FormatService.format()` returns `null` (write unformatted) when disabled, over 1 MB, without an extension, or with no match. Resolution order:

1. **Manual overrides** from settings, first entry whose comma-separated extension list contains the file's extension. Always run as a command.
2. **Auto-detection** (if `autoDetect`), by config files at the worktree root only, evaluated in `DETECTION_RULES` order, first formatter claiming the extension wins: prettier (config files or a `prettier` key in `package.json`), oxfmt (`.oxfmtrc.*` or an `oxfmt` dependency), rustfmt, ruff (`pyproject.toml`), clang-format, deno. Prettier and oxfmt share `SHARED_FORMAT_EXTENSIONS`; prettier adds `svelte` and `astro`, oxfmt adds `toml`. Because prettier is first, a project with both uses prettier for every shared extension. Detection is cached per worktree, keyed by a fingerprint of config-file sizes and mtimes.

Each rule has a `BackendMode` from [formatter-backends.ts](../src/server/formatter-backends.ts). `command` spawns the tool per request with content on stdin, `{file}` / `{ext}` substituted, the worktree's `node_modules/.bin` prepended to `PATH`, and a 5 s timeout. The two persistent backends are cached per `(worktree, command)`, restarted if dead, and on a `null` result destroyed and replaced by command mode for that request:

- [oxfmt-lsp-backend.ts](../src/server/oxfmt-lsp-backend.ts) keeps an `oxfmt --lsp` process (worktree `node_modules/.bin` first, then `PATH`) and formats via `didOpen` / `textDocument/formatting` / `didClose`, applying the returned edits.
- [prettier-lib-backend.ts](../src/server/prettier-lib-backend.ts) dynamically imports the worktree's own `node_modules/prettier` and calls `resolveConfig` + `format` in-process.

`invalidateCache(wtPath)` (called from worktree teardown) drops detection and destroys backends; `destroy()` runs at shutdown. `GET /api/detected-formatters?wt=` exposes detection to the settings UI.

## Schemas and JSON validation

- [schema-service.ts](../src/server/schema-service.ts) resolves a schema from an HTTP(S) URL (1 h TTL, 5 MB cap, 10 s timeout) or a local path (relative to a base directory, revalidated by mtime). Other URL schemes are rejected.
- `POST /api/schemas/sync` receives the enabled schema settings, classifies each glob as JSON, YAML or both, resolves JSON schemas inline and returns them, and pushes a `url → globs` map (local paths as `file://`) to the YAML manager's `updateSchemas`. `GET /api/schemas/resolve` resolves a single schema.
- [schema-sync.ts](../src/lib/schema-sync.ts) calls the sync endpoint after the settings store hydrates and when settings are saved, coalescing overlapping calls.
- [json-schema-registry.ts](../src/lib/json-schema-registry.ts) owns the single global `monaco.json.jsonDefaults` schema list (Monaco replaces it wholesale), merging configured glob schemas with per-file `$schema` schemas. `CodeEditorPanel` detects `$schema` in JSON models (debounced), resolves it through the server, and registers it under the URL Monaco's JSON worker would compute relative to the file's `file://` URI; this is one reason JSON is in `useFileScheme`.
- Monaco's JSON diagnostics are permissive (comments and trailing commas ignored) so JSONC files work. [json-strict-validator.ts](../src/lib/json-strict-validator.ts) re-parses files resolved as strict `json` with `jsonc-parser` and adds `json-strict` markers for comments and trailing commas.

## Highlighting and language resolution

- [highlighter.ts](../src/lib/highlighter.ts) holds a singleton Shiki highlighter (themes `loxel-dark` and `github-dark`, a fixed `BUNDLED_LANGUAGES` list), the `FILENAME_TO_LANG` and `EXT_TO_LANG` tables, `detectLanguage()` (case-insensitive filename, `.d.ts`, `.env*`, then extension) and `highlightCode()` for HTML token output. Language IDs here are Shiki IDs; `toMonacoLanguage()` in [monaco-theme.ts](../src/lib/monaco-theme.ts) maps the few that differ (for example `jsonc` → `json`, `toml` → `ini`).
- `monaco-env.ts` passes the highlighter to `shikiToMonaco`, so Monaco tokenizes Shiki-bundled languages with TextMate grammars instead of Monarch. [hcl-monarch.ts](../src/lib/hcl-monarch.ts) supplies a Monarch tokenizer for `dockerbake` only, which Shiki does not know.
- [resolve-language.ts](../src/lib/resolve-language.ts) `resolveLanguage(path, associations, content)` is what the code editor uses: enabled file associations first (first glob match wins; user entries precede built-ins in `selectEffectiveFileAssociations`), then `detectLanguage`, then content sniffing (shebang, XML prolog). The built-in associations in [settings-store.ts](../src/store/settings-store.ts) are generated from `FILENAME_TO_LANG` / `EXT_TO_LANG` plus glob overrides that exact names cannot express (`tsconfig*.json` → `jsonc`, `*.docker-bake.hcl` → `dockerbake`).
- [textmate-inspector.ts](../src/lib/textmate-inspector.ts) backs the editor's token-scope inspector using `codeToTokensBase` with explanations.
- [file-icons.tsx](../src/lib/file-icons.tsx) has its own filename, compound-extension and extension maps (JetBrains icon theme) and is independent of language resolution.

## Where to look

- Server bridge and managers: [stdio-lsp-manager.ts](../src/server/stdio-lsp-manager.ts), `src/server/*-lsp-manager.ts`, routes in [server.ts](../src/server/server.ts) (`worktreeLspTypes`, `websocket` handlers).
- Client wiring: [monaco-env.ts](../src/lib/monaco-env.ts), [lsp-client.ts](../src/lib/lsp-client.ts), [monaco-lsp-client](../../monaco-lsp-client/README.md).
- URI choice and markers: [CodeEditorPanel.tsx](../src/components/code-editor/CodeEditorPanel.tsx), [diff/EditorPanel.tsx](../src/components/diff/EditorPanel.tsx).
- Diagnostics: [diagnostics.ts](../src/server/diagnostics.ts), [worktree-utils.ts](../src/server/worktree-utils.ts).
- Formatting: [format-service.ts](../src/server/format-service.ts) and its backends, [formatting-model.ts](../src/lib/formatting-model.ts).
- Schemas: [schema-service.ts](../src/server/schema-service.ts), [schema-sync.ts](../src/lib/schema-sync.ts), [json-schema-registry.ts](../src/lib/json-schema-registry.ts).
- Highlighting: [highlighter.ts](../src/lib/highlighter.ts), [resolve-language.ts](../src/lib/resolve-language.ts).
- Related docs: [ARCHITECTURE.md](ARCHITECTURE.md), [EDITOR.md](EDITOR.md), [CODE_REVIEW.md](CODE_REVIEW.md) and [DIFF_VIEW_SPEC.md](DIFF_VIEW_SPEC.md) for the diff editors, [PROJECTS_AND_WORKTREES.md](PROJECTS_AND_WORKTREES.md) for worktree lifecycle.
