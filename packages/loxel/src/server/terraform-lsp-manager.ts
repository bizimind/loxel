import type { ServerWebSocket, Subprocess } from "bun";

import path from "node:path";

import {
  type SpawnOptions,
  StdioLspManager,
  type WtLspContext,
  type WtLspSession,
} from "./stdio-lsp-manager";

export class TerraformLspManager extends StdioLspManager<WtLspSession, WtLspContext> {
  protected override readonly disableSemanticTokens = true;

  constructor() {
    super("terraform-lsp");
  }

  createSession(ws: ServerWebSocket<unknown>, wtPath: string): void {
    this.startSession(ws, { wtPath });
  }

  destroySession(ws: ServerWebSocket<unknown>): void {
    this.detach(ws);
  }

  protected resolveBinary(): string | null {
    return this.resolveBundledBinary(
      "terraform-ls",
      path.resolve(import.meta.dir, "../../build/terraform-ls"),
    );
  }

  protected override spawnArgs(): readonly string[] {
    // terraform-ls uses `serve`, not `--stdio`.
    return ["serve"];
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

  protected override getInitializationOptions(): Record<string, unknown> {
    return {
      indexing: {
        ignoreDirectoryNames: [
          "node_modules",
          ".git",
          "dist",
          "build",
          ".turbo",
          ".next",
          ".cache",
          ".wt-local-res",
          ".worktrees",
          "coverage",
          "out",
        ],
      },
    };
  }
}
