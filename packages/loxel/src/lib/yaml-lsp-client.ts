import { MonacoLspClient, WebSocketTransport } from "@bizimind/monaco-lsp-client";

import { isLiveEditorModel } from "./live-editor-model";

let connected = false;
let yamlClient: MonacoLspClient | undefined;

/** The YAML client while connected. */
export function getYamlLspClient(): MonacoLspClient | undefined {
  return yamlClient;
}

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
      const client = new MonacoLspClient(transport, {
        languageId: "yaml",
        modelFilter: isLiveEditorModel,
        markerOwner: "yaml-lsp",
      });
      yamlClient = client;
      // A closed socket never answers again.
      transport.state.onChange(({ state }) => {
        if (state === "closed" && yamlClient === client) yamlClient = undefined;
      });
    },
    () => {
      connected = false;
    },
  );
}
