import { rm } from "node:fs/promises";
import path from "node:path";

import type { ServerWebSocket, Subprocess } from "bun";

import { isRecord } from "@/lib/is-record";

import {
  BIOME_PACKAGE,
  biomeBinary,
  biomeNotInstalledMessage,
  createBiomeDaemonHome,
  findBiomeInstall,
  hasBiomeConfig,
  isBiomeConfigFile,
  scanBiomeWorktree,
} from "./biome-project";
import { readPackageJson, namesDependency, projectDirs } from "./js-project";
import {
  type LinterLaunch,
  type LinterNoLaunch,
  ProjectLinterLspManager,
} from "./project-linter-lsp-manager";
import { ReliedTrust } from "./project-scan";
import { isRepoTrusted } from "./repo-trust";
import type {
  SpawnOptions,
  SuppressibleFeature,
  WtLspContext,
  WtLspSession,
} from "./stdio-lsp-manager";

/** What else the server reads, and has no way to hear about from Loxel. */
const RESTARTING_FILES = new Set([
  ".editorconfig",
  ".gitignore",
  ".ignore",
  "package.json",
  "tsconfig.json",
]);

/** Longest `pkill` may take, as a process table can hang on a stuck file system. */
const PKILL_TIMEOUT_MS = 2000;

export interface BiomeLaunch extends LinterLaunch {
  node: null;
  bin: string;
}

/**
 * The project's own Biome through `lsp-proxy`, one per worktree. Nothing of Biome's is bundled, so a
 * worktree without an install holds its connection.
 *
 * What a server would read when it starts is looked at first, and a repository whose trust is still
 * open holds the connection. Config changes restart the server rather than reach it, so that this
 * holds for every load: it is told of no watched file.
 *
 * The proxy starts a daemon that does the work. Each session has its own, stopped with the session.
 */
export class BiomeLspManager extends ProjectLinterLspManager<BiomeLaunch> {
  protected override readonly repoTrustRestriction =
    "Biome's linter doesn't run, since it would run this project's install and plugins.";

  /** Format on save owns formatting. */
  protected override readonly suppressedFeatures: readonly SuppressibleFeature[] = [
    "textDocument/formatting",
    "textDocument/rangeFormatting",
  ];

  private readonly reliedTrust = new ReliedTrust();
  private readonly startingHomes = new WeakMap<WtLspContext, string>();
  private readonly homes = new WeakMap<WtLspSession, string>();
  private readonly daemonStops = new Set<Promise<void>>();

  constructor() {
    super("biome-lsp");
  }

  protected async findLaunch(
    context: WtLspContext,
    signal: AbortSignal,
  ): Promise<BiomeLaunch | LinterNoLaunch> {
    const { wtPath } = context;
    try {
      if (!hasBiomeConfig(wtPath)) {
        this.reliedTrust.record(context, []);
        return { notice: null };
      }
      const scan = await scanBiomeWorktree(wtPath, { signal });
      if (signal.aborted) return { notice: null };
      this.reliedTrust.record(context, [...scan.nestedConfigRepos, ...scan.ancestorRepos]);
      if (scan.incomplete) {
        return {
          notice:
            "Doesn't run here, as not every folder in this worktree could be checked, including those git ignores. Make them readable, or move the largest out of the worktree.",
        };
      }
      const nested = scan.nestedConfigRepos.find((dir) => !isRepoTrusted(dir));
      if (nested) {
        return {
          notice: `Doesn't run here while ${path.relative(wtPath, nested)}, a separate repository with its own Biome config, isn't trusted. Open it in Loxel and trust it.`,
        };
      }
      const ancestor = scan.ancestorRepos.find((dir) => !isRepoTrusted(dir));
      if (ancestor) {
        return {
          notice: `Doesn't run here while ${ancestor}, above this worktree, isn't trusted, since Biome would use its config. Open it in Loxel and trust it.`,
        };
      }
      const installDir = findBiomeInstall(scan.installDirs, wtPath);
      if (!installDir) return { notice: biomeNotInstalledMessage(wtPath) };
      const bin = biomeBinary(installDir);
      if (!bin) {
        return {
          notice: `Biome's binary for this platform wasn't found in this install. Reinstall ${BIOME_PACKAGE} in a terminal.`,
        };
      }
      return { node: null, bin };
    } catch (err) {
      this.log.warn("Could not decide how to run Biome", { error: err });
      return { notice: null };
    }
  }

  protected usesLinter(file: string, wtPath: string): boolean {
    return hasBiomeConfig(wtPath) && projectDirs(file, wtPath).length > 0;
  }

  protected override isLaunchStale(context: WtLspContext): boolean {
    return this.reliedTrust.isStale(context);
  }

  /** A native binary: no Node changes any answer. */
  protected override isHeldOnNode(): boolean {
    return false;
  }

  /** A worktree not using Biome holds its connection, and most changes mean nothing to it. */
  protected override changeRestarts(file: string) {
    const segments = file.split(path.sep);
    const packageIndex = segments.lastIndexOf("node_modules") + 1;
    if (packageIndex > 0) return segments[packageIndex] === "@biomejs" ? "all" : "running";
    if (isBiomeConfigFile(file)) return "all";
    if (path.basename(file) !== "package.json") {
      return RESTARTING_FILES.has(path.basename(file)) ? "running" : null;
    }
    const manifest = readPackageJson(path.dirname(file));
    return namesDependency(manifest, BIOME_PACKAGE) ? "all" : "running";
  }

  protected override resolveBinary(context: WtLspContext): string | null {
    return this.launchOf(context)?.bin ?? null;
  }

  protected override spawnArgs(): readonly string[] {
    return ["lsp-proxy"];
  }

  /** Each session gets its own daemon. A failure here is a start failure. */
  protected override spawnOptions(context: WtLspContext): SpawnOptions {
    const options = super.spawnOptions(context);
    const home = createBiomeDaemonHome();
    this.startingHomes.set(context, home);
    // macOS finds its cache through `HOME`, Linux through this first.
    const env = { ...options.env, HOME: home, XDG_CACHE_HOME: path.join(home, ".cache") };
    return { ...options, env };
  }

  protected override workspaceConfiguration(
    _session: WtLspSession,
    section: string | undefined,
  ): Promise<unknown> {
    return Promise.resolve(section === "biome" ? { requireConfiguration: true } : null);
  }

  protected override buildSession(
    ws: ServerWebSocket<unknown>,
    proc: Subprocess,
    context: WtLspContext,
  ): WtLspSession {
    const session = super.buildSession(ws, proc, context);
    const home = this.startingHomes.get(context);
    if (home) this.homes.set(session, home);
    return session;
  }

  protected override onSessionClosed(session: WtLspSession): void {
    super.onSessionClosed(session);
    const home = this.homes.get(session);
    if (!home) return;
    this.homes.delete(session);
    const stop = this.stopDaemon(home).finally(() => this.daemonStops.delete(stop));
    this.daemonStops.add(stop);
  }

  /**
   * Its command line names its home, which is this session's alone, so this finds it whatever became
   * of the proxy. Never rejects, as closing a session must go on regardless.
   */
  private async stopDaemon(home: string): Promise<void> {
    try {
      const pkill = Bun.spawn(["pkill", "-KILL", "-f", `__run_server.*${home}`], {
        stdout: "ignore",
        stderr: "ignore",
        timeout: PKILL_TIMEOUT_MS,
      });
      await pkill.exited;
    } catch (err) {
      this.log.warn("Could not stop Biome's daemon", { error: err });
    }
    await rm(home, { recursive: true, force: true, maxRetries: 3 }).catch((err: unknown) => {
      this.log.debug("Could not remove Biome's daemon folder", { error: err });
    });
  }

  override async destroy(): Promise<void> {
    await super.destroy();
    await Promise.all(this.daemonStops);
  }

  /**
   * The TypeScript server owns Organize Imports: it answers wherever the cursor is, and it removes
   * unused imports. Biome answers only with the cursor on its diagnostic, which would make the same
   * command sometimes ask which server to use. Its order stays in Source Action and Fix All.
   */
  protected override handleClientData(session: WtLspSession, data: string): void {
    const id = organizeImportsRequestId(data);
    if (id === undefined) {
      super.handleClientData(session, data);
      return;
    }
    session.ws.send(JSON.stringify({ jsonrpc: "2.0", id, result: [] }));
  }
}

/** The id of a request listing only Organize Imports actions. */
function organizeImportsRequestId(data: string): number | string | undefined {
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!isRecord(message) || message.method !== "textDocument/codeAction") return undefined;
  if (typeof message.id !== "number" && typeof message.id !== "string") return undefined;
  const context = isRecord(message.params) ? message.params.context : undefined;
  const only = isRecord(context) ? context.only : undefined;
  const asksOrganize =
    Array.isArray(only) &&
    only.length > 0 &&
    only.every((kind) => typeof kind === "string" && kind.startsWith("source.organizeImports"));
  return asksOrganize ? message.id : undefined;
}
