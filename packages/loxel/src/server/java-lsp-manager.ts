import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isRecord } from "@/lib/is-record";

import { config, hash12 } from "./config";
import { logger } from "./logger";
import { fileUri } from "./lsp-file-uri";
import {
  type SpawnOptions,
  WorktreeLspManager,
  type WtLspContext,
  type WtLspSession,
} from "./stdio-lsp-manager";

const JDTLS_STATE_DIR = path.join(config.stateDir, "jdtls");

/** Settings every session starts with: Maven and Gradle project import stay off. */
export const JAVA_SETTINGS = {
  import: { maven: { enabled: false }, gradle: { enabled: false }, exclusions: ["**"] },
  autobuild: { enabled: false },
  telemetry: { enabled: false },
  // Their commands are the client's own in VS Code; Loxel has none to run.
  referencesCodeLens: { enabled: false },
  implementationCodeLens: "none",
};

/** Directories never worth starting from when looking for a Java file. */
const NOT_SOURCE_DIRS = new Set(["node_modules", "build", "target", "out", "bin"]);
/** Where looking for a Java file stops, in a repository with none near the top. */
const MAX_SCANNED_DIRS = 20_000;
/** Longest a new server waits for the previous one to let go of its workspace directory. */
const PREVIOUS_SERVER_EXIT_TIMEOUT_MS = 10_000;

/** The client command behind the actions that need a prompt Loxel does not have. */
const PROMPT_COMMAND = "java.action.applyRefactoringCommand";
/** Offered without an edit or a command, so choosing it would do nothing. */
const EMPTY_ACTION_TITLE = "Ignore compiler problem(s)";

/** What jdtls pulls per file, to indent the code it generates. */
const TAB_SIZE_SECTION = "java.format.tabSize";
const INSERT_SPACES_SECTION = "java.format.insertSpaces";

interface BundledJdtls {
  java: string;
  home: string;
}

/** The bundled runtime and server, next to `loxel-server` or, in development, in `build/`. */
function resolveBundledJdtls(): BundledJdtls | null {
  const java = process.platform === "win32" ? "java.exe" : "java";
  for (const dir of [
    path.dirname(process.execPath),
    path.resolve(import.meta.dir, "../../build"),
  ]) {
    const javaPath = path.join(dir, "jdtls-runtime", "bin", java);
    const home = path.join(dir, "jdtls");
    if (
      Bun.file(javaPath).size &&
      Bun.file(path.join(home, sharedConfigDir(), "config.ini")).size
    ) {
      return { java: javaPath, home };
    }
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

/** The JVM command line, what `bin/jdtls.py` would run plus Loxel's own flags. */
export function jdtlsArgs({ home, configuration, data, hosts }: JdtlsPaths): readonly string[] {
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
    "-Djdk.xml.maxGeneralEntitySizeLimit=0",
    "-Djdk.xml.totalEntitySizeLimit=0",
    // A crash report would otherwise land in the working directory.
    `-XX:ErrorFile=${path.join(data, "hs_err_%p.log")}`,
    "-Xmx1G",
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

/** The workspace directory of a worktree's server, keyed by path: same-named projects collide. */
export function jdtlsDataDir(wtPath: string): string {
  return path.join(JDTLS_STATE_DIR, "data", hash12(wtPath));
}

/** Forget a removed worktree's workspace directory. */
export function deleteJdtlsData(wtPath: string): void {
  try {
    rmSync(jdtlsDataDir(wtPath), { recursive: true, force: true });
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
      if (entry.isDirectory() && !entry.name.startsWith(".") && !NOT_SOURCE_DIRS.has(entry.name)) {
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

/**
 * Manages Eclipse JDT LS child processes, one per worktree, running on the bundled Java runtime.
 * Maven and Gradle project import is off and the server makes no network requests; see
 * `docs/languages/java.md`.
 */
export class JavaLspManager extends WorktreeLspManager {
  protected override readonly forwardWatchedFiles = true;

  /** By worktree: the file `initialize` names, found while the session's frames are held. */
  private readonly triggerFiles = new Map<string, string | null>();
  /** By worktree: when its server was last started, to tell its log from earlier ones. */
  private readonly startedAt = new Map<string, number>();
  /** By worktree: the exit of its closed server, until that server is gone. */
  private readonly exiting = new Map<string, Promise<unknown>>();

  constructor() {
    super("java-lsp");
  }

  protected async resolveBinary(context: WtLspContext): Promise<string | null> {
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
    return resolveBundledJdtls()?.java ?? null;
  }

  protected override spawnArgs(context: WtLspContext): readonly string[] {
    const bundled = resolveBundledJdtls();
    if (!bundled) throw new Error("jdtls is not bundled");
    const configuration = jdtlsConfigurationDir(bundled.home);
    const data = jdtlsDataDir(context.wtPath);
    const hosts = path.join(JDTLS_STATE_DIR, "hosts");
    mkdirSync(configuration, { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(hosts, "127.0.0.1 localhost\n");
    this.startedAt.set(context.wtPath, Date.now());
    return jdtlsArgs({ home: bundled.home, configuration, data, hosts });
  }

  protected override serverFailureReason(context: WtLspContext): string | null {
    const bundled = resolveBundledJdtls();
    if (!bundled) return "The Java language server is missing from this build of Loxel";
    const since = this.startedAt.get(context.wtPath) ?? Date.now();
    const message = latestLogMessage(jdtlsConfigurationDir(bundled.home), since);
    return message ? `Java language server: ${message}` : null;
  }

  protected override spawnOptions(context: WtLspContext): SpawnOptions {
    return {
      // Not the worktree: nothing in it is read through the working directory.
      cwd: jdtlsDataDir(context.wtPath),
      // Options from the user's shell don't reach the server's JVM.
      env: { JAVA_TOOL_OPTIONS: "", JDK_JAVA_OPTIONS: "", _JAVA_OPTIONS: "" },
    };
  }

  protected override getInitializationOptions(session: WtLspSession): Record<string, unknown> {
    const trigger = this.triggerFiles.get(session.wtPath);
    return { settings: { java: JAVA_SETTINGS }, ...(trigger ? { triggerFiles: [trigger] } : {}) };
  }

  protected override onSessionClosed(session: WtLspSession): void {
    const { proc, wtPath } = session;
    const exited = proc.exited.then(() => {
      if (this.exiting.get(wtPath) === exited) this.exiting.delete(wtPath);
      // The worktree went away while its server ran, which could write until it stopped.
      if (!existsSync(wtPath)) deleteJdtlsData(wtPath);
    });
    this.exiting.set(wtPath, exited);
  }

  protected override onClientInitialized(session: WtLspSession): void {
    this.writeToStdin(
      session,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "workspace/didChangeConfiguration",
        params: { settings: { java: JAVA_SETTINGS } },
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

  protected override handleServerFrame(session: WtLspSession, body: string): void {
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
