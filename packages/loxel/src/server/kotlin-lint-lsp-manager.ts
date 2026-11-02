import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ServerWebSocket } from "bun";

import { LSP_REPLACED_CLOSE_CODE } from "@/api/ws-protocol";
import { isRecord } from "@/lib/is-record";

import { KTLINT_INSTALL_HINT } from "./kotlin-formatter";
import {
  findKotlinLintProjects,
  isKotlinLintSignalFile,
  type KotlinLintProject,
  type KotlinLintTool,
} from "./kotlin-lint-config";
import {
  type KotlinLintDiagnostic,
  type KotlinLintOutcome,
  runKotlinLint,
} from "./kotlin-lint-runner";
import { logger } from "./logger";
import { fileUri } from "./lsp-file-uri";
import type { WorktreeLspServer } from "./server-state";
import { isInside } from "./shipped-by-repo";

const log = logger.child("kotlin-lint-lsp");

/** Writes arriving together (a save with its format, a checkout) start one JVM. */
const CHECK_DELAY_MS = 500;
const KOTLIN_FILE = /\.kts?$/;
const INSTALL_HINTS: Record<KotlinLintTool, string> = {
  detekt: "brew install detekt",
  ktlint: KTLINT_INSTALL_HINT,
};

/** `window/showMessage` types. */
const MESSAGE_TYPE = { error: 1, warning: 2 } as const;

interface KotlinLintSession {
  ws: ServerWebSocket<unknown>;
  wtPath: string;
  /** Open Kotlin files, by absolute path. */
  openFiles: Set<string>;
  /** Open files to check on the next run. */
  pending: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  /** What each tool last reported, by file. */
  reports: Map<string, Map<KotlinLintTool, KotlinLintDiagnostic[]>>;
  /** Files with diagnostics published, so a run that no longer reports one clears it. */
  published: Set<string>;
  /** Config files in use, which may have any name. */
  configs: Set<string>;
  notices: Set<string>;
  /** Stops the running tool when the session ends. */
  abort: AbortController;
}

/**
 * detekt and ktlint diagnostics for Kotlin projects configured for them, served as a language server
 * on its own route so they reach the editor through the ordinary client. Neither tool has a language
 * server, so this one is in-process: it answers the handshake, follows which Kotlin files are open,
 * and runs the tools from the machine ({@link runKotlinLint}) on saved files.
 *
 * A JVM start per save is not free, so a run covers only open files: a file when it opens, an open
 * file when it changes on disk, and all open files when a config changes. A checkout of a thousand
 * files costs what its open files cost, and files that aren't open are never checked. Runs go one at
 * a time per worktree, one tool and project root after another, debounced, each with a timeout;
 * changes during a run wait for the next one.
 *
 * Which tools apply is read for every run ({@link findKotlinLintProjects}), so a project with no
 * signal starts no process and a config change needs no restart.
 */
export class KotlinLintLspManager implements WorktreeLspServer {
  readonly name = "kotlin-lint-lsp";
  private readonly sessions = new Map<ServerWebSocket<unknown>, KotlinLintSession>();
  private readonly sessionsByWorktree = new Map<string, KotlinLintSession>();

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
    const session: KotlinLintSession = {
      ws,
      wtPath,
      openFiles: new Set(),
      pending: new Set(),
      timer: null,
      running: false,
      reports: new Map(),
      published: new Set(),
      configs: new Set(),
      notices: new Set(),
      abort: new AbortController(),
    };
    this.sessions.set(ws, session);
    this.sessionsByWorktree.set(wtPath, session);
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
    const file = typeof uri === "string" ? kotlinFileOf(uri, session.wtPath) : null;
    if (!file) return;
    if (method === "textDocument/didOpen") {
      session.openFiles.add(file);
      this.schedule(session, [file]);
    } else if (method === "textDocument/didClose") {
      session.openFiles.delete(file);
      session.pending.delete(file);
      session.reports.delete(file);
      this.publish(session, file);
    }
  }

  notifyWatchedFilesChanged(wtPath: string, paths: readonly string[]): void {
    const session = this.sessionsByWorktree.get(wtPath);
    if (!session) return;
    const configChanged = paths.some(
      (file) => isKotlinLintSignalFile(file) || session.configs.has(file),
    );
    this.schedule(
      session,
      configChanged ? [...session.openFiles] : paths.filter((file) => session.openFiles.has(file)),
    );
  }

  destroy(): void {
    for (const session of [...this.sessions.values()]) this.closeSession(session);
  }

  // ---------------------------------------------------------------------------

  private answerRequest(session: KotlinLintSession, id: number | string, method: string): void {
    if (method === "initialize") {
      // Only open and close matter: the tools check files as they are on disk.
      this.send(session, {
        id,
        result: {
          capabilities: { textDocumentSync: { openClose: true, change: 0 } },
          serverInfo: { name: "Kotlin lint" },
        },
      });
    } else if (method === "shutdown") {
      this.send(session, { id, result: null });
    } else {
      this.send(session, { id, error: { code: -32601, message: `Unhandled method ${method}` } });
    }
  }

  private schedule(session: KotlinLintSession, files: readonly string[]): void {
    if (files.length === 0) return;
    for (const file of files) session.pending.add(file);
    // The first change sets the time, so steady writes to a file can't hold a run off for good.
    if (session.timer) return;
    session.timer = setTimeout(() => {
      session.timer = null;
      void this.runPending(session);
    }, CHECK_DELAY_MS);
  }

  private async runPending(session: KotlinLintSession): Promise<void> {
    if (session.running) return;
    session.running = true;
    try {
      while (this.isLive(session) && session.pending.size > 0) {
        const files = [...session.pending];
        session.pending.clear();
        await this.check(session, files);
      }
    } catch (err) {
      log.error("Kotlin lint run failed", { wtPath: session.wtPath, error: err });
    } finally {
      session.running = false;
    }
  }

  private async check(session: KotlinLintSession, files: string[]): Promise<void> {
    const groups = this.groupByProject(session, files);
    for (const { project, files: groupFiles } of groups) {
      // A file closed while an earlier tool ran has nothing left to show.
      const open = groupFiles.filter((file) => session.openFiles.has(file) && isFile(file));
      if (open.length === 0) continue;
      const outcome = await this.run(session, project, open);
      if (!this.isLive(session)) return;
      const diagnostics = outcome.kind === "reported" ? outcome.diagnostics : new Map();
      for (const file of open) {
        if (!session.openFiles.has(file)) continue;
        this.record(session, file, project.tool, diagnostics.get(file) ?? []);
      }
      this.tell(session, project, outcome);
    }
  }

  /** An unexpected error is one tool's failed run: the other tools and later files still run. */
  private async run(
    session: KotlinLintSession,
    project: KotlinLintProject,
    files: string[],
  ): Promise<KotlinLintOutcome> {
    try {
      return await runKotlinLint(project, files, session.wtPath, session.abort.signal);
    } catch (err) {
      log.error("Kotlin lint run failed", { tool: project.tool, root: project.root, error: err });
      return { kind: "failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** What to run for `files`, clearing what a tool that no longer applies reported on them. */
  private groupByProject(
    session: KotlinLintSession,
    files: readonly string[],
  ): { project: KotlinLintProject; files: string[] }[] {
    const groups = new Map<string, { project: KotlinLintProject; files: string[] }>();
    for (const file of files) {
      const projects = isFile(file) ? findKotlinLintProjects(file, session.wtPath) : [];
      const tools = new Set(projects.map((project) => project.tool));
      for (const tool of session.reports.get(file)?.keys() ?? []) {
        if (!tools.has(tool)) this.record(session, file, tool, []);
      }
      for (const project of projects) {
        if (project.tool === "detekt") {
          for (const config of project.configs) session.configs.add(config);
        }
        const key = JSON.stringify(project);
        const group = groups.get(key) ?? { project, files: [] };
        group.files.push(file);
        groups.set(key, group);
      }
    }
    return [...groups.values()];
  }

  private record(
    session: KotlinLintSession,
    file: string,
    tool: KotlinLintTool,
    diagnostics: KotlinLintDiagnostic[],
  ): void {
    const report = session.reports.get(file) ?? new Map<KotlinLintTool, KotlinLintDiagnostic[]>();
    report.set(tool, diagnostics);
    session.reports.set(file, report);
    this.publish(session, file);
  }

  /** Publish what all tools last reported on `file`, unless both sides are empty. */
  private publish(session: KotlinLintSession, file: string): void {
    const diagnostics = [...(session.reports.get(file)?.values() ?? [])].flat();
    if (diagnostics.length === 0 && !session.published.has(file)) return;
    if (diagnostics.length > 0) session.published.add(file);
    else session.published.delete(file);
    this.send(session, {
      method: "textDocument/publishDiagnostics",
      params: { uri: fileUri(file), diagnostics },
    });
  }

  private tell(
    session: KotlinLintSession,
    { tool, root }: KotlinLintProject,
    outcome: KotlinLintOutcome,
  ): void {
    if (outcome.kind === "not-installed") {
      this.notify(
        session,
        MESSAGE_TYPE.warning,
        `This project uses ${tool}, which is not on your PATH. Install it, for example with \`${INSTALL_HINTS[tool]}\`, to see its diagnostics.`,
      );
    } else if (outcome.kind === "no-java") {
      this.notify(
        session,
        MESSAGE_TYPE.warning,
        `${tool} needs Java, which is not on your PATH. Install a JDK and add it to your PATH to see its diagnostics.`,
      );
    } else if (outcome.kind === "failed") {
      const where = path.relative(session.wtPath, root) || "the worktree";
      log.warn("Kotlin lint tool failed", { tool, root, message: outcome.message });
      this.notify(
        session,
        MESSAGE_TYPE.error,
        `${tool} could not check ${where}: ${outcome.message}`,
      );
    }
  }

  private notify(session: KotlinLintSession, type: number, message: string): void {
    if (session.notices.has(message)) return;
    session.notices.add(message);
    this.send(session, { method: "window/showMessage", params: { type, message } });
  }

  private closeSession(session: KotlinLintSession): void {
    this.sessions.delete(session.ws);
    if (this.sessionsByWorktree.get(session.wtPath) === session) {
      this.sessionsByWorktree.delete(session.wtPath);
    }
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    session.abort.abort();
  }

  private isLive(session: KotlinLintSession): boolean {
    return this.sessions.get(session.ws) === session;
  }

  private send(session: KotlinLintSession, message: Record<string, unknown>): void {
    try {
      session.ws.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
    } catch (err) {
      log.debug("send() on a closed Kotlin lint WebSocket threw", { error: err });
    }
  }
}

/** The path of a Kotlin file in the worktree; a config applies only to what is under it. */
function kotlinFileOf(uri: string, wtPath: string): string | null {
  if (!uri.startsWith("file:")) return null;
  try {
    const file = fileURLToPath(uri);
    return KOTLIN_FILE.test(file) && isInside(file, path.resolve(wtPath)) ? file : null;
  } catch {
    return null;
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
