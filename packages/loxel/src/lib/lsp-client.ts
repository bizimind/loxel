import { MonacoLspClient, WebSocketTransport } from "@bizimind/monaco-lsp-client";

/**
 * Factory for worktree-scoped LSP client connections. Each call creates an
 * independent connect/disconnect pair backed by a single WebSocket transport.
 *
 * The connect function is idempotent per worktree path — calling it with the
 * same path while already connected is a no-op. Calling with a different path
 * disposes the old transport (killing the server-side subprocess) and opens a
 * new connection.
 */
export function createWorktreeLspClient(wsPath: string, languageId?: string) {
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
    currentTransport?.dispose();
    currentTransport = null;
    currentClient = null;
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
        currentClient = new MonacoLspClient(transport, languageId ? { languageId } : undefined);
      },
      () => {
        if (currentWtPath === wtPath) {
          connecting = false;
          currentWtPath = null;
        }
      },
    );
  }

  function disconnect(): void {
    currentTransport?.dispose();
    currentTransport = null;
    currentClient = null;
    currentWtPath = null;
    connecting = false;
  }

  return { connect, disconnect };
}
