import type { WsClient } from "./client";
import { formatWorktreeRef, type ServerId, type WorktreeRef } from "./worktree-ref";

/** Error thrown for non-2xx API responses, with the HTTP status and the server's optional reason code. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The server confirmed the file does not exist on disk (`404` with `code: "ENOENT"`). A plain
 * 404 only means the path could not be resolved, e.g. its worktree is not subscribed yet.
 */
export function isFileMissingError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && err.code === "ENOENT";
}

/**
 * The server refused a write with `expectedContent` because the file no longer held it (`409`
 * with `code: "EDISKCHANGED"`): it changed on disk since the client read it.
 */
export function isDiskChangedError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.code === "EDISKCHANGED";
}

export interface ServerConnectionOptions {
  server: ServerId;
  /**
   * Where the server's `/api` and `/ws` paths live, as a same-origin path prefix: `""` for the
   * window's own server. The window never talks to another origin, so the session secret the app
   * adds to its own origin's requests covers every connection.
   */
  baseUrl: string;
  /** The server's WebSocket client. */
  ws: WsClient;
}

/**
 * The window's connection to one Loxel server: its HTTP transport and its WebSocket client. Every
 * request about something a server holds goes through that server's connection
 * ({@link connectionOf}).
 */
export class ServerConnection {
  readonly server: ServerId;
  readonly baseUrl: string;
  readonly ws: WsClient;

  constructor({ server, baseUrl, ws }: ServerConnectionOptions) {
    this.server = server;
    this.baseUrl = baseUrl;
    this.ws = ws;
  }

  /** The URL of the server's API endpoint `path` (`/status`, say), for a fetch or an `<img>`. */
  apiUrl(path: string): string {
    return `${this.baseUrl}/api${path}`;
  }

  /** Request `path` of the server's API and parse its JSON answer; throws {@link ApiError} on non-2xx. */
  fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
    return fetchApiJson(this.baseUrl, path, options, () => this.ws.expireSession());
  }
}

/** The base URL of the window's own server, the origin it was loaded from. */
export const LOCAL_BASE_URL = "";

/**
 * Request `path` of the API under `baseUrl` and parse its JSON answer; throws {@link ApiError} on
 * non-2xx, after `onUnauthorized` for a `401`. {@link ServerConnection.fetchJson} for a request
 * before its connection exists.
 */
export async function fetchApiJson<T>(
  baseUrl: string,
  path: string,
  options?: RequestInit,
  onUnauthorized?: () => void,
): Promise<T> {
  const headers = new Headers(options?.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${baseUrl}/api${path}`, { ...options, headers });

  if (response.status === 401) onUnauthorized?.();
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const fields = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const message = typeof fields.error === "string" ? fields.error : "Request failed";
    const code = typeof fields.code === "string" ? fields.code : undefined;
    throw new ApiError(message, response.status, code);
  }

  return response.json();
}

/** The window's connections, by the server each reaches. Today only the window's own server's. */
const connections = new Map<ServerId, ServerConnection>();

/**
 * Add the connection to its server; returns its removal. A server has one connection: registering
 * a second one for it is a mistake.
 */
export function registerConnection(connection: ServerConnection): () => void {
  if (connections.has(connection.server)) {
    throw new Error(`Server ${connection.server} already has a connection`);
  }
  connections.set(connection.server, connection);
  return () => {
    if (connections.get(connection.server) === connection) connections.delete(connection.server);
  };
}

/**
 * Whether the window is connected to `server`, so requests about what it holds can be sent.
 */
export function hasConnection(server: ServerId): boolean {
  return connections.has(server);
}

/**
 * The connection to `server`, for a request about something that server holds (a worktree, a
 * file, a project on it). One the window is not connected to is a caller's mistake.
 */
export function connectionOf(server: ServerId): ServerConnection {
  const connection = connections.get(server);
  if (!connection) throw new Error(`No connection to server ${server}`);
  return connection;
}

/**
 * The connection of a request about a path on `server` that may name a worktree for scope. The
 * worktree must be on the same server: one request reaches one server.
 */
export function scopedConnection(
  server: ServerId,
  wt: WorktreeRef | null | undefined,
): ServerConnection {
  if (wt && wt.server !== server) {
    throw new Error(`Worktree ${formatWorktreeRef(wt)} is not on server ${server}`);
  }
  return connectionOf(server);
}
