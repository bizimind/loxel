import path from "node:path";

import type { FileSink, ServerWebSocket, Subprocess } from "bun";

import type { LogCategory } from "@/api/log-entry-model";

import { logger } from "./logger";
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

export interface LspPosition {
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
  protected readonly log: ReturnType<typeof logger.child>;

  constructor(protected readonly name: LogCategory) {
    this.log = logger.child(name);
  }

  handleMessage(ws: ServerWebSocket<unknown>, data: string): void {
    const session = this.sessions.get(ws);
    if (!session) return;
    this.handleClientData(session, data);
  }

  detach(ws: ServerWebSocket<unknown>): void {
    const session = this.sessions.get(ws);
    if (!session) return;
    this.killSession(session);
    this.sessions.delete(ws);
    for (const [key, mappedWs] of this._sessionsByKey) {
      if (mappedWs === ws) {
        this._sessionsByKey.delete(key);
        break;
      }
    }
  }

  destroy(): void {
    for (const session of this.sessions.values()) {
      this.killSession(session);
    }
    this.sessions.clear();
    this._sessionsByKey.clear();
  }

  // ---------------------------------------------------------------------------
  // Hooks for subclasses

  protected abstract resolveBinary(): string | null;

  protected spawnArgs(): readonly string[] {
    return ["--stdio"];
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
   * `typescript.tsdk` path, Pyright's analysis settings. For servers that
   * expect push-based config via `workspace/didChangeConfiguration` after
   * initialization, use {@link onClientInitialized} instead.
   */
  protected getInitializationOptions(_session: TSession): Record<string, unknown> | null {
    return null;
  }

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
            capabilities?: { textDocument?: Record<string, unknown> };
            initializationOptions?: Record<string, unknown>;
          };
        };
        if (msg.method === "initialize") {
          if (this.disableSemanticTokens && msg.params?.capabilities?.textDocument) {
            delete msg.params.capabilities.textDocument.semanticTokens;
          }
          const workspace = this.getSessionWorkspace(session);
          if (workspace && msg.params) {
            const rootUri = `file://${workspace}`;
            if (!msg.params.rootUri) msg.params.rootUri = rootUri;
            if (!msg.params.rootPath) msg.params.rootPath = workspace;
            if (!msg.params.workspaceFolders) {
              msg.params.workspaceFolders = [
                { uri: rootUri, name: path.basename(workspace) || workspace },
              ];
            }
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
          this.onClientInitialized(session);
          return;
        }
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
   * for servers whose config protocol is push-based — e.g. Docker's compose/
   * telemetry settings, YAML's schema mappings. For config the server reads
   * from `initializationOptions` at startup, use {@link getInitializationOptions}.
   */
  protected onClientInitialized(_session: TSession): void {}

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
      const m = preparsed as { error?: { code?: number; message?: string; data?: unknown } };
      if (m.error && typeof m.error === "object") {
        this.log.info(`[${this.name}] LSP error response`, {
          code: m.error.code,
          message: m.error.message,
          data: m.error.data,
        });
      }
    }

    if (this.disableSemanticTokens) {
      try {
        const parsed = didParse ? preparsed : JSON.parse(body);
        if (typeof parsed === "object" && parsed !== null) {
          const msg = parsed as {
            id?: number | string;
            method?: string;
            params?: { registrations?: Array<{ method?: string }> };
            result?: { capabilities?: Record<string, unknown> };
          };

          // Dynamic registration — drop semantic-tokens entries before they
          // reach Monaco so no provider ever gets registered.
          if (
            msg.method === "client/registerCapability" &&
            Array.isArray(msg.params?.registrations)
          ) {
            const filtered = msg.params.registrations.filter(
              (r) => r?.method !== "textDocument/semanticTokens",
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

          // initialize response — strip semanticTokensProvider so Monaco
          // never registers a provider in the first place.
          if (msg.id !== undefined && msg.result?.capabilities) {
            if ("semanticTokensProvider" in msg.result.capabilities) {
              delete msg.result.capabilities.semanticTokensProvider;
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
          existingWs.close(4000, "Replaced by newer connection");
        } catch (err) {
          this.log.debug("close() on replaced WebSocket threw (already closed)", { error: err });
        }
      }
      this._sessionsByKey.set(key, ws);
    }

    const bin = this.resolveBinary();
    if (!bin) {
      this.log.error(`${this.name} binary not found`);
      ws.close(4001, `${this.name} binary not found — is it installed?`);
      return;
    }

    const args = this.spawnArgs();
    const opts = this.spawnOptions(context);
    this.log.info(`Spawning ${this.name} ${args.join(" ")}: ${bin}`);

    const proc = Bun.spawn([bin, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: opts.cwd,
      env: { ...process.env, NODE_OPTIONS: "", ...opts.env },
    });

    const session = this.buildSession(ws, proc, context);
    this.sessions.set(ws, session);

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
      if (this.sessions.get(ws) === session) {
        this.sessions.delete(ws);
      }
    });
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

    return Bun.which(binaryName);
  }

  // ---------------------------------------------------------------------------

  private killSession(session: TSession): void {
    try {
      session.proc.kill();
    } catch {
      // Already dead
    }
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
    if (isPlainObject(existingValue) && isPlainObject(addValue)) {
      out[key] = { ...addValue, ...existingValue };
    } else if (existingValue === undefined) {
      out[key] = addValue;
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildLineOffsets(content: string): number[] {
  const offsets = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

export function offsetAt(lineOffsets: number[], totalLength: number, pos: LspPosition): number {
  const base = lineOffsets[pos.line];
  if (base === undefined) return totalLength;
  return Math.min(base + pos.character, totalLength);
}
