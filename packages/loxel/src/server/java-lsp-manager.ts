import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isRecord } from "@/lib/is-record";

import { config, hash12 } from "./config";
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
  project: { referencedLibraries: [] },
  inlayHints: { parameterNames: { enabled: "literals" } },
  autobuild: { enabled: false },
  telemetry: { enabled: false },
};

/** Directories never worth starting from when looking for a Java file. */
const NOT_SOURCE_DIRS = new Set(["node_modules", "build", "target", "out", "bin"]);

/** The client command behind the actions that need a prompt Loxel does not have. */
const PROMPT_COMMAND = "java.action.applyRefactoringCommand";
/** Offered without an edit to apply. */
const EMPTY_ACTION_TITLE = "Add all missing imports";

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
    if (Bun.file(javaPath).size && Bun.file(path.join(home, "config_win", "config.ini")).size) {
      return { java: javaPath, home };
    }
  }
  return null;
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
  rmSync(jdtlsDataDir(wtPath), { recursive: true, force: true });
}

/**
 * A Java file of the worktree. jdtls infers a folder's source root from the first file it hears
 * about, and `initialize` comes before any file is open.
 */
function firstJavaFile(wtPath: string): string | null {
  for (const file of new Bun.Glob("**/*.java").scanSync({ cwd: wtPath })) {
    if (!file.split(path.sep).some((segment) => NOT_SOURCE_DIRS.has(segment))) {
      return fileUri(path.join(wtPath, file));
    }
  }
  return null;
}

/**
 * The initialize response without `workspace.fileOperations.willRename`: jdtls's rename already
 * carries the edits `workspace/willRenameFiles` would return, so the client would apply them twice.
 */
function dropWillRename(message: Record<string, unknown>): boolean {
  const { result } = message;
  if (!isRecord(result) || !isRecord(result.capabilities)) return false;
  const { workspace } = result.capabilities;
  if (!isRecord(workspace) || !isRecord(workspace.fileOperations)) return false;
  return delete workspace.fileOperations.willRename;
}

/** Drop the code actions from a response that Loxel could not carry out. */
function dropUnusableActions(message: Record<string, unknown>): boolean {
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

  private spawnContext: WtLspContext | null = null;

  constructor() {
    super("java-lsp");
  }

  protected resolveBinary(context: WtLspContext): string | null {
    this.spawnContext = context;
    return resolveBundledJdtls()?.java ?? null;
  }

  protected override spawnArgs(): readonly string[] {
    const bundled = resolveBundledJdtls();
    if (!bundled || !this.spawnContext) throw new Error("jdtls is not bundled");
    const plugins = readdirSync(path.join(bundled.home, "plugins"));
    const launcher = plugins.find((name) => name.startsWith("org.eclipse.equinox.launcher_"));
    const core = plugins.find((name) => name.startsWith("org.eclipse.jdt.ls.core_"));
    if (!launcher || !core) throw new Error(`Incomplete jdtls at ${bundled.home}`);
    const configuration = path.join(JDTLS_STATE_DIR, "configuration", core);
    const data = jdtlsDataDir(this.spawnContext.wtPath);
    const hosts = path.join(JDTLS_STATE_DIR, "hosts");
    mkdirSync(configuration, { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(hosts, "127.0.0.1 localhost\n");
    return [
      "-Declipse.application=org.eclipse.jdt.ls.core.id1",
      "-Dosgi.bundles.defaultStartLevel=4",
      "-Declipse.product=org.eclipse.jdt.ls.core.product",
      "-Dosgi.checkConfiguration=true",
      `-Dosgi.sharedConfiguration.area=${path.join(bundled.home, sharedConfigDir())}`,
      "-Dosgi.sharedConfiguration.area.readOnly=true",
      "-Dosgi.configuration.cascaded=true",
      "-Djava.import.generatesMetadataFilesAtProjectRoot=false",
      // The server makes no network requests: no host name resolves but localhost.
      `-Djdk.net.hosts.file=${hosts}`,
      "-Djdk.xml.maxGeneralEntitySizeLimit=0",
      "-Djdk.xml.totalEntitySizeLimit=0",
      `-XX:ErrorFile=${path.join(data, "hs_err_%p.log")}`,
      "-Xmx1G",
      "-XX:+UseParallelGC",
      "-XX:GCTimeRatio=4",
      "-XX:AdaptiveSizePolicyWeight=90",
      "--add-modules=ALL-SYSTEM",
      "--add-opens",
      "java.base/java.util=ALL-UNNAMED",
      "--add-opens",
      "java.base/java.lang=ALL-UNNAMED",
      "-jar",
      path.join(bundled.home, "plugins", launcher),
      "-configuration",
      configuration,
      "-data",
      data,
    ];
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
    const trigger = firstJavaFile(session.wtPath);
    return { settings: { java: JAVA_SETTINGS }, ...(trigger ? { triggerFiles: [trigger] } : {}) };
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

  protected override handleServerFrame(session: WtLspSession, body: string): void {
    if (
      !body.includes('"willRename"') &&
      !body.includes(PROMPT_COMMAND) &&
      !body.includes(EMPTY_ACTION_TITLE)
    ) {
      super.handleServerFrame(session, body);
      return;
    }
    const message: unknown = JSON.parse(body);
    if (isRecord(message) && (dropWillRename(message) || dropUnusableActions(message))) {
      super.handleServerFrame(session, JSON.stringify(message));
      return;
    }
    super.handleServerFrame(session, body);
  }
}
