import path from "node:path";

import { isRecord } from "@/lib/is-record";

import { readPackageJson } from "./js-project";
import {
  findOxlintProjectDir,
  isOxlintConfigFile,
  isOxlintFile,
  OXLINT_PACKAGE,
  oxlintNotInstalledMessage,
  scanWorktree,
} from "./oxlint-project";
import {
  isInNodeModules,
  type LinterLaunch,
  type LinterNoLaunch,
  ProjectLinterLspManager,
  sendWarning,
} from "./project-linter-lsp-manager";
import { isRepoTrusted } from "./repo-trust";
import type { WtLspContext, WtLspSession } from "./stdio-lsp-manager";
import { documentPath, textDocumentUri } from "./ts-lsp-manager";

/** The first version with `--lsp`; older ones ship a separate server. */
const MIN_OXLINT_VERSION = "1.29.0";

/** LSP's largest line number, for a range to the end of any file. */
const LAST_LINE = 2_147_483_647;

/** Files whose change can change what starts, and what a running server has read. */
const RESTARTING_FILES = new Set(["package.json", ".gitignore"]);

export interface OxlintLaunch extends LinterLaunch {
  bin: string;
}

export type OxlintNoLaunch = LinterNoLaunch;

/**
 * The project's own oxlint with `--lsp`, one per worktree, under the worktree's Node. Nothing of
 * oxlint's is bundled, so a worktree without an install holds its connection.
 *
 * A server reads the configs it can see when it starts, wherever they lie, so what it would load is
 * looked for first, and a config it should not load holds the connection. Config changes restart
 * the server rather than reach it, so that this holds for every load: it is told of no watched file.
 *
 * It also lints with its defaults where it finds no config, so only files of a project that uses
 * oxlint reach it, and the rest get the answer of a clean file.
 */
export class OxlintLspManager extends ProjectLinterLspManager<OxlintLaunch> {
  protected override readonly repoTrustRestriction =
    "oxlint doesn't run, since it would load this project's config and plugins.";

  /** The answer of each repository a launch decision relied on; a context absent is still deciding. */
  private readonly trustRelied = new WeakMap<WtLspContext, Map<string, boolean>>();
  private readonly eligible = new WeakMap<WtLspSession, Map<string, boolean>>();

  constructor() {
    super("oxlint-lsp");
  }

  protected async findLaunch(context: WtLspContext): Promise<OxlintLaunch | OxlintNoLaunch> {
    const { wtPath } = context;
    try {
      const scan = await scanWorktree(wtPath);
      const relied = [
        ...scan.nestedConfigRepos,
        ...(scan.ancestorConfigRepo ? [scan.ancestorConfigRepo] : []),
      ];
      this.trustRelied.set(context, new Map(relied.map((dir) => [dir, isRepoTrusted(dir)])));
      if (scan.truncated) {
        return {
          notice:
            "Doesn't run here, as this worktree has too many folders to check. Add the largest to .gitignore.",
        };
      }
      const nested = scan.nestedConfigRepos.find((dir) => !isRepoTrusted(dir));
      if (nested) {
        return {
          notice: `Doesn't run here while ${path.relative(wtPath, nested)}, a separate repository with its own oxlint config, isn't trusted. Open it in Loxel and trust it, or add it to .gitignore.`,
        };
      }
      const { ancestorConfigRepo: ancestor } = scan;
      if (ancestor && !isRepoTrusted(ancestor)) {
        return {
          notice: `Doesn't run here while ${ancestor} has an oxlint config and isn't trusted. Open it in Loxel and trust it, or add an oxlint config to this project.`,
        };
      }
      const [installDir] = scan.installDirs;
      if (!installDir || !scan.usesOxlint) return { notice: null };
      return await this.launchFrom(path.join(installDir, "node_modules", OXLINT_PACKAGE), wtPath);
    } catch (err) {
      this.log.warn("Could not decide how to run oxlint", { error: err });
      return { notice: null };
    }
  }

  private async launchFrom(
    packageDir: string,
    wtPath: string,
  ): Promise<OxlintLaunch | OxlintNoLaunch> {
    const manifest = readPackageJson(packageDir);
    const version = typeof manifest?.version === "string" ? manifest.version : null;
    if (!version || Bun.semver.order(version, MIN_OXLINT_VERSION) < 0) {
      return {
        notice: `Needs oxlint ${MIN_OXLINT_VERSION} or newer to run in the editor, and this project has ${version ?? "an unknown version"}. Upgrade it in a terminal.`,
      };
    }
    const range = isRecord(manifest?.engines) ? manifest.engines.node : undefined;
    const node = await this.resolveNode(
      wtPath,
      typeof range === "string" ? { range, label: range } : null,
    );
    if (typeof node !== "string") return node;
    return { node, bin: path.join(packageDir, "bin", "oxlint") };
  }

  protected usesLinter(file: string, wtPath: string): boolean {
    return findOxlintProjectDir(file, wtPath) !== null;
  }

  protected override heldNotice(file: string, wtPath: string, notice: string | null) {
    if (notice) return notice;
    const projectDir = findOxlintProjectDir(file, wtPath);
    return projectDir ? oxlintNotInstalledMessage(projectDir, wtPath) : null;
  }

  protected override isLaunchStale(context: WtLspContext): boolean {
    if (!context.repoTrusted) return false;
    const relied = this.trustRelied.get(context);
    if (!relied) return true;
    return [...relied].some(([dir, trusted]) => isRepoTrusted(dir) !== trusted);
  }

  protected override changeRestarts(file: string) {
    if (isInNodeModules(file) || isOxlintConfigFile(file)) return "all" as const;
    return RESTARTING_FILES.has(path.basename(file)) ? ("all" as const) : null;
  }

  protected override spawnArgs(context: WtLspContext): readonly string[] {
    const bin = this.launchOf(context)?.bin;
    // Thrown, it is a start failure, which `resolveBinary` already makes unreachable.
    if (!bin) throw new Error("oxlint started without its path");
    return [bin, "--lsp"];
  }

  protected override handleClientData(session: WtLspSession, data: string): void {
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      super.handleClientData(session, data);
      return;
    }
    const uri = isRecord(message) ? textDocumentUri(message.params) : undefined;
    if (!isRecord(message) || uri === undefined) {
      super.handleClientData(session, data);
      return;
    }
    if (this.isLinted(session, uri)) {
      super.handleClientData(session, withWholeFileRange(message) ? JSON.stringify(message) : data);
      return;
    }
    if (message.id === undefined) return;
    const result =
      message.method === "textDocument/diagnostic" ? { kind: "full", items: [] } : null;
    session.ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  }

  /** Decided once per session, since what decides it restarts the session. */
  private isLinted(session: WtLspSession, uri: string): boolean {
    const known = this.eligible.get(session) ?? new Map<string, boolean>();
    this.eligible.set(session, known);
    const cached = known.get(uri);
    if (cached !== undefined) return cached;
    const file = documentPath(uri);
    const linted = file !== null && isOxlintFile(file, session.wtPath);
    known.set(uri, linted);
    const projectDir = !linted && file ? findOxlintProjectDir(file, session.wtPath) : null;
    if (projectDir) {
      sendWarning(session.ws, oxlintNotInstalledMessage(projectDir, session.wtPath));
    }
    return linted;
  }
}

/**
 * Widen a request for a source action to the whole file, and say whether it was one. The editor
 * sends the cursor's range, and the server's Fix All covers only the fixes touching the range.
 */
function withWholeFileRange(message: Record<string, unknown>): boolean {
  if (message.method !== "textDocument/codeAction" || !isRecord(message.params)) return false;
  const { context } = message.params;
  const only = isRecord(context) ? context.only : undefined;
  if (!Array.isArray(only)) return false;
  if (!only.some((kind) => typeof kind === "string" && kind.startsWith("source"))) return false;
  message.params.range = {
    start: { line: 0, character: 0 },
    end: { line: LAST_LINE, character: 0 },
  };
  return true;
}
