import type { ServerWebSocket, Subprocess } from "bun";

import path from "node:path";

import {
  type SpawnOptions,
  StdioLspManager,
  type WtLspContext,
  type WtLspSession,
} from "./stdio-lsp-manager";

export class XmlLspManager extends StdioLspManager<WtLspSession, WtLspContext> {
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
}
