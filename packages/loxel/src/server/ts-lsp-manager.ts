import type { ServerWebSocket, Subprocess } from "bun";

import {
  type BaseLspSession,
  type LspPosition,
  type SpawnOptions,
  StdioLspManager,
  buildLineOffsets,
  offsetAt,
} from "./stdio-lsp-manager";
import { selectTsLspBackend } from "./ts-lsp-backend";

const backend = selectTsLspBackend();

const TS_EXTENSIONS = /\.(ts|tsx|js|jsx|mts|mjs|cts|cjs|json|jsonc)$/i;

interface PendingRequest {
  method: string;
  /** loxel:// textDocument URI (if scoped to a document). */
  uri?: string;
}

interface DocumentState {
  content: string;
  /** Monotonically incremented on every didChange for this URI. */
  version: number;
}

interface TsLspSession extends BaseLspSession {
  wtPath: string;
  pendingRequests: Map<number | string, PendingRequest>;
  /**
   * Loxel URI → full text + version, kept in sync from client didOpen/didChange.
   * Separate from the base's `documentContents` because TS tracks a document
   * version in addition to the text.
   */
  tsDocuments: Map<string, DocumentState>;
}

interface TsLspContext {
  wtPath: string;
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
 * Manages `tsgo --lsp -stdio` child processes, one per WebSocket connection.
 * Each `/ws/ts-lsp?wt=<path>` connection gets its own tsgo rooted at the
 * worktree path. Translates loxel://HEAD/... ↔ file:///... URIs and augments
 * semantic token responses with custom JSX tokens.
 */
export class TsLspManager extends StdioLspManager<TsLspSession, TsLspContext> {
  constructor() {
    super("ts-lsp");
  }

  createSession(ws: ServerWebSocket<unknown>, wtPath: string): void {
    this.startSession(ws, { wtPath });
  }

  destroySession(ws: ServerWebSocket<unknown>): void {
    this.detach(ws);
  }

  // ---------------------------------------------------------------------------
  // Hooks

  protected resolveBinary(): string | null {
    return backend.resolveBinary();
  }

  protected override getSessionKey(context: TsLspContext): string {
    return context.wtPath;
  }

  protected override spawnArgs(): readonly string[] {
    return backend.spawnArgs;
  }

  protected override spawnOptions(context: TsLspContext): SpawnOptions {
    return { cwd: context.wtPath };
  }

  protected override buildSession(
    ws: ServerWebSocket<unknown>,
    proc: Subprocess,
    context: TsLspContext,
  ): TsLspSession {
    return {
      ws,
      proc,
      wtPath: context.wtPath,
      stdoutBuf: Buffer.alloc(0),
      documentContents: new Map(),
      pendingRequests: new Map(),
      tsDocuments: new Map(),
    };
  }

  protected override handleClientData(session: TsLspSession, data: string): void {
    let outgoing = data;
    try {
      const parsed: unknown = JSON.parse(data);
      if (typeof parsed === "object" && parsed !== null) {
        const msg = parsed as { id?: number | string; method?: string; params?: unknown };

        if (msg.method !== undefined) {
          if (this.shouldDropForNonTsUri(msg.method, msg.params)) return;

          const mutated = this.trackDocumentLifecycle(session, msg.method, msg.params);

          if (msg.id !== undefined) {
            const pending: PendingRequest = { method: msg.method };
            const params = msg.params;
            if (
              typeof params === "object" &&
              params !== null &&
              "textDocument" in params &&
              typeof (params as { textDocument: unknown }).textDocument === "object" &&
              (params as { textDocument: { uri?: unknown } }).textDocument !== null
            ) {
              const uri = (params as { textDocument: { uri?: unknown } }).textDocument.uri;
              if (typeof uri === "string") pending.uri = uri;
            }
            session.pendingRequests.set(msg.id, pending);
          }

          // Inject rootUri/workspaceFolders so tsgo knows which project to load.
          if (msg.method === "initialize") {
            outgoing = this.augmentInitializeRequest(session, parsed as Record<string, unknown>);
          } else if (mutated) {
            outgoing = JSON.stringify(parsed);
          }

          // After server acks init, push TS preferences so tsgo enables
          // module-export completions, inlay hints, etc. in steady state too.
          if (msg.method === "initialized") {
            queueMicrotask(() => this.sendConfigUpdate(session));
          }
        }
      }
    } catch {
      // Not JSON — forward verbatim.
    }

    // Translate loxel://HEAD/... → file:///... so tsgo sees real file paths.
    // Case-insensitive because Monaco may preserve or normalize the authority
    // component depending on URI construction path.
    const translated = outgoing.replace(/loxel:\/\/head\//gi, "file:///");
    this.writeToStdin(session, translated);
  }

  protected override handleServerFrame(session: TsLspSession, body: string): void {
    // Server→client requests we fulfill locally (tsgo blocks on
    // workspace/configuration until we answer).
    if (this.handleServerRequest(session, body)) return;

    const intercepted = this.interceptServerMessage(session, body);
    // An empty string means the interceptor consumed the message.
    if (intercepted === "") return;

    // Translate file:///... → loxel://HEAD/... for the client. Matches the
    // authority casing CodeEditorPanel uses when constructing model URIs.
    const translated = intercepted.replaceAll("file:///", "loxel://HEAD/");
    session.ws.send(translated);
  }

  // ---------------------------------------------------------------------------

  private sendConfigUpdate(session: TsLspSession): void {
    const msg = JSON.stringify({
      jsonrpc: "2.0",
      method: "workspace/didChangeConfiguration",
      params: {
        settings: {
          typescript: {
            preferences: {
              includeCompletionsForModuleExports: true,
              includeCompletionsForImportStatements: true,
              includeCompletionsWithInsertText: true,
              includeCompletionsWithSnippetText: true,
              includeAutomaticOptionalChainCompletions: true,
              allowIncompleteCompletions: true,
              importModuleSpecifierPreference: "shortest",
              includePackageJsonAutoImports: "auto",
            },
          },
          javascript: {
            preferences: {
              includeCompletionsForModuleExports: true,
              includeCompletionsForImportStatements: true,
              includeCompletionsWithInsertText: true,
              allowIncompleteCompletions: true,
            },
          },
        },
      },
    });
    this.writeToStdin(session, msg);
  }

  private augmentInitializeRequest(session: TsLspSession, msg: Record<string, unknown>): string {
    const rootUri = `file://${session.wtPath}`;
    const workspaceName = session.wtPath.split("/").pop() || session.wtPath;
    const params = (msg.params as Record<string, unknown> | undefined) ?? {};
    params.rootUri = rootUri;
    params.rootPath = session.wtPath;
    params.workspaceFolders = [{ uri: rootUri, name: workspaceName }];
    params.initializationOptions = {
      preferences: {
        includeCompletionsForModuleExports: true,
        includeCompletionsForImportStatements: true,
        includeCompletionsWithInsertText: true,
        includeCompletionsWithSnippetText: true,
        includeAutomaticOptionalChainCompletions: true,
        allowIncompleteCompletions: true,
      },
    };
    msg.params = params;
    return JSON.stringify(msg);
  }

  /** Returns true if the params object was mutated and must be re-serialized. */
  private trackDocumentLifecycle(session: TsLspSession, method: string, params: unknown): boolean {
    if (typeof params !== "object" || params === null) return false;
    let mutated = false;

    if (method === "textDocument/didOpen") {
      const p = params as { textDocument?: { uri?: string; text?: string; languageId?: string } };
      if (p.textDocument?.uri && typeof p.textDocument.text === "string") {
        session.tsDocuments.set(p.textDocument.uri, { content: p.textDocument.text, version: 0 });
      }
      // Monaco reports `tsx`/`jsx` for .tsx/.jsx files, but LSP
      // needs `typescriptreact`/`javascriptreact` for tsgo to enable JSX mode.
      if (p.textDocument?.uri) {
        const uri = p.textDocument.uri;
        const current = p.textDocument.languageId;
        if (/\.tsx$/i.test(uri) && current !== "typescriptreact") {
          p.textDocument.languageId = "typescriptreact";
          mutated = true;
        } else if (/\.jsx$/i.test(uri) && current !== "javascriptreact") {
          p.textDocument.languageId = "javascriptreact";
          mutated = true;
        }
      }
    } else if (method === "textDocument/didChange") {
      const p = params as { textDocument?: { uri?: string }; contentChanges?: LspContentChange[] };
      const uri = p.textDocument?.uri;
      const changes = p.contentChanges;
      if (!uri || !Array.isArray(changes)) return mutated;
      const state = session.tsDocuments.get(uri);
      if (state === undefined) return mutated;
      let content = state.content;
      for (const change of changes) {
        if (!change.range) {
          content = change.text;
          continue;
        }
        const offsets = buildLineOffsets(content);
        const start = offsetAt(offsets, content.length, change.range.start);
        const end = offsetAt(offsets, content.length, change.range.end);
        content = content.slice(0, start) + change.text + content.slice(end);
      }
      session.tsDocuments.set(uri, { content, version: state.version + 1 });
    } else if (method === "textDocument/didClose") {
      const p = params as { textDocument?: { uri?: string } };
      if (p.textDocument?.uri) session.tsDocuments.delete(p.textDocument.uri);
    }
    return mutated;
  }

  /**
   * Drop textDocument/* notifications/requests whose URI targets a file tsgo
   * doesn't understand (e.g. `.astro`, `.vue`). The TS LSP client has no
   * languageId filter, so Monaco sends every open model to us.
   */
  private shouldDropForNonTsUri(method: string, params: unknown): boolean {
    if (!method.startsWith("textDocument/")) return false;
    const uri = (params as { textDocument?: { uri?: string } } | null)?.textDocument?.uri;
    if (!uri) return false;
    return !TS_EXTENSIONS.test(uri);
  }

  /**
   * Handle server→client requests locally (don't forward to the WebSocket
   * client). Returns true if consumed. tsgo sends `workspace/configuration`
   * immediately after `initialized` and blocks until it's answered — so we
   * reply inline with our canned TS/JS preferences.
   */
  private handleServerRequest(session: TsLspSession, body: string): boolean {
    let msg: unknown;
    try {
      msg = JSON.parse(body);
    } catch {
      return false;
    }
    if (typeof msg !== "object" || msg === null) return false;
    const m = msg as { id?: number | string; method?: string; params?: unknown };
    if (m.id === undefined || typeof m.method !== "string") return false;

    if (m.method === "workspace/configuration") {
      const items = ((m.params as { items?: unknown[] } | undefined)?.items ?? []) as Array<{
        section?: string;
      }>;
      const prefs = {
        includeCompletionsForModuleExports: true,
        includeCompletionsForImportStatements: true,
        includeCompletionsWithInsertText: true,
        includeCompletionsWithSnippetText: true,
        includeAutomaticOptionalChainCompletions: true,
        allowIncompleteCompletions: true,
        importModuleSpecifierPreference: "shortest" as const,
        includePackageJsonAutoImports: "auto" as const,
      };
      const result = items.map((item) => {
        const section = (item.section ?? "").toLowerCase();
        if (section === "typescript" || section === "javascript" || section === "js/ts") {
          return { preferences: prefs };
        }
        return {};
      });
      this.writeToStdin(session, JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
      return true;
    }

    // client/(un)registerCapability: DO NOT swallow. tsgo announces the
    // semantic-tokens capability dynamically via client/registerCapability,
    // and if we ack it locally the real Monaco client never sees the
    // registration — so no semantic-token provider is registered and our
    // JSX augmentation has no provider legend to sit on.
    if (m.method === "client/registerCapability" || m.method === "client/unregisterCapability") {
      return false;
    }

    if (m.method === "window/workDoneProgress/create") {
      this.writeToStdin(session, JSON.stringify({ jsonrpc: "2.0", id: m.id, result: null }));
      return true;
    }

    return false;
  }

  private interceptServerMessage(session: TsLspSession, body: string): string {
    let msg: unknown;
    try {
      msg = JSON.parse(body);
    } catch {
      return body;
    }
    if (typeof msg !== "object" || msg === null || !("id" in msg) || !("result" in msg)) {
      return body;
    }

    const response = msg as { id: number | string; result: unknown };
    const pending = session.pendingRequests.get(response.id);
    if (!pending) return body;
    session.pendingRequests.delete(response.id);

    return body;
  }
}
