import type { ServerWebSocket, Subprocess } from "bun";

import path from "node:path";

import { type BaseLspSession, type SpawnOptions, StdioLspManager } from "./stdio-lsp-manager";

interface AstroLspContext {
  wtPath: string;
}

interface AstroLspSession extends BaseLspSession {
  wtPath: string;
}

export class AstroLspManager extends StdioLspManager<AstroLspSession, AstroLspContext> {
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

  protected override spawnOptions(context: AstroLspContext): SpawnOptions {
    return { cwd: context.wtPath };
  }

  protected buildSession(
    ws: ServerWebSocket<unknown>,
    proc: Subprocess,
    context: AstroLspContext,
  ): AstroLspSession {
    return {
      ws,
      proc,
      wtPath: context.wtPath,
      stdoutBuf: Buffer.alloc(0),
      documentContents: new Map(),
    };
  }

  protected override getSessionKey(context: AstroLspContext): string {
    return context.wtPath;
  }

  protected override getSessionWorkspace(session: AstroLspSession): string | null {
    return session.wtPath;
  }

  protected override getInitializationOptions(session: AstroLspSession): Record<string, unknown> {
    return {
      typescript: { tsdk: path.join(session.wtPath, "node_modules/typescript/lib") },
      contentIntellisense: true,
    };
  }
}
