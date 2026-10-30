import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ServerWebSocket } from "bun";

import type { PythonEnv } from "@/api/python-env-model";
import { LSP_REPLACED_CLOSE_CODE } from "@/api/ws-protocol";
import { isRecord } from "@/lib/is-record";

import { logger } from "./logger";
import { fileUri } from "./lsp-file-uri";
import { coversFile, findMypyConfig, isMypyConfigFile, type MypyConfig } from "./mypy-config";
import { MypyDaemon, type MypyDiagnostic } from "./mypy-daemon";
import {
  getPythonEnv,
  isEnvShippedByRepo,
  isShippedByRepo,
  pathOutsideWorktree,
  subscribePythonEnv,
} from "./python-env";
import { pythonEnvActivation, setPythonEnvVars } from "./python-env-activation";
import type { ExternalTypeChecker } from "./python-lsp-manager";
import { buildSpawnEnv } from "./shell-env";

const log = logger.child("mypy-lsp");

const DMYPY = process.platform === "win32" ? "dmypy.exe" : "dmypy";
/** Changes arriving together (a save, a checkout) are checked once. */
const CHECK_DELAY_MS = 200;
/** A failure notice longer than this is cut; the log has all of it. */
const MAX_NOTICE_LENGTH = 600;
const PYTHON_FILE = /\.pyi?$/;

/** `window/showMessage` types. */
const MESSAGE_TYPE = { error: 1, warning: 2 } as const;

/** One mypy config root with open files, and the daemon checking it. */
interface MypyProject {
  config: MypyConfig;
  /**
   * `active` once its daemon can run, until a check fails; `failing` after a check mypy could not
   * run, until one succeeds; `unavailable` when the environment has no usable mypy. Only an
   * `active` project owns type checking, so basedpyright's type errors return otherwise.
   */
  state: "pending" | "active" | "failing" | "unavailable";
  daemon: MypyDaemon | null;
  /** The open files it checks, as of the last {@link MypyLspManager.syncProjects}. */
  openFiles: Set<string>;
  /** What its last check reported, by file. */
  diagnostics: Map<string, MypyDiagnostic[]>;
  timer: ReturnType<typeof setTimeout> | null;
  checking: boolean;
  /** A check was asked for while one ran. */
  recheck: boolean;
  /** Bumped on every setup and on disposal, so a stale setup's outcome is dropped. */
  generation: number;
  /** The last notice shown for it, so the same one is not repeated until something changes. */
  notice: string | null;
}

interface MypySession {
  ws: ServerWebSocket<unknown>;
  wtPath: string;
  /** Open Python files, by absolute path. */
  openFiles: Set<string>;
  /** By config directory. */
  projects: Map<string, MypyProject>;
  /** Files with diagnostics published, so a check that no longer reports one clears it. */
  published: Set<string>;
  unsubscribeEnv: (() => void) | null;
}

/**
 * mypy diagnostics for Python projects configured for mypy, served as a language server on its own
 * route, so they reach the editor (markers, and anything else that reads the client's
 * diagnostics) through the same client pipeline as every other server's. mypy has no language
 * server, so this one is in-process: it answers the LSP handshake, follows which Python files are
 * open, and runs the project's own mypy daemon ({@link MypyDaemon}) from the worktree's resolved
 * Python environment, publishing what it reports with the source `mypy` and error-code links.
 *
 * Each open file belongs to the mypy config nearest to it ({@link findMypyConfig}); each config
 * root gets one daemon, started when its first file opens and stopped when its last one closes or
 * the session ends. A root whose config names its targets (`files`, `modules`, `packages`) is
 * checked as configured, the way the project's CI runs mypy; any other is checked on its open
 * files. A check runs when files open or close and when Python files under the root change on disk
 * (saves, checkouts, agents' edits, as watched files); a change to a config file or the Python
 * environment restarts the daemons. Setup problems (mypy not installed, a config error) are shown
 * once each as `window/showMessage`. Where two roots report on the same file (a config whose
 * `files` reach into a nested project), the file gets both roots' diagnostics.
 *
 * While a root's daemon checks successfully, it is the project's type checker for the files it
 * checks: {@link ownsTypeChecking} tells basedpyright's manager to drop basedpyright's own
 * type-checking diagnostics for them.
 */
export class MypyLspManager implements ExternalTypeChecker {
  private readonly sessions = new Map<ServerWebSocket<unknown>, MypySession>();
  private readonly sessionsByWorktree = new Map<string, MypySession>();
  private readonly typeCheckingListeners = new Set<(wtPath: string) => void>();

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
    const session: MypySession = {
      ws,
      wtPath,
      openFiles: new Set(),
      projects: new Map(),
      published: new Set(),
      unsubscribeEnv: null,
    };
    session.unsubscribeEnv = subscribePythonEnv(wtPath, ({ first }) => {
      // The first resolution is the one each project's setup waits for.
      if (!first) this.restartProjects(session, () => true);
    });
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
    const file = typeof uri === "string" ? filePathOf(uri) : null;
    if (!file || !PYTHON_FILE.test(file)) return;
    if (method === "textDocument/didOpen") {
      session.openFiles.add(file);
      this.syncProjects(session);
    } else if (method === "textDocument/didClose") {
      session.openFiles.delete(file);
      this.syncProjects(session);
    }
  }

  /**
   * Re-check the projects of a worktree for changed files, reported by its file watcher: Python
   * files under a project root are re-checked, and a changed config file restarts its project
   * (and may move open files to another config).
   */
  notifyWatchedFilesChanged(wtPath: string, paths: readonly string[]): void {
    const session = this.sessionsByWorktree.get(wtPath);
    if (!session) return;
    const configDirs = new Set(paths.filter(isMypyConfigFile).map((file) => path.dirname(file)));
    if (configDirs.size > 0) {
      this.restartProjects(session, (project) => configDirs.has(project.config.dir));
      this.syncProjects(session);
    }
    for (const project of session.projects.values()) {
      const root = project.config.dir + path.sep;
      if (paths.some((file) => PYTHON_FILE.test(file) && file.startsWith(root))) {
        this.scheduleCheck(session, project);
      }
    }
  }

  destroy(): void {
    for (const session of [...this.sessions.values()]) this.closeSession(session);
  }

  ownsTypeChecking(wtPath: string, filePath: string): boolean {
    const session = this.sessionsByWorktree.get(wtPath);
    if (!session) return false;
    const config = findMypyConfig(filePath, wtPath);
    if (!config || session.projects.get(config.dir)?.state !== "active") return false;
    return coversFile(config, filePath);
  }

  onTypeCheckingChange(listener: (wtPath: string) => void): () => void {
    this.typeCheckingListeners.add(listener);
    return () => this.typeCheckingListeners.delete(listener);
  }

  // ---------------------------------------------------------------------------

  private answerRequest(session: MypySession, id: number | string, method: string): void {
    if (method === "initialize") {
      // Only open and close matter: mypy checks files as they are on disk.
      this.send(session, {
        id,
        result: {
          capabilities: { textDocumentSync: { openClose: true, change: 0 } },
          serverInfo: { name: "mypy" },
        },
      });
    } else if (method === "shutdown") {
      this.send(session, { id, result: null });
    } else {
      this.send(session, { id, error: { code: -32601, message: `Unhandled method ${method}` } });
    }
  }

  /**
   * Bring the session's projects in line with its open files: a project for every config root
   * with an open file, none for a root without. A project checked on its open files is checked
   * again when they change, and so is one whose config changed what it checks.
   */
  private syncProjects(session: MypySession): void {
    const wanted = new Map<string, { config: MypyConfig; files: Set<string> }>();
    for (const file of session.openFiles) {
      const config = findMypyConfig(file, session.wtPath);
      if (!config) continue;
      const entry = wanted.get(config.dir) ?? { config, files: new Set<string>() };
      entry.files.add(file);
      wanted.set(config.dir, entry);
    }
    for (const [dir, project] of session.projects) {
      if (!wanted.has(dir)) this.disposeProject(session, project);
    }
    for (const [dir, { config, files }] of wanted) {
      const project = session.projects.get(dir);
      if (!project) {
        const created = createProject(config, files);
        session.projects.set(dir, created);
        void this.setUp(session, created);
        continue;
      }
      const targetsChanged = config.hasTargets !== project.config.hasTargets;
      const filesChanged = !config.hasTargets && !sameSet(files, project.openFiles);
      project.config = config;
      project.openFiles = files;
      if (targetsChanged || filesChanged) this.scheduleCheck(session, project);
    }
  }

  /** Stop the daemons of the projects `which` selects and set them up again. */
  private restartProjects(session: MypySession, which: (project: MypyProject) => boolean): void {
    for (const project of session.projects.values()) {
      if (!which(project)) continue;
      project.daemon?.stop();
      project.daemon = null;
      void this.setUp(session, project);
    }
  }

  /** Find the environment's mypy for `project` and, when it can run, check the project. */
  private async setUp(session: MypySession, project: MypyProject): Promise<void> {
    const generation = ++project.generation;
    const env = await getPythonEnv(session.wtPath);
    const dmypy = await usableDmypy(session.wtPath, env);
    const spawnEnv = dmypy && env ? await activatedEnv(session.wtPath, env) : null;
    if (project.generation !== generation || !this.isLive(session)) return;
    if (!dmypy || !env || !spawnEnv) {
      this.setState(session, project, "unavailable");
      // What an earlier daemon reported is stale now.
      this.publish(session, project, new Map());
      // The same words for every worktree of a project, so the client shows it once.
      this.notify(
        session,
        project,
        MESSAGE_TYPE.warning,
        `mypy is configured in ${this.relative(session, project.config.file)} but is not installed ` +
          "in the worktree's Python environment. Install it there to see mypy's diagnostics; " +
          "until then basedpyright checks types.",
      );
      return;
    }
    project.daemon = new MypyDaemon({
      root: project.config.dir,
      dmypy,
      pythonPath: env.pythonPath,
      env: spawnEnv,
    });
    this.setState(session, project, "active");
    this.scheduleCheck(session, project);
  }

  private scheduleCheck(session: MypySession, project: MypyProject): void {
    if (!project.daemon) return;
    if (project.timer) clearTimeout(project.timer);
    project.timer = setTimeout(() => {
      project.timer = null;
      void this.check(session, project);
    }, CHECK_DELAY_MS);
  }

  private async check(session: MypySession, project: MypyProject): Promise<void> {
    if (project.checking) {
      project.recheck = true;
      return;
    }
    const { daemon } = project;
    if (!daemon || !this.isLive(session)) return;
    project.checking = true;
    try {
      await this.runCheck(session, project, daemon);
    } catch (err) {
      log.error("mypy check failed", { root: project.config.dir, error: err });
    } finally {
      project.checking = false;
    }
    if (project.recheck && project.daemon) {
      project.recheck = false;
      await this.check(session, project);
    }
  }

  private async runCheck(
    session: MypySession,
    project: MypyProject,
    daemon: MypyDaemon,
  ): Promise<void> {
    const { config } = project;
    const targets = config.hasTargets
      ? []
      : [...project.openFiles].map((file) => path.relative(config.dir, file));
    if (!config.hasTargets && targets.length === 0) {
      this.publish(session, project, new Map());
      return;
    }
    const result = await daemon.run(targets);
    // Stopped meanwhile (restarted, closed): its successor publishes.
    if (!result || project.daemon !== daemon || !this.isLive(session)) return;
    this.publish(session, project, result.diagnostics);
    if (result.failure === null) {
      project.notice = null;
      this.setState(session, project, "active");
      return;
    }
    // Until mypy checks again, basedpyright's type errors are better than none.
    this.setState(session, project, "failing");
    const failure =
      result.failure.length > MAX_NOTICE_LENGTH
        ? `${result.failure.slice(0, MAX_NOTICE_LENGTH)}…`
        : result.failure;
    const where = path.relative(session.wtPath, config.dir) || "the worktree";
    this.notify(session, project, MESSAGE_TYPE.error, `mypy could not check ${where}: ${failure}`);
  }

  /**
   * Make `diagnostics` the project's report and publish each file it or the previous report
   * names, with every project's diagnostics for that file.
   */
  private publish(
    session: MypySession,
    project: MypyProject,
    diagnostics: Map<string, MypyDiagnostic[]>,
  ): void {
    const files = new Set([...project.diagnostics.keys(), ...diagnostics.keys()]);
    project.diagnostics = diagnostics;
    if (!this.isLive(session)) return;
    for (const file of files) {
      const list = [...session.projects.values()].flatMap((p) => p.diagnostics.get(file) ?? []);
      if (list.length === 0 && !session.published.has(file)) continue;
      if (list.length > 0) session.published.add(file);
      else session.published.delete(file);
      this.send(session, {
        method: "textDocument/publishDiagnostics",
        params: { uri: fileUri(file), diagnostics: list },
      });
    }
  }

  private notify(session: MypySession, project: MypyProject, type: number, message: string): void {
    if (project.notice === message) return;
    project.notice = message;
    this.send(session, { method: "window/showMessage", params: { type, message } });
  }

  private setState(session: MypySession, project: MypyProject, state: MypyProject["state"]): void {
    if (project.state === state) return;
    const wasActive = project.state === "active";
    project.state = state;
    if (wasActive !== (state === "active")) this.emitTypeCheckingChange(session.wtPath);
  }

  private disposeProject(session: MypySession, project: MypyProject): void {
    project.generation++;
    if (project.timer) clearTimeout(project.timer);
    project.timer = null;
    project.daemon?.stop();
    project.daemon = null;
    session.projects.delete(project.config.dir);
    this.publish(session, project, new Map());
    if (project.state === "active") this.emitTypeCheckingChange(session.wtPath);
  }

  private closeSession(session: MypySession): void {
    this.sessions.delete(session.ws);
    if (this.sessionsByWorktree.get(session.wtPath) === session) {
      this.sessionsByWorktree.delete(session.wtPath);
    }
    session.unsubscribeEnv?.();
    session.unsubscribeEnv = null;
    for (const project of [...session.projects.values()]) this.disposeProject(session, project);
  }

  private isLive(session: MypySession): boolean {
    return this.sessions.get(session.ws) === session;
  }

  private emitTypeCheckingChange(wtPath: string): void {
    for (const listener of this.typeCheckingListeners) listener(wtPath);
  }

  private relative(session: MypySession, file: string): string {
    return path.relative(session.wtPath, file);
  }

  private send(session: MypySession, message: Record<string, unknown>): void {
    try {
      session.ws.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
    } catch (err) {
      log.debug("send() on a closed mypy WebSocket threw", { error: err });
    }
  }
}

function createProject(config: MypyConfig, openFiles: Set<string>): MypyProject {
  return {
    config,
    state: "pending",
    daemon: null,
    openFiles,
    diagnostics: new Map(),
    timer: null,
    checking: false,
    recheck: false,
    generation: 0,
    notice: null,
  };
}

function filePathOf(uri: string): string | null {
  if (!uri.startsWith("file:")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((item) => b.has(item));
}

/**
 * The `dmypy` next to the environment's interpreter, when it exists and passes the environment
 * trust rule (the whole environment, or the single file for one outside any environment).
 */
async function usableDmypy(wtPath: string, env: PythonEnv | null): Promise<string | null> {
  if (!env) return null;
  const dmypy = path.join(path.dirname(env.pythonPath), DMYPY);
  if (!(await Bun.file(dmypy).exists())) return null;
  const shipped = env.envPath
    ? await isEnvShippedByRepo(wtPath, env.envPath, dmypy)
    : await isShippedByRepo(wtPath, dmypy);
  if (shipped) {
    log.warn("Ignoring a dmypy tracked by git", { wtPath, dmypy });
    return null;
  }
  return dmypy;
}

/** The spawn environment with `env` activated, or null when it must not be activated. */
async function activatedEnv(
  wtPath: string,
  env: PythonEnv,
): Promise<Record<string, string | undefined> | null> {
  const spawnEnv: Record<string, string | undefined> = buildSpawnEnv();
  // Nothing mypy runs by name (an interpreter it infers from `python_version`) may come from the
  // worktree; activation then puts the trusted environment's `bin` first.
  spawnEnv.PATH = pathOutsideWorktree(spawnEnv.PATH ?? "", wtPath);
  // An interpreter outside any environment (a system Python) needs no activation.
  if (!env.envPath) return spawnEnv;
  const activation = await pythonEnvActivation(env, wtPath);
  if (!activation) return null;
  setPythonEnvVars(spawnEnv, activation, { virtualEnv: true });
  return spawnEnv;
}
