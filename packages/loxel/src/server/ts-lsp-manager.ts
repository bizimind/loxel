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
 * JSON paths: their live editor models use `file://` URIs (CodeEditorPanel's `useFileScheme`),
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
 * Manages `tsc --lsp -stdio` child processes, one per worktree. Translates loxel://HEAD/... ↔
 * file:///... URIs, answers TypeScript's `workspace/configuration` with Loxel's preferences, and
 * gives `.tsx`/`.jsx` documents the language ids TypeScript expects.
 */
export class TsLspManager extends WorktreeLspManager {
  protected override readonly forwardWatchedFiles = true;

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
          if (this.shouldDropForNonTsUri(msg.method, msg.params)) return;

          // Inject rootUri/workspaceFolders so TypeScript knows which project to load.
          if (msg.method === "initialize") {
            outgoing = this.augmentInitializeRequest(session, parsed as Record<string, unknown>);
          } else if (msg.method === "textDocument/didOpen" && setReactLanguageId(msg.params)) {
            outgoing = JSON.stringify(parsed);
          }

          // After server acks init, push TS preferences so TypeScript enables
          // module-export completions, inlay hints, etc. in steady state too.
          if (msg.method === "initialized") {
            queueMicrotask(() => this.sendConfigUpdate(session));
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

  private sendConfigUpdate(session: WtLspSession): void {
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

  private augmentInitializeRequest(session: WtLspSession, msg: Record<string, unknown>): string {
    const params = (msg.params as Record<string, unknown> | undefined) ?? {};
    params.rootUri = fileUri(session.wtPath);
    params.rootPath = session.wtPath;
    params.workspaceFolders = workspaceFolders(session.wtPath);
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

  /**
   * Drop textDocument/* notifications/requests whose URI targets a file TypeScript
   * doesn't understand (e.g. `.astro`, `.vue`). The TS LSP client has no
   * languageId filter, so Monaco sends every open model to us.
   */
  private shouldDropForNonTsUri(method: string, params: unknown): boolean {
    if (!method.startsWith("textDocument/")) return false;
    if (typeof params !== "object" || params === null) return false;
    const td = (params as { textDocument?: unknown }).textDocument;
    if (typeof td !== "object" || td === null) return false;
    const uri = (td as { uri?: unknown }).uri;
    if (typeof uri !== "string") return false;
    return !TS_EXTENSIONS.test(uri);
  }

  /**
   * Handle server→client requests locally (don't forward to the WebSocket
   * client). Returns true if consumed. TypeScript sends `workspace/configuration`
   * immediately after `initialized` and blocks until it's answered — so we
   * reply inline with our canned TS/JS preferences.
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
