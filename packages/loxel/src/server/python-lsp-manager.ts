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
  // One active WebSocket per worktree path. Prevents multiple pyright
  // processes from spawning when the browser opens duplicate connections
  // (e.g. Vite HMR re-evaluating the lazy-connector module).
  private readonly wtSessions = new Map<string, ServerWebSocket<unknown>>();

  constructor() {
    super("python-lsp");
  }

  createSession(ws: ServerWebSocket<unknown>, wtPath: string): void {
    const existingWs = this.wtSessions.get(wtPath);
    if (existingWs && existingWs !== ws) {
      this.destroySession(existingWs);
      try {
        existingWs.close(4000, "Replaced by newer connection");
      } catch (err) {
        this.log.debug(`python-lsp: close() on replaced WebSocket threw (already closed)`, { err });
      }
    }
    this.wtSessions.set(wtPath, ws);
    this.startSession(ws, { wtPath });
  }

  destroySession(ws: ServerWebSocket<unknown>): void {
    const session = this.sessions.get(ws);
    if (session) {
      this.wtSessions.delete(session.wtPath);
    } else {
      // proc.exited may delete the session before destroySession is called
      // (natural process exit bypasses this override). Reverse-lookup to
      // ensure the stale wtSessions entry is cleaned up regardless.
      for (const [wtPath, mappedWs] of this.wtSessions) {
        if (mappedWs === ws) {
          this.wtSessions.delete(wtPath);
          break;
        }
      }
    }
    this.detach(ws);
  }

  protected resolveBinary(): string | null {
    return this.resolveBundledBinary("pyright-langserver");
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
