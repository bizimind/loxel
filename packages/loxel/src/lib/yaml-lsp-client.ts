import { MonacoLspClient, WebSocketTransport } from "@bizimind/monaco-lsp-client";

let connected = false;

/**
 * Connect to the YAML language server via WebSocket.
 * Call once at module load time — the LSP handshake completes async and
 * Monaco providers register automatically when capabilities arrive.
 */
export function connectYamlLsp(): void {
  if (connected) return;
  connected = true;

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const address = `${proto}//${location.host}/ws/yaml-lsp`;

  WebSocketTransport.connectTo({ address }).then(
    (transport) => {
      // TODO: consider returning the client instead of relying on self-registration in the constructor
      // eslint-disable-next-line no-new
      new MonacoLspClient(transport, { languageId: "yaml" });
    },
    () => {
      connected = false;
    },
  );
}
