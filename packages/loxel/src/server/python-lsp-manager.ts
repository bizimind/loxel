import type { ServerWebSocket, Subprocess } from "bun";

import type { PythonEnv } from "@/api/python-env-model";

import { resolvePythonEnv, watchPythonEnv } from "./python-env";
import {
  type SpawnOptions,
  StdioLspManager,
  type WtLspContext,
  type WtLspSession,
} from "./stdio-lsp-manager";

/**
 * Pyright's `python.analysis` settings. These match Pyright's defaults but are pinned here because
 * sending an `analysis` section at all resets `autoSearchPaths` to false unless it is set.
 */
const PYRIGHT_ANALYSIS_SETTINGS = {
  autoSearchPaths: true,
  diagnosticMode: "openFilesOnly",
  useLibraryCodeForTypes: true,
};

interface PythonLspSession extends WtLspSession {
  /** Latest resolution of the worktree's interpreter; replaced whenever the environment changes. */
  pythonEnv: Promise<PythonEnv | null>;
  stopWatchingEnv: (() => void) | null;
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
      stopWatchingEnv: null,
      initialized: false,
    };
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
    session.stopWatchingEnv?.();
    session.stopWatchingEnv = null;
  }

  protected override async workspaceConfiguration(
    session: PythonLspSession,
    section: string | undefined,
  ): Promise<unknown> {
    if (section !== "python") return null;
    const env = await session.pythonEnv;
    return { ...(env && { pythonPath: env.pythonPath }), analysis: PYRIGHT_ANALYSIS_SETTINGS };
  }

  /**
   * Re-resolve the interpreter, then watch for the next change. Pyright pulls configuration once
   * at startup, so a change after that is announced (`notify`) and Pyright asks again; that also
   * makes it re-resolve imports after packages are installed into the same environment. The
   * announcement waits until the new watch is armed, so whatever Pyright's re-pull misses still
   * triggers another round.
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
      session.stopWatchingEnv?.();
      session.stopWatchingEnv = watchPythonEnv(session.wtPath, env, () => {
        if (this.isSessionLive(session)) this.refreshEnvironment(session, true);
      });
      if (notify && session.initialized) this.notifyConfigurationChanged(session);
    });
  }
}
