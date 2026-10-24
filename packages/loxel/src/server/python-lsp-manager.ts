import path from "node:path";

import type { ServerWebSocket, Subprocess } from "bun";

import type { PythonEnv } from "@/api/python-env-model";

import { type PythonEnvWatch, resolvePythonEnv, watchPythonEnv } from "./python-env";
import {
  type SpawnOptions,
  StdioLspManager,
  type WtLspContext,
  type WtLspSession,
} from "./stdio-lsp-manager";

interface PythonLspSession extends WtLspSession {
  /** Latest resolution of the worktree's interpreter; replaced whenever the environment changes. */
  pythonEnv: Promise<PythonEnv | null>;
  envWatch: PythonEnvWatch | null;
  /** The interpreter last resolved, to report only real changes; undefined before the first. */
  resolvedEnv: PythonEnv | null | undefined;
  /** Set once the client's `initialized` reached the server, after which config may be pushed. */
  initialized: boolean;
}

/**
 * Manages Pyright (`pyright-langserver`) child processes, one per worktree.
 * Each `/ws/python-lsp?wt=<path>` connection gets its own subprocess
 * rooted at the worktree path so cross-file references and module
 * resolution work against the full worktree workspace.
 *
 * Pyright does not discover project virtual environments itself, so the
 * worktree's interpreter comes from {@link resolvePythonEnv} and reaches
 * Pyright as `python.pythonPath` through `workspace/configuration`. A
 * `pyrightconfig.json` / `[tool.pyright]` `venv` still takes precedence
 * inside Pyright.
 */
export class PythonLspManager extends StdioLspManager<PythonLspSession, WtLspContext> {
  /** @param onEnvironmentResolved Called when a session's interpreter resolves to a different one. */
  constructor(private readonly onEnvironmentResolved: (wtPath: string) => void = () => {}) {
    super("python-lsp");
  }

  /** Re-resolve the interpreter of the worktree's sessions, e.g. after its override changed. */
  refreshWorktreeEnvironment(wtPath: string): void {
    const target = path.resolve(wtPath);
    for (const session of this.sessions.values()) {
      if (path.resolve(session.wtPath) === target) this.refreshEnvironment(session, true);
    }
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

  protected override getSessionKey(context: WtLspContext): string {
    return context.wtPath;
  }

  protected override spawnOptions(context: WtLspContext): SpawnOptions {
    return { cwd: context.wtPath };
  }

  protected buildSession(
    ws: ServerWebSocket<unknown>,
    proc: Subprocess,
    context: WtLspContext,
  ): PythonLspSession {
    const session: PythonLspSession = {
      ws,
      proc,
      wtPath: context.wtPath,
      stdoutBuf: Buffer.alloc(0),
      documentContents: new Map(),
      pythonEnv: Promise.resolve(null),
      envWatch: null,
      resolvedEnv: undefined,
      initialized: false,
    };
    // Watch the layout before the first resolution so nothing created meanwhile is missed.
    session.envWatch = this.watchEnvironment(session, null);
    this.refreshEnvironment(session);
    return session;
  }

  protected override getSessionWorkspace(session: PythonLspSession): string | null {
    return session.wtPath;
  }

  protected override onClientInitialized(session: PythonLspSession): void {
    session.initialized = true;
  }

  protected override onSessionClosed(session: PythonLspSession): void {
    session.envWatch?.close();
    session.envWatch = null;
  }

  protected override async workspaceConfiguration(
    session: PythonLspSession,
    section: string | undefined,
  ): Promise<unknown> {
    if (section !== "python") return null;
    // Only the interpreter: Pyright's own defaults (open-files-only diagnostics, auto search
    // paths, library types) are what Loxel wants, and sending any `analysis` section would reset
    // `autoSearchPaths` unless it is repeated.
    const env = await session.pythonEnv;
    return env ? { pythonPath: env.pythonPath } : null;
  }

  /**
   * Re-resolve the interpreter, then watch for the next change. Pyright pulls configuration once
   * at startup, so a change after that is announced (`notify`) and Pyright asks again; that also
   * makes it re-resolve imports after packages are installed into the same environment. The old
   * watch stays armed until the new one is, and a change it saw in between is handed to the new
   * watch's debounce, so nothing written during resolution is lost.
   */
  private refreshEnvironment(session: PythonLspSession, notify = false): void {
    const resolution = resolvePythonEnv(session.wtPath);
    session.pythonEnv = resolution;
    void resolution.then((env) => {
      if (!this.isSessionLive(session) || session.pythonEnv !== resolution) return;
      this.log.info("Python environment resolved", {
        wtPath: session.wtPath,
        source: env?.source ?? null,
        pythonPath: env?.pythonPath ?? null,
      });
      const previous = session.envWatch;
      const next = this.watchEnvironment(session, env);
      session.envWatch = next;
      // Hand a change the old watch saw during resolution to the new one's debounce, so a write
      // burst still coalesces into one more round instead of re-resolving back to back.
      if (previous?.hasPendingChange) next.nudge();
      previous?.close();
      if (notify && session.initialized) this.notifyConfigurationChanged(session);
      // Packages installed into the same environment re-resolve too; only a different
      // interpreter is news to the UI.
      if (session.resolvedEnv === undefined || !isSameEnv(session.resolvedEnv, env)) {
        this.onEnvironmentResolved(session.wtPath);
      }
      session.resolvedEnv = env;
    });
  }

  private watchEnvironment(session: PythonLspSession, env: PythonEnv | null): PythonEnvWatch {
    return watchPythonEnv(session.wtPath, env, () => {
      if (this.isSessionLive(session)) this.refreshEnvironment(session, true);
    });
  }
}

function isSameEnv(a: PythonEnv | null, b: PythonEnv | null): boolean {
  return a?.source === b?.source && a?.pythonPath === b?.pythonPath && a?.envPath === b?.envPath;
}
