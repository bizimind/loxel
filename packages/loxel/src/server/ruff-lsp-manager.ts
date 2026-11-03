import path from "node:path";

import type { ServerWebSocket, Subprocess } from "bun";

import type { PythonEnv } from "@/api/python-env-model";
import { LSP_RESTART_CLOSE_CODE } from "@/api/ws-protocol";

import { logger } from "./logger";
import { getPythonEnv, getPythonEnvNow, isSamePythonEnv, subscribePythonEnv } from "./python-env";
import { reportRepoRestriction } from "./repo-trust";
import { buildSpawnEnv } from "./shell-env";
import { isEnvShippedByRepo, isShippedByRepo } from "./shipped-by-repo";
import { measureSpawn } from "./spawn-metrics";
import {
  type SuppressibleFeature,
  type WtLspContext,
  type WtLspSession,
  WorktreeSessionLspManager,
} from "./stdio-lsp-manager";

const log = logger.child("ruff-lsp");

const RUFF = process.platform === "win32" ? "ruff.exe" : "ruff";
/** Where `build:language-servers` puts the bundled binary in dev mode. */
const DEV_PATH = path.resolve(import.meta.dir, "../../build", RUFF);
/** First release whose `ruff server` is stable (older ones lack it or need `--preview`). */
const MIN_SERVER_VERSION = "0.5.3";
const VERSION_TIMEOUT_MS = 5_000;
/** Exported for tests. */
export const RUFF_REPO_TRUST_RESTRICTION = "Ruff lints with Loxel's own ruff, not the project's.";

/**
 * The ruff that ships with Loxel, next to the server binary or, in dev mode, where
 * `build:language-servers` puts it; never one found on PATH, so it is what may run in an untrusted
 * repository.
 */
export function bundledRuff(): string | null {
  const sibling = path.join(path.dirname(process.execPath), RUFF);
  if (Bun.file(sibling).size) return sibling;
  return Bun.file(DEV_PATH).size ? DEV_PATH : null;
}

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
 * a new session starts with the new binary. The environment's ruff is installed with the project's
 * dependencies, so only a trusted repository runs it; an untrusted one runs {@link bundledRuff}.
 */
export class RuffLspManager extends WorktreeSessionLspManager<RuffLspSession> {
  /** Ruff watches its config files (`pyproject.toml`, `ruff.toml`) to reload settings. */
  protected override readonly forwardWatchedFiles = true;
  protected override readonly suppressedFeatures: readonly SuppressibleFeature[] = [
    "textDocument/formatting",
    "textDocument/rangeFormatting",
  ];
  /** The pick behind each worktree's spawn and the environment it was made for, from `resolveBinary` until its session is built. */
  private readonly spawnedRuff = new Map<string, { pick: RuffPick; env: PythonEnv | null }>();

  protected override readonly repoTrustRestriction = RUFF_REPO_TRUST_RESTRICTION;
  // Held back only when the environment has a ruff; see resolveBinary.
  protected override readonly reportsRestrictionAtStart = false;

  constructor() {
    super("ruff-lsp");
  }

  protected async resolveBinary(context: WtLspContext): Promise<string | null> {
    const env = await getPythonEnv(context.wtPath);
    const fromEnv = envRuff(env);
    if (!context.repoTrusted && fromEnv && (await Bun.file(fromEnv).exists())) {
      reportRepoRestriction(context.wtPath, RUFF_REPO_TRUST_RESTRICTION);
    }
    const pick = await this.pick(context.wtPath, env, context.repoTrusted);
    if (pick) this.spawnedRuff.set(context.wtPath, { pick, env });
    return pick?.path ?? null;
  }

  protected override spawnArgs(): readonly string[] {
    return ["server"];
  }

  protected override getInitializationOptions(): Record<string, unknown> {
    return { settings: { showSyntaxErrors: false } };
  }

  protected buildSession(
    ws: ServerWebSocket<unknown>,
    proc: Subprocess,
    context: WtLspContext,
  ): RuffLspSession {
    const spawned = this.spawnedRuff.get(context.wtPath);
    const session: RuffLspSession = {
      ws,
      proc,
      wtPath: context.wtPath,
      repoTrusted: context.repoTrusted,
      stdoutBuf: Buffer.alloc(0),
      documentContents: new Map(),
      ruff: spawned?.pick ?? null,
      unsubscribeEnv: null,
      repicking: Promise.resolve(),
    };
    this.spawnedRuff.delete(context.wtPath);
    session.unsubscribeEnv = subscribePythonEnv(context.wtPath, ({ env }) => {
      // One pick at a time, so the last re-resolution decides.
      session.repicking = session.repicking.then(() => this.repick(session, env));
    });
    // A re-resolution that landed while the binary was picked and spawned was heard by no one.
    session.repicking = getPythonEnvNow(context.wtPath).then((env) =>
      spawned && isSamePythonEnv(env, spawned.env) ? undefined : this.repick(session, env),
    );
    return session;
  }

  protected override onSessionClosed(session: RuffLspSession): void {
    session.unsubscribeEnv?.();
    session.unsubscribeEnv = null;
  }

  private pick(
    wtPath: string,
    env: PythonEnv | null,
    repoTrusted: boolean,
  ): Promise<RuffPick | null> {
    if (!repoTrusted) return pickRuffBinary(wtPath, null, bundledRuff());
    return pickRuffBinary(wtPath, env, this.resolveBundledBinary(RUFF, DEV_PATH));
  }

  /** Restart the session's ruff when the environment now calls for a different one. */
  private async repick(session: RuffLspSession, env: PythonEnv | null): Promise<void> {
    if (!this.isSessionLive(session)) return;
    const next = await this.pick(session.wtPath, env, session.repoTrusted);
    // Without any usable ruff now, the running one keeps serving.
    if (!next || !this.isSessionLive(session) || isSamePick(next, session.ruff)) return;
    // The environment's ruff still in place and trusted, whose version just could not be read (a
    // timeout while the OS scans it, a reinstall in progress), is no reason to restart.
    const running = session.ruff?.path;
    if (
      running &&
      running === envRuff(env) &&
      next.path !== running &&
      (await isTrustedRuff(session.wtPath, running, env?.envPath ?? null))
    ) {
      return;
    }
    if (!this.isSessionLive(session)) return;
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
  const fromEnv = envRuff(env);
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
  if (!(await isTrustedRuff(wtPath, ruff, envPath))) return null;
  const version = await ruffVersion(wtPath, ruff);
  if (!version || Bun.semver.order(version, MIN_SERVER_VERSION) < 0) {
    log.info("Ignoring a ruff without a stable language server", { ruff, version });
    return null;
  }
  return version;
}

/** The ruff next to the environment's interpreter, whether or not it exists. */
function envRuff(env: PythonEnv | null): string | null {
  return env ? path.join(path.dirname(env.pythonPath), RUFF) : null;
}

/** Whether `ruff` exists and the repository ships neither it nor, for one in an environment, any of that environment. */
async function isTrustedRuff(
  wtPath: string,
  ruff: string,
  envPath: string | null,
): Promise<boolean> {
  if (!(await Bun.file(ruff).exists())) return false;
  // Both checks treat a ruff removed meanwhile as shipped, so the next candidate gets its turn.
  const shipped = envPath
    ? await isEnvShippedByRepo(wtPath, envPath, ruff)
    : await isShippedByRepo(wtPath, ruff);
  if (shipped) log.warn("Ignoring a ruff binary tracked by git", { wtPath, ruff });
  return !shipped;
}

/**
 * The `major.minor.patch` that `ruff --version` reports, or null when it does not run. Probed where the
 * server will run, since a shim (pyenv, asdf) picks its ruff by directory and environment.
 */
async function ruffVersion(wtPath: string, ruff: string): Promise<string | null> {
  try {
    const proc = measureSpawn("ruff", () =>
      Bun.spawn([ruff, "--version"], {
        cwd: wtPath,
        env: buildSpawnEnv(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        timeout: VERSION_TIMEOUT_MS,
      }),
    );
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const match = /^ruff (\d+\.\d+\.\d+)/.exec(stdout.trim());
    return exitCode === 0 && match?.[1] ? match[1] : null;
  } catch {
    return null;
  }
}
