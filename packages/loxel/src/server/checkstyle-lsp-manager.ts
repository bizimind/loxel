import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ServerWebSocket } from "bun";

import { LSP_REPLACED_CLOSE_CODE } from "@/api/ws-protocol";
import { isRecord } from "@/lib/is-record";

import {
  CheckstyleDiscovery,
  mayAffectCheckstyle,
  type CheckstyleProject,
} from "./checkstyle-config";
import {
  type CheckstyleDiagnostic,
  type CheckstyleOutcome,
  checkstyleVersion,
  findCheckstyle,
  runCheckstyle,
} from "./checkstyle-runner";
import { subscribeJavaEnv } from "./java-env";
import { logger } from "./logger";
import { fileUri } from "./lsp-file-uri";
import { isRepoTrusted, onRepoTrustChange, reportRepoRestriction } from "./repo-trust";
import type { WorktreeLspServer } from "./server-state";
import { isInside } from "./shipped-by-repo";

const log = logger.child("checkstyle-lsp");

/** Writes arriving together (a save with its format, a checkout) start one JVM. */
const CHECK_DELAY_MS = 500;
const JAVA_FILE = /\.java$/;
const REPO_TRUST_RESTRICTION = "Checkstyle doesn't run.";

/** `window/showMessage` types. */
const MESSAGE_TYPE = { warning: 2 } as const;

interface CheckstyleSession {
  ws: ServerWebSocket<unknown>;
  wtPath: string;
  trusted: boolean;
  /** Open Java files, by absolute path. */
  openFiles: Set<string>;
  /** Open files to check on the next run. */
  pending: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  /** Files with diagnostics published, so a run that no longer reports one clears it. */
  published: Set<string>;
  discovery: CheckstyleDiscovery;
  /** Configs that failed to load, as their projects: not run again until something changes. */
  failedConfigs: Set<string>;
  /** Bumped when that set is cleared, so a run that started before doesn't add to it after. */
  configEpoch: number;
  notices: Set<string>;
  /** Stops the running tool when the session ends or trust goes away. */
  abort: AbortController;
  unsubscribeJdk: () => void;
}

/**
 * Checkstyle diagnostics for Java projects whose build runs it, served as a language server on its
 * own route so they reach the editor through the ordinary client. Checkstyle has no language server,
 * so this one is in-process: it answers the handshake, follows which Java files are open, and runs
 * the machine's `checkstyle` ({@link runCheckstyle}) on them as they are on disk.
 *
 * A JVM start per save is not free, so a run covers only open files: a file when it opens, an open
 * file when it changes on disk, and all open files when a build or config file changes. Runs go one
 * at a time per worktree, one project after another, debounced, each with a timeout; changes during
 * a run wait for the next one. A config that doesn't load is said once and not tried again until a
 * build or config file changes, or the JDKs do.
 *
 * It only runs in a trusted repository, and nothing in an untrusted one but reading build files.
 */
export class CheckstyleLspManager implements WorktreeLspServer {
  readonly name = "checkstyle-lsp";
  private readonly sessions = new Map<ServerWebSocket<unknown>, CheckstyleSession>();
  private readonly sessionsByWorktree = new Map<string, CheckstyleSession>();
  private unsubscribeTrust: (() => void) | null = null;

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
    const session: CheckstyleSession = {
      ws,
      wtPath,
      trusted: isRepoTrusted(wtPath),
      openFiles: new Set(),
      pending: new Set(),
      timer: null,
      running: false,
      published: new Set(),
      discovery: new CheckstyleDiscovery(wtPath),
      failedConfigs: new Set(),
      configEpoch: 0,
      notices: new Set(),
      abort: new AbortController(),
      // A new JDK can run what an older one could not. Asked for by the first run, not a change.
      unsubscribeJdk: subscribeJavaEnv(wtPath, ({ first, changed }) => {
        if (first || !changed) return;
        forgetFailures(session);
        this.schedule(session, [...session.openFiles]);
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
    const file = typeof uri === "string" ? javaFileOf(uri, session.wtPath) : null;
    if (!file) return;
    if (method === "textDocument/didOpen") {
      session.openFiles.add(file);
      this.schedule(session, [file]);
    } else if (method === "textDocument/didClose") {
      session.openFiles.delete(file);
      session.pending.delete(file);
      this.publish(session, file, []);
    }
  }

  notifyWatchedFilesChanged(wtPath: string, paths: readonly string[]): void {
    const session = this.sessionsByWorktree.get(wtPath);
    if (!session) return;
    if (paths.some(mayAffectCheckstyle)) {
      session.discovery.clear();
      forgetFailures(session);
      this.schedule(session, [...session.openFiles]);
      return;
    }
    this.schedule(
      session,
      paths.filter((file) => session.openFiles.has(file)),
    );
  }

  destroy(): void {
    for (const session of [...this.sessions.values()]) this.closeSession(session);
    this.unsubscribeTrust?.();
    this.unsubscribeTrust = null;
  }

  // ---------------------------------------------------------------------------

  private answerRequest(session: CheckstyleSession, id: number | string, method: string): void {
    if (method === "initialize") {
      // Only open and close matter: Checkstyle checks files as they are on disk.
      this.send(session, {
        id,
        result: {
          capabilities: { textDocumentSync: { openClose: true, change: 0 } },
          serverInfo: { name: "Checkstyle" },
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
      if (!trusted) {
        // What it reported came from a run that would not start now.
        session.abort.abort();
        session.abort = new AbortController();
        session.pending.clear();
        for (const file of [...session.published]) this.publish(session, file, []);
      }
      session.discovery.clear();
      forgetFailures(session);
      this.schedule(session, [...session.openFiles]);
    }
  }

  private schedule(session: CheckstyleSession, files: readonly string[]): void {
    if (files.length === 0 || !this.isLive(session)) return;
    if (!session.trusted) {
      void this.reportHeldBack(session, files);
      return;
    }
    for (const file of files) session.pending.add(file);
    // The first change sets the time, so steady writes to a file can't hold a run off for good.
    if (session.timer) return;
    session.timer = setTimeout(() => {
      session.timer = null;
      void this.runPending(session);
    }, this.checkDelayMs);
  }

  /** Ask for trust only when it would help: a build runs Checkstyle and the machine has it. */
  private async reportHeldBack(
    session: CheckstyleSession,
    files: readonly string[],
  ): Promise<void> {
    if (!files.some((file) => session.discovery.projectFor(file))) return;
    const tool = await findCheckstyle(session.wtPath);
    if (this.isLive(session) && !session.trusted && "executable" in tool) {
      reportRepoRestriction(session.wtPath, REPO_TRUST_RESTRICTION);
    }
  }

  private async runPending(session: CheckstyleSession): Promise<void> {
    if (session.running) return;
    session.running = true;
    try {
      while (this.isLive(session) && session.trusted && session.pending.size > 0) {
        const files = [...session.pending];
        session.pending.clear();
        await this.check(session, files);
      }
    } catch (err) {
      log.error("Checkstyle run failed", { wtPath: session.wtPath, error: err });
    } finally {
      session.running = false;
    }
  }

  private async check(session: CheckstyleSession, files: readonly string[]): Promise<void> {
    // Trust going away replaces this, and ends the batch whichever project it has reached.
    const { signal } = session.abort;
    for (const { project, key, files: group } of this.groupByProject(session, files)) {
      if (signal.aborted) return;
      if (session.failedConfigs.has(key)) continue;
      const open = group.filter((file) => session.openFiles.has(file));
      if (open.length === 0) continue;
      const epoch = session.configEpoch;
      const outcome = await this.run(session, project, open, signal);
      if (!this.isLive(session) || signal.aborted) return;
      this.apply(session, open, outcome);
      if (outcome.kind === "config-failed" && epoch === session.configEpoch) {
        session.failedConfigs.add(key);
      }
      await this.tell(session, project, outcome, signal);
    }
  }

  /** An unexpected error is one failed run: the later projects still run. */
  private async run(
    session: CheckstyleSession,
    project: CheckstyleProject,
    files: string[],
    signal: AbortSignal,
  ): Promise<CheckstyleOutcome> {
    try {
      return await runCheckstyle(project, files, session.wtPath, signal);
    } catch (err) {
      log.error("Checkstyle run failed", { root: project.dir, error: err });
      return { kind: "failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** What to run for `files`; a file no project checks has what it last showed cleared. */
  private groupByProject(
    session: CheckstyleSession,
    files: readonly string[],
  ): { project: CheckstyleProject; key: string; files: string[] }[] {
    const groups = new Map<string, { project: CheckstyleProject; key: string; files: string[] }>();
    for (const file of files) {
      // A file gone from disk, by a branch switch, would leave Checkstyle nothing to report on.
      const project = isFile(file) ? session.discovery.projectFor(file) : null;
      if (!project) {
        this.publish(session, file, []);
        continue;
      }
      const key = JSON.stringify(project);
      const group = groups.get(key) ?? { project, key, files: [] };
      group.files.push(file);
      groups.set(key, group);
    }
    return [...groups.values()];
  }

  private apply(
    session: CheckstyleSession,
    files: readonly string[],
    outcome: CheckstyleOutcome,
  ): void {
    if (outcome.kind === "reported") {
      for (const file of files) {
        if (session.openFiles.has(file)) {
          this.publish(session, file, outcome.diagnostics.get(file) ?? []);
        }
      }
      return;
    }
    if (outcome.kind === "stopped") return;
    // Nothing was checked, so what is showing can't be vouched for.
    for (const file of files) this.publish(session, file, []);
  }

  private async tell(
    session: CheckstyleSession,
    project: CheckstyleProject,
    outcome: CheckstyleOutcome,
    signal: AbortSignal,
  ): Promise<void> {
    if (outcome.kind === "reported" || outcome.kind === "stopped") return;
    const build = path.relative(session.wtPath, project.buildFile);
    // The same words for every project of a worktree and every worktree, so it is said once.
    if (outcome.kind === "not-installed") {
      this.notify(
        session,
        "This project uses Checkstyle, which is not on your PATH. Install it, for example with `brew install checkstyle`, to see its diagnostics.",
      );
    } else if (outcome.kind === "shim-only") {
      this.notify(
        session,
        `"checkstyle" on your PATH is a version manager's shim, which Loxel doesn't run. Add the tool's own directory to your PATH to see its diagnostics.`,
      );
    } else if (outcome.kind === "no-java") {
      this.notify(session, "Checkstyle needs Java. Install a JDK to see its diagnostics.");
    } else if (outcome.kind === "needs-newer-java") {
      this.notify(
        session,
        "Checkstyle needs a newer JDK than any Loxel found. Install one to see its diagnostics.",
      );
    } else if (outcome.kind === "config-failed") {
      log.warn("Checkstyle could not load a config", { build, message: outcome.message });
      const notice = await this.configFailureNotice(session, project, outcome.message, signal);
      if (!signal.aborted) this.notify(session, notice);
    } else {
      log.warn("Checkstyle failed", { build, message: outcome.message });
      this.notify(session, `Checkstyle could not check ${build}'s files: ${outcome.message}`);
    }
  }

  private async configFailureNotice(
    session: CheckstyleSession,
    project: CheckstyleProject,
    message: string,
    signal: AbortSignal,
  ): Promise<string> {
    const { config } = project;
    const where =
      config.kind === "file"
        ? path.relative(session.wtPath, config.path)
        : path.relative(session.wtPath, project.buildFile);
    const version = await checkstyleVersion(session.wtPath, signal);
    const pin = project.pinnedVersion;
    const named = version ? `Checkstyle ${version}` : "Checkstyle";
    const pinned = pin && pin !== version ? ` This project pins Checkstyle ${pin}.` : "";
    const sentence = /[.!?…]$/.test(message) ? message : `${message}.`;
    return `${named} could not load ${where}: ${sentence}${pinned}`;
  }

  /** Publish `diagnostics` for `file`, unless it had none and still has none. */
  private publish(
    session: CheckstyleSession,
    file: string,
    diagnostics: readonly CheckstyleDiagnostic[],
  ): void {
    if (diagnostics.length === 0 && !session.published.has(file)) return;
    if (diagnostics.length > 0) session.published.add(file);
    else session.published.delete(file);
    this.send(session, {
      method: "textDocument/publishDiagnostics",
      params: { uri: fileUri(file), diagnostics },
    });
  }

  private notify(session: CheckstyleSession, message: string): void {
    if (session.notices.has(message)) return;
    session.notices.add(message);
    this.send(session, {
      method: "window/showMessage",
      params: { type: MESSAGE_TYPE.warning, message },
    });
  }

  private closeSession(session: CheckstyleSession): void {
    this.sessions.delete(session.ws);
    if (this.sessionsByWorktree.get(session.wtPath) === session) {
      this.sessionsByWorktree.delete(session.wtPath);
    }
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    session.abort.abort();
    session.unsubscribeJdk();
  }

  private isLive(session: CheckstyleSession): boolean {
    return this.sessions.get(session.ws) === session;
  }

  private send(session: CheckstyleSession, message: Record<string, unknown>): void {
    try {
      session.ws.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
    } catch (err) {
      log.debug("send() on a closed Checkstyle WebSocket threw", { error: err });
    }
  }
}

function forgetFailures(session: CheckstyleSession): void {
  session.failedConfigs.clear();
  session.configEpoch += 1;
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The path of a Java file in the worktree; a build applies only to what is under it. */
function javaFileOf(uri: string, wtPath: string): string | null {
  if (!uri.startsWith("file:")) return null;
  try {
    const file = fileURLToPath(uri);
    return JAVA_FILE.test(file) && isInside(file, path.resolve(wtPath)) ? file : null;
  } catch {
    return null;
  }
}
