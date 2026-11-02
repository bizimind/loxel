import path from "node:path";

import type { ServerWebSocket, Subprocess } from "bun";

import { LSP_RESTART_CLOSE_CODE } from "@/api/ws-protocol";
import { isRecord } from "@/lib/is-record";

import {
  ESLINT_CONFIG_GLOBS,
  eslintNotInstalledMessage,
  findEslintConfigDir,
  hasInstalledEslint,
} from "./eslint-project";
import { fileUri } from "./lsp-file-uri";
import { getNodeEnv, subscribeNodeEnv } from "./node-env";
import { onRepoTrustChange, reportRepoRestriction, isRepoTrusted } from "./repo-trust";
import {
  type SpawnOptions,
  type SuppressibleFeature,
  WorktreeLspManager,
  type WtLspContext,
  type WtLspSession,
} from "./stdio-lsp-manager";
import {
  documentPath,
  setReactLanguageId,
  textDocumentUri,
  toClientUris,
  toServerUris,
} from "./ts-lsp-manager";

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

/** LSP `MessageType.Warning`. */
const MESSAGE_TYPE_WARNING = 2;
/** JSON-RPC's `MethodNotFound`. */
const METHOD_NOT_FOUND = -32601;

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
const MIN_NODE_VERSION = "16.0.0";

export interface EslintLaunch {
  node: string;
  server: string;
}

/** Why no server can run, with what to tell the user of a project that uses ESLint, if anything. */
export interface EslintNoLaunch {
  notice: string | null;
}

/** A connection with no server running, or none decided on yet. */
interface HeldConnection {
  ws: ServerWebSocket<unknown>;
  context: WtLspContext;
  /** What the client sent while deciding; null once decided. */
  frames: string[] | null;
  /** What to tell the user of a project that uses ESLint, in a trusted repository. */
  notice: string | null;
  stopWatchingNode: (() => void) | null;
}

/**
 * The project's own ESLint, through the ESLint language server, one per worktree. The server is
 * bundled and runs under the worktree's Node (`node-env.ts`), and loading a project's ESLint runs
 * its config and plugins. So nothing runs unless the repository is trusted and there is a Node;
 * otherwise the connection is held with no process, says what is missing once a file in a project
 * with an ESLint config opens, and restarts when that changes.
 *
 * With a server running, each file's settings decide: a file with no ESLint config above it, or no
 * ESLint installed, gets `validate: "off"`, and the server then loads nothing for it.
 *
 * Models of these languages use `loxel://HEAD/` URIs, for TypeScript. Only the fields that hold a
 * URI are translated, since a fix's text can hold anything, such as a `file:///` string.
 */
export class EslintLspManager extends WorktreeLspManager {
  protected override readonly repoTrustRestriction =
    "ESLint doesn't run, since it would load this project's config and plugins.";
  protected override readonly reportsRestrictionAtStart = false;
  protected override readonly forwardWatchedFiles = true;
  protected override readonly watchedFileGlobs = ESLINT_CONFIG_GLOBS;
  /** Format on save owns formatting. */
  protected override readonly suppressedFeatures: readonly SuppressibleFeature[] = [
    "textDocument/formatting",
    "textDocument/rangeFormatting",
  ];

  private readonly held = new Map<ServerWebSocket<unknown>, HeldConnection>();
  private readonly launches = new WeakMap<WtLspContext, EslintLaunch>();
  private readonly stopWatchingNode = new WeakMap<WtLspSession, () => void>();
  private unsubscribeTrust: (() => void) | null = null;

  constructor() {
    super("eslint-lsp");
  }

  // -------------------------------------------------------------------------
  // Whether a server runs

  protected override startSession(ws: ServerWebSocket<unknown>, context: WtLspContext): void {
    this.detach(ws);
    this.unsubscribeTrust ??= onRepoTrustChange(() => {
      for (const held of [...this.held.values()]) {
        if (isRepoTrusted(held.context.wtPath) !== held.context.repoTrusted) {
          this.restart(held.ws, "Repository trust changed; reconnect");
        }
      }
    });
    const held: HeldConnection = { ws, context, frames: [], notice: null, stopWatchingNode: null };
    this.held.set(ws, held);
    void this.decide(held);
  }

  private async decide(held: HeldConnection): Promise<void> {
    const { ws, context } = held;
    let launch: EslintLaunch | EslintNoLaunch = { notice: null };
    if (context.repoTrusted) {
      // Before resolving, so that no change is missed.
      held.stopWatchingNode = subscribeNodeEnv(context.wtPath, ({ env }) => {
        if (env && held.frames === null) this.restart(ws, "Node changed; reconnect");
      });
      launch = await this.findLaunch(context);
    }
    if (this.held.get(ws) !== held) return;
    const frames = held.frames ?? [];
    if ("node" in launch) {
      this.releaseHeld(ws);
      this.launches.set(context, launch);
      super.startSession(ws, context);
      for (const frame of frames) super.handleMessage(ws, frame);
      return;
    }
    held.frames = null;
    held.notice = launch.notice;
    for (const frame of frames) this.answerHeld(held, frame);
  }

  protected async findLaunch(context: WtLspContext): Promise<EslintLaunch | EslintNoLaunch> {
    try {
      const env = (await getNodeEnv(context.wtPath)).env;
      if (!env) {
        return {
          notice: "Needs Node to run. Install Node from nodejs.org or with a version manager.",
        };
      }
      if (env.version && Bun.semver.order(env.version, MIN_NODE_VERSION) < 0) {
        return {
          notice: `Needs Node ${MIN_NODE_VERSION} or newer to run, and this worktree uses Node ${env.version}.`,
        };
      }
      const server = this.resolveBundledBinary(SERVER_FILE, DEV_SERVER_FILE);
      if (server) return { node: env.nodePath, server };
      this.log.warn("The ESLint language server is not built");
    } catch (err) {
      this.log.warn("Could not resolve Node for ESLint", { error: err });
    }
    return { notice: null };
  }

  /** Be a server with no features, and tell the user about what is held back in an ESLint project. */
  private answerHeld(held: HeldConnection, frame: string): void {
    let message: unknown;
    try {
      message = JSON.parse(frame);
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message.method !== "string") return;
    const { id, method } = message;
    if (typeof id === "number" || typeof id === "string") {
      if (method === "initialize") {
        const capabilities = { textDocumentSync: { openClose: true, change: 0 } };
        send(held.ws, { id, result: { capabilities } });
      } else if (method === "shutdown") {
        send(held.ws, { id, result: null });
      } else {
        const error = { code: METHOD_NOT_FOUND, message: `Unhandled method ${method}` };
        send(held.ws, { id, error });
      }
      return;
    }
    if (method !== "textDocument/didOpen") return;
    const file = documentPath(textDocumentUri(message.params));
    if (!file || !findEslintConfigDir(file, held.context.wtPath)) return;
    if (!held.context.repoTrusted) {
      reportRepoRestriction(held.context.wtPath, this.repoTrustRestriction);
    } else if (held.notice) {
      sendWarning(held.ws, held.notice);
    }
  }

  private releaseHeld(ws: ServerWebSocket<unknown>): void {
    this.held.get(ws)?.stopWatchingNode?.();
    this.held.delete(ws);
  }

  private restart(ws: ServerWebSocket<unknown>, reason: string): void {
    this.detach(ws);
    try {
      ws.close(LSP_RESTART_CLOSE_CODE, reason);
    } catch (err) {
      this.log.debug("close() on a restarted WebSocket threw (already closed)", { error: err });
    }
  }

  override handleMessage(ws: ServerWebSocket<unknown>, data: string): void {
    const held = this.held.get(ws);
    if (!held) super.handleMessage(ws, data);
    else if (held.frames) held.frames.push(data);
    else this.answerHeld(held, data);
  }

  override detach(ws: ServerWebSocket<unknown>): void {
    this.releaseHeld(ws);
    super.detach(ws);
  }

  override async destroy(): Promise<void> {
    this.unsubscribeTrust?.();
    this.unsubscribeTrust = null;
    for (const ws of [...this.held.keys()]) this.releaseHeld(ws);
    await super.destroy();
  }

  /**
   * The server keeps every ESLint and plugin it has loaded, so an install needs a new one. Reported
   * once `node_modules` has been quiet, see `node-modules-changes.ts`.
   */
  override notifyWatchedFilesChanged(wtPath: string, paths: readonly string[]): void {
    if (paths.some((file) => file.split(path.sep).includes("node_modules"))) {
      for (const session of [...this.sessions.values()]) {
        if (session.wtPath === wtPath) this.restart(session.ws, "Dependencies changed; reconnect");
      }
    }
    super.notifyWatchedFilesChanged(wtPath, paths);
  }

  // -------------------------------------------------------------------------
  // The running server

  protected resolveBinary(context: WtLspContext): string | null {
    return this.launches.get(context)?.node ?? null;
  }

  protected override spawnArgs(context: WtLspContext): readonly string[] {
    const server = this.launches.get(context)?.server;
    // Thrown, it is a start failure, which `resolveBinary` already makes unreachable.
    if (!server) throw new Error("ESLint started without a server file");
    return [server, "--stdio"];
  }

  /**
   * Started from the filesystem root: a `node` that is a version manager's shim acts on the pin
   * files of the directory it runs in, which can mean downloading a version. The pins that apply
   * were already matched against what is installed, and the server moves to each project's folder
   * itself to lint.
   */
  protected override spawnOptions(context: WtLspContext): SpawnOptions {
    return { cwd: path.parse(context.wtPath).root, env: { MISE_NOT_FOUND_AUTO_INSTALL: "0" } };
  }

  protected override buildSession(
    ws: ServerWebSocket<unknown>,
    proc: Subprocess,
    context: WtLspContext,
  ): WtLspSession {
    const session = super.buildSession(ws, proc, context);
    const node = this.launches.get(context)?.node;
    this.stopWatchingNode.set(
      session,
      subscribeNodeEnv(context.wtPath, ({ env }) => {
        if (this.isSessionLive(session) && env?.nodePath !== node) {
          this.restart(ws, "Node changed; reconnect");
        }
      }),
    );
    // A subscription resolves nothing by itself.
    void getNodeEnv(context.wtPath);
    return session;
  }

  protected override onSessionClosed(session: WtLspSession): void {
    this.stopWatchingNode.get(session)?.();
    this.stopWatchingNode.delete(session);
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

  protected override handleClientData(session: WtLspSession, data: string): void {
    super.handleClientData(session, translateFrame(data, toServerUris, setDidOpenLanguageId));
  }

  protected override handleServerFrame(session: WtLspSession, body: string): void {
    if (this.answerServerFrame(session, body)) return;
    super.handleServerFrame(session, translateFrame(body, toClientUris));
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

function send(ws: ServerWebSocket<unknown>, message: Record<string, unknown>): void {
  ws.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
}

/** The client shows each distinct message once, after the server's name. */
function sendWarning(ws: ServerWebSocket<unknown>, message: string): void {
  send(ws, { method: "window/showMessage", params: { type: MESSAGE_TYPE_WARNING, message } });
}

function setDidOpenLanguageId(message: Record<string, unknown>): void {
  if (message.method === "textDocument/didOpen") setReactLanguageId(message.params);
}

/** `frame` with the URIs in it translated, and whatever `adjust` changes. Not JSON: as it is. */
function translateFrame(
  frame: string,
  translate: (uri: string) => string,
  adjust?: (message: Record<string, unknown>) => void,
): string {
  let message: unknown;
  try {
    message = JSON.parse(frame);
  } catch {
    return frame;
  }
  if (!isRecord(message)) return frame;
  adjust?.(message);
  translateUris(message, translate);
  return JSON.stringify(message);
}

/**
 * Translate, in place, every `uri` field and the keys of a workspace edit's `changes`, and nothing
 * else: `scopeUri` asks about a file on disk, and text is the user's.
 */
function translateUris(value: unknown, translate: (uri: string) => string): void {
  if (Array.isArray(value)) {
    for (const item of value) translateUris(item, translate);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "uri" && typeof child === "string") {
      value.uri = translate(child);
    } else if (key === "changes" && isRecord(child)) {
      value.changes = Object.fromEntries(
        Object.entries(child).map(([uri, edits]) => [translate(uri), edits]),
      );
    } else {
      translateUris(child, translate);
    }
  }
}
