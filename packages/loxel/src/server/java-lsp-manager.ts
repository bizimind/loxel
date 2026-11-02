import {
  existsSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { JavaRuntime } from "@/api/java-env-model";
import { LSP_RESTART_CLOSE_CODE } from "@/api/ws-protocol";
import { isRecord } from "@/lib/is-record";

import { config, hash12 } from "./config";
import { getJavaEnv, javaExecutable, listJavaRuntimes, subscribeJavaEnv } from "./java-env";
import {
  applyImportSignal,
  findBuildProjects,
  gradleClientFlags,
  importJavaToolOptions,
  importSignal,
  type ImportPlan,
  type ImportState,
  isProjectFile,
  MAX_SCANNED_DIRS,
  mayCarryImportSignal,
  NOT_PROJECT_DIRS,
  onJavaProjectsReload,
  planImport,
  projectIssue,
  setJavaProjectIssue,
  stopGradleDaemons,
  trustedImportSettings,
} from "./java-project-import";
import { logger } from "./logger";
import { fileUri } from "./lsp-file-uri";
import { isRepoTrusted } from "./repo-trust";
import { buildSpawnEnv } from "./shell-env";
import { isInside } from "./shipped-by-repo";
import {
  type SpawnOptions,
  WorktreeLspManager,
  type WtLspContext,
  type WtLspSession,
} from "./stdio-lsp-manager";

const JDTLS_STATE_DIR = path.join(config.stateDir, "jdtls");

/** Settings every session starts with: Maven and Gradle project import stay off. */
const JAVA_SETTINGS = {
  import: { maven: { enabled: false }, gradle: { enabled: false }, exclusions: ["**"] },
  autobuild: { enabled: false },
  telemetry: { enabled: false },
  // Their commands are the client's own in VS Code; Loxel has none to run.
  referencesCodeLens: { enabled: false },
  implementationCodeLens: "none",
};

/** What jdtls itself runs on. A project on an older Java also needs a JDK of its own level. */
const JDTLS_MIN_JAVA = 25;
const NO_JDK_REASON = `Java needs JDK ${JDTLS_MIN_JAVA} or newer for its language server. Install one alongside your project's JDK.`;
/** Longest a new server waits for the previous one to let go of its workspace directory. */
const PREVIOUS_SERVER_EXIT_TIMEOUT_MS = 10_000;

/** The id of the import request the manager sends itself, whose answer the client never sees. */
const PROJECT_IMPORT_REQUEST_ID = "loxel-project-import";

/** The client command behind the actions that need a prompt Loxel does not have. */
const PROMPT_COMMAND = "java.action.applyRefactoringCommand";
/** Offered without an edit or a command, so choosing it would do nothing. */
const EMPTY_ACTION_TITLE = "Ignore compiler problem(s)";

/** What jdtls pulls per file, to indent the code it generates. */
const TAB_SIZE_SECTION = "java.format.tabSize";
const INSERT_SPACES_SECTION = "java.format.insertSpaces";

/** The bundled server, next to `loxel-server` or, in development, in `build/`. */
function resolveBundledJdtls(): string | null {
  for (const dir of [
    path.dirname(process.execPath),
    path.resolve(import.meta.dir, "../../build"),
  ]) {
    const home = path.join(dir, "jdtls");
    if (Bun.file(path.join(home, sharedConfigDir(), "config.ini")).size) return home;
  }
  return null;
}

/** Writable per-version OSGi configuration; the bundled `config_*` is read-only in a signed app. */
function jdtlsConfigurationDir(home: string): string {
  const core = readdirSync(path.join(home, "plugins")).find((name) =>
    name.startsWith("org.eclipse.jdt.ls.core_"),
  );
  if (!core) throw new Error(`Incomplete jdtls at ${home}`);
  return path.join(JDTLS_STATE_DIR, "configuration", core);
}

/**
 * The last error of the newest log in `dir` written since `sinceMs`: a JVM that cannot start writes
 * only there, and the directory holds the logs of earlier runs too.
 */
export function latestLogMessage(dir: string, sinceMs: number): string | null {
  try {
    const logs = readdirSync(dir)
      .filter((name) => name.endsWith(".log"))
      .map((name) => path.join(dir, name))
      .filter((file) => statSync(file).mtimeMs >= sinceMs)
      .toSorted((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (!logs[0]) return null;
    const messages = readFileSync(logs[0], "utf8").match(/^!MESSAGE .*$/gm);
    return messages?.at(-1)?.slice("!MESSAGE ".length) ?? null;
  } catch {
    return null;
  }
}

export interface JdtlsPaths {
  home: string;
  configuration: string;
  data: string;
  hosts: string;
}

/** Where the Gradle daemons of a worktree's server register, inside its workspace directory. */
function gradleDaemonDir(data: string): string {
  return path.join(data, "gradle-daemons");
}

/** The JVM command line, what `bin/jdtls.py` would run plus Loxel's own flags. */
export function jdtlsArgs(
  { home, configuration, data, hosts }: JdtlsPaths,
  repoTrusted = false,
): readonly string[] {
  const plugins = path.join(home, "plugins");
  const launcher = readdirSync(plugins).find((name) =>
    name.startsWith("org.eclipse.equinox.launcher_"),
  );
  if (!launcher) throw new Error(`Incomplete jdtls at ${home}`);
  return [
    "-Declipse.application=org.eclipse.jdt.ls.core.id1",
    "-Dosgi.bundles.defaultStartLevel=4",
    "-Declipse.product=org.eclipse.jdt.ls.core.product",
    "-Dosgi.checkConfiguration=true",
    `-Dosgi.sharedConfiguration.area=${path.join(home, sharedConfigDir())}`,
    "-Dosgi.sharedConfiguration.area.readOnly=true",
    "-Dosgi.configuration.cascaded=true",
    "-Djava.import.generatesMetadataFilesAtProjectRoot=false",
    // The server makes no network requests: no host name resolves but localhost.
    `-Djdk.net.hosts.file=${hosts}`,
    ...(repoTrusted ? gradleClientFlags(gradleDaemonDir(data)) : []),
    "-Djdk.xml.maxGeneralEntitySizeLimit=0",
    "-Djdk.xml.totalEntitySizeLimit=0",
    // A crash report would otherwise land in the working directory.
    `-XX:ErrorFile=${path.join(data, "hs_err_%p.log")}`,
    // A loaded project's model and its dependencies' indexes take more than a folder of files.
    repoTrusted ? "-Xmx2G" : "-Xmx1G",
    // Gives memory back when idle, since each worktree has its own server.
    "-XX:+UseParallelGC",
    "-XX:GCTimeRatio=4",
    "-XX:AdaptiveSizePolicyWeight=90",
    "--add-modules=ALL-SYSTEM",
    "--add-opens",
    "java.base/java.util=ALL-UNNAMED",
    "--add-opens",
    "java.base/java.lang=ALL-UNNAMED",
    "-jar",
    path.join(plugins, launcher),
    "-configuration",
    configuration,
    "-data",
    data,
  ];
}

function sharedConfigDir(): string {
  const arm = process.arch === "arm64" ? "_arm" : "";
  if (process.platform === "darwin") return `config_mac${arm}`;
  if (process.platform === "win32") return "config_win";
  return `config_linux${arm}`;
}

/**
 * The workspace directory of a worktree's server, keyed by path: same-named projects collide. A
 * trusted server's is its own, since a workspace keeps the projects it imported from then on.
 */
export function jdtlsDataDir(wtPath: string, repoTrusted = false): string {
  return path.join(JDTLS_STATE_DIR, repoTrusted ? "data-trusted" : "data", hash12(wtPath));
}

/** Forget a trusted server's workspace directory, after the daemons listed in it. */
async function deleteTrustedJdtlsData(wtPath: string): Promise<void> {
  const data = jdtlsDataDir(wtPath, true);
  await stopGradleDaemons(gradleDaemonDir(data));
  rmSync(data, { recursive: true, force: true });
}

/** Forget a removed worktree's workspace directories. */
export function deleteJdtlsData(wtPath: string): void {
  try {
    rmSync(jdtlsDataDir(wtPath), { recursive: true, force: true });
    void deleteTrustedJdtlsData(wtPath).catch((err: unknown) => {
      logger.child("java-lsp").debug("Deleting the workspace directory failed", { error: err });
    });
  } catch (err) {
    // Its server may still be writing; `onSessionClosed` deletes it once the server exits.
    logger.child("java-lsp").debug("Deleting the workspace directory failed", { error: err });
  }
}

/**
 * A Java file of the worktree, as shallow as possible. jdtls infers a folder's source root from the
 * first file it hears about, and `initialize` comes before any file is open. Symbolic links are not
 * followed, and an unreadable folder is skipped.
 */
export async function firstJavaFile(wtPath: string): Promise<string | null> {
  const queue = [wtPath];
  for (let i = 0; i < queue.length && i < MAX_SCANNED_DIRS; i++) {
    const dir = queue[i] ?? "";
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".java"))
        return fileUri(path.join(dir, entry.name));
      if (entry.isDirectory() && !entry.name.startsWith(".") && !NOT_PROJECT_DIRS.has(entry.name)) {
        queue.push(path.join(dir, entry.name));
      }
    }
  }
  return null;
}

/** The indentation a Java file uses, from its first indented line, skipping `*` comment lines. */
export function indentationOf(text: string): { tabSize: number; insertSpaces: boolean } | null {
  for (const line of text.split("\n")) {
    const indent = /^[\t ]+(?=[^\s*])/.exec(line)?.[0];
    if (!indent) continue;
    return indent.startsWith("\t")
      ? { tabSize: 4, insertSpaces: false }
      : { tabSize: indent.length, insertSpaces: true };
  }
  return null;
}

/**
 * The initialize response without `workspace.fileOperations.willRename`: jdtls's rename already
 * carries the edits `workspace/willRenameFiles` would return, so the client would apply them twice.
 */
export function dropWillRename(message: Record<string, unknown>): boolean {
  const { result } = message;
  if (!isRecord(result) || !isRecord(result.capabilities)) return false;
  const { workspace } = result.capabilities;
  if (!isRecord(workspace) || !isRecord(workspace.fileOperations)) return false;
  return delete workspace.fileOperations.willRename;
}

/** Drop the code actions from a response that Loxel could not carry out. */
export function dropUnusableActions(message: Record<string, unknown>): boolean {
  if (!Array.isArray(message.result)) return false;
  const usable = message.result.filter((action: unknown) => {
    if (!isRecord(action)) return true;
    if (action.title === EMPTY_ACTION_TITLE) return false;
    const { command } = action;
    return !(isRecord(command) && command.command === PROMPT_COMMAND);
  });
  if (usable.length === message.result.length) return false;
  message.result = usable;
  return true;
}

/** Whether a JDK's home is in the worktree, by real paths. A path that cannot be read counts. */
export function isJdkInWorktree(home: string, wtPath: string): boolean {
  try {
    return isInside(realpathSync(home), realpathSync(wtPath));
  } catch {
    return true;
  }
}

/** Whether one of `runtimes` can run the server. */
export function canRunJdtls(runtimes: readonly JavaRuntime[]): boolean {
  return runtimes.some((runtime) => runtime.majorVersion >= JDTLS_MIN_JAVA);
}

/** A JDK that can run the server appeared or went; the first look (`before` null) is neither. */
export function jdtlsHostCrossed(before: boolean | null, now: boolean): boolean {
  return before !== null && before !== now;
}

/** An entry of `java.configuration.runtimes`. */
export interface JavaRuntimeSetting {
  name: string;
  path: string;
  sources?: string;
  default?: true;
}

/**
 * One runtime per Java level, for projects at each level to compile against, each with its sources
 * where the JDK has them, which is where hover documentation comes from. `runtimes` is newest first;
 * `chosen`, the worktree's JDK, takes its level's place and is the default.
 */
export function javaRuntimesSetting(
  runtimes: readonly JavaRuntime[],
  chosen: JavaRuntime | null,
): JavaRuntimeSetting[] {
  const byLevel = new Map<number, JavaRuntime>();
  for (const runtime of runtimes) {
    if (!byLevel.has(runtime.majorVersion)) byLevel.set(runtime.majorVersion, runtime);
  }
  if (chosen) byLevel.set(chosen.majorVersion, chosen);
  return [...byLevel.values()].map((runtime) => {
    const { majorVersion, path: home } = runtime;
    const setting: JavaRuntimeSetting = {
      name: majorVersion === 8 ? "JavaSE-1.8" : `JavaSE-${majorVersion}`,
      path: home,
    };
    // Java 8 keeps them at the top of the JDK.
    const sources = path.join(home, ...(majorVersion === 8 ? [] : ["lib"]), "src.zip");
    if (existsSync(sources)) setting.sources = sources;
    if (chosen?.path === home) setting.default = true;
    return setting;
  });
}

/** The settings of a session, as `initialize` and `workspace/didChangeConfiguration` carry them. */
export function javaSettings(runtimes: readonly JavaRuntimeSetting[]): Record<string, unknown> {
  return { ...JAVA_SETTINGS, configuration: { runtimes } };
}

/** {@link javaSettings} for a trusted repository, where Maven and Gradle projects load. */
export function trustedJavaSettings(
  wtPath: string,
  plan: ImportPlan,
  runtimes: readonly JavaRuntimeSetting[],
): Record<string, unknown> {
  const trusted = trustedImportSettings(wtPath, plan, runtimes);
  const { configuration } = trusted;
  return {
    ...JAVA_SETTINGS,
    ...trusted,
    configuration: { ...(isRecord(configuration) ? configuration : {}), runtimes },
  };
}

/**
 * Manages Eclipse JDT LS child processes, one per worktree. The server is bundled and runs on the
 * newest JDK of the user's that is new enough, which is never a project's to choose. Maven and
 * Gradle projects load only in a trusted repository, from what is already on the machine, and
 * neither the server nor Gradle downloads anything; see `docs/languages/java.md`.
 */
export class JavaLspManager extends WorktreeLspManager {
  protected override readonly forwardWatchedFiles = true;
  protected override readonly repoTrustRestriction = "Maven and Gradle projects aren't loaded.";
  // Generated sources are read by jdtls but usually ignored by git.
  protected override readonly watchedIgnoredGlobs = [
    "**/target/generated-sources/**",
    "**/target/generated-test-sources/**",
    "**/build/generated/**",
  ];

  /** By worktree: the file `initialize` names, found while the session's frames are held. */
  private readonly triggerFiles = new Map<string, string | null>();
  /** By worktree: the settings of the server being started, and the last ones pushed to it. */
  private readonly runtimeSettings = new Map<string, JavaRuntimeSetting[]>();
  /** Each session's subscription to the machine's JDKs. */
  private readonly jdkSubscriptions = new Map<WtLspSession, () => void>();
  /** By worktree: when its server was last started, to tell its log from earlier ones. */
  private readonly startedAt = new Map<string, number>();
  /** By worktree: the exit of its closed server, until that server is gone. */
  private readonly exiting = new Map<string, Promise<unknown>>();
  /** By worktree, when trusted: what can be imported right now. */
  private readonly importPlans = new Map<string, ImportPlan>();
  /** Each trusted session's import, as the server has reported it so far. */
  private readonly importStates = new Map<WtLspSession, ImportState>();
  private readonly closedSessions = new WeakSet<WtLspSession>();
  /** Each trusted session's handling of changed project files, one at a time. */
  private readonly projectFollowers = new WeakMap<WtLspSession, Promise<void>>();

  constructor() {
    super("java-lsp");
    onJavaProjectsReload((wtPath) => this.restart(wtPath, "Reloading projects; reconnect"));
  }

  private restart(wtPath: string, reason: string): void {
    for (const [ws, session] of [...this.sessions]) {
      if (session.wtPath !== wtPath) continue;
      this.detach(ws);
      ws.close(LSP_RESTART_CLOSE_CODE, reason);
    }
  }

  protected async resolveBinary(context: WtLspContext): Promise<string | null> {
    this.startedAt.delete(context.wtPath);
    // A workspace directory takes one server at a time, and a replaced server is still exiting.
    const previous = this.exiting.get(context.wtPath);
    if (previous) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        previous,
        new Promise((resolve) => {
          timer = setTimeout(resolve, PREVIOUS_SERVER_EXIT_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    this.triggerFiles.set(context.wtPath, await firstJavaFile(context.wtPath));
    const { java, runtimes } = await this.findJdks(context);
    this.runtimeSettings.set(context.wtPath, runtimes);
    if (context.repoTrusted) {
      const projects = await findBuildProjects(context.wtPath);
      this.importPlans.set(context.wtPath, planImport(context.wtPath, projects, buildSpawnEnv()));
    }
    return resolveBundledJdtls() && java;
  }

  /** The `java` to run the server on, by absolute path, and the runtimes to give it. */
  private async findJdks({
    wtPath,
    repoTrusted,
  }: WtLspContext): Promise<{ java: string | null; runtimes: JavaRuntimeSetting[] }> {
    const [runtimes, chosen] = await Promise.all([listJavaRuntimes(wtPath), getJavaEnv(wtPath)]);
    const host = runtimes.find(
      (runtime) =>
        runtime.majorVersion >= JDTLS_MIN_JAVA &&
        (repoTrusted || !isJdkInWorktree(runtime.path, wtPath)),
    );
    return {
      java: host ? javaExecutable(host.path) : null,
      runtimes: javaRuntimesSetting(runtimes, chosen),
    };
  }

  protected override spawnArgs(context: WtLspContext): readonly string[] {
    const home = resolveBundledJdtls();
    if (!home) throw new Error("jdtls is not bundled");
    const configuration = jdtlsConfigurationDir(home);
    const data = jdtlsDataDir(context.wtPath, context.repoTrusted);
    const hosts = path.join(JDTLS_STATE_DIR, "hosts");
    mkdirSync(configuration, { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(hosts, "127.0.0.1 localhost\n");
    this.startedAt.set(context.wtPath, Date.now());
    return jdtlsArgs({ home, configuration, data, hosts }, context.repoTrusted);
  }

  protected override serverFailureReason(context: WtLspContext): string | null {
    const home = resolveBundledJdtls();
    if (!home) return "The Java language server is missing from this build of Loxel";
    // No server was started, so there is no log of its own to read.
    if (!this.startedAt.has(context.wtPath)) return NO_JDK_REASON;
    const message = latestLogMessage(
      jdtlsConfigurationDir(home),
      this.startedAt.get(context.wtPath) ?? 0,
    );
    return message ? `Java language server: ${message}` : null;
  }

  protected override spawnOptions(context: WtLspContext): SpawnOptions {
    return {
      // Not the worktree: nothing in it is read through the working directory.
      cwd: jdtlsDataDir(context.wtPath, context.repoTrusted),
      // Options from the user's shell don't reach the server's JVM.
      env: {
        JAVA_TOOL_OPTIONS: context.repoTrusted
          ? importJavaToolOptions(path.join(JDTLS_STATE_DIR, "hosts"))
          : "",
        JDK_JAVA_OPTIONS: "",
        _JAVA_OPTIONS: "",
      },
    };
  }

  protected override getInitializationOptions(session: WtLspSession): Record<string, unknown> {
    const trigger = this.triggerFiles.get(session.wtPath);
    return {
      settings: { java: this.settingsOf(session) },
      ...(trigger ? { triggerFiles: [trigger] } : {}),
    };
  }

  protected override onSessionClosed(session: WtLspSession): void {
    // Fired again as the process exits, when a new server may already be running here.
    if (this.closedSessions.has(session)) return;
    this.closedSessions.add(session);
    const { proc, repoTrusted, wtPath } = session;
    this.jdkSubscriptions.get(session)?.();
    this.jdkSubscriptions.delete(session);
    this.importStates.delete(session);
    if (repoTrusted) setJavaProjectIssue(wtPath, null);
    const exited = proc.exited.then(async () => {
      // Gradle's daemons outlive the server that started them.
      if (repoTrusted) await stopGradleDaemons(gradleDaemonDir(jdtlsDataDir(wtPath, true)));
      if (repoTrusted && !isRepoTrusted(wtPath)) await deleteTrustedJdtlsData(wtPath);
      if (this.exiting.get(wtPath) === exited) this.exiting.delete(wtPath);
      // The worktree went away while its server ran, which could write until it stopped.
      if (!existsSync(wtPath)) deleteJdtlsData(wtPath);
    });
    this.exiting.set(wtPath, exited);
  }

  protected override onClientInitialized(session: WtLspSession): void {
    this.pushSettings(session);
    this.reportProjects(session);
    // The first update also reports the JDKs read a moment ago; only a difference is pushed.
    this.jdkSubscriptions.set(
      session,
      subscribeJavaEnv(session.wtPath, () => void this.followJdks(session)),
    );
    void getJavaEnv(session.wtPath);
  }

  // Stopping Gradle's daemons, which would otherwise wait out their idle timeout, comes after this.
  override async destroy(): Promise<void> {
    await super.destroy();
    await Promise.all(this.exiting.values());
  }

  /** Give a running server the JDKs installed, removed or chosen since it started. */
  private async followJdks(session: WtLspSession): Promise<void> {
    const { runtimes } = await this.findJdks(session);
    const previous = this.runtimeSettings.get(session.wtPath);
    if (JSON.stringify(runtimes) === JSON.stringify(previous)) return;
    this.runtimeSettings.set(session.wtPath, runtimes);
    if (!this.isSessionLive(session)) return;
    const chosen = (settings?: JavaRuntimeSetting[]) => settings?.find((r) => r.default)?.path;
    const gradle =
      session.repoTrusted && this.importPlans.get(session.wtPath)?.projects.gradleRoots;
    // Gradle's daemon runs on the chosen JDK, and jdtls checks that only as it starts.
    if (gradle && gradle.length > 0 && chosen(runtimes) !== chosen(previous)) {
      this.restart(session.wtPath, "The JDK changed; reconnect");
      return;
    }
    this.pushSettings(session);
  }

  private settingsOf({ repoTrusted, wtPath }: WtLspSession): Record<string, unknown> {
    const runtimes = this.runtimeSettings.get(wtPath) ?? [];
    const plan = this.importPlans.get(wtPath);
    return repoTrusted && plan
      ? trustedJavaSettings(wtPath, plan, runtimes)
      : javaSettings(runtimes);
  }

  private pushSettings(session: WtLspSession): void {
    const java = this.settingsOf(session);
    this.writeToStdin(
      session,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "workspace/didChangeConfiguration",
        params: { settings: { java } },
      }),
    );
  }

  protected override async workspaceConfiguration(
    session: WtLspSession,
    section: string | undefined,
    scopeUri: string | undefined,
  ): Promise<unknown> {
    if ((section !== TAB_SIZE_SECTION && section !== INSERT_SPACES_SECTION) || !scopeUri)
      return null;
    if (!scopeUri.startsWith("file:")) return null;
    const file = fileURLToPath(scopeUri);
    if (!file.startsWith(session.wtPath + path.sep)) return null;
    const indentation = indentationOf(await readFile(file, "utf8").catch(() => ""));
    if (!indentation) return null;
    return section === TAB_SIZE_SECTION ? indentation.tabSize : indentation.insertSpaces;
  }

  /** Tell the user what a trusted repository's projects need, as far as anyone knows yet. */
  private reportProjects(session: WtLspSession): void {
    const plan = this.importPlans.get(session.wtPath);
    if (!session.repoTrusted || !plan) return;
    setJavaProjectIssue(session.wtPath, projectIssue(plan, this.importStateOf(session)));
  }

  private importStateOf(session: WtLspSession): ImportState {
    const state = this.importStates.get(session) ?? {
      statusOk: null,
      incompatible: null,
      buildFileErrors: new Map(),
    };
    this.importStates.set(session, state);
    return state;
  }

  // Generated sources only mean something to a server that loads projects.
  override notifyIgnoredPathChanged(wtPath: string, relPath: string): void {
    const sessions = [...this.sessions.values()];
    if (sessions.some((s) => s.wtPath === wtPath && s.repoTrusted)) {
      super.notifyIgnoredPathChanged(wtPath, relPath);
    }
  }

  override notifyWatchedFilesChanged(wtPath: string, paths: readonly string[]): void {
    super.notifyWatchedFilesChanged(wtPath, paths);
    if (!paths.some(isProjectFile)) return;
    for (const session of this.sessions.values()) {
      if (session.wtPath !== wtPath || !session.repoTrusted) continue;
      const previous = this.projectFollowers.get(session) ?? Promise.resolve();
      const next = previous.then(() => this.followProjects(session));
      this.projectFollowers.set(
        session,
        next.catch((err: unknown) => {
          // The worktree may be going away: its removal changes its build files too.
          this.log.debug("Could not follow the worktree's projects", { error: err });
        }),
      );
    }
  }

  /**
   * A wrapper changed or a build file came or went, with `git checkout` or an agent. jdtls follows
   * the projects it knows, and needs asking to import a new one.
   */
  private async followProjects(session: WtLspSession): Promise<void> {
    const { wtPath } = session;
    const previous = this.importPlans.get(wtPath);
    // The first settings go out with `initialized`, and jdtls takes nothing before them.
    if (!previous || !this.jdkSubscriptions.has(session)) return;
    const projects = await findBuildProjects(wtPath);
    const plan = planImport(wtPath, projects, buildSpawnEnv());
    this.importPlans.set(wtPath, plan);
    if (!this.isSessionLive(session)) return;
    this.reportProjects(session);
    const blocked = (p: ImportPlan) => JSON.stringify(p.blocked.map(({ root }) => root));
    if (blocked(plan) !== blocked(previous)) this.pushSettings(session);
    const stillBlocked = new Set(plan.blocked.map(({ root }) => root));
    const released = previous.blocked.some(({ root }) => !stillBlocked.has(root));
    if (!released && !projects.dirs.some((dir) => !previous.projects.dirs.includes(dir))) return;
    this.writeToStdin(
      session,
      JSON.stringify({
        jsonrpc: "2.0",
        id: PROJECT_IMPORT_REQUEST_ID,
        method: "workspace/executeCommand",
        params: { command: "java.project.import", arguments: [] },
      }),
    );
  }

  /** Keep what the user is told in step with what a frame says about a trusted repo's import. */
  private trackImport(session: WtLspSession, body: string): void {
    const plan = this.importPlans.get(session.wtPath);
    if (!session.repoTrusted || !plan || !mayCarryImportSignal(body)) return;
    // A closed server's last frames can't speak for the one that follows it.
    if (!this.isSessionLive(session)) return;
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      return;
    }
    const signal = isRecord(message) ? importSignal(message) : null;
    if (!signal) return;
    applyImportSignal(this.importStateOf(session), signal);
    this.reportProjects(session);
  }

  protected override handleServerFrame(session: WtLspSession, body: string): void {
    if (body.includes(`"id":"${PROJECT_IMPORT_REQUEST_ID}"`)) return;
    this.trackImport(session, body);
    if (
      !body.includes('"willRename"') &&
      !body.includes(PROMPT_COMMAND) &&
      !body.includes(EMPTY_ACTION_TITLE)
    ) {
      super.handleServerFrame(session, body);
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      super.handleServerFrame(session, body);
      return;
    }
    if (isRecord(message) && (dropWillRename(message) || dropUnusableActions(message))) {
      super.handleServerFrame(session, JSON.stringify(message));
      return;
    }
    super.handleServerFrame(session, body);
  }
}
