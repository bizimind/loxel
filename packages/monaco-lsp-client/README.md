# monaco-lsp-client

Language Server Protocol client for the Monaco editor: speaks JSON-RPC to a language server over a pluggable transport and registers Monaco providers (completion, hover, diagnostics, definitions, references, rename, formatting, semantic tokens, inlay hints, code actions, and more) based on the server's capabilities. Used by [loxel](../loxel)'s editor (`packages/loxel/src/lib/lsp-client.ts`, `yaml-lsp-client.ts`), which connects to language servers proxied by the loxel server over WebSocket.

## Origin

Forked from [`@vscode/monaco-lsp-client`](https://github.com/microsoft/monaco-editor/tree/main/monaco-lsp-client) in the monaco-editor repository. Local changes:

- Imports `monaco-editor` (peer dependency) instead of `monaco-editor-core`
- `languageId` option to restrict model sync and provider registration to specific languages
- Additional features: inline completions and linked editing ranges
- Document-filter glob patterns are matched with `picomatch`

`src/types.ts` holds the LSP 3.17 protocol typings generated upstream; do not edit it by hand.

## Usage

Workspace-only and private; add `"@bizimind/monaco-lsp-client": "workspace:*"`.

```typescript
import { MonacoLspClient, WebSocketTransport } from "@bizimind/monaco-lsp-client";

const transport = await WebSocketTransport.connectTo({ address: "ws://localhost:1234/lsp" });
const client = new MonacoLspClient(transport, { languageId: ["typescript", "javascript"] });
```

Exports ([`src/index.ts`](src/index.ts)): `MonacoLspClient`, the transports `WebSocketTransport`, `createTransportToWorker`, and `createTransportToIFrame` (re-exported from `@hediet/json-rpc-*`), and the `capabilities` contract plus related types for registering extra client capabilities via `client.addStaticClientCapabilities()`.

The package has no build, typecheck, or test scripts; loxel consumes it as TypeScript source and bundles it.
