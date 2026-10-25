import type * as monaco from "monaco-editor";

import type {
  Range,
  SymbolInformation,
  WorkspaceSymbol,
  WorkspaceSymbolRegistrationOptions,
} from "../../types";
import { api, capabilities, SymbolTag } from "../../types";
import { Disposable } from "../../utils";
import type { LspConnection } from "../LspConnection";
import { lspSymbolKindToMonacoSymbolKind, toMonacoSymbolKind, toMonacoSymbolTag } from "./common";

/** A `workspace/symbol` result in Monaco terms. Monaco has no workspace symbol provider API. */
export interface WorkspaceSymbolItem {
  readonly name: string;
  readonly kind: monaco.languages.SymbolKind;
  readonly tags: readonly monaco.languages.SymbolTag[];
  readonly containerName: string | undefined;
  /** URI of the file holding the symbol, as the server reported it. */
  readonly uri: string;
  /** The symbol's range, or undefined when the server leaves it to `workspaceSymbol/resolve`. */
  readonly range: monaco.IRange | undefined;
}

/**
 * Workspace symbol search. Monaco standalone has no provider to register, so the client exposes
 * `provideWorkspaceSymbols` / `resolveWorkspaceSymbol` for the host's own picker.
 */
export class LspWorkspaceSymbolFeature extends Disposable {
  /** Live registrations (static or dynamic); the server supports the request while any exist. */
  private readonly _registrations = new Set<WorkspaceSymbolRegistrationOptions>();
  /** The server's symbol behind each item, sent back on resolve (it may carry `data`). */
  private readonly _serverSymbols = new WeakMap<WorkspaceSymbolItem, WorkspaceSymbol>();

  constructor(private readonly _connection: LspConnection) {
    super();

    this._register(
      this._connection.capabilities.addStaticClientCapabilities({
        workspace: {
          symbol: {
            dynamicRegistration: true,
            symbolKind: { valueSet: Array.from(lspSymbolKindToMonacoSymbolKind.keys()) },
            tagSupport: { valueSet: [SymbolTag.Deprecated] },
            resolveSupport: { properties: ["location.range"] },
          },
        },
      }),
    );

    this._register(
      this._connection.capabilities.registerCapabilityHandler(
        capabilities.workspaceSymbol,
        true,
        (options) => {
          // A static `workspaceSymbolProvider: true` arrives as `true`, not as an options object.
          const registration = typeof options === "object" && options !== null ? options : {};
          this._registrations.add(registration);
          return { dispose: () => this._registrations.delete(registration) };
        },
      ),
    );
  }

  /** Symbols matching `query`; empty when the server has no workspace symbol provider. */
  async provideWorkspaceSymbols(
    query: string,
    token: monaco.CancellationToken,
  ): Promise<WorkspaceSymbolItem[]> {
    if (this._registrations.size === 0) return [];
    const result = await this._connection.cancellableRequests.request(
      api.server.workspaceSymbol,
      { query },
      token,
    );
    return (result ?? []).map((symbol) => this._toItem(symbol));
  }

  /**
   * Fills in a range the server left out, through `workspaceSymbol/resolve` when the server
   * offers it. Returns the item unchanged when it already has a range or cannot be resolved.
   */
  async resolveWorkspaceSymbol(
    item: WorkspaceSymbolItem,
    token: monaco.CancellationToken,
  ): Promise<WorkspaceSymbolItem> {
    if (item.range) return item;
    const serverSymbol = this._serverSymbols.get(item);
    const canResolve = [...this._registrations].some((r) => r.resolveProvider === true);
    if (!serverSymbol || !canResolve) return item;

    const resolved = await this._connection.cancellableRequests.request(
      api.server.workspaceSymbolResolve,
      serverSymbol,
      token,
    );
    return this._toItem(resolved);
  }

  private _toItem(symbol: SymbolInformation | WorkspaceSymbol): WorkspaceSymbolItem {
    const tags = (symbol.tags ?? [])
      .map((tag) => toMonacoSymbolTag(tag))
      .filter((tag): tag is monaco.languages.SymbolTag => tag !== undefined);
    const deprecatedTag = toMonacoSymbolTag(SymbolTag.Deprecated);
    if ("deprecated" in symbol && symbol.deprecated && deprecatedTag !== undefined) {
      if (!tags.includes(deprecatedTag)) tags.push(deprecatedTag);
    }

    const item: WorkspaceSymbolItem = {
      name: symbol.name,
      kind: toMonacoSymbolKind(symbol.kind),
      tags,
      containerName: symbol.containerName || undefined,
      uri: symbol.location.uri,
      range: "range" in symbol.location ? toMonacoRange(symbol.location.range) : undefined,
    };
    this._serverSymbols.set(item, symbol);
    return item;
  }
}

function toMonacoRange(range: Range): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}
