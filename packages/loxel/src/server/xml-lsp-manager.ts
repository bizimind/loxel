import type { ServerWebSocket, Subprocess } from "bun";

import path from "node:path";

import { type BaseLspSession, type SpawnOptions, StdioLspManager } from "./stdio-lsp-manager";

interface XmlLspContext {
  wtPath: string;
}

interface XmlLspSession extends BaseLspSession {
  wtPath: string;
}

export class XmlLspManager extends StdioLspManager<XmlLspSession, XmlLspContext> {
  constructor() {
    super("xml-lsp");
  }

  createSession(ws: ServerWebSocket<unknown>, wtPath: string): void {
    this.startSession(ws, { wtPath });
  }

  destroySession(ws: ServerWebSocket<unknown>): void {
    this.detach(ws);
  }

  protected resolveBinary(): string | null {
    return this.resolveBundledBinary(
      "lemminx",
      path.resolve(import.meta.dir, "../../build/lemminx/lemminx"),
    );
  }

  protected override spawnOptions(context: XmlLspContext): SpawnOptions {
    return { cwd: context.wtPath };
  }

  protected buildSession(
    ws: ServerWebSocket<unknown>,
    proc: Subprocess,
    context: XmlLspContext,
  ): XmlLspSession {
    return {
      ws,
      proc,
      wtPath: context.wtPath,
      stdoutBuf: Buffer.alloc(0),
      documentContents: new Map(),
    };
  }

  protected override getSessionKey(context: XmlLspContext): string {
    return context.wtPath;
  }

  protected override getSessionWorkspace(session: XmlLspSession): string | null {
    return session.wtPath;
  }
}
