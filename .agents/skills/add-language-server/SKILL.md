---
name: add-language-server
description: Add a new language server to loxel with full integration across all layers (build/download, server manager, server routing, client connection, Monaco registration, highlighting/icons, editor URI scheme, packaging). Use when adding support for a new programming language or file type that needs LSP features like completions, hover, diagnostics, or go-to-definition.
---

# Add Language Server

Integrate a new language server into loxel. There are 7 layers to wire up plus packaging (layer 8). Read `references/existing-integrations.md` for per-LSP quirks and the integration matrix.

This skill covers LSP integration only. It does not cover formatters, TextMate grammars, or monaco-lsp-client internals.

## Decision Points

Resolve these with the user before starting:

| Decision            | Default                                   | Alternatives                                                               |
| ------------------- | ----------------------------------------- | -------------------------------------------------------------------------- |
| **Scope**           | Worktree (one subprocess per worktree)    | Global (YAML model — single shared subprocess)                             |
| **Connection**      | Lazy (spawned when matching models exist) | Eager (TypeScript model — always connected)                                |
| **Binary source**   | Bun-built from NPM package                | Downloaded pre-built binary (Go/Rust servers)                              |
| **Semantic tokens** | Enabled                                   | Disabled (`disableSemanticTokens = true`) if buggy                         |
| **Text sync**       | Incremental                               | Full-text (`requiresFullTextSync = true`) if server mishandles incremental |
| **URI scheme**      | `file://` (most LSPs)                     | `loxel://HEAD/` with server-side translation (TypeScript only)             |
| **Language IDs**    | One language per server                   | Multiple (Docker serves `dockerfile` + `dockerbake`)                       |
| **Spawn args**      | `["--stdio"]`                             | Varies: `["serve"]` (terraform-ls), `["start", "--stdio"]` (docker-ls)     |

## Layer 1: Binary Sourcing

**Three approaches — pick one:**

**A. Bun-built from NPM package** — `packages/loxel/scripts/build-<name>.ts`. Two-step: `Bun.build()` bundles the entry point, then `bun build --compile` produces a standalone binary in `build/`. Use `resolvePackage()` from `./resolve-package.ts` to locate the NPM package. Some servers need Bun.build plugins (see pyright and yaml-ls build scripts for examples). Add the NPM package as a devDependency.

**B. Downloaded pre-built binary** — `packages/loxel/scripts/download-<name>.ts`. For Go/Rust/GraalVM-native binaries. Pin SHA256 digests per platform. Hash the downloaded bytes _in memory before writing or extracting_ — never extract untrusted content before verification. For zip archives, pass the expected binary filename to `unzip` to restrict extraction to that single file. See docker-ls (raw binary), terraform-ls (zip), and xml-lsp (zip with rename) download scripts.

**C. Copied from an installed package** — Simple copy script (TypeScript 7's `copy-typescript.ts` pattern).

Add a `build:<name>` or `download:<name>` script in package.json and chain it in `build:server:standalone`.

## Layer 2: Server-Side LSP Manager

**File:** `packages/loxel/src/server/<name>-lsp-manager.ts`

Use `astro-lsp-manager.ts` as the template — it's the simplest worktree-scoped integration. Extend `StdioLspManager<WtLspSession, WtLspContext>` (from `stdio-lsp-manager.ts`) and call `super("<name>-lsp")` (the name is a `LogCategory`, see Layer 3).

### Required

- **`createSession(ws, wtPath)` / `destroySession(ws)`** — Public entry points called from `server.ts`; delegate to `startSession(ws, { wtPath })` / `detach(ws)`.
- **`resolveBinary()`** — Abstract. Usually `return this.resolveBundledBinary("<binary>")`, which checks execPath sibling → `node_modules/.bin` → PATH. Pass a `devPath` (absolute path under `build/`) for downloaded binaries; it replaces the `node_modules/.bin` check.
- **`buildSession(ws, proc, context)`** — Abstract. Return the session object (copy Astro's).

### Worktree-scoped (copy from Astro)

- **`getSessionKey(context)`** — Return `context.wtPath` (prevents double-spawn). The default `null` is for global managers (YAML).
- **`getSessionWorkspace(session)`** — Return `session.wtPath` so `rootUri`/`workspaceFolders` are injected into `initialize`.
- **`spawnOptions(context)`** — Return `{ cwd: context.wtPath }`.

### Optional overrides

- **`disableSemanticTokens` / `requiresFullTextSync`** — Readonly flags, see Decision Points.
- **`spawnArgs()`** — Override if the server doesn't use `["--stdio"]`.
- **`getInitializationOptions(session)`** — For config the server reads at startup (SDK paths, indexing settings).
- **`onClientInitialized(session)`** — For push-based config via `workspace/didChangeConfiguration` after handshake (Docker's compose settings, YAML's schemas).
- **`handleServerFrame(session, body)` / `handleClientData(session, data)`** — For intercepting/transforming messages. Only TypeScript and Docker use these.

## Layer 3: Server Registration

### `packages/loxel/src/server/server-state.ts`

Add `| WorktreeLspData<"<name>-lsp">` to the `WsData` union.

### `packages/loxel/src/server/server.ts`

(`index.ts` is only the process entry point; the server lives in `server.ts`.)

1. Import and instantiate the manager at module level
2. Add `"<name>-lsp"` to the `worktreeLspTypes` array (WebSocket upgrade route `/ws/<name>-lsp?wt=<path>`)
3. Add `open`/`close`/`message` handlers in the websocket block
4. Call `.destroy()` in `shutdown()`

### `packages/loxel/src/api/log-entry-model.ts`

Add `"<name>-lsp"` to `LOG_CATEGORIES` (required — the manager constructor takes a `LogCategory`).

## Layer 4: Client-Side LSP Connection

**File:** `packages/loxel/src/lib/<name>-lsp-client.ts`

```typescript
import { createWorktreeLspClient } from "./lsp-client";

// Example for a server named "foo"
const { connect: connectFooLsp, disconnect: disconnectFooLsp } = createWorktreeLspClient(
  "ws/foo-lsp",
  "foo", // string for single language
  // ["id1", "id2"], // array for multi-language servers (Docker, TypeScript)
);

export { connectFooLsp, disconnectFooLsp };
```

The `languageId` parameter filters which Monaco models get synced over the WebSocket.

YAML is special — uses a custom client that doesn't use `createWorktreeLspClient`. See `yaml-lsp-client.ts`. TypeScript only exports `connect` (it is never disconnected).

## Layer 5: Monaco Integration

**File:** `packages/loxel/src/lib/monaco-env.ts`

1. **Register the language** with `monaco.languages.register()` if Monaco doesn't ship it (common ones like json, xml, yaml, python, dockerfile are built in; `monaco-env.ts` already registers terraform, astro, tsx, jsx, dockerbake).
2. **Set language configuration** (brackets, comments, auto-closing pairs) via `monaco.languages.setLanguageConfiguration()`.
3. **Wire the lazy connector:**

```typescript
createLazyLspConnector({
  languageIds: ["<languageId>"], // array — list all language IDs for multi-language servers
  connect: connectFooLsp,
  disconnect: disconnectFooLsp,
});
```

## Layer 6: Highlighting & Icons

**`packages/loxel/src/lib/highlighter.ts`** — Add to `BUNDLED_LANGUAGES` (if Shiki supports it) and map in `EXT_TO_LANG` (or `FILENAME_TO_LANG` for extensionless names like `Dockerfile`). If the Shiki language ID differs from Monaco's, add a mapping in `monaco-theme.ts` `LANG_MAP`.

**`packages/loxel/src/lib/file-icons.tsx`** — Add SVG to `public/icons/`, map extension in `EXT_MAP`, config filenames in `FILE_NAME_MAP`.

## Layer 7: Editor URI Scheme

**File:** `packages/loxel/src/components/code-editor/CodeEditorPanel.tsx`

Add the language to the `useFileScheme` check. Most LSPs need `file://` URIs for import resolution. Languages not in the list get `loxel://HEAD/` URIs; only TypeScript translates those server-side (`ts-lsp-manager.ts`).

## Layer 8: Packaging & Release

- **`packages/loxel/electron-builder.yml`** — Add `from: build/<binary-name>` to `extraResources`
- **`.github/workflows/release-loxel.yml`** — Add ad-hoc codesign (`codesign -s - -f packages/loxel/build/<binary>`) and staging copy (`cp ... staging/`) lines next to the existing LSP binaries

## Checklist

- [ ] Binary sourced and script chained in `build:server:standalone`
- [ ] LSP manager extends `StdioLspManager` with `resolveBinary`, `buildSession`, worktree hooks, and correct flags
- [ ] `server-state.ts` WsData union entry
- [ ] `server.ts`: import, instantiate, route, handlers, destroy
- [ ] `log-entry-model.ts` log category
- [ ] Client module exports connect/disconnect with languageId filter
- [ ] Monaco language registered (if not built-in) with language configuration
- [ ] Lazy connector wired in `monaco-env.ts`
- [ ] Extension/filename mapped in `highlighter.ts`
- [ ] File icon SVG + mappings in `file-icons.tsx`
- [ ] URI scheme set to `file://` in `CodeEditorPanel.tsx`
- [ ] `electron-builder.yml` and release workflow updated
- [ ] `pnpm install` and `pnpm -C packages/loxel run typecheck` pass
