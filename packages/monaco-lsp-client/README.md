# monaco-lsp-client

Language Server Protocol client for the Monaco editor: speaks JSON-RPC to a language server over a pluggable transport and registers Monaco providers (completion, hover, diagnostics, definitions, references, rename, formatting, semantic tokens, inlay hints, code actions, and more) based on the server's capabilities. Used by [loxel](../loxel)'s editor, which connects to language servers proxied by the loxel server over WebSocket (see [LANGUAGE_SERVERS.md](../loxel/docs/LANGUAGE_SERVERS.md)).

## Origin

Forked from [`@vscode/monaco-lsp-client`](https://github.com/microsoft/monaco-editor/tree/main/monaco-lsp-client) in the monaco-editor repository. Local changes:

- Imports `monaco-editor` (peer dependency) instead of `monaco-editor-core`
- `languageId` option to restrict model sync and provider registration to specific languages
- `modelFilter` option to restrict model sync further (for example to keep read-only diff views away from the server); providers and pull diagnostics answer only for synced models, since the server has never seen any other
- A null or empty document selector (basedpyright registers pull diagnostics that way) matches only the `languageId` languages, for pull diagnostics as for provider registration, and `typescript`/`javascript` filters also match `tsx`/`jsx` models
- Server commands (those in `executeCommandProvider.commands`) attached to code actions, code lenses, completions and inlay hints run through `workspace/executeCommand`, via one Monaco command per client; other commands reach Monaco unchanged
- Workspace edits (rename, code actions, `workspace/applyEdit`) share one path, `WorkspaceEditApplier`, instead of Monaco's standalone bulk-edit service, which can only edit open models. The rename provider applies its edit itself and hands Monaco an empty one, also when the edit failed (the applier reports it); a code action carries its edit to a per-client Monaco command that applies it, then runs the action's own command: a server command through `workspace/executeCommand`, a client command (`editor.action.*`) on the focused editor. An edit is planned whole before anything changes (every resource but a text-edited open model checked, versions and overlapping edits validated, files without a model read and edited in memory), then executed in order: open models get one undo stop per change, other files are written back after checking they did not change on disk meanwhile. Edits apply one at a time, and disposing the client refuses queued ones and stops the one in progress before its next change. `documentChanges` wins over `changes`; change annotations are ignored (`changeAnnotationSupport` is not declared)
- The `workspaceFileSystem` option is the app's disk access for those edits: with it they can edit files that have no model and create, rename and delete files, and the client declares `resourceOperations` and `failureHandling: "abort"` (a failure stops the edit and keeps what was applied, and the reason says how far it got). A file rename in an edit first asks the server for the edits it implies through `workspace/willRenameFiles` when its registration filters match the path (static or dynamic; the filter's scheme is not compared), and applies them before the rename: a server's rename of an import path may hold just the file rename. Paths are resolved (`src/./b.ts` is `src/b.ts`). Its `stat` sees every resource first, so throwing there refuses the whole edit; open models only text edits touch are the exception, edited like typing in them would be. Without the option, an edit that touches a file with no model or holds a file operation is refused whole. `onWorkspaceEditFailure` receives the reason whenever an edit is refused or fails
- The `onShowMessage` option receives each `window/showMessage` notification, which upstream drops, for the app to show
- The `semanticTokenStyling` option names what the app's theme has rules for: tokens of other types keep their TextMate color, and other modifiers are dropped so they cannot stop a rule from matching
- Additional features: inline completions and linked editing ranges
- Workspace symbols: Monaco standalone has no workspace symbol provider, so `client.workspaceSymbols(query, token)` sends `workspace/symbol` and returns `WorkspaceSymbolItem`s (Monaco kinds and tags, 1-based range, or no range when the server defers it), and `client.resolveWorkspaceSymbol(item, token)` fills a missing range through `workspaceSymbol/resolve`. Cancelling the token sends `$/cancelRequest` for the request's id (`LspCancellableRequests`, which sends through the channel's request sender because `TypedChannel.request` does not expose ids) and rejects with a `Canceled` error
- Document-filter glob patterns are matched with `picomatch`
- `MonacoLspClient.dispose()` unregisters providers, closes synced documents, removes its diagnostics markers and drops the capability registry
- Each client sets its diagnostics markers under an owner of its own, so several servers on one model (basedpyright and ruff for Python) do not overwrite each other's: the `markerOwner` option, or by default an owner unique to the client (`lsp-<n>`). A marker's code links to the diagnostic's `codeDescription`
- Code action requests carry, of the markers Monaco hands the provider, those of the client's own owner, turned back into the diagnostics the server sent (matched by range, severity, message, code and source), so `code`, `source`, `data`, tags and related information reach the server unchanged; upstream sends every owner's markers with only range, message and severity, which servers such as ruff cannot match to their fixes. Monaco's requested kind is sent as `only`
- `client.supportsCodeActionKind(model, kind)` tells whether the server may offer code actions of a kind for a model (a live registration covers the model and declares a kind containing or inside it, or no kinds; with `{ declared: true }`, only a declared kind equal to or inside it, which Monaco's Fix All and Organize Imports require), for apps that expose code action commands
- Document URIs are sent percent-encoded (`Uri.toString()`, as servers write them, where upstream skips encoding), and URIs from the server are matched to models after `Uri.parse(...).toString()`, since servers differ in what they escape
- Markdown from the server (completion and signature-help documentation, hover contents, inlay-hint tooltips) is rendered untrusted, so command links and other trusted-only markdown are not executed
- Document sync honors the negotiated `TextDocumentSyncKind`: `Full` sends the whole text, `None` sends no `didChange`, `Incremental` sends deltas
- Completion declares `snippetSupport` and `resolveSupport` for `additionalTextEdits`, so servers may send snippets and compute the edits an item adds (auto-imports) only on `completionItem/resolve`
- Completion lists propagate the server's `isIncomplete` flag so Monaco re-requests as the user types, and completion and signature-help requests are skipped, or their results dropped, once Monaco cancels them

`src/types.ts` holds the LSP 3.17 protocol typings generated upstream; do not edit it by hand.

## Usage

Workspace-only and private; add `"@bizimind/monaco-lsp-client": "workspace:*"`.

```typescript
import { MonacoLspClient, WebSocketTransport } from "@bizimind/monaco-lsp-client";

const transport = await WebSocketTransport.connectTo({ address: "ws://localhost:1234/lsp" });
const client = new MonacoLspClient(transport, {
  languageId: ["typescript", "javascript"],
  modelFilter: (model) => model.uri.scheme === "file",
  workspaceFileSystem: myFileSystem, // stat/readFile/writeFile/createFile/rename/delete
  onWorkspaceEditFailure: (reason) => showError(reason),
  markerOwner: "ts-lsp", // diagnostics markers' owner; unique among live clients
  onShowMessage: ({ type, message }) => notify(type, message), // window/showMessage
  semanticTokenStyling: { types, modifiers }, // what the theme has rules for; the rest keeps TextMate colors
});
```

Exports ([`src/index.ts`](src/index.ts)): `MonacoLspClient` (and its `WorkspaceSymbolItem` result type), the transports `WebSocketTransport`, `createTransportToWorker`, and `createTransportToIFrame` (re-exported from `@hediet/json-rpc-*`), the `capabilities` contract plus related types for registering extra client capabilities via `client.addStaticClientCapabilities()`, the `WorkspaceFileSystem` interface the `workspaceFileSystem` option implements, and the `SemanticTokenStyling` interface of the `semanticTokenStyling` option.

The package has no build script (only `typecheck` and `test`); loxel consumes it as TypeScript source and bundles it. Tests run under `bun test` against the fake `monaco-editor` module in [`src/testing/fake-monaco.ts`](src/testing/fake-monaco.ts) (with Monaco's real `Uri` class), which every test file must share. Call `client.dispose()` before disposing the transport so the `textDocument/didClose` notifications reach the server.
