import path from "node:path";

import type { ServerWebSocket, Subprocess } from "bun";

import { isRecord } from "@/lib/is-record";

import { type BaseLspSession, StdioLspManager } from "./stdio-lsp-manager";

/** The server's command behind its schema CodeLens, which needs `window/showDocument`. */
const JUMP_TO_SCHEMA = "jumpToSchema";

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
 * The server's frame with each schema CodeLens made a label: the lens names the schema each YAML
 * document uses, and its command would open the schema with `window/showDocument`, which Loxel does
 * not answer. A command with an empty id is one Monaco shows but does not run.
 */
export function withSchemaLensesAsLabels(body: string): string {
  if (!body.includes(`"${JUMP_TO_SCHEMA}"`)) return body;
  let frame: unknown;
  try {
    frame = JSON.parse(body);
  } catch {
    return body;
  }
  if (!isRecord(frame) || !Array.isArray(frame.result)) return body;
  let changed = false;
  for (const lens of frame.result) {
    if (!isRecord(lens) || !isRecord(lens.command)) continue;
    if (lens.command.command !== JUMP_TO_SCHEMA || !("range" in lens)) continue;
    lens.command = { title: lens.command.title, command: "" };
    changed = true;
  }
  return changed ? JSON.stringify(frame) : body;
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
    // The compiled bundle, also in development: the npm package's own bin lacks what the build
    // script patches in (see scripts/build-yaml-lsp.ts).
    return this.resolveBundledBinary(
      "yaml-language-server",
      path.resolve(import.meta.dir, "../../build/yaml-language-server"),
    );
  }

  protected buildSession(ws: ServerWebSocket<unknown>, proc: Subprocess): BaseLspSession {
    return { ws, proc, stdoutBuf: Buffer.alloc(0) };
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
      super.handleServerFrame(session, withSchemaLensesAsLabels(body));
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
