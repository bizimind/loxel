import type { ServerWebSocket, Subprocess } from "bun";

import type { PythonEnv } from "@/api/python-env-model";

import {
  getPythonEnv,
  getPythonEnvNow,
  isSamePythonEnv,
  pathOutsideWorktree,
  subscribePythonEnv,
} from "./python-env";
import { buildSpawnEnv } from "./shell-env";
import {
  type SpawnOptions,
  StdioLspManager,
  type WtLspContext,
  type WtLspSession,
} from "./stdio-lsp-manager";

interface PythonLspSession extends WtLspSession {
  unsubscribeEnv: (() => void) | null;
  /** The interpreter last answered in `workspace/configuration`; undefined before the first. */
  answeredEnv: PythonEnv | null | undefined;
  /** Set once the client's `initialized` reached the server, after which config may be pushed. */
  initialized: boolean;
}

/**
 * Settings answered for the `basedpyright` section. Loxel defaults to the
 * `standard` ruleset because basedpyright's own `recommended` flags ordinary
 * code (unused call results, unknown types); a project config file
 * (`pyrightconfig.json`, `[tool.basedpyright]` / `[tool.pyright]`) replaces
 * these analysis settings entirely. Sending `analysis` resets
 * `autoSearchPaths` unless it is repeated.
 */
const BASEDPYRIGHT_SETTINGS = { analysis: { typeCheckingMode: "standard", autoSearchPaths: true } };

/**
 * Settings answered for the `python` section: the resolved interpreter. Without one,
 * basedpyright would run a root `.venv/bin/python` it finds itself, even one the repository
 * commits, which the resolver refuses. A `venvPath` with no `venv` turns that detection off
 * without selecting an environment, so it falls back to `python3` on its (worktree-free) PATH.
 */
export function pythonSettings(env: PythonEnv | null, wtPath: string): Record<string, string> {
  return env ? { pythonPath: env.pythonPath } : { venvPath: wtPath };
}

/**
 * Manages basedpyright (`basedpyright-langserver`) child processes, one per
 * worktree. Each `/ws/python-lsp?wt=<path>` connection gets its own subprocess
 * rooted at the worktree path so cross-file references and module
 * resolution work against the full worktree workspace.
 *
 * The worktree's interpreter comes from the shared resolution in `python-env.ts`
 * ({@link getPythonEnv}), the single source of truth (basedpyright's own root
 * `.venv` detection covers less), and reaches basedpyright as `python.pythonPath`
 * through `workspace/configuration`.
 * A `pyrightconfig.json` / `[tool.basedpyright]` / `[tool.pyright]` `venv`
 * still takes precedence inside basedpyright.
 */
export class PythonLspManager extends StdioLspManager<PythonLspSession, WtLspContext> {
  protected override readonly forwardWatchedFiles = true;

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
    return this.resolveBundledBinary("basedpyright-langserver");
  }

  protected override getSessionKey(context: WtLspContext): string {
    return context.wtPath;
  }

  protected override spawnOptions(context: WtLspContext): SpawnOptions {
    // Without a resolved interpreter basedpyright runs `python3` / `python` from its PATH; keep the
    // worktree's own directories out of it, matching the resolver's refusal of committed ones.
    const PATH = pathOutsideWorktree(buildSpawnEnv().PATH ?? "", context.wtPath);
    return { cwd: context.wtPath, env: { PATH } };
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
      unsubscribeEnv: null,
      answeredEnv: undefined,
      initialized: false,
    };
    session.unsubscribeEnv = subscribePythonEnv(session.wtPath, ({ env, first }) => {
      if (!this.isSessionLive(session) || !session.initialized) return;
      // The first resolution is what the configuration answer waited for; every later one may
      // mean a different interpreter or packages installed into the same one.
      if (first && session.answeredEnv !== undefined && isSamePythonEnv(session.answeredEnv, env))
        return;
      this.notifyConfigurationChanged(session);
    });
    // Resolve while basedpyright starts, rather than when it first asks.
    void getPythonEnv(session.wtPath);
    return session;
  }

  protected override getSessionWorkspace(session: PythonLspSession): string | null {
    return session.wtPath;
  }

  protected override onClientInitialized(session: PythonLspSession): void {
    session.initialized = true;
  }

  protected override onSessionClosed(session: PythonLspSession): void {
    session.unsubscribeEnv?.();
    session.unsubscribeEnv = null;
  }

  protected override async workspaceConfiguration(
    session: PythonLspSession,
    section: string | undefined,
  ): Promise<unknown> {
    if (section === "basedpyright") return BASEDPYRIGHT_SETTINGS;
    if (section !== "python") return null;
    // The last resolution, even while a newer one runs: basedpyright is told to ask again when
    // that one lands (see the subscription in `buildSession`), instead of analyzing nothing until then.
    const env = await getPythonEnvNow(session.wtPath);
    session.answeredEnv = env;
    return pythonSettings(env, session.wtPath);
  }
}
