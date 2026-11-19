import { MonacoLspClient, WebSocketTransport } from "@bizimind/monaco-lsp-client";
import type { IDisposable } from "monaco-editor";

import { localServerId } from "@/api/local-server";
import { sameWorktreeRef, type ServerId, type WorktreeRef } from "@/api/worktree-ref";
import { LSP_FRESH_SERVER_PARAM } from "@/api/ws-protocol";
import { showToast } from "@/components/ui/toast";
import { useLspStatusStore } from "@/store/lsp-status";

import { frontendLog } from "./frontend-logger";
import { editorFile, isLiveEditorModel, isPreviewModel } from "./live-editor-model";
import {
  createLspConnection,
  createStopToastFilter,
  type LspClose,
  type LspConnection,
  type LspConnectionState,
  type LspLink,
} from "./lsp-connection";
import { type LspTransport, translateLspUris } from "./lsp-uri-translation";
import { createLspWorkspaceFiles } from "./lsp-workspace-files";
import { SEMANTIC_TOKEN_STYLING } from "./monaco-theme";
import {
  isVirtualDocumentUri,
  registerVirtualDocumentScheme,
  type VirtualDocumentOptions,
} from "./virtual-documents";

const log = frontendLog.child("ui");

/** Every connected client, with the worktree it serves (null: YAML, shared by every worktree). */
const connectedClients = new Map<MonacoLspClient, WorktreeRef | null>();

/** Every client's connection, for restarting them. */
const connections = new Set<LspConnection>();

/**
 * The language-server clients connected for `wt` now: TypeScript for the active worktree, plus
 * each lazily started server while a file of its language is open.
 */
export function getConnectedLspClients(wt: WorktreeRef): MonacoLspClient[] {
  return [...connectedClients]
    .filter(([, served]) => served !== null && sameWorktreeRef(served, wt))
    .map(([client]) => client);
}

/** Every connected client, whatever its worktree, including YAML's. */
export function getAllConnectedLspClients(): MonacoLspClient[] {
  return [...connectedClients.keys()];
}

/** Restart every language server Loxel is connected to (or trying to be), from scratch. */
export function restartLanguageServers(): void {
  for (const connection of connections) connection.restart({ freshServer: true });
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
  /**
   * Runs for each connection's transport, which translates the URIs of what it sends and receives
   * (see `lspUriTranslation`), with the server it reaches, whose models alone it may report on;
   * what it returns is disposed with the connection.
   */
  onConnected?: (transport: LspTransport, server: ServerId) => IDisposable;
  /**
   * Show the errors and warnings the server sends with `window/showMessage` as toasts, each
   * distinct message once while Loxel runs, for a server whose messages are meant for the user
   * (mypy's setup problems, a Kotlin lint tool that is missing or failed).
   */
  showMessages?: boolean;
  /** The server's read-only documents: tabs and peek widgets show them, read through this client. */
  virtualDocuments?: VirtualDocumentOptions;
  /**
   * Leave these languages' editor models on `loxel:` URIs instead of `file:` ones (see
   * `fileSchemeLanguages`), for a server sharing languages with one that needs them. Its manager
   * translates the URIs.
   */
  keepsEditorUris?: boolean;
}

/**
 * Factory for a language-server client connection. Each call creates an independent
 * connect/disconnect pair backed by one WebSocket and one `MonacoLspClient` at a time.
 *
 * `connect(wt)` is idempotent per worktree (null: a server not scoped to a worktree, YAML, on the
 * window's server). Connecting to another worktree disposes the old client and socket (the server
 * keeps the old worktree's server a while for a socket to take it over, see `stdio-lsp-manager.ts`)
 * and opens a new connection. Both the worktree switch and `disconnect()` dispose the client
 * (unregistering providers and closing synced documents) before the socket. Only the live models of
 * editor tabs showing the connection's server's files are synced to the server (see
 * `isLiveEditorModel`), plus the tabs of its own read-only documents, and the URIs of every message
 * are translated between editor model URIs and the server's (see `lspUriTranslation`). Workspace edits
 * (rename, code actions) also change the worktree's files that are not open (see
 * `createLspWorkspaceFiles`), and a toast says why when one fails.
 *
 * When the socket closes on its own, `createLspConnection` decides whether and when to reconnect;
 * a reconnect starts a new client, which re-initializes the server and re-opens the synced
 * documents. A client that stops reconnecting is listed in `useLspStatusStore` for the status bar,
 * with a toast when its server crashed or could not start.
 */
export function createLspClient({
  route,
  name,
  languageId,
  onConnected,
  showMessages,
  virtualDocuments,
  keepsEditorUris = false,
}: LspClientOptions) {
  const markerOwner = route.replace(/^ws\//, "");
  const showMessage = showMessages ? createServerMessageToasts(name) : undefined;
  const languageIds = typeof languageId === "string" ? [languageId] : languageId;
  const virtualDocumentScheme = virtualDocuments
    ? registerVirtualDocumentScheme(virtualDocuments, languageIds[0] ?? "plaintext")
    : undefined;
  const ownsVirtualDocument = (model: Parameters<typeof isLiveEditorModel>[0]): boolean =>
    model.uri.scheme === virtualDocuments?.scheme && !isPreviewModel(model);

  async function open(
    wt: WorktreeRef | null,
    signal: AbortSignal,
    freshServer: boolean,
  ): Promise<LspLink> {
    const server = connectionServer(wt);
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const fresh = freshServer ? `&${LSP_FRESH_SERVER_PARAM}=1` : "";
    const query = wt === null ? "" : `?wt=${encodeURIComponent(wt.path)}${fresh}`;
    const address = `${proto}//${location.host}/${route}${query}`;
    const { socket, closed } = await openSocket(address, signal);
    // Superseded while the open settled (the abort closed the socket): start no client on it.
    signal.throwIfAborted();
    const socketTransport = WebSocketTransport.fromWebSocket(socket);
    const transport = translateLspUris(socketTransport, server);
    const isServersLiveModel = (model: Parameters<typeof isLiveEditorModel>[0]): boolean =>
      isLiveEditorModel(model) && editorFile(model.uri)?.server === server;
    let client: MonacoLspClient;
    try {
      client = new MonacoLspClient(transport, {
        languageId,
        modelFilter: (model) => isServersLiveModel(model) || ownsVirtualDocument(model),
        // Any server's. Their tabs are read-only, which stops typing but not a server's edit.
        isReadOnlyModel: (model) => isVirtualDocumentUri(model.uri.toString()),
        // One client per route at a time: each takes over the markers' owner of the one before.
        markerOwner,
        workspaceFileSystem: wt === null ? undefined : createLspWorkspaceFiles(wt),
        onWorkspaceEditFailure: (reason) => showToast(`Edit not applied: ${reason}`),
        onShowMessage: showMessage,
        semanticTokenStyling: SEMANTIC_TOKEN_STYLING,
      });
    } catch (err) {
      socketTransport.dispose();
      throw err;
    }
    connectedClients.set(client, wt);
    const endVirtualDocuments = virtualDocumentScheme?.connected(client);
    const extension = onConnected?.(transport, server);
    return {
      closed,
      // The client first, so its `textDocument/didClose` notifications still go out over a live
      // socket.
      dispose() {
        connectedClients.delete(client);
        endVirtualDocuments?.();
        extension?.dispose();
        try {
          client.dispose();
        } catch (err) {
          log.error("Language-server client dispose failed", { route, error: err });
        }
        socketTransport.dispose();
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
  return {
    connect: connection.connect,
    disconnect: connection.disconnect,
    languageIds,
    ownsVirtualDocument,
    keepsEditorUris,
    logCategory: markerOwner,
  };
}

export type LspClient = ReturnType<typeof createLspClient>;

/**
 * The server a connection to `wt` reaches (YAML's, scoped to no worktree, is the window's). Sockets
 * go to the window's server, the only one language servers are reached on, so a worktree on
 * another server is refused rather than served by the wrong one.
 */
function connectionServer(wt: WorktreeRef | null): ServerId {
  const server = localServerId();
  if (wt !== null && wt.server !== server) {
    throw new Error(`Language servers of ${wt.path} on server ${wt.server} cannot be reached`);
  }
  return server;
}

/** LSP `MessageType.Warning`: errors and warnings are shown, info and log messages are not. */
const WARNING_MESSAGE_TYPE = 2;
const ERROR_MESSAGE_TYPE = 1;

/**
 * Show the errors and warnings a server sends with `window/showMessage` as toasts, each distinct
 * message once while Loxel runs, since a server that restarts or re-checks would repeat it.
 */
function createServerMessageToasts(
  name: string,
): (params: { type: number; message: string }) => void {
  const shown = new Set<string>();
  return ({ type, message }) => {
    if (type > WARNING_MESSAGE_TYPE || shown.has(message)) return;
    shown.add(message);
    log.info("Language server message", { server: name, type, message });
    showToast(`${name}: ${message}`, type === ERROR_MESSAGE_TYPE ? "error" : "info");
  };
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
