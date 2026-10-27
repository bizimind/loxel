import path from "node:path";

import type { ServerWebSocket, Subprocess } from "bun";

import type { PythonEnv } from "@/api/python-env-model";
import { LSP_RESTART_CLOSE_CODE } from "@/api/ws-protocol";

import { logger } from "./logger";
import {
  getPythonEnv,
  isEnvShippedByRepo,
  isShippedByRepo,
  subscribePythonEnv,
} from "./python-env";
import { buildSpawnEnv } from "./shell-env";
import {
  type SpawnOptions,
  StdioLspManager,
  type SuppressibleFeature,
  type WtLspContext,
  type WtLspSession,
} from "./stdio-lsp-manager";

const log = logger.child("ruff-lsp");

const RUFF = process.platform === "win32" ? "ruff.exe" : "ruff";
/** Where `download:ruff` puts the bundled binary in dev mode. */
const DEV_PATH = path.resolve(import.meta.dir, "../../build", RUFF);
/** First release whose `ruff server` is stable (older ones lack it or need `--preview`). */
const MIN_SERVER_VERSION = "0.5.3";
const VERSION_TIMEOUT_MS = 5_000;

/**
 * Manages `ruff server` child processes, one per worktree: lint diagnostics, quick fixes, fix all
 * and organize imports for Python, next to basedpyright's type checking (basedpyright offers no organize
 * imports code action, so the two never compete for it). Ruff finds its configuration
 * per file (nearest `.ruff.toml` / `ruff.toml` / `pyproject.toml`), so nothing is configured here
 * beyond turning off what another owner already provides: syntax errors (basedpyright reports them) and
 * formatting (format on save picks ruff or black per project, see `python-formatter.ts`).
 *
 * The binary is picked again after every re-resolution of the worktree's Python environment
 * (`uv sync` creating `.venv`, ruff upgraded in it, another interpreter chosen); when the pick
 * differs, the socket is closed with {@link LSP_RESTART_CLOSE_CODE} so the client reconnects and
 * a new session starts with the new binary.
 */
export class RuffLspManager extends StdioLspManager<RuffLspSession, WtLspContext> {
  /** Ruff watches its config files (`pyproject.toml`, `ruff.toml`) to reload settings. */
  protected override readonly forwardWatchedFiles = true;
  protected override readonly suppressedFeatures: readonly SuppressibleFeature[] = [
    "textDocument/formatting",
    "textDocument/rangeFormatting",
  ];
  /** The pick behind each worktree's spawn, from `resolveBinary` until its session is built. */
  private readonly spawnedRuff = new Map<string, RuffPick>();

  constructor() {
    super("ruff-lsp");
  }

  createSession(ws: ServerWebSocket<unknown>, wtPath: string): void {
    this.startSession(ws, { wtPath });
  }

  destroySession(ws: ServerWebSocket<unknown>): void {
    this.detach(ws);
  }

  protected async resolveBinary(context: WtLspContext): Promise<string | null> {
    const pick = await this.pick(context.wtPath, await getPythonEnv(context.wtPath));
    if (pick) this.spawnedRuff.set(context.wtPath, pick);
    return pick?.path ?? null;
  }

  protected override spawnArgs(): readonly string[] {
    return ["server"];
  }

  protected override getSessionKey(context: WtLspContext): string {
    return context.wtPath;
  }

  protected override spawnOptions(context: WtLspContext): SpawnOptions {
    return { cwd: context.wtPath };
  }

  protected override getSessionWorkspace(session: WtLspSession): string {
    return session.wtPath;
  }

  protected override getInitializationOptions(): Record<string, unknown> {
    return { settings: { showSyntaxErrors: false } };
  }

  protected buildSession(
    ws: ServerWebSocket<unknown>,
    proc: Subprocess,
    context: WtLspContext,
  ): RuffLspSession {
    const session: RuffLspSession = {
      ws,
      proc,
      wtPath: context.wtPath,
      stdoutBuf: Buffer.alloc(0),
      documentContents: new Map(),
      ruff: this.spawnedRuff.get(context.wtPath) ?? null,
      unsubscribeEnv: null,
      repicking: Promise.resolve(),
    };
    this.spawnedRuff.delete(context.wtPath);
    session.unsubscribeEnv = subscribePythonEnv(context.wtPath, ({ env }) => {
      // One pick at a time, so the last re-resolution decides.
      session.repicking = session.repicking.then(() => this.repick(session, env));
    });
    return session;
  }

  protected override onSessionClosed(session: RuffLspSession): void {
    session.unsubscribeEnv?.();
    session.unsubscribeEnv = null;
  }

  private pick(wtPath: string, env: PythonEnv | null): Promise<RuffPick | null> {
    return pickRuffBinary(wtPath, env, this.resolveBundledBinary(RUFF, DEV_PATH));
  }

  /** Restart the session's ruff when the environment now calls for a different one. */
  private async repick(session: RuffLspSession, env: PythonEnv | null): Promise<void> {
    if (!this.isSessionLive(session)) return;
    const next = await this.pick(session.wtPath, env);
    // Without any usable ruff now, the running one keeps serving.
    if (!next || !this.isSessionLive(session) || isSamePick(next, session.ruff)) return;
    this.log.info("Restarting ruff for a different binary", {
      wtPath: session.wtPath,
      from: session.ruff,
      to: next,
    });
    const { ws } = session;
    this.detach(ws);
    ws.close(LSP_RESTART_CLOSE_CODE, "ruff changed; reconnect");
  }
}

interface RuffLspSession extends WtLspSession {
  /** The binary this session runs; null when unknown. */
  ruff: RuffPick | null;
  unsubscribeEnv: (() => void) | null;
  repicking: Promise<void>;
}

/** A ruff binary and the version it reported. */
export interface RuffPick {
  path: string;
  version: string;
}

function isSamePick(a: RuffPick, b: RuffPick | null): boolean {
  return a.path === b?.path && a.version === b.version;
}

/**
 * The ruff to run for a worktree: the one installed in its Python environment `env` (next to the
 * interpreter the shared resolution found), so the project's pinned version applies, else
 * `bundled`. A candidate counts only when the repository does not ship it and it is new enough to
 * serve.
 */
export async function pickRuffBinary(
  wtPath: string,
  env: PythonEnv | null,
  bundled: string | null,
): Promise<RuffPick | null> {
  const fromEnv = env ? path.join(path.dirname(env.pythonPath), RUFF) : null;
  const candidates = [
    { ruff: fromEnv, envPath: env?.envPath ?? null },
    { ruff: bundled, envPath: null },
  ];
  for (const { ruff: candidate, envPath } of candidates) {
    const version = candidate ? await usableRuffVersion(wtPath, candidate, envPath) : null;
    if (candidate && version) {
      log.info("Using ruff", { wtPath, ruff: candidate, version, fromEnv: candidate === fromEnv });
      return { path: candidate, version };
    }
  }
  return null;
}

/**
 * The version of `ruff` when it exists, is not shipped by the repository and serves. A ruff in an environment is
 * checked with the whole environment (`isEnvShippedByRepo`); one outside any (a system
 * interpreter's directory, the bundled one) only as a file, since its directory can belong to an
 * unrelated repository (Homebrew's prefix tracks `bin/brew`).
 */
async function usableRuffVersion(
  wtPath: string,
  ruff: string,
  envPath: string | null,
): Promise<string | null> {
  if (!(await Bun.file(ruff).exists())) return null;
  // Both checks treat a ruff removed meanwhile as shipped, so the next candidate gets its turn.
  const shipped = envPath
    ? await isEnvShippedByRepo(wtPath, envPath, ruff)
    : await isShippedByRepo(wtPath, ruff);
  if (shipped) {
    log.warn("Ignoring a ruff binary tracked by git", { wtPath, ruff });
    return null;
  }
  const version = await ruffVersion(wtPath, ruff);
  if (!version || Bun.semver.order(version, MIN_SERVER_VERSION) < 0) {
    log.info("Ignoring a ruff without a stable language server", { ruff, version });
    return null;
  }
  return version;
}

/**
 * The `major.minor.patch` that `ruff --version` reports, or null when it does not run. Probed where the
 * server will run, since a shim (pyenv, asdf) picks its ruff by directory and environment.
 */
async function ruffVersion(wtPath: string, ruff: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([ruff, "--version"], {
      cwd: wtPath,
      env: buildSpawnEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: VERSION_TIMEOUT_MS,
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const match = /^ruff (\d+\.\d+\.\d+)/.exec(stdout.trim());
    return exitCode === 0 && match?.[1] ? match[1] : null;
  } catch {
    return null;
  }
}
