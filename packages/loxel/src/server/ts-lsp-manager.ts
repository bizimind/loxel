import { fileURLToPath } from "node:url";

import {
  DOCUMENT_INDENTATION_METHOD,
  type DocumentIndentation,
  documentIndentationParamsSchema,
} from "@/api/lsp-indentation-model";
import { isRecord } from "@/lib/is-record";
import { TS_SOURCE_EXTENSIONS } from "@/lib/typescript-files";

import { fileUri } from "./lsp-file-uri";
import { WorktreeLspManager, type WtLspSession, workspaceFolders } from "./stdio-lsp-manager";
import { resolveTypeScriptBinary } from "./typescript-path";

const TS_EXTENSIONS = new RegExp(
  `\\.(?:${[...TS_SOURCE_EXTENSIONS, "json", "jsonc"].join("|")})$`,
  "i",
);

/**
 * JSON paths: their live editor models use `file://` URIs (`fileSchemeLanguages`),
 * unlike TS/JS models, which use `loxel://HEAD/`.
 */
const JSON_PATH = /\.jsonc?$/i;

/**
 * Translate a client→server JSON-RPC body: `loxel://HEAD/<abs path>` (TS/JS editor models) →
 * `file:///<abs path>`. Case-insensitive because Monaco's `Uri.toString()` lowercases the
 * authority. `file://` URIs (JSON editor models) pass through.
 */
export function toServerUris(body: string): string {
  return body.replace(/loxel:\/\/head\//gi, "file:///");
}

/**
 * Translate a server→client JSON-RPC body: `file:///<abs path>` → `loxel://HEAD/<abs path>`, the
 * URI of a TS/JS editor model (and the authority casing CodeEditorPanel uses), so diagnostics,
 * references and edits land on the open models. JSON files keep `file://`, which is what their
 * editor models use.
 */
export function toClientUris(body: string): string {
  // The path runs until the end of the JSON string, a markdown link or the URI's query/fragment.
  return body.replace(/file:\/\/\/([^\s"'\\#?()<>[\]`]*)/g, (uri: string, uriPath: string) =>
    JSON_PATH.test(uriPath) ? uri : `loxel://HEAD/${uriPath}`,
  );
}

/**
 * TypeScript 7's user preferences, by the raw names it reads at the top of a settings section.
 * TypeScript keeps one set per server: the `js/ts` section covers TS and JS files alike.
 */
const PREFERENCES = {
  includeCompletionsForModuleExports: true,
  includeCompletionsForImportStatements: true,
  includeAutomaticOptionalChainCompletions: true,
  importModuleSpecifierPreference: "shortest",
} as const;

/**
 * The `js/ts` settings section: the preferences, plus the format settings TypeScript indents the
 * code of quick fixes and completions with (its default is 4 spaces).
 */
function typeScriptSettings(indentation: DocumentIndentation | null): Record<string, unknown> {
  if (!indentation) return { ...PREFERENCES };
  // Capped: TypeScript builds each indentation string in full, and an `.editorconfig` can say 1e9.
  const tabSize = Math.min(indentation.tabSize, MAX_INDENT_COLUMNS);
  const indentSize = Math.min(indentation.indentSize, MAX_INDENT_COLUMNS);
  const format = { tabSize, indentSize, convertTabsToSpaces: indentation.insertSpaces };
  return { ...PREFERENCES, format };
}

const MAX_INDENT_COLUMNS = 16;

/** Client requests whose edits TypeScript indents with its format settings. */
const INDENTED_EDIT_REQUESTS = new Set([
  "textDocument/codeAction",
  "textDocument/completion",
  "completionItem/resolve",
]);

interface SessionIndentation {
  /** Each live editor model's indentation, by file path. */
  documents: Map<string, DocumentIndentation>;
  /** What TypeScript indents with now; absent while it has its default. */
  current?: DocumentIndentation;
}

/**
 * Manages `tsc --lsp -stdio` child processes, one per worktree. Translates loxel://HEAD/... ↔
 * file:///... URIs, gives TypeScript Loxel's preferences, and gives `.tsx`/`.jsx` documents the
 * language ids TypeScript expects.
 *
 * TypeScript applies one set of format settings to every file, so the bridge keeps each document's
 * indentation (the client's `loxel/documentIndentation` notifications) and, before forwarding a
 * request whose edits TypeScript indents, switches the settings to that document's indentation
 * when they differ. TypeScript applies a configuration change before it reads the next request.
 */
export class TsLspManager extends WorktreeLspManager {
  protected override readonly forwardWatchedFiles = true;
  private readonly indentation = new WeakMap<WtLspSession, SessionIndentation>();

  constructor() {
    super("ts-lsp");
  }

  protected resolveBinary(): string | null {
    return resolveTypeScriptBinary();
  }

  protected override spawnArgs(): readonly string[] {
    return ["--lsp", "-stdio"];
  }

  protected override handleClientData(session: WtLspSession, data: string): void {
    let outgoing = data;
    try {
      const parsed: unknown = JSON.parse(data);
      if (typeof parsed === "object" && parsed !== null) {
        const msg = parsed as { id?: number | string; method?: string; params?: unknown };

        if (msg.method !== undefined) {
          if (msg.method === DOCUMENT_INDENTATION_METHOD) {
            this.setDocumentIndentation(session, msg.params);
            return;
          }
          if (this.shouldDropForNonTsUri(msg.method, msg.params)) return;

          // Inject rootUri/workspaceFolders so TypeScript knows which project to load.
          if (msg.method === "initialize") {
            outgoing = this.augmentInitializeRequest(session, parsed as Record<string, unknown>);
          } else if (msg.method === "textDocument/didOpen" && setReactLanguageId(msg.params)) {
            outgoing = JSON.stringify(parsed);
          } else if (msg.method === "textDocument/didClose") {
            const path = documentPath(textDocumentUri(msg.params));
            if (path) this.sessionIndentation(session).documents.delete(path);
          } else if (INDENTED_EDIT_REQUESTS.has(msg.method)) {
            this.indentLike(session, requestDocumentPath(msg.method, msg.params));
          }
        }
      }
    } catch {
      // Not JSON — forward verbatim.
    }

    this.writeToStdin(session, toServerUris(outgoing));
  }

  protected override handleServerFrame(session: WtLspSession, body: string): void {
    // Server→client requests we fulfill locally (TypeScript blocks on
    // workspace/configuration until we answer).
    if (this.handleServerRequest(session, body)) return;
    session.ws.send(toClientUris(body));
  }

  // ---------------------------------------------------------------------------

  private sessionIndentation(session: WtLspSession): SessionIndentation {
    let state = this.indentation.get(session);
    if (!state) {
      state = { documents: new Map() };
      this.indentation.set(session, state);
    }
    return state;
  }

  private setDocumentIndentation(session: WtLspSession, params: unknown): void {
    const parsed = documentIndentationParamsSchema.safeParse(params);
    if (!parsed.success) {
      this.log.warn("Ignoring a malformed document indentation", { error: parsed.error.message });
      return;
    }
    const path = documentPath(parsed.data.textDocument.uri);
    if (path) this.sessionIndentation(session).documents.set(path, parsed.data.indentation);
  }

  /** Switch TypeScript's format settings to the indentation of the document at `path`. */
  private indentLike(session: WtLspSession, path: string | null): void {
    const state = this.sessionIndentation(session);
    const indentation = path ? state.documents.get(path) : undefined;
    if (!indentation || sameIndentation(indentation, state.current)) return;
    state.current = indentation;
    const msg = JSON.stringify({
      jsonrpc: "2.0",
      method: "workspace/didChangeConfiguration",
      params: { settings: { "js/ts": typeScriptSettings(indentation) } },
    });
    this.writeToStdin(session, msg);
  }

  private augmentInitializeRequest(session: WtLspSession, msg: Record<string, unknown>): string {
    const params = (msg.params as Record<string, unknown> | undefined) ?? {};
    params.rootUri = fileUri(session.wtPath);
    params.rootPath = session.wtPath;
    params.workspaceFolders = workspaceFolders(session.wtPath);
    // TypeScript reads these as the `js/ts` section when the client cannot answer
    // `workspace/configuration` (monaco-lsp-client does not).
    params.initializationOptions = { userPreferences: typeScriptSettings(null) };
    msg.params = params;
    return JSON.stringify(msg);
  }

  /**
   * Drop textDocument/* notifications/requests whose URI targets a file TypeScript
   * doesn't understand (e.g. `.astro`, `.vue`). The TS LSP client has no
   * languageId filter, so Monaco sends every open model to us.
   */
  private shouldDropForNonTsUri(method: string, params: unknown): boolean {
    if (!method.startsWith("textDocument/")) return false;
    const uri = textDocumentUri(params);
    if (uri === undefined) return false;
    return !TS_EXTENSIONS.test(uri);
  }

  /**
   * Handle server→client requests locally (don't forward to the WebSocket
   * client). Returns true if consumed. TypeScript asks for `workspace/configuration`
   * after `initialized` if the client advertises it, and blocks until it's answered,
   * so we reply inline with the current settings.
   */
  private handleServerRequest(session: WtLspSession, body: string): boolean {
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
      const settings = typeScriptSettings(this.sessionIndentation(session).current ?? null);
      const result = items.map((item) => (item.section === "js/ts" ? settings : null));
      this.writeToStdin(session, JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
      return true;
    }

    // client/(un)registerCapability: DO NOT swallow. TypeScript announces the
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
}

function sameIndentation(a: DocumentIndentation, b: DocumentIndentation | undefined): boolean {
  return (
    a.tabSize === b?.tabSize && a.indentSize === b.indentSize && a.insertSpaces === b.insertSpaces
  );
}

function textDocumentUri(params: unknown): string | undefined {
  const textDocument = isRecord(params) ? params.textDocument : undefined;
  return isRecord(textDocument) && typeof textDocument.uri === "string"
    ? textDocument.uri
    : undefined;
}

/**
 * The file a request's edits are for: its text document, or for `completionItem/resolve` the file
 * TypeScript recorded in the item's data.
 */
function requestDocumentPath(method: string, params: unknown): string | null {
  if (method !== "completionItem/resolve") return documentPath(textDocumentUri(params));
  const data = isRecord(params) ? params.data : undefined;
  return isRecord(data) && typeof data.fileName === "string" ? data.fileName : null;
}

/** The file path of a client or server document URI, or null for any other URI. */
function documentPath(uri: string | undefined): string | null {
  if (uri === undefined) return null;
  const serverUri = toServerUris(uri);
  if (!serverUri.startsWith("file:")) return null;
  try {
    return fileURLToPath(serverUri);
  } catch {
    return null;
  }
}

const REACT_LANGUAGE_IDS: Record<string, string> = {
  tsx: "typescriptreact",
  jsx: "javascriptreact",
};

/**
 * Monaco reports `tsx`/`jsx` for .tsx/.jsx files, but TypeScript needs `typescriptreact` /
 * `javascriptreact` in a `textDocument/didOpen` to enable JSX mode. True when it changed `params`.
 */
export function setReactLanguageId(params: unknown): boolean {
  const textDocument = isRecord(params) ? params.textDocument : undefined;
  if (!isRecord(textDocument) || typeof textDocument.uri !== "string") return false;
  const extension = /\.([jt]sx)$/i.exec(textDocument.uri)?.[1]?.toLowerCase();
  const languageId = extension ? REACT_LANGUAGE_IDS[extension] : undefined;
  if (!languageId || textDocument.languageId === languageId) return false;
  textDocument.languageId = languageId;
  return true;
}
