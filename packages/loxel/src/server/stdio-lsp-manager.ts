import path from "node:path";

import type { FileSink, ServerWebSocket, Subprocess } from "bun";

import type { LspName } from "@/api/log-entry-model";
import {
  LSP_EXITED_CLOSE_CODE,
  LSP_REPLACED_CLOSE_CODE,
  LSP_RESTART_CLOSE_CODE,
  LSP_START_FAILED_CLOSE_CODE,
} from "@/api/ws-protocol";
import { isRecord } from "@/lib/is-record";

import { logger } from "./logger";
import { fileUri } from "./lsp-file-uri";
import {
  type FileEvent,
  splitWatchedFilesRegistration,
  WatchedFilesForwarder,
  withWatchedFilesCapability,
} from "./lsp-watched-files";
import { buildSpawnEnv, refreshLoginShellEnv } from "./shell-env";
import {
  createStderrThrottle,
  STDERR_THROTTLE_CAPACITY,
  STDERR_THROTTLE_FLUSH_INTERVAL_MS,
  STDERR_THROTTLE_REFILL_PER_SEC,
  type StderrThrottle,
} from "./stderr-throttle";

export interface BaseLspSession {
  ws: ServerWebSocket<unknown>;
  proc: Subprocess;
  stdoutBuf: Buffer;
  /**
   * uri → current full document text. Populated from didOpen/didChange so
   * we can rewrite incremental `didChange` notifications into full-text ones
   * for servers that can't handle incremental sync (see
   * `requiresFullTextSync`). Empty for LSPs that don't opt in.
   */
  documentContents: Map<string, string>;
}

export interface WtLspContext {
  wtPath: string;
}

export interface WtLspSession extends BaseLspSession {
  wtPath: string;
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
}

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

interface LspContentChange {
  range?: LspRange;
  text: string;
}

/** A WebSocket close frame's limit on its reason, in UTF-8 bytes (RFC 6455). */
const MAX_CLOSE_REASON_BYTES = 123;

/** The server capability that advertises each suppressible LSP feature statically. */
const SERVER_CAPABILITY_OF = {
  "textDocument/formatting": "documentFormattingProvider",
  "textDocument/inlayHint": "inlayHintProvider",
  "textDocument/rangeFormatting": "documentRangeFormattingProvider",
  "textDocument/semanticTokens": "semanticTokensProvider",
} as const;

export type SuppressibleFeature = keyof typeof SERVER_CAPABILITY_OF;

/**
 * Base class for language-server subprocess bridges. Handles the
 * Content-Length framed JSON-RPC stdio <-> WebSocket plumbing that is
 * identical across every LSP we ship. Subclasses supply the language-specific
 * bits (binary resolution, spawn args, per-session state, message hooks).
 *
 * Public API (stable across subclasses):
 *   - handleMessage(ws, data)  — forward a WS frame into the LSP
 *   - detach(ws)               — stop and forget a session
 *   - destroy()                — stop every session (server shutdown)
 *
 * Subclasses expose their own public entry points (e.g. `attach(ws)` or
 * `createSession(ws, wtPath)`) that ultimately call `startSession`.
 */
export abstract class StdioLspManager<TSession extends BaseLspSession, TContext = void> {
  protected readonly sessions = new Map<ServerWebSocket<unknown>, TSession>();
  private readonly _sessionsByKey = new Map<string, ServerWebSocket<unknown>>();
  /** Client frames received while an async {@link resolveBinary} runs, replayed once spawned. */
  private readonly _pendingFrames = new Map<ServerWebSocket<unknown>, string[]>();
  /** Each session's file-change forwarder, when {@link forwardWatchedFiles} and it has a worktree. */
  private readonly watchedFiles = new Map<TSession, WatchedFilesForwarder>();
  /** Each session's open document URIs, tracked when {@link didSaveOnFileChange}. */
  private readonly openDocuments = new Map<TSession, Set<string>>();
  protected readonly log: ReturnType<typeof logger.child>;

  constructor(readonly name: LspName) {
    this.log = logger.child(name);
  }

  handleMessage(ws: ServerWebSocket<unknown>, data: string): void {
    const frame = this.forwardWatchedFiles ? withWatchedFilesCapability(data) : data;
    const pending = this._pendingFrames.get(ws);
    if (pending) {
      pending.push(frame);
      return;
    }
    const session = this.sessions.get(ws);
    if (!session) return;
    this.handleClientData(session, frame);
  }

  /**
   * Forward changed files of a worktree, as reported by its file watcher, to the language servers
   * rooted there with a matching file watcher. Only managers with
   * {@link forwardWatchedFiles} have such servers. With {@link didSaveOnFileChange}, changed files
   * the session has open also get `textDocument/didSave`.
   */
  notifyWatchedFilesChanged(wtPath: string, paths: readonly string[]): void {
    const root = path.resolve(wtPath);
    for (const [session, forwarder] of this.watchedFiles) {
      if (forwarder.root === root && this.isSessionLive(session)) forwarder.queue(paths);
    }
    for (const [session, openUris] of this.openDocuments) {
      const workspace = this.getSessionWorkspace(session);
      if (!workspace || path.resolve(workspace) !== root || !this.isSessionLive(session)) continue;
      try {
        for (const uri of paths.map(fileUri)) {
          if (!openUris.has(uri)) continue;
          this.writeToStdin(
            session,
            JSON.stringify({
              jsonrpc: "2.0",
              method: "textDocument/didSave",
              params: { textDocument: { uri } },
            }),
          );
        }
      } catch (err) {
        // A server that has closed its stdin, not yet reaped: this runs in file-watcher callbacks.
        this.log.debug("Could not send didSave", { error: err });
      }
    }
  }

  /**
   * Report a file-watcher event inside a git-ignored directory, at a worktree-relative,
   * `/`-separated path. It goes through {@link notifyWatchedFilesChanged} only when a session
   * rooted there asked for it with {@link watchedIgnoredGlobs}; the rest are dropped. Runs per
   * event, for builds and installs that write thousands of files.
   */
  notifyIgnoredPathChanged(wtPath: string, relPath: string): void {
    if (this.watchedIgnoredGlobs.length === 0) return;
    const root = path.resolve(wtPath);
    for (const forwarder of this.watchedFiles.values()) {
      if (forwarder.root !== root || !forwarder.wantsIgnoredPath(relPath)) continue;
      this.notifyWatchedFilesChanged(wtPath, [path.join(root, relPath)]);
      return;
    }
  }

  detach(ws: ServerWebSocket<unknown>): void {
    this._pendingFrames.delete(ws);
    // Also without a session (still resolving its binary, or it failed to start): the key is
    // claimed from the start.
    for (const [key, mappedWs] of this._sessionsByKey) {
      if (mappedWs === ws) {
        this._sessionsByKey.delete(key);
        break;
      }
    }
    const session = this.sessions.get(ws);
    if (!session) return;
    this.killSession(session);
    this.sessions.delete(ws);
  }

  destroy(): void {
    for (const session of this.sessions.values()) {
      this.killSession(session);
    }
    this.sessions.clear();
    this._sessionsByKey.clear();
    this._pendingFrames.clear();
  }

  // ---------------------------------------------------------------------------
  // Hooks for subclasses

  /**
   * The server binary for a session, or null when none is available. May be
   * async (a lookup in the session's project); frames the client sends
   * meanwhile are held and replayed once the server is spawned.
   */
  protected abstract resolveBinary(context: TContext): string | null | Promise<string | null>;

  protected spawnArgs(_context: TContext): readonly string[] {
    return ["--stdio"];
  }

  /**
   * What to tell the user when this server cannot start or exits, in place of the generic "binary
   * not found" or "exited with code N": a missing runtime, or an error only the server's own log
   * holds. Null keeps the generic text. It is cut to what a WebSocket close frame can carry.
   */
  protected serverFailureReason(_context: TContext): string | null {
    return null;
  }

  protected spawnOptions(_context: TContext): SpawnOptions {
    return {};
  }

  protected abstract buildSession(
    ws: ServerWebSocket<unknown>,
    proc: Subprocess,
    context: TContext,
  ): TSession;

  /**
   * Set to true in subclasses whose server emits buggy semantic-tokens
   * responses (ranges extending beyond line length, encoding mismatches).
   * We strip the capability from the client's initialize request, remove
   * `semanticTokensProvider` from the server's initialize response, and
   * swallow any `client/registerCapability` registration for semantic tokens.
   */
  protected readonly disableSemanticTokens: boolean = false;

  /**
   * Set to true for servers that advertise `TextDocumentSyncKind.Full` or
   * otherwise mis-handle incremental `textDocument/didChange` notifications.
   * When set, we track each document's content from didOpen and apply
   * incremental changes locally, then rewrite every outgoing didChange as a
   * single full-text change. Example: docker-language-server, which overwrites
   * its entire document with each incremental fragment's replacement text.
   */
  protected readonly requiresFullTextSync: boolean = false;

  /**
   * LSP features Monaco must not get from this server: their capability is
   * deleted from the initialize response and their dynamic
   * `client/registerCapability` entries are dropped (the server is told they
   * succeeded), whichever way the server advertises them. Semantic tokens are
   * suppressed as well when `disableSemanticTokens` is set.
   */
  protected readonly suppressedFeatures: readonly SuppressibleFeature[] = [];

  /**
   * Set to true for servers that should hear about on-disk changes to files that are not open
   * (dependencies, config files, edits by git or agents). The `workspace.didChangeWatchedFiles`
   * client capability is added to `initialize`, the server's watcher registrations are answered
   * here instead of reaching the client, and {@link notifyWatchedFilesChanged} forwards matching
   * changes as `workspace/didChangeWatchedFiles`. Needs {@link getSessionWorkspace}: only changes
   * inside the session's worktree are reported, outside its git-ignored directories except for
   * dependency installs under `node_modules` (see `node-modules-changes.ts`) and
   * {@link watchedIgnoredGlobs}.
   */
  protected readonly forwardWatchedFiles: boolean = false;

  /**
   * Worktree-relative globs to report changes for without any registration from the server, for
   * servers that register no watchers of their own and rely on the client to pick them (ESLint).
   * They add to whatever the server registers and apply once the client's `initialized` passed
   * through the base's {@link handleClientData}. Needs {@link forwardWatchedFiles}.
   */
  protected readonly watchedFileGlobs: readonly string[] = [];

  /**
   * Like {@link watchedFileGlobs}, and also matched against events inside git-ignored directories,
   * which reach servers only through this: `build/compile_commands.json` (clangd),
   * `obj/project.assets.json` (C#). Keep them narrow, since build output is the busiest part of
   * a worktree. A manager that must act on such a file itself, rather than tell its server, can
   * override {@link notifyWatchedFilesChanged}. Needs {@link forwardWatchedFiles}.
   */
  protected readonly watchedIgnoredGlobs: readonly string[] = [];

  /**
   * Set to true for servers that only react to `textDocument/didSave` (clangd reparses, and
   * rust-analyzer runs its check): a change the file watcher reports to a document the session has
   * open is sent as one, without text. monaco-lsp-client saves nothing itself, since saving goes
   * through the file routes. The client keeps advertising `didSave: false`: these servers take the
   * notification regardless, and advertising it would have rust-analyzer register it dynamically
   * with a client that cannot send it. A subclass overriding {@link handleClientData} must pass
   * `didOpen` and `didClose` to the base. Needs {@link getSessionWorkspace}.
   */
  protected readonly didSaveOnFileChange: boolean = false;

  /**
   * Return a dedup key for this session context. When non-null, the base class
   * enforces at most one active session per key — if a new WebSocket arrives
   * for a key that already has a session, the old session is killed first.
   *
   * Worktree-scoped managers return `context.wtPath`. Global managers (YAML)
   * return null to opt out of dedup.
   */
  protected getSessionKey(_context: TContext): string | null {
    return null;
  }

  /**
   * Return the worktree path for this session if the server needs
   * `rootUri` / `rootPath` / `workspaceFolders` injected into the
   * `initialize` request. Returns null by default (no injection).
   * Subclasses that carry `wtPath` on their session override this.
   * It is also the single folder the base answers `workspace/workspaceFolders`
   * with, and the root whose file changes reach the server when
   * {@link forwardWatchedFiles} is set.
   */
  protected getSessionWorkspace(_session: TSession): string | null {
    return null;
  }

  /**
   * Return language-server-specific `initializationOptions` to merge into the
   * client's `initialize` request. Returns null by default.
   *
   * Use this for config the server reads once at startup and cannot change
   * later — e.g. Terraform's `indexing.ignoreDirectoryNames`, Astro's
   * `typescript.tsdk` path. For servers that expect push-based config via
   * `workspace/didChangeConfiguration` after initialization, use
   * {@link onClientInitialized}; for servers that pull it, use
   * {@link workspaceConfiguration}.
   */
  protected getInitializationOptions(_session: TSession): Record<string, unknown> | null {
    return null;
  }

  /**
   * Answer the server's `workspace/configuration` requests here instead of
   * forwarding them (monaco-lsp-client does not implement that request).
   * Returns the value for one requested `section`; `null` means unset.
   * `scopeUri` is the resource the server asks about, for settings per file
   * (ESLint's working directory), undefined when it asks for the workspace.
   * Defining it also advertises the `workspace.configuration` client
   * capability in `initialize`, which pull-based servers such as basedpyright
   * need before they ask. Call {@link notifyConfigurationChanged} when an
   * answer would change.
   */
  protected workspaceConfiguration?(
    session: TSession,
    section: string | undefined,
    scopeUri: string | undefined,
  ): Promise<unknown>;

  /**
   * Handle a JSON-RPC frame from the WebSocket client. Default: forward to
   * stdin verbatim, but detect `initialized` and invoke `onClientInitialized`.
   * Subclasses may override completely for URI translation, lifecycle
   * tracking, etc.
   */
  protected handleClientData(session: TSession, data: string): void {
    try {
      const parsed: unknown = JSON.parse(data);
      if (typeof parsed === "object" && parsed !== null && "method" in parsed) {
        const msg = parsed as {
          method: string;
          params?: {
            rootUri?: string | null;
            rootPath?: string | null;
            workspaceFolders?: unknown;
            capabilities?: {
              textDocument?: Record<string, unknown>;
              workspace?: Record<string, unknown>;
            };
            initializationOptions?: Record<string, unknown>;
          };
        };
        if (msg.method === "initialize") {
          if (this.disableSemanticTokens && msg.params?.capabilities?.textDocument) {
            delete msg.params.capabilities.textDocument.semanticTokens;
          }
          if (this.workspaceConfiguration && msg.params?.capabilities) {
            msg.params.capabilities.workspace = {
              ...msg.params.capabilities.workspace,
              configuration: true,
            };
          }
          const workspace = this.getSessionWorkspace(session);
          if (workspace && msg.params) {
            if (!msg.params.rootUri) msg.params.rootUri = fileUri(workspace);
            if (!msg.params.rootPath) msg.params.rootPath = workspace;
            if (!msg.params.workspaceFolders)
              msg.params.workspaceFolders = workspaceFolders(workspace);
          }
          const initOpts = this.getInitializationOptions(session);
          if (initOpts) {
            msg.params ??= {};
            msg.params.initializationOptions = mergeInitOptions(
              msg.params.initializationOptions,
              initOpts,
            );
          }
          this.writeToStdin(session, JSON.stringify(parsed));
          return;
        }
        if (msg.method === "initialized") {
          this.writeToStdin(session, data);
          this.watchedFiles.get(session)?.serverInitialized();
          this.onClientInitialized(session);
          return;
        }
        if (this.didSaveOnFileChange) this.trackOpenDocument(session, parsed);
        if (this.requiresFullTextSync) {
          if (msg.method === "textDocument/didOpen") {
            this.trackDidOpen(session, parsed);
            this.writeToStdin(session, data);
            return;
          }
          if (msg.method === "textDocument/didChange") {
            this.writeToStdin(session, this.rewriteDidChangeToFullText(session, parsed));
            return;
          }
          if (msg.method === "textDocument/didClose") {
            this.trackDidClose(session, parsed);
            this.writeToStdin(session, data);
            return;
          }
        }
      }
    } catch {
      // Not JSON — forward as-is.
    }
    this.writeToStdin(session, data);
  }

  /** Keep {@link openDocuments} current from a client notification. */
  private trackOpenDocument(session: TSession, msg: object): void {
    if (!("method" in msg) || !("params" in msg) || !isRecord(msg.params)) return;
    const { textDocument } = msg.params;
    if (!isRecord(textDocument) || typeof textDocument.uri !== "string") return;
    if (msg.method === "textDocument/didOpen") {
      const openUris = this.openDocuments.get(session) ?? new Set<string>();
      this.openDocuments.set(session, openUris.add(textDocument.uri));
    } else if (msg.method === "textDocument/didClose") {
      this.openDocuments.get(session)?.delete(textDocument.uri);
    }
  }

  /**
   * Record the text carried in a `textDocument/didOpen` notification.
   * Subclasses that override handleClientData but still want full-text sync
   * can call this from their custom path.
   */
  protected trackDidOpen(session: TSession, msg: unknown): void {
    const p = (msg as { params?: { textDocument?: { uri?: string; text?: string } } }).params;
    if (p?.textDocument?.uri && typeof p.textDocument.text === "string") {
      session.documentContents.set(p.textDocument.uri, p.textDocument.text);
    }
  }

  /** Forget the tracked content for a `textDocument/didClose` URI. */
  protected trackDidClose(session: TSession, msg: unknown): void {
    const p = (msg as { params?: { textDocument?: { uri?: string } } }).params;
    if (p?.textDocument?.uri) session.documentContents.delete(p.textDocument.uri);
  }

  /**
   * Apply a `textDocument/didChange` notification's incremental changes to
   * the session-tracked document and return a rewritten JSON-RPC message
   * whose `contentChanges` is a single full-text entry. Safe to call even
   * when the original change was already full-text.
   */
  protected rewriteDidChangeToFullText(session: TSession, msg: unknown): string {
    const params = (msg as { params?: unknown }).params;
    if (typeof params !== "object" || params === null) return JSON.stringify(msg);

    const p = params as {
      textDocument?: { uri?: string; version?: number };
      contentChanges?: LspContentChange[];
    };
    const uri = p.textDocument?.uri;
    const changes = p.contentChanges;
    if (!uri || !Array.isArray(changes)) return JSON.stringify(msg);

    const tracked = session.documentContents.get(uri);
    if (tracked === undefined) {
      // didChange arrived before didOpen — we can't reconstruct full text
      // without the baseline. Forward as-is; the server will see an incremental
      // change it may or may not handle, but at least we don't fabricate state.
      this.log.warn(`didChange for untracked URI, forwarding as-is`, { uri });
      return JSON.stringify(msg);
    }

    let content = tracked;
    for (const change of changes) {
      if (!change.range) {
        content = change.text;
        continue;
      }
      const offsets = buildLineOffsets(content);
      let start = offsetAt(offsets, content.length, change.range.start);
      let end = offsetAt(offsets, content.length, change.range.end);
      // Clamp to [0, content.length] and ensure start <= end so a malformed
      // range can never slice out arbitrary regions.
      start = Math.min(Math.max(0, start), content.length);
      end = Math.min(Math.max(start, end), content.length);
      content = content.slice(0, start) + change.text + content.slice(end);
    }
    session.documentContents.set(uri, content);

    p.contentChanges = [{ text: content }];
    return JSON.stringify(msg);
  }

  /**
   * Fired after the client's `initialized` notification is forwarded.
   *
   * Override to push runtime configuration via `workspace/didChangeConfiguration`
   * for servers whose config protocol is push-based — e.g. YAML's schema
   * mappings. For config the server reads
   * from `initializationOptions` at startup, use {@link getInitializationOptions}.
   */
  protected onClientInitialized(_session: TSession): void {}

  /**
   * Fired once a session is gone: detached, destroyed, or its process
   * exited. May fire more than once for the same session, so overrides must
   * be idempotent. Override to release per-session resources.
   */
  protected onSessionClosed(_session: TSession): void {}

  /**
   * Handle a decoded JSON-RPC frame from the LSP server. Default: forward to
   * the WebSocket verbatim, but scrub semantic-tokens capability/registrations
   * when `disableSemanticTokens` is set. Subclasses may override to translate
   * URIs, reply locally to server→client requests, etc.
   */
  protected handleServerFrame(session: TSession, body: string): void {
    // Surface LSP error responses at info level so misbehaving servers don't
    // fail silently. Parsing happens once; stash the result for reuse below.
    let preparsed: unknown;
    let didParse = false;
    try {
      preparsed = JSON.parse(body);
      didParse = true;
    } catch {
      // Not JSON — skip.
    }
    if (didParse && typeof preparsed === "object" && preparsed !== null) {
      const m = preparsed as {
        id?: number | string;
        method?: string;
        params?: { items?: unknown };
        error?: { code?: number; message?: string; data?: unknown };
      };
      if (
        this.workspaceConfiguration &&
        m.method === "workspace/configuration" &&
        m.id !== undefined &&
        Array.isArray(m.params?.items)
      ) {
        void this.answerWorkspaceConfiguration(session, m.id, m.params.items);
        return;
      }
      // monaco-lsp-client does not implement this request either (Tombi sends it).
      const workspace = this.getSessionWorkspace(session);
      if (workspace && m.method === "workspace/workspaceFolders" && m.id !== undefined) {
        this.writeToStdin(
          session,
          JSON.stringify({ jsonrpc: "2.0", id: m.id, result: workspaceFolders(workspace) }),
        );
        return;
      }
      if (m.error && typeof m.error === "object") {
        this.log.info(`[${this.name}] LSP error response`, {
          code: m.error.code,
          message: m.error.message,
          data: m.error.data,
        });
      }
    }

    const suppressed: readonly SuppressibleFeature[] = this.disableSemanticTokens
      ? [...this.suppressedFeatures, "textDocument/semanticTokens"]
      : this.suppressedFeatures;
    if (suppressed.length > 0) {
      try {
        const parsed = didParse ? preparsed : JSON.parse(body);
        if (typeof parsed === "object" && parsed !== null) {
          const msg = parsed as {
            id?: number | string;
            method?: string;
            params?: { registrations?: Array<{ method?: string }> };
            result?: { capabilities?: Record<string, unknown> };
          };

          // Dynamic registration — drop suppressed entries before they reach
          // Monaco so no provider ever gets registered.
          if (
            msg.method === "client/registerCapability" &&
            Array.isArray(msg.params?.registrations)
          ) {
            const filtered = msg.params.registrations.filter(
              (r) => !suppressed.some((method) => method === r?.method),
            );
            if (filtered.length === 0 && msg.id !== undefined) {
              this.writeToStdin(
                session,
                JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null }),
              );
              return;
            }
            msg.params.registrations = filtered;
            session.ws.send(JSON.stringify(parsed));
            return;
          }

          // initialize response — strip the suppressed capabilities so Monaco
          // never registers a provider in the first place.
          if (msg.id !== undefined && msg.result?.capabilities) {
            const caps = msg.result.capabilities;
            const present = suppressed
              .map((method) => SERVER_CAPABILITY_OF[method])
              .filter((key) => key in caps);
            if (present.length > 0) {
              for (const key of present) delete caps[key];
              session.ws.send(JSON.stringify(parsed));
              return;
            }
          }
        }
      } catch {
        // Not JSON — fall through to raw forward.
      }
    }
    session.ws.send(body);
  }

  // ---------------------------------------------------------------------------
  // Primitives for subclasses

  /**
   * Start a new subprocess session bound to this WebSocket. Safe to call when
   * a prior session exists on the same WS — the old one is killed first.
   */
  protected startSession(ws: ServerWebSocket<unknown>, context: TContext): void {
    this.detach(ws);

    const key = this.getSessionKey(context);
    if (key) {
      const existingWs = this._sessionsByKey.get(key);
      if (existingWs && existingWs !== ws) {
        this.detach(existingWs);
        try {
          existingWs.close(LSP_REPLACED_CLOSE_CODE, "Replaced by newer connection");
        } catch (err) {
          this.log.debug("close() on replaced WebSocket threw (already closed)", { error: err });
        }
      }
      this._sessionsByKey.set(key, ws);
    }

    const bin = this.resolveBinary(context);
    if (!(bin instanceof Promise)) {
      this.spawnSession(ws, context, bin);
      return;
    }
    const frames: string[] = [];
    this._pendingFrames.set(ws, frames);
    void bin
      .catch((err: unknown) => {
        this.log.error(`${this.name} binary resolution failed`, { error: err });
        return null;
      })
      .then((resolved) => {
        // Detached (or replaced by a newer connection) while resolving.
        if (this._pendingFrames.get(ws) !== frames) return;
        this._pendingFrames.delete(ws);
        this.spawnSession(ws, context, resolved);
        const session = this.sessions.get(ws);
        if (!session) return;
        for (const frame of frames) this.handleClientData(session, frame);
      });
  }

  /**
   * Spawn the server for `ws`, or, when it cannot start, release `ws`'s session and close it with
   * {@link LSP_START_FAILED_CLOSE_CODE}: nothing else would answer the client's `initialize`, so it
   * fails visibly.
   */
  private spawnSession(ws: ServerWebSocket<unknown>, context: TContext, bin: string | null): void {
    let reason: string;
    if (bin) {
      try {
        this.spawnProcess(ws, context, bin);
        return;
      } catch (err) {
        // E.g. `Bun.spawn` throwing synchronously because the binary cannot be executed (EACCES,
        // ENOEXEC).
        this.log.error(`${this.name} failed to start`, { error: err });
        reason = `${this.name} failed to start`;
      }
    } else {
      this.log.error(`${this.name} binary not found`);
      reason = `${this.name} binary not found — is it installed?`;
    }
    this.detach(ws);
    ws.close(LSP_START_FAILED_CLOSE_CODE, this.failureCloseReason(context, reason));
  }

  private spawnProcess(ws: ServerWebSocket<unknown>, context: TContext, bin: string): void {
    const args = this.spawnArgs(context);
    const opts = this.spawnOptions(context);
    this.log.info(`Spawning ${this.name} ${args.join(" ")}: ${bin}`);

    const proc = Bun.spawn([bin, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: opts.cwd,
      // Login-shell environment, so servers that run user tools (basedpyright's
      // interpreter probe, terraform-ls's `terraform`) find the user's PATH
      // even when Loxel was launched from Finder.
      env: { ...buildSpawnEnv(), NODE_OPTIONS: "", ...opts.env },
    });

    // Until it is in `sessions` nothing else would kill the process (`detach` finds the session there).
    let session: TSession;
    try {
      session = this.buildSession(ws, proc, context);
    } catch (err) {
      proc.kill();
      throw err;
    }
    this.sessions.set(ws, session);
    // From the start, so changes made before the server registers its watchers reach it too.
    const watchedRoot = this.forwardWatchedFiles ? this.getSessionWorkspace(session) : null;
    if (watchedRoot) {
      const forwarder = new WatchedFilesForwarder(path.resolve(watchedRoot), (changes) =>
        this.sendWatchedFilesChanged(session, changes),
      );
      forwarder.declareWatchers(this.watchedFileGlobs, this.watchedIgnoredGlobs);
      this.watchedFiles.set(session, forwarder);
    }

    // Per-session token bucket to cap stderr volume so a chatty LSP (e.g.
    // terraform-ls's workspace-walker spew) can't evict useful entries from
    // the shared ring buffer or chew disk on the rotating log file. Dropped
    // lines are counted and summarized on a timer / at process exit so the
    // throttling is observable.
    const throttle = createStderrThrottle({
      capacity: STDERR_THROTTLE_CAPACITY,
      refillPerSec: STDERR_THROTTLE_REFILL_PER_SEC,
      flushIntervalMs: STDERR_THROTTLE_FLUSH_INTERVAL_MS,
      onSummary: (droppedCount) => {
        this.log.debug(`[${this.name} stderr suppressed]`, { droppedCount });
      },
    });

    const recentStderrLines: string[] = [];

    this.readStdout(session);
    const stderrDone = this.readStderr(proc, throttle, recentStderrLines);

    proc.exited.then(async (code) => {
      this.log.info(`${this.name} exited with code ${code}`);
      throttle.dispose();
      // Wait for the stderr stream to drain before checking recent lines —
      // proc.exited may resolve before the last stderr chunk is delivered.
      await stderrDone;
      if (code !== null && code !== 0) {
        this.log.warn(`${this.name} stderr before exit (code ${code})`, {
          stderr: recentStderrLines.join("\n") || "(empty)",
        });
      }
      this.releaseSession(session);
      // Still live: it exited on its own (crash, out of memory, killed outside Loxel), not through
      // `detach` / `destroy`. The socket would otherwise stay open with nothing answering it, so
      // release the session's key and close the socket, which tells the client to reconnect.
      if (!this.isSessionLive(session)) return;
      this.detach(ws);
      try {
        const how = proc.signalCode
          ? `was killed by ${proc.signalCode}`
          : `exited with code ${code}`;
        ws.close(LSP_EXITED_CLOSE_CODE, this.failureCloseReason(context, `${this.name} ${how}`));
      } catch (err) {
        this.log.debug("close() on an exited server's WebSocket threw (already closed)", {
          error: err,
        });
      }
    });
  }

  /** Have every client reconnect to a fresh server, one that reads its schemas again. */
  restartSessions(reason: string): void {
    for (const { ws } of [...this.sessions.values()]) {
      this.detach(ws);
      ws.close(LSP_RESTART_CLOSE_CODE, reason);
    }
  }

  /** The close reason for a failed server; a throwing hook must not keep the socket from closing. */
  private failureCloseReason(context: TContext, generic: string): string {
    try {
      return closeReason(this.serverFailureReason(context) ?? generic);
    } catch (err) {
      this.log.warn(`${this.name} failure reason threw`, { error: err });
      return closeReason(generic);
    }
  }

  /** True while `session` is still the live session of its WebSocket. */
  protected isSessionLive(session: TSession): boolean {
    return this.sessions.get(session.ws) === session;
  }

  /**
   * Tell the server its configuration changed. Sends `settings: null`, so a
   * server that pulls configuration asks {@link workspaceConfiguration} again.
   */
  protected notifyConfigurationChanged(session: TSession): void {
    this.writeToStdin(
      session,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "workspace/didChangeConfiguration",
        params: { settings: null },
      }),
    );
  }

  /** Write a JSON-RPC message to the LSP stdin with Content-Length framing. */
  protected writeToStdin(session: TSession, json: string): void {
    const stdin = session.proc.stdin as FileSink | undefined;
    if (!stdin) return;
    const body = Buffer.from(json, "utf-8");
    const header = `Content-Length: ${body.byteLength}\r\n\r\n`;
    stdin.write(header);
    stdin.write(body);
    // Bun buffers FileSink writes — flush to ensure the subprocess receives
    // each message promptly instead of waiting for the buffer to fill.
    stdin.flush();
  }

  /**
   * Resolve a binary by checking, in order: sibling of the running executable
   * (standalone deployment), a dev-mode path, then the ambient PATH.
   *
   * When `devPath` is provided (absolute path to a binary in `build/`), it is
   * checked instead of `node_modules/.bin`. Use this for pre-built binaries
   * that are downloaded or extracted rather than npm-installed.
   */
  protected resolveBundledBinary(binaryName: string, devPath?: string): string | null {
    const sibling = path.join(path.dirname(process.execPath), binaryName);
    if (Bun.file(sibling).size) return sibling;

    if (devPath) {
      if (Bun.file(devPath).size) return devPath;
    } else {
      const localBin = path.resolve(import.meta.dir, "../../node_modules/.bin/", binaryName);
      if (Bun.file(localBin).size) return localBin;
    }

    const found = Bun.which(binaryName, { PATH: buildSpawnEnv().PATH ?? "" });
    // It may have been installed since the login-shell PATH was captured; the next start retries.
    if (!found) void refreshLoginShellEnv();
    return found;
  }

  // ---------------------------------------------------------------------------

  private killSession(session: TSession): void {
    this.releaseSession(session);
    try {
      session.proc.kill();
    } catch {
      // Already dead
    }
  }

  private releaseSession(session: TSession): void {
    this.watchedFiles.get(session)?.dispose();
    this.watchedFiles.delete(session);
    this.openDocuments.delete(session);
    this.onSessionClosed(session);
  }

  /**
   * Take the server's `workspace/didChangeWatchedFiles` (un)registrations out of a
   * `client/registerCapability` / `client/unregisterCapability` request before it reaches the
   * client, which cannot watch files: remember the watchers and acknowledge the request, or pass
   * on what remains when it carries other registrations too. True when the frame was consumed.
   */
  private interceptWatchedFilesRegistration(session: TSession, body: string): boolean {
    if (!this.forwardWatchedFiles) return false;
    const request = splitWatchedFilesRegistration(body);
    if (!request) return false;
    const forwarder = this.watchedFiles.get(session);
    // None: the session is gone (drop the frame) or has no worktree (leave it to the client).
    if (!forwarder) return !this.isSessionLive(session);

    for (const entry of request.entries) {
      if (request.register) forwarder.register(entry.id, entry.registerOptions);
      else forwarder.unregister(entry.id);
    }

    if (request.remainder === null) {
      this.writeToStdin(
        session,
        JSON.stringify({ jsonrpc: "2.0", id: request.requestId, result: null }),
      );
    } else {
      this.handleServerFrame(session, request.remainder);
    }
    return true;
  }

  private sendWatchedFilesChanged(session: TSession, changes: FileEvent[]): void {
    if (!this.isSessionLive(session)) return;
    this.writeToStdin(
      session,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "workspace/didChangeWatchedFiles",
        params: { changes },
      }),
    );
  }

  private async answerWorkspaceConfiguration(
    session: TSession,
    id: number | string,
    items: unknown[],
  ): Promise<void> {
    let result: unknown[];
    try {
      result = await Promise.all(
        items.map((item) => {
          const { section, scopeUri } = isRecord(item) ? item : {};
          return this.workspaceConfiguration?.(
            session,
            typeof section === "string" ? section : undefined,
            typeof scopeUri === "string" ? scopeUri : undefined,
          );
        }),
      );
    } catch (err) {
      this.log.warn(`[${this.name}] workspace/configuration answer failed`, { error: err });
      result = items.map(() => null);
    }
    if (!this.isSessionLive(session)) return;
    this.writeToStdin(session, JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private async readStdout(session: TSession): Promise<void> {
    const stdout = session.proc.stdout as ReadableStream<Uint8Array> | undefined;
    if (!stdout) return;

    const reader = stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        session.stdoutBuf = Buffer.concat([session.stdoutBuf, Buffer.from(value)]);
        this.drainMessages(session);
      }
    } catch {
      // Process exited
    }
  }

  private drainMessages(session: TSession): void {
    while (true) {
      const headerEnd = session.stdoutBuf.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = session.stdoutBuf.subarray(0, headerEnd).toString("utf-8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        session.stdoutBuf = session.stdoutBuf.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1]!, 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (session.stdoutBuf.byteLength < messageEnd) break;

      const body = session.stdoutBuf.subarray(messageStart, messageEnd).toString("utf-8");
      session.stdoutBuf = session.stdoutBuf.subarray(messageEnd);

      if (this.interceptWatchedFilesRegistration(session, body)) continue;
      this.handleServerFrame(session, body);
    }
  }

  private async readStderr(
    proc: Subprocess,
    throttle: StderrThrottle,
    recentLines: string[],
  ): Promise<void> {
    const stderr = proc.stderr as ReadableStream<Uint8Array> | undefined;
    if (!stderr) return;

    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // `reader.read()` delivers multi-line chunks — counting tokens per
        // chunk would let a 1000-line burst through on a single token. Split
        // on newlines and consume per non-empty line so the throttle actually
        // rate-caps lines (and "dropped" counts lines, not chunks).
        // Note: `{ stream: true }` can cosmetically split a line mid-buffer
        // across chunks; we accept that for stderr (a few partial lines at
        // worst) rather than buffer across reads.
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          // Keep a rolling window of the last 20 lines for non-zero exit diagnostics.
          recentLines.push(trimmed);
          if (recentLines.length > 20) recentLines.shift();
          if (throttle.tryConsume()) {
            this.log.debug(`[${this.name} stderr] ${trimmed}`);
          }
        }
      }
    } catch {
      // Process exited
    }
  }
}

/**
 * Base for servers run one per worktree: started in the worktree, rooted at it (`rootUri`,
 * `workspaceFolders`, watched files), and replaced when a newer connection asks for the same
 * worktree. Subclasses supply what differs per server: the binary, its arguments and settings.
 */
export abstract class WorktreeLspManager extends StdioLspManager<WtLspSession, WtLspContext> {
  createSession(ws: ServerWebSocket<unknown>, wtPath: string): void {
    this.startSession(ws, { wtPath });
  }

  destroySession(ws: ServerWebSocket<unknown>): void {
    this.detach(ws);
  }

  protected override spawnOptions(context: WtLspContext): SpawnOptions {
    return { cwd: context.wtPath };
  }

  protected buildSession(
    ws: ServerWebSocket<unknown>,
    proc: Subprocess,
    context: WtLspContext,
  ): WtLspSession {
    return {
      ws,
      proc,
      wtPath: context.wtPath,
      stdoutBuf: Buffer.alloc(0),
      documentContents: new Map(),
    };
  }

  protected override getSessionKey(context: WtLspContext): string {
    return context.wtPath;
  }

  protected override getSessionWorkspace(session: WtLspSession): string {
    return session.wtPath;
  }
}

/**
 * Merge server-supplied `initializationOptions` into the client-supplied ones.
 * One level deep: nested plain objects are merged key-by-key, everything else
 * is replaced. The client's values win over the server's on shallow keys to
 * preserve caller intent; nested object keys from the server are added only
 * where the client didn't already specify them.
 */
function mergeInitOptions(
  existing: Record<string, unknown> | undefined,
  add: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(existing ?? {}) };
  for (const [key, addValue] of Object.entries(add)) {
    const existingValue = out[key];
    if (isRecord(existingValue) && isRecord(addValue)) {
      out[key] = { ...addValue, ...existingValue };
    } else if (existingValue === undefined) {
      out[key] = addValue;
    }
  }
  return out;
}

/**
 * `reason` cut, at a character boundary, to what a close frame carries. Bun sends a longer one
 * anyway, which the browser rejects as an invalid frame, losing the close code as well.
 */
function closeReason(reason: string): string {
  let cut = "";
  let bytes = 0;
  for (const char of reason) {
    bytes += Buffer.byteLength(char);
    if (bytes > MAX_CLOSE_REASON_BYTES) break;
    cut += char;
  }
  return cut;
}

/** The session's single workspace folder, as `initialize` and `workspace/workspaceFolders` carry it. */
export function workspaceFolders(workspace: string): { uri: string; name: string }[] {
  return [{ uri: fileUri(workspace), name: path.basename(workspace) || workspace }];
}

function buildLineOffsets(content: string): number[] {
  const offsets = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

function offsetAt(lineOffsets: number[], totalLength: number, pos: LspPosition): number {
  const base = lineOffsets[pos.line];
  if (base === undefined) return totalLength;
  return Math.min(base + pos.character, totalLength);
}
