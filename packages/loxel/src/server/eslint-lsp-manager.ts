import path from "node:path";

import { isRecord } from "@/lib/is-record";

import {
  ESLINT_CONFIG_GLOBS,
  eslintNotInstalledMessage,
  findEslintConfigDir,
  hasInstalledEslint,
} from "./eslint-project";
import { fileUri } from "./lsp-file-uri";
import {
  type LinterLaunch,
  type LinterNoLaunch,
  ProjectLinterLspManager,
  sendWarning,
} from "./project-linter-lsp-manager";
import type { SuppressibleFeature, WtLspContext, WtLspSession } from "./stdio-lsp-manager";
import { documentPath } from "./ts-lsp-manager";

const SERVER_FILE = path.join("eslint-language-server", "eslintServer.cjs");
/** Where `build:language-servers` puts the bundle in dev mode. */
const DEV_SERVER_FILE = path.resolve(import.meta.dir, "../../build", SERVER_FILE);

/** The server's own requests to the extension it was written for, answered here with nothing. */
const IGNORED_REQUESTS = new Set([
  "eslint/noLibrary",
  "eslint/probeFailed",
  "eslint/openDoc",
  "eslint/noConfig",
]);
/** Likewise its notifications; `eslint/status` is read first. */
const IGNORED_NOTIFICATIONS = new Set([
  "eslint/status",
  "eslint/exitCalled",
  "eslint/showOutputChannel",
]);
/** `Status.ok` in the server's `eslint/status`; anything above it means a file wasn't linted. */
const STATUS_OK = 1;

/**
 * What differs from the server's defaults. `packageManager` names none of the ones it asks for a
 * global folder, so it runs no `npm` and resolves only the project's ESLint. `workingDirectory`
 * lets it pick each package's folder in a monorepo.
 */
const SERVER_SETTINGS = {
  packageManager: "project-only",
  workingDirectory: { mode: "auto" },
  codeAction: {
    disableRuleComment: { enable: true, location: "separateLine", commentStyle: "line" },
    showDocumentation: { enable: false },
  },
} as const;

/** Older ones cannot parse the bundle. */
const REQUIRED_NODE = { range: ">=16.0.0", label: "16.0.0 or newer" };

export interface EslintLaunch extends LinterLaunch {
  server: string;
}

export type EslintNoLaunch = LinterNoLaunch;

/**
 * The project's own ESLint, through the ESLint language server, one per worktree. The server is
 * bundled and runs under the worktree's Node (`node-env.ts`), and loading a project's ESLint runs
 * its config and plugins, so `ProjectLinterLspManager` holds the connection until it can run.
 *
 * With a server running, each file's settings decide: a file with no ESLint config above it, or no
 * ESLint installed, gets `validate: "off"`, and the server then loads nothing for it.
 */
export class EslintLspManager extends ProjectLinterLspManager<EslintLaunch> {
  protected override readonly repoTrustRestriction =
    "ESLint doesn't run, since it would load this project's config and plugins.";
  protected override readonly forwardWatchedFiles = true;
  protected override readonly watchedFileGlobs = ESLINT_CONFIG_GLOBS;
  /** Format on save owns formatting. */
  protected override readonly suppressedFeatures: readonly SuppressibleFeature[] = [
    "textDocument/formatting",
    "textDocument/rangeFormatting",
  ];

  constructor() {
    super("eslint-lsp");
  }

  protected async findLaunch(context: WtLspContext): Promise<EslintLaunch | EslintNoLaunch> {
    try {
      const node = await this.resolveNode(context.wtPath, REQUIRED_NODE);
      if (typeof node !== "string") return node;
      const server = this.resolveBundledBinary(SERVER_FILE, DEV_SERVER_FILE);
      if (server) return { node, server };
      this.log.warn("The ESLint language server is not built");
    } catch (err) {
      this.log.warn("Could not resolve Node for ESLint", { error: err });
    }
    return { notice: null };
  }

  protected usesLinter(file: string, wtPath: string): boolean {
    return findEslintConfigDir(file, wtPath) !== null;
  }

  protected override spawnArgs(context: WtLspContext): readonly string[] {
    const server = this.launchOf(context)?.server;
    // Thrown, it is a start failure, which `resolveBinary` already makes unreachable.
    if (!server) throw new Error("ESLint started without a server file");
    return [server, "--stdio"];
  }

  protected override workspaceConfiguration(
    session: WtLspSession,
    section: string | undefined,
    scopeUri: string | undefined,
  ): Promise<unknown> {
    if (section) return Promise.resolve(null);
    return Promise.resolve({
      ...SERVER_SETTINGS,
      validate: this.shouldLint(session, documentPath(scopeUri)) ? "on" : "off",
      workspaceFolder: { uri: fileUri(session.wtPath), name: path.basename(session.wtPath) },
    });
  }

  private shouldLint({ wtPath, ws }: WtLspSession, file: string | null): boolean {
    if (!file) return false;
    const configDir = findEslintConfigDir(file, wtPath);
    if (!configDir) return false;
    if (hasInstalledEslint(file, wtPath)) return true;
    sendWarning(ws, eslintNotInstalledMessage(configDir, wtPath));
    return false;
  }

  protected override handleServerFrame(session: WtLspSession, body: string): void {
    if (this.answerServerFrame(session, body)) return;
    super.handleServerFrame(session, body);
  }

  /** Answer what the server sends for the extension it was written for. True when consumed. */
  private answerServerFrame(session: WtLspSession, body: string): boolean {
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      return false;
    }
    if (!isRecord(message) || typeof message.method !== "string") return false;
    const { id, method, params } = message;
    const failed =
      method === "eslint/noLibrary" ||
      (method === "eslint/status" && isRecord(params) && Number(params.state) > STATUS_OK);
    if (failed) {
      sendWarning(
        session.ws,
        `Could not lint ${path.basename(session.wtPath)}. Run ESLint in a terminal to see why.`,
      );
    }
    if (IGNORED_NOTIFICATIONS.has(method)) return true;
    if (!IGNORED_REQUESTS.has(method)) return false;
    if (typeof id === "number" || typeof id === "string") {
      this.writeToStdin(session, JSON.stringify({ jsonrpc: "2.0", id, result: null }));
    }
    return true;
  }
}
