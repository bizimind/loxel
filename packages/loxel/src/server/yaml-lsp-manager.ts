import type { ServerWebSocket, Subprocess } from "bun";

import { type BaseLspSession, StdioLspManager } from "./stdio-lsp-manager";

/**
 * Manages yaml-language-server child processes, one per WebSocket connection.
 * Each `/ws/yaml-lsp` connection gets its own LSP subprocess bridged via stdio.
 */
export class YamlLspManager extends StdioLspManager<BaseLspSession> {
  constructor(private schemaMap: Record<string, string[]>) {
    super("yaml-lsp");
  }

  /** Called when a WS client connects to /ws/yaml-lsp. */
  attach(ws: ServerWebSocket<unknown>): void {
    this.startSession(ws, undefined);
  }

  /** Update schema mappings and push to all active sessions. */
  updateSchemas(schemaMap: Record<string, string[]>): void {
    this.schemaMap = schemaMap;
    for (const session of this.sessions.values()) {
      this.injectSchemaConfig(session);
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
    this.injectSchemaConfig(session);
  }

  private injectSchemaConfig(session: BaseLspSession): void {
    const msg = JSON.stringify({
      jsonrpc: "2.0",
      method: "workspace/didChangeConfiguration",
      params: {
        settings: {
          yaml: {
            schemas: this.schemaMap,
            validate: true,
            completion: true,
            hover: true,
            schemaStore: { enable: false },
          },
        },
      },
    });
    this.log.debug("Injecting schema configuration", {
      schemaCount: Object.keys(this.schemaMap).length,
    });
    this.writeToStdin(session, msg);
  }
}
