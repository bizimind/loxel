import path from "node:path";

import type { ServerWebSocket, Subprocess } from "bun";

import { LSP_RESTART_CLOSE_CODE } from "@/api/ws-protocol";
import { isRecord } from "@/lib/is-record";

import { getNodeEnv, subscribeNodeEnv } from "./node-env";
import { onRepoTrustChange, reportRepoRestriction, isRepoTrusted } from "./repo-trust";
import {
  type SpawnOptions,
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

/** LSP `MessageType.Warning`. */
const MESSAGE_TYPE_WARNING = 2;
/** JSON-RPC's `MethodNotFound`. */
const METHOD_NOT_FOUND = -32601;

/** How to run a linter: under which Node, plus whatever else its manager needs. */
export interface LinterLaunch {
  node: string;
}

/** Why no server can run, with what to tell the user of a project using the linter, if anything. */
export interface LinterNoLaunch {
  notice: string | null;
}

/** What a linter needs of the worktree's Node, and how a notice says it. */
export interface NodeRequirement {
  range: string;
  label: string;
}

/** A connection with no server running, or none decided on yet. */
interface HeldConnection {
  ws: ServerWebSocket<unknown>;
  context: WtLspContext;
  /** What the client sent while deciding; null once decided. */
  frames: string[] | null;
  /** What to tell the user of a project using the linter, in a trusted repository. */
  notice: string | null;
  stopWatchingNode: (() => void) | null;
}

/**
 * A JavaScript project's own linter as a language server next to TypeScript, one per worktree.
 * Loading a project's linter runs its config and plugins, so nothing runs unless the repository is
 * trusted and the linter can start; otherwise the connection is held with no process, says what is
 * missing once a file of a project using the linter opens, and restarts when that changes.
 *
 * Models of these languages use `loxel://HEAD/` URIs, for TypeScript. Only the fields that hold a
 * URI are translated, since a fix's text can hold anything, such as a `file:///` string.
 */
export abstract class ProjectLinterLspManager<
  TLaunch extends LinterLaunch,
> extends WorktreeLspManager {
  protected override readonly reportsRestrictionAtStart = false;

  private readonly held = new Map<ServerWebSocket<unknown>, HeldConnection>();
  private readonly launches = new WeakMap<WtLspContext, TLaunch>();
  private readonly stopWatchingNode = new WeakMap<WtLspSession, () => void>();
  private readonly sessionContexts = new WeakMap<WtLspSession, WtLspContext>();
  private unsubscribeTrust: (() => void) | null = null;

  /** How to run the linter for this context, or why it cannot run. Runs only once trusted. */
  protected abstract findLaunch(context: WtLspContext): Promise<TLaunch | LinterNoLaunch>;

  /** Whether `file` belongs to a project using the linter, which is who hears about a hold. */
  protected abstract usesLinter(file: string, wtPath: string): boolean;

  /** What to tell the user when `file`, of a project using the linter, opens on a held connection. */
  protected heldNotice(_file: string, _wtPath: string, notice: string | null): string | null {
    return notice;
  }

  /** Whether what `findLaunch` decided depended on a trust answer that has since changed. */
  protected isLaunchStale(_context: WtLspContext): boolean {
    return false;
  }

  /** Which connections of a worktree a changed file restarts: running servers, or held ones too. */
  protected changeRestarts(file: string): "running" | "all" | null {
    return isInNodeModules(file) ? "running" : null;
  }

  protected launchOf(context: WtLspContext): TLaunch | undefined {
    return this.launches.get(context);
  }

  /** The worktree's Node, or what to tell the user when it cannot run the linter. */
  protected async resolveNode(
    wtPath: string,
    required: NodeRequirement | null,
  ): Promise<string | LinterNoLaunch> {
    const env = (await getNodeEnv(wtPath)).env;
    if (!env) {
      return {
        notice: "Needs Node to run. Install Node from nodejs.org or with a version manager.",
      };
    }
    if (required && env.version && !Bun.semver.satisfies(env.version, required.range)) {
      return {
        notice: `Needs Node ${required.label} to run, and this worktree uses Node ${env.version}.`,
      };
    }
    return env.nodePath;
  }

  // -------------------------------------------------------------------------
  // Whether a server runs

  protected override startSession(ws: ServerWebSocket<unknown>, context: WtLspContext): void {
    this.detach(ws);
    this.unsubscribeTrust ??= onRepoTrustChange(() => this.restartOnTrustChange());
    const held: HeldConnection = { ws, context, frames: [], notice: null, stopWatchingNode: null };
    this.held.set(ws, held);
    void this.decide(held);
  }

  private restartOnTrustChange(): void {
    for (const held of [...this.held.values()]) {
      if (
        isRepoTrusted(held.context.wtPath) !== held.context.repoTrusted ||
        this.isLaunchStale(held.context)
      ) {
        this.restart(held.ws, "Repository trust changed; reconnect");
      }
    }
    for (const session of [...this.sessions.values()]) {
      const context = this.sessionContexts.get(session);
      if (context && this.isSessionLive(session) && this.isLaunchStale(context)) {
        this.restart(session.ws, "Repository trust changed; reconnect");
      }
    }
  }

  private async decide(held: HeldConnection): Promise<void> {
    const { ws, context } = held;
    let launch: TLaunch | LinterNoLaunch = { notice: null };
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

  /** Be a server with no features, and tell the user about what is held back in a linter's project. */
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
    const { wtPath, repoTrusted } = held.context;
    if (!file || !this.usesLinter(file, wtPath)) return;
    if (!repoTrusted) {
      if (this.repoTrustRestriction) reportRepoRestriction(wtPath, this.repoTrustRestriction);
      return;
    }
    const notice = this.heldNotice(file, wtPath, held.notice);
    if (notice) sendWarning(held.ws, notice);
  }

  private releaseHeld(ws: ServerWebSocket<unknown>): void {
    this.held.get(ws)?.stopWatchingNode?.();
    this.held.delete(ws);
  }

  protected restart(ws: ServerWebSocket<unknown>, reason: string): void {
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

  /** Reported once `node_modules` has been quiet, see `node-modules-changes.ts`. */
  override notifyWatchedFilesChanged(wtPath: string, paths: readonly string[]): void {
    const restarts = new Set(paths.map((file) => this.changeRestarts(file)));
    if (restarts.has("running") || restarts.has("all")) {
      for (const session of [...this.sessions.values()]) {
        if (session.wtPath === wtPath) this.restart(session.ws, "Project files changed; reconnect");
      }
    }
    if (restarts.has("all")) {
      // In an untrusted repository, what a held connection says is read from disk as files open.
      for (const { ws, context } of [...this.held.values()]) {
        if (context.wtPath === wtPath && context.repoTrusted) {
          this.restart(ws, "Project files changed; reconnect");
        }
      }
    }
    super.notifyWatchedFilesChanged(wtPath, paths);
  }

  // -------------------------------------------------------------------------
  // The running server

  protected resolveBinary(context: WtLspContext): string | null {
    return this.launches.get(context)?.node ?? null;
  }

  /**
   * Started from the filesystem root: a `node` that is a version manager's shim acts on the pin
   * files of the directory it runs in, which can mean downloading a version. The pins that apply
   * were already matched against what is installed, and the linter finds each project by itself.
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
    this.sessionContexts.set(session, context);
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

  protected override handleClientData(session: WtLspSession, data: string): void {
    super.handleClientData(session, translateFrame(data, toServerUris, setDidOpenLanguageId));
  }

  protected override handleServerFrame(session: WtLspSession, body: string): void {
    super.handleServerFrame(session, translateFrame(body, toClientUris));
  }
}

export function isInNodeModules(file: string): boolean {
  return file.split(path.sep).includes("node_modules");
}

function send(ws: ServerWebSocket<unknown>, message: Record<string, unknown>): void {
  ws.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
}

/** The client shows each distinct message once, after the server's name. */
export function sendWarning(ws: ServerWebSocket<unknown>, message: string): void {
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
