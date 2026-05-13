import type { ServerWebSocket, Subprocess } from "bun";

import { type BaseLspSession, type SpawnOptions, StdioLspManager } from "./stdio-lsp-manager";

interface PythonLspContext {
  wtPath: string;
}

interface PythonLspSession extends BaseLspSession {
  wtPath: string;
}

/**
 * Manages Pyright (`pyright-langserver`) child processes, one per worktree.
 * Each `/ws/python-lsp?wt=<path>` connection gets its own subprocess
 * rooted at the worktree path so cross-file references and module
 * resolution work against the full worktree workspace.
 */
export class PythonLspManager extends StdioLspManager<PythonLspSession, PythonLspContext> {
  constructor() {
    super("python-lsp");
  }

  createSession(ws: ServerWebSocket<unknown>, wtPath: string): void {
    this.startSession(ws, { wtPath });
  }

  destroySession(ws: ServerWebSocket<unknown>): void {
    this.detach(ws);
  }

  protected resolveBinary(): string | null {
    return this.resolveBundledBinary("pyright-langserver");
  }

  protected override getSessionKey(context: PythonLspContext): string {
    return context.wtPath;
  }

  protected override spawnOptions(context: PythonLspContext): SpawnOptions {
    return { cwd: context.wtPath };
  }

  protected buildSession(
    ws: ServerWebSocket<unknown>,
    proc: Subprocess,
    context: PythonLspContext,
  ): PythonLspSession {
    return {
      ws,
      proc,
      wtPath: context.wtPath,
      stdoutBuf: Buffer.alloc(0),
      documentContents: new Map(),
    };
  }

  protected override getSessionWorkspace(session: PythonLspSession): string | null {
    return session.wtPath;
  }

  protected override getInitializationOptions(): Record<string, unknown> {
    return {
      python: {
        analysis: {
          autoSearchPaths: true,
          diagnosticMode: "openFilesOnly",
          useLibraryCodeForTypes: true,
        },
      },
    };
  }
}
