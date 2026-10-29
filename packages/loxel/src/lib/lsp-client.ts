import { MonacoLspClient, WebSocketTransport } from "@bizimind/monaco-lsp-client";
import type { IDisposable } from "monaco-editor";

import { showToast } from "@/components/ui/toast";
import { useLspStatusStore } from "@/store/lsp-status";

import { frontendLog } from "./frontend-logger";
import { isLiveEditorModel } from "./live-editor-model";
import {
  createLspConnection,
  createStopToastFilter,
  type LspClose,
  type LspConnection,
  type LspConnectionState,
  type LspLink,
} from "./lsp-connection";
import { createLspWorkspaceFiles } from "./lsp-workspace-files";

const log = frontendLog.child("ui");

/** Every connected worktree client, with the worktree it serves. */
const connectedClients = new Map<MonacoLspClient, string>();

/** Every client's connection, for restarting them. */
const connections = new Set<LspConnection>();

/**
 * The language-server clients connected for `wtPath` now: TypeScript for the active worktree,
 * plus each lazily started server while a file of its language is open.
 */
export function getConnectedLspClients(wtPath: string): MonacoLspClient[] {
  return [...connectedClients].filter(([, path]) => path === wtPath).map(([client]) => client);
}

/** Restart every language server Loxel is connected to (or trying to be), from scratch. */
export function restartLanguageServers(): void {
  for (const connection of connections) connection.restart();
}

/** Restart the language servers that stopped (crashed, could not start, another window took them). */
export function restartStoppedLanguageServers(): void {
  for (const connection of connections) {
    if (connection.state.state === "stopped") connection.restart();
  }
}

/** Loxel's server is reachable again: reconnect the clients that lost it (see `LspConnection.resume`). */
export function resumeLanguageServers(): void {
  for (const connection of connections) connection.resume();
}

export interface LspClientOptions {
  /** WebSocket route of the server, such as `ws/python-lsp`. Also the client's marker owner. */
  route: string;
  /** The server's name for notices, such as `basedpyright`. */
  name: string;
  languageId: string | readonly string[];
  /** Runs for each connection's transport; what it returns is disposed with the connection. */
  onConnected?: (transport: WebSocketTransport) => IDisposable;
}

/**
 * Factory for a language-server client connection. Each call creates an independent
 * connect/disconnect pair backed by one WebSocket and one `MonacoLspClient` at a time.
 *
 * `connect(wtPath)` is idempotent per worktree path (null: a server not scoped to a worktree,
 * YAML). Connecting to a different path disposes the old client and socket (killing the
 * server-side subprocess) and opens a new connection. Both the worktree switch and `disconnect()`
 * dispose the client (unregistering providers and closing synced documents) before the socket.
 * Only editor tabs' live models are synced to the server (see `isLiveEditorModel`). Workspace edits
 * (rename, code actions) also change the worktree's files that are not open (see
 * `createLspWorkspaceFiles`), and a toast says why when one fails.
 *
 * When the socket closes on its own, `createLspConnection` decides whether and when to reconnect;
 * a reconnect starts a new client, which re-initializes the server and re-opens the synced
 * documents. A client that stops reconnecting is listed in `useLspStatusStore` for the status bar,
 * with a toast when its server crashed or could not start.
 */
export function createLspClient({ route, name, languageId, onConnected }: LspClientOptions) {
  const markerOwner = route.replace(/^ws\//, "");

  async function open(wtPath: string | null, signal: AbortSignal): Promise<LspLink> {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const query = wtPath === null ? "" : `?wt=${encodeURIComponent(wtPath)}`;
    const address = `${proto}//${location.host}/${route}${query}`;
    const { socket, closed } = await openSocket(address, signal);
    // Superseded while the open settled (the abort closed the socket): start no client on it.
    signal.throwIfAborted();
    const transport = WebSocketTransport.fromWebSocket(socket);
    let client: MonacoLspClient;
    try {
      client = new MonacoLspClient(transport, {
        languageId,
        modelFilter: isLiveEditorModel,
        // One client per route at a time: each takes over the markers' owner of the one before.
        markerOwner,
        workspaceFileSystem: wtPath === null ? undefined : createLspWorkspaceFiles(wtPath),
        onWorkspaceEditFailure: (reason) => showToast(`Edit not applied: ${reason}`),
      });
    } catch (err) {
      transport.dispose();
      throw err;
    }
    if (wtPath !== null) connectedClients.set(client, wtPath);
    const extension = onConnected?.(transport);
    return {
      closed,
      // The client first, so its `textDocument/didClose` notifications still go out over a live
      // socket.
      dispose() {
        connectedClients.delete(client);
        extension?.dispose();
        try {
          client.dispose();
        } catch (err) {
          log.error("Language-server client dispose failed", { route, error: err });
        }
        transport.dispose();
      },
    };
  }

  const shouldToast = createStopToastFilter();

  function onStateChange(state: LspConnectionState): void {
    const { setStopped } = useLspStatusStore.getState();
    const toast = shouldToast(state);
    if (state.state !== "stopped") {
      setStopped(route, null);
      return;
    }
    setStopped(route, { name, reason: state.reason, detail: state.detail });
    if (!toast) return;
    showToast(
      state.reason === "crashed"
        ? `${name} kept crashing and was stopped. Click it in the status bar to restart it.`
        : `${name} could not start. Click it in the status bar to try again.`,
    );
  }

  const connection = createLspConnection({ open, onStateChange });
  connections.add(connection);
  return { connect: connection.connect, disconnect: connection.disconnect };
}

/**
 * Open a socket, listening for its close from the start so none is missed. Aborting `signal`
 * closes it, opening or open, and rejects if it has not opened yet.
 */
function openSocket(
  address: string,
  signal: AbortSignal,
): Promise<{ socket: WebSocket; closed: Promise<LspClose> }> {
  const superseded = () => new Error("Language-server connection superseded");
  if (signal.aborted) return Promise.reject(superseded());
  const socket = new WebSocket(address);
  const closed = new Promise<LspClose>((resolve) => {
    socket.addEventListener(
      "close",
      (event) => resolve({ code: event.code, reason: event.reason }),
      { once: true },
    );
  });
  return new Promise((resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        socket.close();
        reject(superseded());
      },
      { once: true },
    );
    socket.addEventListener("open", () => resolve({ socket, closed }), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
}
