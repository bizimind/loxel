import type { ServerWebSocket, Subprocess } from "bun";

import path from "node:path";

import {
  type SpawnOptions,
  StdioLspManager,
  type WtLspContext,
  type WtLspSession,
} from "./stdio-lsp-manager";

export class AstroLspManager extends StdioLspManager<WtLspSession, WtLspContext> {
  protected override readonly disableSemanticTokens = true;

  constructor() {
    super("astro-lsp");
  }

  createSession(ws: ServerWebSocket<unknown>, wtPath: string): void {
    this.startSession(ws, { wtPath });
  }

  destroySession(ws: ServerWebSocket<unknown>): void {
    this.detach(ws);
  }

  protected resolveBinary(): string | null {
    return this.resolveBundledBinary("astro-ls");
  }

  protected override spawnArgs(): readonly string[] {
    return ["--stdio"];
  }

  protected override spawnOptions(context: WtLspContext): SpawnOptions {
    return { cwd: context.wtPath };
  }

  protected buildSession(
    ws: ServerWebSocket<unknown>,
    proc: Subprocess,
    context: WtLspContext,
  ): WtLspSession {
    return {
      ws,
      proc,
      wtPath: context.wtPath,
      stdoutBuf: Buffer.alloc(0),
      documentContents: new Map(),
    };
  }

  protected override getSessionKey(context: WtLspContext): string {
    return context.wtPath;
  }

  protected override getSessionWorkspace(session: WtLspSession): string | null {
    return session.wtPath;
  }

  protected override getInitializationOptions(session: WtLspSession): Record<string, unknown> {
    return {
      typescript: { tsdk: path.join(session.wtPath, "node_modules/typescript/lib") },
      contentIntellisense: true,
    };
  }
}
