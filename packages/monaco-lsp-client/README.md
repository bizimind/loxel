# monaco-lsp-client

Language Server Protocol client for the Monaco editor: speaks JSON-RPC to a language server over a pluggable transport and registers Monaco providers (completion, hover, diagnostics, definitions, references, rename, formatting, semantic tokens, inlay hints, code actions, and more) based on the server's capabilities. Used by [loxel](../loxel)'s editor, which connects to language servers proxied by the loxel server over WebSocket (see [LANGUAGE_SERVERS.md](../loxel/docs/LANGUAGE_SERVERS.md)).

## Origin

Forked from [`@vscode/monaco-lsp-client`](https://github.com/microsoft/monaco-editor/tree/main/monaco-lsp-client) in the monaco-editor repository. Local changes:

- Imports `monaco-editor` (peer dependency) instead of `monaco-editor-core`
- `languageId` option to restrict model sync and provider registration to specific languages
- `modelFilter` option to restrict model sync further (for example to keep read-only diff views away from the server); providers and pull diagnostics answer only for synced models, since the server has never seen any other
- A null or empty document selector (basedpyright registers pull diagnostics that way) matches only the `languageId` languages, for pull diagnostics as for provider registration, and `typescript`/`javascript` filters also match `tsx`/`jsx` models
- Server commands (those in `executeCommandProvider.commands`) attached to code actions, code lenses, completions and inlay hints run through `workspace/executeCommand`, via one Monaco command per client; other commands reach Monaco unchanged
- `workspace/applyEdit` is handled: the edit is applied to open Monaco models, one undo stop per model, and refused whole when a target has no model, a versioned edit is stale, or it holds file create/rename/delete operations (the client does not declare `resourceOperations`). Rename and code-action edits use the same conversion: `documentChanges` wins over `changes`, and file operations reject the rename or refuse the code action (disabled in the list, or a no-op when they only appear on resolve) instead of being dropped
- Additional features: inline completions and linked editing ranges
- Document-filter glob patterns are matched with `picomatch`
- `MonacoLspClient.dispose()` unregisters providers, closes synced documents, removes its diagnostics markers and drops the capability registry
- Each client sets its diagnostics markers under an owner of its own, so several servers on one model (basedpyright and ruff for Python) do not overwrite each other's
- Markdown from the server (completion and signature-help documentation, hover contents, inlay-hint tooltips) is rendered untrusted, so command links and other trusted-only markdown are not executed
- Document sync honors the negotiated `TextDocumentSyncKind`: `Full` sends the whole text, `None` sends no `didChange`, `Incremental` sends deltas
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
});
```

Exports ([`src/index.ts`](src/index.ts)): `MonacoLspClient`, the transports `WebSocketTransport`, `createTransportToWorker`, and `createTransportToIFrame` (re-exported from `@hediet/json-rpc-*`), and the `capabilities` contract plus related types for registering extra client capabilities via `client.addStaticClientCapabilities()`.

The package has no build script (only `typecheck` and `test`); loxel consumes it as TypeScript source and bundles it. Tests run under `bun test` against the fake `monaco-editor` module in [`src/testing/fake-monaco.ts`](src/testing/fake-monaco.ts), which every test file must share. Call `client.dispose()` before disposing the transport so the `textDocument/didClose` notifications reach the server.
