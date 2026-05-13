---
name: add-language-server
description: Add a new language server to loxel with full integration across all layers (build/download, server manager, server routing, client connection, Monaco registration, highlighting/icons, editor URI scheme, packaging). Use when adding support for a new programming language or file type that needs LSP features like completions, hover, diagnostics, or go-to-definition.
---

# Add Language Server

Integrate a new language server into loxel. There are 7 layers to wire up plus packaging. Read `references/existing-integrations.md` for per-LSP quirks and the integration matrix.

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

**B. Downloaded pre-built binary** — `packages/loxel/scripts/download-<name>.ts`. For Go/Rust binaries. Pin SHA256 digests per platform, verify after download. See docker-ls and terraform-ls download scripts.

**C. Copied from existing install** — Simple copy script (tsgo pattern).

Add a `build:<name>` or `download:<name>` script in package.json and chain it in `build:server:standalone`.

## Layer 2: Server-Side LSP Manager

**File:** `packages/loxel/src/server/<name>-lsp-manager.ts`

Use `astro-lsp-manager.ts` as the template — it's the simplest worktree-scoped integration. Extend `StdioLspManager<TSession, TContext>`.

### Override hooks (only when needed)

**`getSessionKey(context)`** — Return `context.wtPath` for worktree-scoped managers (prevents double-spawn). Return `null` for global managers.

**`resolveBinary()`** — Default: `resolveBundledBinary(name)` checks execPath sibling → node_modules/.bin → PATH. Pass optional `devPath` for pre-built binaries in `build/`. Override completely only for platform-specific names (`.exe` on Windows).

**`spawnArgs()`** — Override if the server doesn't use `["--stdio"]`.

**`getInitializationOptions(session)`** — For config the server reads at startup (SDK paths, indexing settings).

**`onClientInitialized(session)`** — For push-based config via `workspace/didChangeConfiguration` after handshake (Docker's compose settings, YAML's schemas).

**`handleServerFrame(session, body)` / `handleClientData(session, data)`** — For intercepting/transforming messages. Only TypeScript and Docker use these.

## Layer 3: Server Registration

### `packages/loxel/src/server/server-state.ts`

Add `| WorktreeLspData<"<name>-lsp">` to the `WsData` union.

### `packages/loxel/src/server/index.ts`

1. Import and instantiate the manager globally
2. Add `"<name>-lsp"` to the `worktreeLspTypes` array
3. Add `open`/`close`/`message` handlers in the websocket block
4. Call `.destroy()` in `shutdown()`

### `packages/loxel/src/api/log-entry-model.ts`

Add `"<name>-lsp"` to `LOG_CATEGORIES`.

## Layer 4: Client-Side LSP Connection

**File:** `packages/loxel/src/lib/<name>-lsp-client.ts`

```typescript
import { createWorktreeLspClient } from "./lsp-client";

const { connect: connect<Name>Lsp, disconnect: disconnect<Name>Lsp } = createWorktreeLspClient(
  "ws/<name>-lsp",
  "<languageId>",       // string for single language
  // ["id1", "id2"],    // array for multi-language servers (Docker, TypeScript)
);

export { connect<Name>Lsp, disconnect<Name>Lsp };
```

The `languageId` parameter filters which Monaco models get synced over the WebSocket.

YAML is special — uses a custom client that doesn't use `createWorktreeLspClient`. See `yaml-lsp-client.ts`.

## Layer 5: Monaco Integration

**File:** `packages/loxel/src/lib/monaco-env.ts`

1. **Register the language** if Monaco doesn't have it built-in (built-in: json, css, html, typescript, javascript, dockerfile, python, markdown, yaml). Use `monaco.languages.register()`.
2. **Set language configuration** (brackets, comments, auto-closing pairs) via `monaco.languages.setLanguageConfiguration()`.
3. **Wire the lazy connector:**

```typescript
createLazyLspConnector({
  languageIds: ["<languageId>"], // array — list all language IDs for multi-language servers
  connect: connect < Name > Lsp,
  disconnect: disconnect < Name > Lsp,
});
```

## Layer 6: Highlighting & Icons

**`packages/loxel/src/lib/highlighter.ts`** — Add to `BUNDLED_LANGUAGES` (if Shiki supports it) and map in `EXT_TO_LANG`. If the Shiki language ID differs from Monaco's, add a mapping in `monaco-theme.ts` `LANG_MAP`.

**`packages/loxel/src/lib/file-icons.tsx`** — Add SVG to `public/icons/`, map extension in `EXT_MAP`, config filenames in `FILE_NAME_MAP`.

## Layer 7: Editor URI Scheme

**File:** `packages/loxel/src/components/code-editor/CodeEditorPanel.tsx`

Add the language to the `useFileScheme` check. Most LSPs need `file://` URIs for import resolution. Only TypeScript uses `loxel://HEAD/` with server-side translation.

## Layer 8: Packaging & Release

- **`packages/loxel/electron-builder.yml`** — Add `from: build/<binary-name>` to `extraResources`
- **`.github/workflows/release-loxel.yml`** — Add codesign (`codesign -s - -f`) and staging copy (`cp`) lines

## Checklist

- [ ] Binary sourced and script chained in `build:server:standalone`
- [ ] LSP manager extends `StdioLspManager` with correct flags and `getSessionKey`
- [ ] `server-state.ts` WsData union entry
- [ ] `index.ts`: import, instantiate, route, handlers, destroy
- [ ] `log-entry-model.ts` log category
- [ ] Client module exports connect/disconnect with languageId filter
- [ ] Monaco language registered (if not built-in) with language configuration
- [ ] Lazy connector wired in `monaco-env.ts`
- [ ] Extension mapped in `highlighter.ts`
- [ ] File icon SVG + mappings in `file-icons.tsx`
- [ ] URI scheme set to `file://` in `CodeEditorPanel.tsx`
- [ ] `electron-builder.yml` and release workflow updated
- [ ] `bun install` and typecheck pass
