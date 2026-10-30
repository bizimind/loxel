import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ServerWebSocket, Subprocess } from "bun";

import type { PythonEnv } from "@/api/python-env-model";
import { isRecord } from "@/lib/is-record";

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
import { readToml, recordAt } from "./toml-file";

/** Another type checker that owns type checking for some files (mypy, see `mypy-lsp-manager.ts`). */
export interface ExternalTypeChecker {
  /** Whether it type-checks `filePath` in `wtPath`, so basedpyright's own type errors are dropped there. */
  ownsTypeChecking(wtPath: string, filePath: string): boolean;
  /** Calls `listener` with a worktree whose answers may have changed; returns the unsubscribe. */
  onTypeCheckingChange(listener: (wtPath: string) => void): () => void;
}

/** Ids of the `workspace/diagnostic/refresh` requests sent to the client, whose answers are dropped. */
const REFRESH_ID_PREFIX = "loxel-diagnostic-refresh-";
/** The id of a JSON-RPC response written with `jsonrpc` and `id` first. */
const RESPONSE_ID = /^\{\s*"jsonrpc"\s*:\s*"2\.0"\s*,\s*"id"\s*:\s*(\d+|"(?:[^"\\]|\\.)*")/;
/** LSP `DiagnosticSeverity.Hint`. */
const HINT_SEVERITY = 4;

interface PythonLspSession extends WtLspSession {
  unsubscribeEnv: (() => void) | null;
  /** The interpreter last answered in `workspace/configuration`; undefined before the first. */
  answeredEnv: PythonEnv | null | undefined;
  /** Set once the client's `initialized` reached the server, after which config may be pushed. */
  initialized: boolean;
  /** The document of each `textDocument/diagnostic` request awaiting its report, by request id. */
  diagnosticRequests: Map<number | string, string>;
  /** Whether the external type checker owned each document when its last report was answered. */
  reportedOwnership: Map<string, boolean>;
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
 *
 * Where an {@link ExternalTypeChecker} type-checks a file (mypy, in projects configured for it),
 * basedpyright's own type errors for that file are dropped from its diagnostics reports, keeping
 * syntax errors and its unused, unreachable and deprecated hints, so the project's checker is the
 * only one reporting type errors while basedpyright still serves completion, hover, navigation and
 * refactors. A project that configures basedpyright or pyright itself keeps both.
 */
export class PythonLspManager extends StdioLspManager<PythonLspSession, WtLspContext> {
  protected override readonly forwardWatchedFiles = true;
  // basedpyright's snippets are method overrides, at most a selected `pass` as a tab stop, and hold
  // default values unescaped: inserted as snippets, `x="$HOME"` would become `x=""`.
  protected override readonly disableCompletionSnippets = true;
  private refreshCount = 0;

  constructor(private readonly typeChecker: ExternalTypeChecker | null = null) {
    super("python-lsp");
    typeChecker?.onTypeCheckingChange((wtPath) => this.refreshDiagnostics(wtPath));
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
      diagnosticRequests: new Map(),
      reportedOwnership: new Map(),
    };
    session.unsubscribeEnv = subscribePythonEnv(session.wtPath, ({ env, first }) => {
      if (!this.isSessionLive(session) || !session.initialized) return;
      // The first resolution is what the configuration answer waited for (or, not answered yet,
      // is waiting for); every later one may mean a different interpreter or packages installed
      // into the same one.
      if (
        first &&
        (session.answeredEnv === undefined || isSamePythonEnv(session.answeredEnv, env))
      ) {
        return;
      }
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

  protected override handleClientData(session: PythonLspSession, data: string): void {
    if (!this.typeChecker) {
      super.handleClientData(session, data);
      return;
    }
    // Most frames are none of these, and need no second parse.
    const message =
      data.includes("textDocument/diagnostic") ||
      data.includes("textDocument/didClose") ||
      data.includes(REFRESH_ID_PREFIX)
        ? parseRecord(data)
        : null;
    const { id, method, params } = message ?? {};
    // The client's answer to a refresh this manager asked for: basedpyright never sent one.
    if (method === undefined && typeof id === "string" && id.startsWith(REFRESH_ID_PREFIX)) return;
    const uri =
      isRecord(params) && isRecord(params.textDocument) ? params.textDocument.uri : undefined;
    if (method === "textDocument/didClose" && typeof uri === "string") {
      session.reportedOwnership.delete(uri);
    }
    if (
      method === "textDocument/diagnostic" &&
      (typeof id === "number" || typeof id === "string") &&
      isRecord(params) &&
      typeof uri === "string"
    ) {
      session.diagnosticRequests.set(id, uri);
      // basedpyright's "unchanged" answer would keep a report filtered under the other owner: ask
      // for the full one when the owner changed since the last report.
      const reported = session.reportedOwnership.get(uri);
      if ("previousResultId" in params && reported !== this.ownsTypeChecking(session, uri)) {
        delete params.previousResultId;
        super.handleClientData(session, JSON.stringify(message));
        return;
      }
    }
    super.handleClientData(session, data);
  }

  protected override handleServerFrame(session: PythonLspSession, body: string): void {
    super.handleServerFrame(session, this.withoutExternalTypeErrors(session, body));
  }

  /** `body` without basedpyright's type errors for files the external type checker owns. */
  private withoutExternalTypeErrors(session: PythonLspSession, body: string): string {
    if (!this.typeChecker || !this.mayCarryDiagnostics(session, body)) return body;
    const message = parseRecord(body);
    if (!message) return body;
    const { id, method, result, params } = message;
    if (method === undefined && (typeof id === "number" || typeof id === "string")) {
      const uri = session.diagnosticRequests.get(id);
      if (uri === undefined) return body;
      session.diagnosticRequests.delete(id);
      if (!isRecord(result) || !Array.isArray(result.items)) return body;
      const owned = this.ownsTypeChecking(session, uri);
      session.reportedOwnership.set(uri, owned);
      if (!owned) return body;
      result.items = result.items.filter(isKeptDiagnostic);
      return JSON.stringify(message);
    }
    if (
      method === "textDocument/publishDiagnostics" &&
      isRecord(params) &&
      typeof params.uri === "string" &&
      Array.isArray(params.diagnostics) &&
      this.ownsTypeChecking(session, params.uri)
    ) {
      params.diagnostics = params.diagnostics.filter(isKeptDiagnostic);
      return JSON.stringify(message);
    }
    return body;
  }

  /**
   * Whether `body` may be diagnostics to filter: pushed ones, or the answer to a pending pull,
   * told by the id at its start (basedpyright writes `jsonrpc` and `id` first), so completion and
   * semantic-token answers that arrive while a pull is pending are not parsed twice.
   */
  private mayCarryDiagnostics(session: PythonLspSession, body: string): boolean {
    if (body.includes("textDocument/publishDiagnostics")) return true;
    if (session.diagnosticRequests.size === 0) return false;
    const id = RESPONSE_ID.exec(body)?.[1];
    if (id === undefined) return true;
    const key: unknown = JSON.parse(id);
    return (
      (typeof key === "number" || typeof key === "string") && session.diagnosticRequests.has(key)
    );
  }

  private ownsTypeChecking(session: PythonLspSession, uri: string): boolean {
    let filePath: string;
    try {
      filePath = fileURLToPath(uri);
    } catch {
      return false;
    }
    return (
      this.typeChecker?.ownsTypeChecking(session.wtPath, filePath) === true &&
      !configuresPyright(session.wtPath)
    );
  }

  /**
   * Make the clients of `wtPath` pull basedpyright's diagnostics again, since which of them are
   * dropped changed. The answers to these requests are dropped in {@link handleClientData}.
   */
  private refreshDiagnostics(wtPath: string): void {
    for (const session of this.sessions.values()) {
      if (session.wtPath !== wtPath || !session.initialized || !this.isSessionLive(session)) {
        continue;
      }
      session.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: `${REFRESH_ID_PREFIX}${++this.refreshCount}`,
          method: "workspace/diagnostic/refresh",
        }),
      );
    }
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

/** Syntax errors carry no rule; hints (unused, unreachable, deprecated) are not type errors. */
function isKeptDiagnostic(diagnostic: unknown): boolean {
  if (!isRecord(diagnostic)) return true;
  return diagnostic.code === undefined || diagnostic.severity === HINT_SEVERITY;
}

function parseRecord(json: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(json);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** Each worktree's answer to {@link configuresPyright}, kept while its config files are unchanged. */
const pyrightConfigCache = new Map<string, { stamp: string; configured: boolean }>();

/**
 * Whether the project at `wtPath` configures basedpyright itself (`pyrightconfig.json`, or a
 * `[tool.basedpyright]` / `[tool.pyright]` table in `pyproject.toml`, at the root, where
 * basedpyright reads them), so it wants basedpyright's type errors even next to another checker.
 */
export function configuresPyright(wtPath: string): boolean {
  const pyrightconfig = path.join(wtPath, "pyrightconfig.json");
  const pyproject = path.join(wtPath, "pyproject.toml");
  const stamp = [pyrightconfig, pyproject].map(fileStamp).join("|");
  const cached = pyrightConfigCache.get(wtPath);
  if (cached?.stamp === stamp) return cached.configured;
  const tool = recordAt(readToml(pyproject), "tool");
  const configured =
    fileStamp(pyrightconfig) !== "" ||
    recordAt(tool, "basedpyright") !== undefined ||
    recordAt(tool, "pyright") !== undefined;
  pyrightConfigCache.set(wtPath, { stamp, configured });
  return configured;
}

function fileStamp(file: string): string {
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "";
  }
}
