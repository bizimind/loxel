import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ServerWebSocket } from "bun";

import { LSP_REPLACED_CLOSE_CODE } from "@/api/ws-protocol";
import { isRecord } from "@/lib/is-record";

import { getGoEnv, goSpawnEnv, realpathOr, subscribeGoEnv, trustedGoTool } from "./go-env";
import { isSkippedGoDir } from "./go-formatter";
import {
  findGolangciConfig,
  type GolangciConfigVerdict,
  isFile,
  isGolangciConfigFile,
  judgeGolangciConfig,
} from "./golangci-lint-config";
import {
  type GolangciLintDiagnostic,
  type GolangciLintIssue,
  goplsReportsToo,
  toGolangciLintDiagnostic,
} from "./golangci-lint-diagnostics";
import { isSupportedGolangciLint, runGolangciLint } from "./golangci-lint-runner";
import { dirsUpToRoot } from "./language-formatter";
import { logger } from "./logger";
import { fileUri } from "./lsp-file-uri";
import { isRepoTrusted, onRepoTrustChange, reportRepoRestriction } from "./repo-trust";
import type { WorktreeLspServer } from "./server-state";
import { buildSpawnEnv } from "./shell-env";
import { isInside } from "./shipped-by-repo";

const log = logger.child("golangci-lint-lsp");

const GOLANGCI_LINT = process.platform === "win32" ? "golangci-lint.exe" : "golangci-lint";
/** Writes arriving together (a save with its format, a checkout) start one run. */
const CHECK_DELAY_MS = 1000;
/** Past this many changed packages (a checkout), a run covers the open files' packages only. */
const MAX_CHANGED_DIRS = 64;
const MAX_NOTICE_LENGTH = 600;
const GO_FILE = /\.go$/;
const MODULE_FILE = /^go\.(mod|sum|work)$/;
const PACKAGE_EXCLUDED = /^typechecking error: build constraints exclude all Go files in (.+)$/;

const REPO_TRUST_RESTRICTION = "golangci-lint doesn't run.";

/** `window/showMessage` types. */
const MESSAGE_TYPE = { error: 1, warning: 2 } as const;

// The same words for every worktree of a project, so the client shows each once.
const NOT_INSTALLED_NOTICE =
  "This project has a golangci-lint config, but Loxel found no golangci-lint v2 to run. Install " +
  "it from https://golangci-lint.run/docs/welcome/install/ so that it is on your PATH, outside " +
  "the project and not behind a version manager's shim, to see its diagnostics.";
const OLD_BINARY_NOTICE =
  "This project has a golangci-lint config, but the golangci-lint on your PATH is not v2.1 or a " +
  "later v2, which is what Loxel runs. Install that to see its diagnostics.";
const OLD_CONFIG_NOTICE =
  "This project's golangci-lint config is for v1, and Loxel runs v2. Run `golangci-lint migrate` " +
  "in a terminal to update it and see its diagnostics.";
const CUSTOM_CONFIG_NOTICE =
  "This project's golangci-lint config uses custom linters or a custom output, which Loxel does " +
  "not run. Run golangci-lint in a terminal to see its diagnostics.";
const UNREADABLE_CONFIG_NOTICE =
  "Loxel could not read this project's golangci-lint config, so it does not run it. Run " +
  "`golangci-lint config verify` in a terminal to see why.";

const CONFIG_NOTICES: Record<Exclude<GolangciConfigVerdict, "runnable">, string> = {
  custom: CUSTOM_CONFIG_NOTICE,
  unreadable: UNREADABLE_CONFIG_NOTICE,
  v1: OLD_CONFIG_NOTICE,
};

interface GolangciLintSession {
  ws: ServerWebSocket<unknown>;
  wtPath: string;
  /** The last answer for this worktree, to tell a change of trust from another repository's. */
  trusted: boolean;
  /** Open Go files, by absolute path. */
  openFiles: Set<string>;
  /** Package directories to check on the next run. */
  pending: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  /** What the last conclusive run covering each file reported on it. */
  reports: Map<string, GolangciLintDiagnostic[]>;
  notices: Set<string>;
  /** Stops the running tool when the session ends or trust goes. */
  abort: AbortController;
  unsubscribeGoEnv: () => void;
}

/** Package directories that one process checks: same working directory, same config. */
interface RunGroup {
  module: string;
  config: string;
  dirs: string[];
}

/**
 * golangci-lint diagnostics for Go projects configured for it, served as a language server on its
 * own route so they reach the editor through the ordinary client. golangci-lint has no language
 * server, so this one is in-process: it answers the handshake, follows which Go files are open, and
 * runs the machine's golangci-lint v2 ({@link runGolangciLint}) on saved files.
 *
 * It runs only in a trusted repository, on a config it accepts ({@link judgeGolangciConfig}). A run
 * covers the package directories of files that opened or changed, coalesced and debounced, with the
 * project's module as its working directory. A cold run can take gigabytes, so one runs at a time
 * across all worktrees.
 *
 * A run replaces diagnostics only for files in its own packages, and only when it got through: a
 * compile error hides issues in other packages, so a run that hit one leaves what was there.
 */
export class GolangciLintLspManager implements WorktreeLspServer {
  readonly name = "golangci-lint-lsp";
  private readonly sessions = new Map<ServerWebSocket<unknown>, GolangciLintSession>();
  private readonly sessionsByWorktree = new Map<string, GolangciLintSession>();
  private unsubscribeTrust: (() => void) | null = null;
  /** The end of the queue of runs. */
  private lastRun: Promise<void> = Promise.resolve();

  constructor(private readonly checkDelayMs = CHECK_DELAY_MS) {}

  createSession(ws: ServerWebSocket<unknown>, wtPath: string): void {
    this.destroySession(ws);
    const existing = this.sessionsByWorktree.get(wtPath);
    if (existing) {
      this.closeSession(existing);
      try {
        existing.ws.close(LSP_REPLACED_CLOSE_CODE, "Replaced by newer connection");
      } catch (err) {
        log.debug("close() on replaced WebSocket threw (already closed)", { error: err });
      }
    }
    let firstResolution = true;
    const session: GolangciLintSession = {
      ws,
      wtPath,
      trusted: isRepoTrusted(wtPath),
      openFiles: new Set(),
      pending: new Set(),
      timer: null,
      running: false,
      reports: new Map(),
      notices: new Set(),
      abort: new AbortController(),
      unsubscribeGoEnv: subscribeGoEnv(wtPath, ({ changed }) => {
        if (!firstResolution && changed) this.schedule(session, openDirs(session));
        firstResolution = false;
      }),
    };
    this.sessions.set(ws, session);
    this.sessionsByWorktree.set(wtPath, session);
    this.unsubscribeTrust ??= onRepoTrustChange(() => this.followTrust());
  }

  destroySession(ws: ServerWebSocket<unknown>): void {
    const session = this.sessions.get(ws);
    if (session) this.closeSession(session);
  }

  handleMessage(ws: ServerWebSocket<unknown>, data: string): void {
    const session = this.sessions.get(ws);
    if (!session) return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message.method !== "string") return;
    const { id, method, params } = message;
    if (typeof id === "number" || typeof id === "string") {
      this.answerRequest(session, id, method);
      return;
    }
    const uri = isRecord(params) && isRecord(params.textDocument) ? params.textDocument.uri : null;
    const file = typeof uri === "string" ? goFileOf(uri, session.wtPath) : null;
    if (!file) return;
    if (method === "textDocument/didOpen") {
      session.openFiles.add(file);
      this.schedule(session, [path.dirname(file)]);
    } else if (method === "textDocument/didClose") {
      session.openFiles.delete(file);
    }
  }

  notifyWatchedFilesChanged(wtPath: string, paths: readonly string[]): void {
    const session = this.sessionsByWorktree.get(wtPath);
    if (!session || session.openFiles.size === 0) return;
    const root = path.resolve(wtPath);
    const changed = paths.filter((file) => isInside(file, root));
    const projectChanged = changed.some(
      (file) => isGolangciConfigFile(file) || MODULE_FILE.test(path.basename(file)),
    );
    const changedDirs = new Set(
      changed.filter((file) => GO_FILE.test(file)).map((file) => path.dirname(file)),
    );
    const dirs = changedDirs.size > MAX_CHANGED_DIRS ? [] : [...changedDirs];
    if (projectChanged || changedDirs.size > MAX_CHANGED_DIRS) {
      // What it reported elsewhere may no longer hold either.
      dirs.push(...openDirs(session), ...[...session.reports.keys()].map((f) => path.dirname(f)));
    }
    this.schedule(session, dirs);
  }

  destroy(): void {
    for (const session of [...this.sessions.values()]) this.closeSession(session);
    this.unsubscribeTrust?.();
    this.unsubscribeTrust = null;
  }

  // ---------------------------------------------------------------------------

  private answerRequest(session: GolangciLintSession, id: number | string, method: string): void {
    if (method === "initialize") {
      // Only open and close matter: golangci-lint checks files as they are on disk.
      this.send(session, {
        id,
        result: {
          capabilities: { textDocumentSync: { openClose: true, change: 0 } },
          serverInfo: { name: "golangci-lint" },
        },
      });
    } else if (method === "shutdown") {
      this.send(session, { id, result: null });
    } else {
      this.send(session, { id, error: { code: -32601, message: `Unhandled method ${method}` } });
    }
  }

  private followTrust(): void {
    for (const session of this.sessions.values()) {
      const trusted = isRepoTrusted(session.wtPath);
      if (trusted === session.trusted) continue;
      session.trusted = trusted;
      if (trusted) {
        this.schedule(session, openDirs(session));
        continue;
      }
      // What it reported came from a run that would not start now.
      session.abort.abort();
      session.abort = new AbortController();
      session.pending.clear();
      this.clearDirs(
        session,
        [...session.reports.keys()].map((file) => path.dirname(file)),
      );
      this.schedule(session, openDirs(session));
    }
  }

  private schedule(session: GolangciLintSession, dirs: readonly string[]): void {
    if (dirs.length === 0 || !this.isLive(session)) return;
    if (!session.trusted) {
      if (dirs.some((dir) => findGolangciConfig(dir, session.wtPath))) {
        reportRepoRestriction(session.wtPath, REPO_TRUST_RESTRICTION);
      }
      return;
    }
    for (const dir of dirs) session.pending.add(dir);
    // The first change sets the time, so steady writes can't hold a run off for good.
    if (session.timer) return;
    session.timer = setTimeout(() => {
      session.timer = null;
      void this.runPending(session);
    }, this.checkDelayMs);
  }

  private async runPending(session: GolangciLintSession): Promise<void> {
    if (session.running) return;
    session.running = true;
    while (this.isLive(session) && session.trusted && session.pending.size > 0) {
      try {
        await this.inTurn(() => this.runNext(session));
      } catch (err) {
        log.error("golangci-lint run failed", { wtPath: session.wtPath, error: err });
      }
    }
    session.running = false;
  }

  /** Runs `task` after every earlier one, whichever worktree it belongs to. */
  private inTurn(task: () => Promise<void>): Promise<void> {
    const turn = this.lastRun.then(task);
    this.lastRun = turn.catch(() => undefined);
    return turn;
  }

  /** One run for the first group of what is pending now; the rest wait for their turn. */
  private async runNext(session: GolangciLintSession): Promise<void> {
    // Another repository at the same path changes the answer without a store event.
    this.followTrust();
    if (!this.isLive(session) || !session.trusted) return;
    const group = this.nextGroup(session);
    if (!group) return;
    for (const dir of group.dirs) session.pending.delete(dir);
    await this.check(session, group);
  }

  /**
   * The first group among the pending directories. One that can have no run is taken out here, and
   * what it had reported cleared: its package, config or module is gone.
   */
  private nextGroup(session: GolangciLintSession): RunGroup | null {
    let group: RunGroup | null = null;
    for (const dir of session.pending) {
      const module = moduleOf(dir, session.wtPath);
      const config = findGolangciConfig(dir, session.wtPath);
      if (!module || !config || !hasGoFiles(dir) || isSkippedGoDir(dir, session.wtPath)) {
        session.pending.delete(dir);
        this.clearDirs(session, [dir]);
        continue;
      }
      group ??= { module, config, dirs: [] };
      if (group.module === module && group.config === config) group.dirs.push(dir);
    }
    return group;
  }

  private async check(session: GolangciLintSession, group: RunGroup): Promise<void> {
    const { abort } = session;
    const [binary, go] = await Promise.all([
      trustedGoTool(session.wtPath, GOLANGCI_LINT),
      getGoEnv(session.wtPath),
    ]);
    if (abort.signal.aborted || !this.isLive(session)) return;
    if (!binary) {
      this.notify(session, MESSAGE_TYPE.warning, NOT_INSTALLED_NOTICE);
      this.clearDirs(session, group.dirs);
      return;
    }
    // gopls and the Go status item say what to do about Go itself.
    if (!go) {
      this.clearDirs(session, group.dirs);
      return;
    }
    const env = { ...buildSpawnEnv(), ...goSpawnEnv(session.wtPath, go) };
    const supported = await isSupportedGolangciLint(binary, env);
    if (abort.signal.aborted || !this.isLive(session)) return;
    if (!supported) {
      this.notify(session, MESSAGE_TYPE.warning, OLD_BINARY_NOTICE);
      this.clearDirs(session, group.dirs);
      return;
    }
    // Last, so that what runs is what was read, and trust is as of now.
    const verdict = judgeGolangciConfig(group.config);
    if (verdict !== "runnable") {
      this.notify(session, MESSAGE_TYPE.warning, CONFIG_NOTICES[verdict]);
      this.clearDirs(session, group.dirs);
      return;
    }
    if (!isRepoTrusted(session.wtPath)) return;
    const outcome = await runGolangciLint({
      binary,
      cwd: group.module,
      config: group.config,
      targets: group.dirs.map((dir) => packageArg(group.module, dir)),
      env,
      signal: abort.signal,
    });
    if (abort.signal.aborted || !this.isLive(session)) return;
    if (outcome.kind === "config-error") {
      log.warn("golangci-lint could not load its config", { config: group.config });
      const relative = path.relative(session.wtPath, group.config);
      this.notify(
        session,
        MESSAGE_TYPE.error,
        `golangci-lint could not run with ${relative}: ${outcome.message.slice(0, MAX_NOTICE_LENGTH)}`,
      );
      return;
    }
    if (outcome.kind !== "reported") return;
    const { issues, error } = outcome.report;
    const excluded = error === null ? undefined : PACKAGE_EXCLUDED.exec(error)?.[1];
    if (error !== null && excluded === undefined) {
      log.warn("golangci-lint stopped part of a run", { module: group.module, error });
      return;
    }
    // A compile error hides what other packages would report, and gopls shows the error itself.
    if (issues.some((issue) => issue.FromLinter === "typecheck")) return;
    const excludedDir = excluded === undefined ? undefined : realpathOr(excluded);
    const scope = group.dirs.filter((dir) => realpathOr(dir) !== excludedDir);
    await this.publishRun(session, scope, issues, abort.signal);
  }

  /** Make `issues` what the files in `dirs` report, and publish each that changes. */
  private async publishRun(
    session: GolangciLintSession,
    dirs: readonly string[],
    issues: readonly GolangciLintIssue[],
    signal: AbortSignal,
  ): Promise<void> {
    // Reported paths have no symlinks; the session's are as the client named them.
    const scope = new Map(dirs.map((dir) => [realpathOr(dir), dir]));
    const byFile = new Map<string, GolangciLintIssue[]>();
    for (const issue of issues) {
      const dir = scope.get(realpathOr(path.dirname(issue.Pos.Filename)));
      if (!dir || goplsReportsToo(issue)) continue;
      const file = path.join(dir, path.basename(issue.Pos.Filename));
      const list = byFile.get(file) ?? [];
      list.push(issue);
      byFile.set(file, list);
    }
    const diagnostics = await Promise.all(
      [...byFile].map(async ([file, list]) => {
        const lines = await readLines(file);
        return [file, list.map((issue) => toGolangciLintDiagnostic(issue, lines))] as const;
      }),
    );
    if (signal.aborted || !this.isLive(session)) return;
    this.clearDirs(session, dirs, new Set(byFile.keys()));
    for (const [file, list] of diagnostics) this.publish(session, file, list);
  }

  /** Clear what was reported on files in `dirs`, apart from `except`. */
  private clearDirs(
    session: GolangciLintSession,
    dirs: readonly string[],
    except?: ReadonlySet<string>,
  ): void {
    const cleared = new Set(dirs);
    for (const file of [...session.reports.keys()]) {
      if (cleared.has(path.dirname(file)) && !except?.has(file)) this.publish(session, file, []);
    }
  }

  private publish(
    session: GolangciLintSession,
    file: string,
    diagnostics: GolangciLintDiagnostic[],
  ): void {
    if (diagnostics.length > 0) session.reports.set(file, diagnostics);
    else session.reports.delete(file);
    this.send(session, {
      method: "textDocument/publishDiagnostics",
      params: { uri: fileUri(file), diagnostics },
    });
  }

  private notify(session: GolangciLintSession, type: number, message: string): void {
    if (session.notices.has(message)) return;
    session.notices.add(message);
    this.send(session, { method: "window/showMessage", params: { type, message } });
  }

  private closeSession(session: GolangciLintSession): void {
    this.sessions.delete(session.ws);
    if (this.sessionsByWorktree.get(session.wtPath) === session) {
      this.sessionsByWorktree.delete(session.wtPath);
    }
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    session.abort.abort();
    session.unsubscribeGoEnv();
  }

  private isLive(session: GolangciLintSession): boolean {
    return this.sessions.get(session.ws) === session;
  }

  private send(session: GolangciLintSession, message: Record<string, unknown>): void {
    try {
      session.ws.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
    } catch (err) {
      log.debug("send() on a closed golangci-lint WebSocket threw", { error: err });
    }
  }
}

function openDirs(session: GolangciLintSession): string[] {
  return [...new Set([...session.openFiles].map((file) => path.dirname(file)))];
}

/** The path of a Go file in the worktree; a config applies only to what is under it. */
function goFileOf(uri: string, wtPath: string): string | null {
  if (!uri.startsWith("file:")) return null;
  try {
    const file = fileURLToPath(uri);
    return GO_FILE.test(file) && isInside(file, path.resolve(wtPath)) ? file : null;
  } catch {
    return null;
  }
}

/** The nearest module above `dir`, where golangci-lint must run. */
function moduleOf(dir: string, wtPath: string): string | undefined {
  return dirsUpToRoot(dir, wtPath).find((candidate) => isFile(path.join(candidate, "go.mod")));
}

function hasGoFiles(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => GO_FILE.test(name));
  } catch {
    return false;
  }
}

/**
 * A package's directory as golangci-lint takes it: one package, since `./...` stops at nested
 * modules and a single file loses the rest of its package.
 */
function packageArg(module: string, dir: string): string {
  const relative = path.relative(module, dir);
  return relative ? `./${relative}/` : "./";
}

async function readLines(file: string): Promise<string[]> {
  try {
    return (await Bun.file(file).text()).split(/\r?\n/);
  } catch {
    return [];
  }
}
