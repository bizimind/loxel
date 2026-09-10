import type { IMessageTransport } from "@hediet/json-rpc";
import { TypedChannel } from "@hediet/json-rpc";

import type { ClientCapabilities } from "../types";
import { api } from "../types";
import type { IDisposable } from "../utils";
import { DisposableStore } from "../utils";
import { LspCodeActionFeature } from "./languageFeatures/LspCodeActionFeature";
import { LspCodeLensFeature } from "./languageFeatures/LspCodeLensFeature";
import { LspCompletionFeature } from "./languageFeatures/LspCompletionFeature";
import { LspDeclarationFeature } from "./languageFeatures/LspDeclarationFeature";
import { LspDefinitionFeature } from "./languageFeatures/LspDefinitionFeature";
import { LspDiagnosticsFeature } from "./languageFeatures/LspDiagnosticsFeature";
import { LspDocumentHighlightFeature } from "./languageFeatures/LspDocumentHighlightFeature";
import { LspDocumentLinkFeature } from "./languageFeatures/LspDocumentLinkFeature";
import { LspDocumentSymbolFeature } from "./languageFeatures/LspDocumentSymbolFeature";
import { LspFoldingRangeFeature } from "./languageFeatures/LspFoldingRangeFeature";
import { LspFormattingFeature } from "./languageFeatures/LspFormattingFeature";
import { LspHoverFeature } from "./languageFeatures/LspHoverFeature";
import { LspImplementationFeature } from "./languageFeatures/LspImplementationFeature";
import { LspInlayHintsFeature } from "./languageFeatures/LspInlayHintsFeature";
import { LspInlineCompletionFeature } from "./languageFeatures/LspInlineCompletionFeature";
import { LspLinkedEditingRangeFeature } from "./languageFeatures/LspLinkedEditingRangeFeature";
import { LspOnTypeFormattingFeature } from "./languageFeatures/LspOnTypeFormattingFeature";
import { LspRangeFormattingFeature } from "./languageFeatures/LspRangeFormattingFeature";
import { LspReferencesFeature } from "./languageFeatures/LspReferencesFeature";
import { LspRenameFeature } from "./languageFeatures/LspRenameFeature";
import { LspSelectionRangeFeature } from "./languageFeatures/LspSelectionRangeFeature";
import { LspSemanticTokensFeature } from "./languageFeatures/LspSemanticTokensFeature";
import { LspSignatureHelpFeature } from "./languageFeatures/LspSignatureHelpFeature";
import { LspTypeDefinitionFeature } from "./languageFeatures/LspTypeDefinitionFeature";
import type { OptionsOf, RegistrableCapability } from "./LspCapabilitiesRegistry";
import { LspCapabilitiesRegistry } from "./LspCapabilitiesRegistry";
import { LspConnection } from "./LspConnection";
import { TextDocumentSynchronizer } from "./TextDocumentSynchronizer";

export interface MonacoLspClientOptions {
  /** Restrict model sync and provider registration to these language(s). */
  languageId?: string | readonly string[];
}

export class MonacoLspClient {
  private _connection: LspConnection;
  private readonly _capabilitiesRegistry: LspCapabilitiesRegistry;
  private readonly _bridge: TextDocumentSynchronizer;

  private _initPromise: Promise<void>;

  constructor(transport: IMessageTransport, options?: MonacoLspClientOptions) {
    const c = TypedChannel.fromTransport(transport);
    const s = api.getServer(c, {});
    c.startListen();

    const languageId = options?.languageId;
    const languageIds = languageId
      ? new Set(Array.isArray(languageId) ? languageId : [languageId])
      : undefined;
    const defaultLanguageIds = languageIds ? [...languageIds] : undefined;
    this._capabilitiesRegistry = new LspCapabilitiesRegistry(c);
    this._bridge = new TextDocumentSynchronizer(s.server, this._capabilitiesRegistry, languageIds);

    this._connection = new LspConnection(
      s.server,
      this._bridge,
      this._capabilitiesRegistry,
      c,
      defaultLanguageIds,
    );
    this.createFeatures();

    this._initPromise = this._init();
  }

  /**
   * Hook into an LSP capability. The handler fires immediately for any
   * capability the server has already advertised, and again for any future
   * dynamic registrations. Safe to call before the initialize handshake
   * completes — handlers are queued and applied when capabilities arrive.
   */
  registerCapabilityHandler<C extends RegistrableCapability>(
    capability: C,
    handleStaticCapability: boolean,
    handler: (options: OptionsOf<C>) => IDisposable,
  ): IDisposable {
    return this._capabilitiesRegistry.registerCapabilityHandler(
      capability,
      handleStaticCapability,
      handler,
    );
  }

  /** Declare additional client capabilities before the initialize handshake. */
  addStaticClientCapabilities(caps: ClientCapabilities): IDisposable {
    return this._capabilitiesRegistry.addStaticClientCapabilities(caps);
  }

  /** Typed LSP server interface. Call any LSP method directly. */
  get server(): typeof api.TServerInterface {
    return this._connection.server;
  }

  private async _init() {
    const result = await this._connection.server.initialize({
      processId: null,
      capabilities: this._capabilitiesRegistry.getClientCapabilities(),
      rootUri: null,
    });

    this._connection.server.initialized({});
    this._capabilitiesRegistry.setServerCapabilities(result.capabilities);
  }

  protected createFeatures(): IDisposable {
    const store = new DisposableStore();

    store.add(new LspCompletionFeature(this._connection));
    store.add(new LspHoverFeature(this._connection));
    store.add(new LspSignatureHelpFeature(this._connection));
    store.add(new LspDefinitionFeature(this._connection));
    store.add(new LspDeclarationFeature(this._connection));
    store.add(new LspTypeDefinitionFeature(this._connection));
    store.add(new LspImplementationFeature(this._connection));
    store.add(new LspReferencesFeature(this._connection));
    store.add(new LspDocumentHighlightFeature(this._connection));
    store.add(new LspDocumentSymbolFeature(this._connection));
    store.add(new LspRenameFeature(this._connection));
    store.add(new LspCodeActionFeature(this._connection));
    store.add(new LspCodeLensFeature(this._connection));
    store.add(new LspDocumentLinkFeature(this._connection));
    store.add(new LspFormattingFeature(this._connection));
    store.add(new LspRangeFormattingFeature(this._connection));
    store.add(new LspOnTypeFormattingFeature(this._connection));
    store.add(new LspFoldingRangeFeature(this._connection));
    store.add(new LspSelectionRangeFeature(this._connection));
    store.add(new LspInlayHintsFeature(this._connection));
    store.add(new LspSemanticTokensFeature(this._connection));
    store.add(new LspDiagnosticsFeature(this._connection));
    store.add(new LspLinkedEditingRangeFeature(this._connection));
    store.add(new LspInlineCompletionFeature(this._connection));

    return store;
  }
}
