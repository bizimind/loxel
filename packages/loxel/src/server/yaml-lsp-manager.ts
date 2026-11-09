import type { ServerWebSocket, Subprocess } from "bun";

import { type BaseLspSession, StdioLspManager } from "./stdio-lsp-manager";

interface ContentRequest {
  id: number | string;
  url: string;
}

/** The `vscode/content` request in a frame from the server, if that is what it is. */
function parseContentRequest(body: string): ContentRequest | null {
  // Cheap check first: every frame the server sends passes through here.
  if (!body.includes('"vscode/content"')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { id, method, params } = parsed as { id?: unknown; method?: unknown; params?: unknown };
  if (method !== "vscode/content") return null;
  if (typeof id !== "number" && typeof id !== "string") return null;
  // The server sends the URL alone or as a one-element array, depending on the transport.
  const url = Array.isArray(params) ? (params as unknown[])[0] : params;
  return typeof url === "string" ? { id, url } : null;
}

/**
 * Manages yaml-language-server child processes, one per WebSocket connection.
 * Each `/ws/yaml-lsp` connection gets its own LSP subprocess bridged via stdio.
 */
export class YamlLspManager extends StdioLspManager<BaseLspSession> {
  /** Sessions whose client has sent `initialized`, which may be asked to pull configuration. */
  private readonly initializedSessions = new WeakSet<BaseLspSession>();

  constructor(
    private schemaMap: Record<string, string[]>,
    private readonly schemaContent: (url: string) => Promise<string>,
  ) {
    super("yaml-lsp");
  }

  /** Called when a WS client connects to /ws/yaml-lsp. */
  attach(ws: ServerWebSocket<unknown>): void {
    this.startSession(ws, undefined);
  }

  /** Update schema mappings and have every initialized session pull them. */
  updateSchemas(schemaMap: Record<string, string[]>): void {
    this.schemaMap = schemaMap;
    for (const session of this.sessions.values()) {
      if (this.initializedSessions.has(session)) this.notifyConfigurationChanged(session);
    }
    this.log.info("Updated YAML schemas", { schemaCount: Object.keys(schemaMap).length });
  }

  // ---------------------------------------------------------------------------

  protected resolveBinary(): string | null {
    return this.resolveBundledBinary("yaml-language-server");
  }

  protected buildSession(ws: ServerWebSocket<unknown>, proc: Subprocess): BaseLspSession {
    return { ws, proc, stdoutBuf: Buffer.alloc(0), documentContents: new Map() };
  }

  protected override onClientInitialized(session: BaseLspSession): void {
    // From here on the server asks for each HTTP(S) schema with `vscode/content` and fetches none
    // itself, modelines and `$ref`s included.
    this.writeToStdin(
      session,
      JSON.stringify({ jsonrpc: "2.0", method: "yaml/registerContentRequest" }),
    );
    this.initializedSessions.add(session);
    this.notifyConfigurationChanged(session);
  }

  /** The server reads its settings with `workspace/configuration`, whatever is pushed to it. */
  protected override async workspaceConfiguration(
    _session: BaseLspSession,
    section: string | undefined,
  ): Promise<unknown> {
    if (section !== "yaml") return null;
    return {
      schemas: this.schemaMap,
      validate: true,
      completion: true,
      hover: true,
      // Its catalog would associate schemas nobody chose, and it fetches that catalog by itself.
      schemaStore: { enable: false },
    };
  }

  protected override handleServerFrame(session: BaseLspSession, body: string): void {
    const request = parseContentRequest(body);
    if (!request) {
      super.handleServerFrame(session, body);
      return;
    }
    void this.answerContentRequest(session, request);
  }

  private async answerContentRequest(
    session: BaseLspSession,
    { id, url }: ContentRequest,
  ): Promise<void> {
    let response: Record<string, unknown>;
    try {
      response = { result: await this.schemaContent(url) };
    } catch (err) {
      const message = err instanceof Error ? err.message : `Could not download ${url}`;
      response = { error: { code: -32603, message } };
    }
    if (!this.isSessionLive(session)) return;
    this.writeToStdin(session, JSON.stringify({ jsonrpc: "2.0", id, ...response }));
  }
}
