import path from "node:path";

import type { ServerWebSocket, Subprocess } from "bun";

import type { PythonEnv } from "@/api/python-env-model";

import { logger } from "./logger";
import { isEnvShippedByRepo, isShippedByRepo, resolvePythonEnv } from "./python-env";
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
 */
export class RuffLspManager extends StdioLspManager<WtLspSession, WtLspContext> {
  /** Ruff watches its config files (`pyproject.toml`, `ruff.toml`) to reload settings. */
  protected override readonly forwardWatchedFiles = true;
  protected override readonly suppressedFeatures: readonly SuppressibleFeature[] = [
    "textDocument/formatting",
    "textDocument/rangeFormatting",
  ];
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
    const env = await resolvePythonEnv(context.wtPath);
    return pickRuffBinary(context.wtPath, env, this.resolveBundledBinary(RUFF, DEV_PATH));
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
  ): WtLspSession {
    return {
      ws,
      proc,
      wtPath: context.wtPath,
      stdoutBuf: Buffer.alloc(0),
      documentContents: new Map(),
    };
  }
}

/**
 * The ruff to run for a worktree: the one installed in its Python environment `env` (next to the
 * interpreter `resolvePythonEnv` found), so the project's pinned version applies, else `bundled`.
 * A candidate counts only when the repository does not ship it and it is new enough to serve.
 */
export async function pickRuffBinary(
  wtPath: string,
  env: PythonEnv | null,
  bundled: string | null,
): Promise<string | null> {
  const fromEnv = env ? path.join(path.dirname(env.pythonPath), RUFF) : null;
  const candidates = [
    { ruff: fromEnv, envPath: env?.envPath ?? null },
    { ruff: bundled, envPath: null },
  ];
  for (const { ruff: candidate, envPath } of candidates) {
    if (candidate && (await isUsableRuff(wtPath, candidate, envPath))) {
      log.info("Using ruff", { wtPath, ruff: candidate, fromEnv: candidate === fromEnv });
      return candidate;
    }
  }
  return null;
}

/**
 * Whether `ruff` exists, is not shipped by the repository and serves. A ruff in an environment is
 * checked with the whole environment (`isEnvShippedByRepo`); one outside any (a system
 * interpreter's directory, the bundled one) only as a file, since its directory can belong to an
 * unrelated repository (Homebrew's prefix tracks `bin/brew`).
 */
async function isUsableRuff(
  wtPath: string,
  ruff: string,
  envPath: string | null,
): Promise<boolean> {
  try {
    if (!(await Bun.file(ruff).exists())) return false;
    const shipped = envPath
      ? await isEnvShippedByRepo(wtPath, envPath, ruff)
      : await isShippedByRepo(wtPath, ruff);
    if (shipped) {
      log.warn("Ignoring a ruff binary tracked by git", { wtPath, ruff });
      return false;
    }
  } catch (err) {
    // Removed between the checks; the next candidate may still do.
    log.debug("Could not check a ruff binary", { ruff, error: err });
    return false;
  }
  const version = await ruffVersion(wtPath, ruff);
  if (!version || Bun.semver.order(version, MIN_SERVER_VERSION) < 0) {
    log.info("Ignoring a ruff without a stable language server", { ruff, version });
    return false;
  }
  return true;
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
