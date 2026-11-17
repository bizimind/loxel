import { isRecord } from "@/lib/is-record";

/**
 * What lets a running language server be handed from one client socket to the next, so a reload
 * or a network blip does not restart and re-index it (see `StdioLspManager`). It watches the
 * frames between the server and its client and keeps what a new client would otherwise be
 * missing, or would trip over:
 *
 * - **The handshake.** A server initializes once, so a new client's `initialize` is answered with
 *   the result the server gave the first one, and its `initialized` stays here.
 * - **Dynamic registrations** the server made with `client/registerCapability` are sent to the new
 *   client once it is initialized, since the server will not make them again.
 * - **Open documents.** When a client goes, its documents are closed on the server, so the
 *   `didOpen` a new client sends for each of its models starts them afresh, with its versions.
 * - **Request ids.** Every client counts its ids up from 0, so a new client's requests are given
 *   ids of their own on the way to the server, and answers to an earlier client's requests, which
 *   are cancelled when it goes, are dropped.
 * - **The server's requests to a client that went** are answered here: registrations as accepted
 *   (they are kept for the next client), anything else as cancelled. While no client is connected,
 *   new ones are answered the same way and notifications are dropped.
 */
export class LspClientHandover {
  /** Whether the client now connected was handed the server, so its request ids are remapped. */
  private adopted = false;
  private connected = true;
  /** Waiting for an adopting client's `initialize`, to answer it with the cached result. */
  private awaitingInitialize = false;
  /** Waiting for an adopting client's `initialized`, to send it the registrations. */
  private awaitingInitialized = false;
  private nextId = ADOPTED_ID_BASE;
  /** Client requests the server has not answered: the id the server knows → the client's id. */
  private readonly inFlight = new Map<JsonRpcId, JsonRpcId>();
  /** An adopted client's ids → the ids the server knows them by, for `$/cancelRequest`. */
  private readonly serverIds = new Map<JsonRpcId, JsonRpcId>();
  /** The server's requests the client has not answered, by id. */
  private readonly serverRequests = new Map<JsonRpcId, string>();
  /** Documents the client has open, by its URI. */
  private readonly openDocuments = new Set<string>();
  /** The server's dynamic registrations, by registration id. */
  private readonly registrations = new Map<string, unknown>();
  private initializeId: JsonRpcId | undefined;
  private initializeResult: unknown;
  private initialized = false;
  private replays = 0;

  /** Whether a new client can take the server over: it has finished its handshake. */
  get canAdopt(): boolean {
    return this.initialized && this.initializeResult !== undefined;
  }

  /**
   * A frame from the client: what to forward to the server, if anything, and what to answer the
   * client with here.
   */
  fromClient(frame: string): ClientFrameResult {
    // Most of the traffic is edits, which need nothing from here.
    if (!frame.includes('"id"') && !TRACKED_CLIENT_NOTIFICATION.test(frame)) {
      return { toServer: frame, toClient: [] };
    }
    const message = parseMessage(frame);
    if (!message) return { toServer: frame, toClient: [] };
    const { id, method } = message;
    if (method !== undefined && id !== undefined) {
      return this.clientRequest(message, frame, id, method);
    }
    if (method !== undefined) return this.clientNotification(message, frame, method);
    if (id === undefined) return { toServer: frame, toClient: [] };
    // An answer to a request: ours, sent with the registrations, or the server's.
    if (typeof id === "string" && id.startsWith(REPLAY_ID_PREFIX)) {
      return { toServer: null, toClient: [] };
    }
    this.serverRequests.delete(id);
    return { toServer: frame, toClient: [] };
  }

  /**
   * A frame on its way to the client, as the manager would send it: what to send the client, if
   * anything, and what to answer the server with here.
   */
  fromServer(frame: string): { toClient: string | null; toServer: string[] } {
    // Notifications are most of the traffic (diagnostics, progress, logs), and carry no id.
    if (!frame.includes('"id"')) return { toClient: this.connected ? frame : null, toServer: [] };
    // Answers can be large (completions, semantic tokens); read the id without parsing the rest.
    const head = RESPONSE_HEAD.exec(frame);
    const idRange = head?.indices?.[1];
    if (head?.[1] !== undefined && idRange) {
      return this.serverResponse(frame, jsonRpcId(JSON.parse(head[1])), idRange);
    }
    const message = parseMessage(frame);
    if (!message) return { toClient: this.connected ? frame : null, toServer: [] };
    const { id, method } = message;
    if (method !== undefined && id !== undefined) {
      this.trackRegistrations(method, message.params);
      if (!this.connected) return { toClient: null, toServer: [answerWithoutClient(id, method)] };
      this.serverRequests.set(id, method);
      return { toClient: frame, toServer: [] };
    }
    if (method !== undefined || id === undefined) {
      return { toClient: this.connected ? frame : null, toServer: [] };
    }
    return this.serverResponse(frame, id, null);
  }

  /**
   * The client went. Returns what the server must be told: requests to cancel and the server's
   * requests answered (`toServer`), and the client's open documents closed (`didClose`, written as
   * the client would, so the manager passes them through its usual path).
   */
  disconnect(): { toServer: string[]; didClose: string[] } {
    this.connected = false;
    this.awaitingInitialize = false;
    this.awaitingInitialized = false;
    const toServer = [
      ...[...this.inFlight.keys()].map((id) =>
        JSON.stringify({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } }),
      ),
      ...[...this.serverRequests].map(([id, method]) => answerWithoutClient(id, method)),
    ];
    const didClose = [...this.openDocuments].map((uri) =>
      JSON.stringify({
        jsonrpc: "2.0",
        method: "textDocument/didClose",
        params: { textDocument: { uri } },
      }),
    );
    this.inFlight.clear();
    this.serverIds.clear();
    this.serverRequests.clear();
    this.openDocuments.clear();
    return { toServer, didClose };
  }

  /** A new client takes the server over; call {@link disconnect} for the last one first. */
  adopt(): void {
    this.connected = true;
    this.adopted = true;
    this.awaitingInitialize = true;
  }

  /**
   * The server's answer to a client request, whose id is `id`, written at `idRange` of the frame
   * when known (else the frame is parsed to replace it).
   */
  private serverResponse(
    frame: string,
    id: JsonRpcId | undefined,
    idRange: [number, number] | null,
  ): { toClient: string | null; toServer: string[] } {
    const clientId = id === undefined ? undefined : this.inFlight.get(id);
    // Not a request of this client's: an answer to one of an earlier client's, which was
    // cancelled, or one no client is connected to hear.
    if (id === undefined || clientId === undefined) {
      return { toClient: this.adopted || !this.connected ? null : frame, toServer: [] };
    }
    this.inFlight.delete(id);
    this.serverIds.delete(clientId);
    if (id === this.initializeId) {
      const message = parseMessage(frame);
      if (message && "result" in message) this.initializeResult = message.result;
    }
    if (!this.adopted) return { toClient: frame, toServer: [] };
    if (idRange) {
      const [start, end] = idRange;
      const rewritten = frame.slice(0, start) + JSON.stringify(clientId) + frame.slice(end);
      return { toClient: rewritten, toServer: [] };
    }
    const message = parseMessage(frame);
    if (!message) return { toClient: null, toServer: [] };
    return { toClient: JSON.stringify({ ...message, id: clientId }), toServer: [] };
  }

  private clientRequest(
    message: JsonRpcMessage,
    frame: string,
    id: JsonRpcId,
    method: string,
  ): ClientFrameResult {
    if (this.awaitingInitialize && method === "initialize") {
      this.awaitingInitialize = false;
      this.awaitingInitialized = true;
      const answer = { jsonrpc: "2.0", id, result: this.initializeResult };
      return { toServer: null, toClient: [JSON.stringify(answer)] };
    }
    const serverId = this.adopted ? this.nextId++ : id;
    this.inFlight.set(serverId, id);
    if (method === "initialize") this.initializeId = serverId;
    if (!this.adopted) return { toServer: frame, toClient: [] };
    this.serverIds.set(id, serverId);
    return { toServer: JSON.stringify({ ...message, id: serverId }), toClient: [] };
  }

  private clientNotification(
    message: JsonRpcMessage,
    frame: string,
    method: string,
  ): ClientFrameResult {
    if (method === "initialized") {
      if (!this.awaitingInitialized) {
        this.initialized = true;
        return { toServer: frame, toClient: [] };
      }
      this.awaitingInitialized = false;
      return { toServer: null, toClient: this.replayRegistrations(), adopted: true };
    }
    const uri = documentUri(message.params);
    if (method === "textDocument/didOpen" && uri) this.openDocuments.add(uri);
    if (method === "textDocument/didClose" && uri) this.openDocuments.delete(uri);
    if (method === "$/cancelRequest" && this.adopted) {
      const clientId = isRecord(message.params) ? jsonRpcId(message.params.id) : undefined;
      const serverId = clientId === undefined ? undefined : this.serverIds.get(clientId);
      if (serverId === undefined) return { toServer: null, toClient: [] };
      const params = { ...(message.params as Record<string, unknown>), id: serverId };
      return { toServer: JSON.stringify({ ...message, params }), toClient: [] };
    }
    return { toServer: frame, toClient: [] };
  }

  private trackRegistrations(method: string, params: unknown): void {
    if (!isRecord(params)) return;
    if (method === "client/registerCapability" && Array.isArray(params.registrations)) {
      for (const registration of params.registrations) {
        if (isRecord(registration) && typeof registration.id === "string") {
          this.registrations.set(registration.id, registration);
        }
      }
    }
    // The protocol's spelling.
    if (method === "client/unregisterCapability" && Array.isArray(params.unregisterations)) {
      for (const registration of params.unregisterations) {
        if (isRecord(registration) && typeof registration.id === "string") {
          this.registrations.delete(registration.id);
        }
      }
    }
  }

  private replayRegistrations(): string[] {
    if (this.registrations.size === 0) return [];
    return [
      JSON.stringify({
        jsonrpc: "2.0",
        id: `${REPLAY_ID_PREFIX}${++this.replays}`,
        method: "client/registerCapability",
        params: { registrations: [...this.registrations.values()] },
      }),
    ];
  }
}

type JsonRpcId = number | string;

/** What to do with a frame from the client. */
interface ClientFrameResult {
  /** The frame to forward to the server, if any. */
  toServer: string | null;
  /** Answers to send the client from here. */
  toClient: string[];
  /** Set once an adopting client has finished its handshake. */
  adopted?: true;
}

interface JsonRpcMessage extends Record<string, unknown> {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

/**
 * The first id an adopting client's requests get on their way to the server: above any a client
 * counts up to from 0, and within the 32-bit range some servers (rust-analyzer) hold ids in.
 */
const ADOPTED_ID_BASE = 1_000_000_000;

/**
 * The start of an answer as servers write it, `{"jsonrpc":"2.0","id":<id>,"result"|"error":`,
 * with the id's position. Frames written otherwise are parsed in full.
 */
const RESPONSE_HEAD =
  /^\{\s*"jsonrpc"\s*:\s*"2\.0"\s*,\s*"id"\s*:\s*(-?\d+|"(?:[^"\\]|\\.)*")\s*,\s*"(?:result|error)"\s*:/d;

/** The client notifications the handover keeps track of; any other without an id passes as is. */
const TRACKED_CLIENT_NOTIFICATION =
  /"(?:initialized|textDocument\/didOpen|textDocument\/didClose|\$\/cancelRequest)"/;

/** Ids of the registration requests sent to an adopting client, whose answers stay here. */
const REPLAY_ID_PREFIX = "loxel-handover-";

/** JSON-RPC's code for a cancelled request. */
const REQUEST_CANCELLED = -32800;

/** The answer to a server request no client will see: registrations are kept for the next one. */
function answerWithoutClient(id: JsonRpcId, method: string): string {
  const keeps = method === "client/registerCapability" || method === "client/unregisterCapability";
  const reply = keeps
    ? { result: null }
    : { error: { code: REQUEST_CANCELLED, message: "No client is connected" } };
  return JSON.stringify({ jsonrpc: "2.0", id, ...reply });
}

function parseMessage(frame: string): JsonRpcMessage | null {
  let message: unknown;
  try {
    message = JSON.parse(frame);
  } catch {
    return null;
  }
  if (!isRecord(message)) return null;
  const id = jsonRpcId(message.id);
  const method = typeof message.method === "string" ? message.method : undefined;
  return { ...message, id, method };
}

function jsonRpcId(value: unknown): JsonRpcId | undefined {
  return typeof value === "number" || typeof value === "string" ? value : undefined;
}

function documentUri(params: unknown): string | undefined {
  if (!isRecord(params) || !isRecord(params.textDocument)) return undefined;
  const { uri } = params.textDocument;
  return typeof uri === "string" ? uri : undefined;
}
