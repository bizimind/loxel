import { MonacoLspClient, WebSocketTransport } from "@bizimind/monaco-lsp-client";
import type { IDisposable } from "monaco-editor";

import { LSP_RESTART_CLOSE_CODE } from "@/api/ws-protocol";
import { showToast } from "@/components/ui/toast";

import { isLiveEditorModel } from "./live-editor-model";
import { createLspWorkspaceFiles } from "./lsp-workspace-files";

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
 * Workspace edits (rename, code actions) also change the worktree's files that are not open
 * (see `createLspWorkspaceFiles`), and a toast says why when one fails. A socket the server closes
 * with `LSP_RESTART_CLOSE_CODE` (it restarts the language server) is reconnected, which
 * re-initializes the server and re-opens the synced documents. `onConnected` runs for each
 * connection's transport, and what it returns is disposed with the connection.
 */
export function createWorktreeLspClient(
  wsPath: string,
  languageId?: string | readonly string[],
  onConnected?: (transport: WebSocketTransport) => IDisposable,
) {
  let currentWtPath: string | null = null;
  let currentTransport: WebSocketTransport | null = null;
  let currentClient: MonacoLspClient | null = null;
  let currentExtension: IDisposable | null = null;
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

    openSocket(address).then(
      (socket) => {
        const transport = WebSocketTransport.fromWebSocket(socket);
        if (currentWtPath !== wtPath) {
          transport.dispose();
          return;
        }
        connecting = false;
        currentTransport = transport;
        currentClient = new MonacoLspClient(transport, {
          languageId,
          modelFilter: isLiveEditorModel,
          // One client per route at a time: each takes over the markers' owner of the one before.
          markerOwner: wsPath.replace(/^ws\//, ""),
          workspaceFileSystem: createLspWorkspaceFiles(wtPath),
          onWorkspaceEditFailure: (reason) => showToast(`Edit not applied: ${reason}`),
        });
        const client = currentClient;
        connectedClients.set(client, wtPath);
        currentExtension = onConnected?.(transport) ?? null;
        // A socket the server closed (replaced by a newer connection) never answers again.
        transport.state.onChange(({ state }) => {
          if (state === "closed") connectedClients.delete(client);
        });
        socket.addEventListener("close", (event) => {
          if (event.code !== LSP_RESTART_CLOSE_CODE || currentTransport !== transport) return;
          teardown();
          currentWtPath = null;
          connect(wtPath);
        });
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
    currentExtension?.dispose();
    currentExtension = null;
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

function openSocket(address: string): Promise<WebSocket> {
  const socket = new WebSocket(address);
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
}
