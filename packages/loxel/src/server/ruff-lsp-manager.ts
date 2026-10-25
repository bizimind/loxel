import path from "node:path";

import type { ServerWebSocket, Subprocess } from "bun";

import { logger } from "./logger";
import { isShippedByRepo, resolvePythonEnv } from "./python-env";
import {
  type SpawnOptions,
  StdioLspManager,
  type WtLspContext,
  type WtLspSession,
} from "./stdio-lsp-manager";

const log = logger.child("ruff-lsp");

const RUFF = process.platform === "win32" ? "ruff.exe" : "ruff";
/** Where `download:ruff` puts the bundled binary in dev mode. */
const DEV_PATH = path.resolve(import.meta.dir, "../../build", RUFF);
/** First release whose `ruff server` is stable (older ones lack it or need `--preview`). */
const MIN_SERVER_VERSION = [0, 5, 3] as const;
const VERSION_TIMEOUT_MS = 5_000;

/**
 * Manages `ruff server` child processes, one per worktree: lint diagnostics, quick fixes, fix all
 * and organize imports for Python, next to Pyright's type checking (Pyright offers no organize
 * imports code action, so the two never compete for it). Ruff finds its configuration
 * per file (nearest `.ruff.toml` / `ruff.toml` / `pyproject.toml`), so nothing is configured here
 * beyond turning off what another owner already provides: syntax errors (Pyright reports them) and
 * formatting (format on save picks ruff or black per project, see `python-formatter.ts`).
 */
export class RuffLspManager extends StdioLspManager<WtLspSession, WtLspContext> {
  /** Ruff watches its config files (`pyproject.toml`, `ruff.toml`) to reload settings. */
  protected override readonly forwardWatchedFiles = true;
  protected override readonly suppressedRegistrations = [
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

  protected resolveBinary(context: WtLspContext): Promise<string | null> {
    return resolveRuffBinary(context.wtPath, this.resolveBundledBinary(RUFF, DEV_PATH));
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
 * The ruff to run for a worktree: the one installed in its Python environment (next to the
 * interpreter `resolvePythonEnv` finds), so the project's pinned version applies, else `bundled`.
 * A candidate counts only when the repository does not ship it and it is new enough to serve.
 */
export async function resolveRuffBinary(
  wtPath: string,
  bundled: string | null,
): Promise<string | null> {
  const env = await resolvePythonEnv(wtPath);
  const fromEnv = env ? path.join(path.dirname(env.pythonPath), RUFF) : null;
  for (const candidate of [fromEnv, bundled]) {
    if (candidate && (await isUsableRuff(wtPath, candidate))) {
      log.info("Using ruff", { wtPath, ruff: candidate, fromEnv: candidate === fromEnv });
      return candidate;
    }
  }
  return null;
}

async function isUsableRuff(wtPath: string, ruff: string): Promise<boolean> {
  if (!(await Bun.file(ruff).exists())) return false;
  if (await isShippedByRepo(wtPath, ruff)) {
    log.warn("Ignoring a ruff binary tracked by git", { wtPath, ruff });
    return false;
  }
  const version = await ruffVersion(ruff);
  if (!version || compareVersions(version, MIN_SERVER_VERSION) < 0) {
    log.info("Ignoring a ruff without a stable language server", { ruff, version });
    return false;
  }
  return true;
}

/** `[major, minor, patch]` from `ruff --version`, or null when it does not run. */
async function ruffVersion(ruff: string): Promise<number[] | null> {
  try {
    const proc = Bun.spawn([ruff, "--version"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: VERSION_TIMEOUT_MS,
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const match = /^ruff (\d+)\.(\d+)\.(\d+)/.exec(stdout.trim());
    return exitCode === 0 && match ? match.slice(1).map(Number) : null;
  } catch {
    return null;
  }
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
