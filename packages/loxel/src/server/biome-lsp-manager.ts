import { rmSync } from "node:fs";
import path from "node:path";

import type { ServerWebSocket, Subprocess } from "bun";

import { isRecord } from "@/lib/is-record";

import {
  BIOME_PACKAGE,
  biomeBinary,
  biomeDaemonHome,
  biomeNotInstalledMessage,
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

export interface BiomeLaunch extends LinterLaunch {
  node: null;
  bin: string;
  /** The home the daemon runs with, so that it serves this worktree alone. */
  home: string;
}

/**
 * The project's own Biome through `lsp-proxy`, one per worktree. Nothing of Biome's is bundled, so a
 * worktree without an install holds its connection.
 *
 * A server reads the configs it can see when it starts, wherever they lie, so what it would load is
 * looked for first, and a config it should not load holds the connection. Config changes restart
 * the server rather than reach it, so that this holds for every load: it is told of no watched file.
 *
 * The proxy starts a daemon that does the work and outlives it while busy, so the daemon is stopped
 * along with the session.
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
  private readonly daemons = new WeakMap<WtLspSession, number | null>();
  private readonly homes = new WeakMap<WtLspSession, string>();

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
      const relied = [...scan.nestedConfigRepos, ...(scan.ancestorRepo ? [scan.ancestorRepo] : [])];
      this.reliedTrust.record(context, relied);
      if (scan.incomplete) {
        return {
          notice: "Doesn't run here, as not every folder in this worktree could be checked.",
        };
      }
      const nested = scan.nestedConfigRepos.find((dir) => !isRepoTrusted(dir));
      if (nested) {
        return {
          notice: `Doesn't run here while ${path.relative(wtPath, nested)}, a separate repository with its own Biome config, isn't trusted. Open it in Loxel and trust it.`,
        };
      }
      if (scan.ancestorRepo && !isRepoTrusted(scan.ancestorRepo)) {
        return {
          notice: `Doesn't run here while ${scan.ancestorRepo}, above this worktree, isn't trusted, since Biome would use its config. Open it in Loxel and trust it.`,
        };
      }
      const [installDir] = scan.installDirs;
      if (!installDir) return { notice: biomeNotInstalledMessage(wtPath) };
      const bin = biomeBinary(installDir);
      if (!bin) {
        return {
          notice: `Biome is installed without its binary for this platform. Reinstall ${BIOME_PACKAGE} in a terminal.`,
        };
      }
      const home = biomeDaemonHome(`${wtPath}\0${bin}`);
      if (!home) return { notice: "Doesn't run here, as its daemon has no private folder to use." };
      return { node: null, bin, home };
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

  protected override spawnOptions(context: WtLspContext): SpawnOptions {
    const options = super.spawnOptions(context);
    const home = this.launchOf(context)?.home;
    if (!home) return options;
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
    const home = this.launchOf(context)?.home;
    if (home) this.homes.set(session, home);
    return session;
  }

  protected override handleServerFrame(session: WtLspSession, body: string): void {
    // Its first answer means the daemon is up.
    if (!this.daemons.has(session)) this.daemons.set(session, findDaemon(session.proc.pid));
    super.handleServerFrame(session, body);
  }

  protected override onSessionClosed(session: WtLspSession): void {
    super.onSessionClosed(session);
    const daemon = this.daemons.get(session);
    this.daemons.set(session, null);
    if (daemon) stopDaemon(daemon);
    const home = this.homes.get(session);
    this.homes.delete(session);
    if (home) rmSync(home, { recursive: true, force: true });
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

/** The daemon `proxy` started; none when it connected to one already running. */
function findDaemon(proxy: number): number | null {
  const { stdout } = Bun.spawnSync(["pgrep", "-P", String(proxy)]);
  const pid = Number(stdout.toString().trim().split("\n")[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Its home makes it this session's alone. It exits by itself once its last client goes, unless a
 * plugin keeps it busy, so nothing is lost by not waiting. The check is for a daemon long gone,
 * whose number may be another process's by now.
 */
function stopDaemon(pid: number): void {
  const { stdout } = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]);
  if (!stdout.toString().includes("__run_server")) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // It went between the check and now, which is what was wanted.
  }
}
