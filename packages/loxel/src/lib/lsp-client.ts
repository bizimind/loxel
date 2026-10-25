import { MonacoLspClient, WebSocketTransport } from "@bizimind/monaco-lsp-client";

import { isLiveEditorModel } from "./live-editor-model";

/** Every connected worktree client, with the worktree it serves. */
const connectedClients = new Map<MonacoLspClient, string>();

/**
 * The language-server clients connected for `wtPath` now: TypeScript for the active worktree,
 * plus each lazily started server while a file of its language is open.
 */
export function getConnectedLspClients(wtPath: string): MonacoLspClient[] {
  return [...connectedClients].filter(([, path]) => path === wtPath).map(([client]) => client);
}

/**
 * Factory for worktree-scoped LSP client connections. Each call creates an
 * independent connect/disconnect pair backed by a single WebSocket transport.
 *
 * The connect function is idempotent per worktree path — calling it with the
 * same path while already connected is a no-op. Calling with a different path
 * disposes the old transport (killing the server-side subprocess) and opens a
 * new connection. Both the worktree switch and `disconnect()` dispose the
 * client (unregistering providers and closing synced documents) before the
 * transport. Only editor tabs' live models are synced to the server (see `isLiveEditorModel`).
 */
export function createWorktreeLspClient(wsPath: string, languageId?: string | readonly string[]) {
  let currentWtPath: string | null = null;
  let currentTransport: WebSocketTransport | null = null;
  let currentClient: MonacoLspClient | null = null;
  let connecting = false;

  function connect(wtPath: string): void {
    // Guard against both an active connection and an in-flight connect to the
    // same path — the latter prevents the double-spawn race where two rapid
    // calls each open a WebSocket before the first resolves.
    if (currentWtPath === wtPath && (currentClient || connecting)) return;
    currentWtPath = wtPath;
    teardown();
    connecting = true;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const address = `${proto}//${location.host}/${wsPath}?wt=${encodeURIComponent(wtPath)}`;

    WebSocketTransport.connectTo({ address }).then(
      (transport) => {
        if (currentWtPath !== wtPath) {
          transport.dispose();
          return;
        }
        connecting = false;
        currentTransport = transport;
        currentClient = new MonacoLspClient(transport, {
          languageId,
          modelFilter: isLiveEditorModel,
        });
        connectedClients.set(currentClient, wtPath);
      },
      () => {
        if (currentWtPath === wtPath) {
          connecting = false;
          currentWtPath = null;
        }
      },
    );
  }

  // Dispose the client before the transport so its `textDocument/didClose`
  // notifications still go out over a live socket.
  function teardown(): void {
    if (currentClient) connectedClients.delete(currentClient);
    currentClient?.dispose();
    currentClient = null;
    currentTransport?.dispose();
    currentTransport = null;
  }

  function disconnect(): void {
    teardown();
    currentWtPath = null;
    connecting = false;
  }

  return { connect, disconnect };
}
