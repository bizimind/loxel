import type { IMessageTransport, IRequestSender } from "@hediet/json-rpc";
import { Channel, StreamBasedChannel, TypedChannel } from "@hediet/json-rpc";
import type * as monaco from "monaco-editor";

import type { ClientCapabilities } from "../types";
import { api } from "../types";
import type { IDisposable } from "../utils";
import { DisposableStore } from "../utils";
import { LspApplyEditFeature } from "./languageFeatures/LspApplyEditFeature";
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
import type { WorkspaceSymbolItem } from "./languageFeatures/LspWorkspaceSymbolFeature";
import { LspWorkspaceSymbolFeature } from "./languageFeatures/LspWorkspaceSymbolFeature";
import { LspCancellableRequests } from "./LspCancellableRequests";
import type { OptionsOf, RegistrableCapability } from "./LspCapabilitiesRegistry";
import { LspCapabilitiesRegistry } from "./LspCapabilitiesRegistry";
import { LspConnection } from "./LspConnection";
import { LspServerCommands } from "./LspServerCommands";
import { TextDocumentSynchronizer } from "./TextDocumentSynchronizer";
import type { WorkspaceFileSystem } from "./WorkspaceEditApplier";
import { WorkspaceEditApplier } from "./WorkspaceEditApplier";

export interface MonacoLspClientOptions {
  /** Restrict model sync and provider registration to these language(s). */
  languageId?: string | readonly string[];
  /**
   * Further restrict model sync to models this returns true for. Requests from
   * Monaco providers for any other model are not sent: the server has never
   * seen it. Use it to keep read-only views (diffs, history) away from the
   * server.
   */
  modelFilter?: (textModel: monaco.editor.ITextModel) => boolean;
  /**
   * Disk access for workspace edits (rename, code actions, `workspace/applyEdit`). With it they
   * can edit files that have no model and create, rename or delete files; without it they are
   * refused when they touch a file that is not open or hold a file operation.
   */
  workspaceFileSystem?: WorkspaceFileSystem;
  /** Called with the reason when a workspace edit is refused or fails, to tell the user. */
  onWorkspaceEditFailure?: (reason: string) => void;
  /**
   * Owner of the diagnostic markers this client sets. Live clients must not share one, so servers
   * syncing the same model keep their own markers; a disposed client removes its owner's markers.
   * Defaults to an owner unique to the client (`lsp-<n>`).
   */
  markerOwner?: string;
}

export class MonacoLspClient {
  private _connection: LspConnection;
  private readonly _capabilitiesRegistry: LspCapabilitiesRegistry;
  private readonly _bridge: TextDocumentSynchronizer;
  private readonly _commands: LspServerCommands;
  private readonly _edits: WorkspaceEditApplier;
  private readonly _features: IDisposable;
  private readonly _diagnostics: LspDiagnosticsFeature;
  private readonly _codeActions: LspCodeActionFeature;
  private readonly _workspaceSymbols: LspWorkspaceSymbolFeature;

  private _initPromise: Promise<void>;

  constructor(transport: IMessageTransport, options?: MonacoLspClientOptions) {
    // `TypedChannel.fromTransport`, keeping the request sender it connects (in `startListen`)
    // for requests that must know their JSON-RPC id to be cancelled.
    const streamChannel = StreamBasedChannel.createChannel(transport, undefined);
    let requestSender: IRequestSender | undefined;
    const c = new TypedChannel(
      new Channel((listener) => (requestSender = streamChannel.connect(listener))),
    );
    const s = api.getServer(c, {});
    c.startListen();
    if (!requestSender) throw new Error("[MonacoLspClient] the channel did not connect on listen");

    const languageId = options?.languageId;
    const languageIds = languageId
      ? new Set(Array.isArray(languageId) ? languageId : [languageId])
      : undefined;
    const defaultLanguageIds = languageIds ? [...languageIds] : undefined;
    this._capabilitiesRegistry = new LspCapabilitiesRegistry(c);
    this._bridge = new TextDocumentSynchronizer(
      s.server,
      this._capabilitiesRegistry,
      languageIds,
      options?.modelFilter,
    );
    this._commands = new LspServerCommands(s.server, this._capabilitiesRegistry);
    this._edits = new WorkspaceEditApplier(s.server, this._capabilitiesRegistry, {
      fileSystem: options?.workspaceFileSystem,
      onFailure: options?.onWorkspaceEditFailure,
    });

    this._connection = new LspConnection(
      s.server,
      this._bridge,
      this._capabilitiesRegistry,
      c,
      this._commands,
      new LspCancellableRequests(requestSender, s.server),
      this._edits,
      defaultLanguageIds,
    );
    this._features = this.createFeatures();
    // Code actions send back the diagnostics behind the client's markers.
    this._diagnostics = new LspDiagnosticsFeature(this._connection, options?.markerOwner);
    this._codeActions = new LspCodeActionFeature(this._connection, this._diagnostics);
    this._workspaceSymbols = new LspWorkspaceSymbolFeature(
      this._connection,
      () => this._initPromise,
    );

    this._initPromise = this._init().catch((err: unknown) => {
      console.error("[MonacoLspClient] initialization failed:", err);
    });
  }

  dispose(): void {
    this._features.dispose();
    this._codeActions.dispose();
    this._diagnostics.dispose();
    this._workspaceSymbols.dispose();
    this._commands.dispose();
    this._edits.dispose();
    this._bridge.dispose();
    this._capabilitiesRegistry.dispose();
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

  /**
   * Symbols matching `query` across the server's workspace (`workspace/symbol`), empty when the
   * server has no workspace symbol provider. Cancelling `token` sends `$/cancelRequest` and
   * rejects with a `Canceled` error.
   */
  workspaceSymbols(query: string, token: monaco.CancellationToken): Promise<WorkspaceSymbolItem[]> {
    return this._workspaceSymbols.provideWorkspaceSymbols(query, token);
  }

  /**
   * Fills in the range of a symbol from `workspaceSymbols` that came without one, through
   * `workspaceSymbol/resolve`; returns it unchanged when there is nothing to resolve.
   */
  resolveWorkspaceSymbol(
    symbol: WorkspaceSymbolItem,
    token: monaco.CancellationToken,
  ): Promise<WorkspaceSymbolItem> {
    return this._workspaceSymbols.resolveWorkspaceSymbol(symbol, token);
  }

  /**
   * Whether the server may offer code actions of `kind` for `model` (`quickfix`, `source.fixAll`,
   * `refactor`, …): it syncs the model and registered code actions for it that declare a kind
   * containing or inside `kind`, or no kinds at all. False until the server has initialized.
   */
  supportsCodeActionKind(model: monaco.editor.ITextModel, kind: string): boolean {
    return this._codeActions.supportsKind(model, kind);
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
    store.add(new LspCodeLensFeature(this._connection));
    store.add(new LspDocumentLinkFeature(this._connection));
    store.add(new LspFormattingFeature(this._connection));
    store.add(new LspRangeFormattingFeature(this._connection));
    store.add(new LspOnTypeFormattingFeature(this._connection));
    store.add(new LspFoldingRangeFeature(this._connection));
    store.add(new LspSelectionRangeFeature(this._connection));
    store.add(new LspInlayHintsFeature(this._connection));
    store.add(new LspSemanticTokensFeature(this._connection));
    store.add(new LspLinkedEditingRangeFeature(this._connection));
    store.add(new LspInlineCompletionFeature(this._connection));
    store.add(new LspApplyEditFeature(this._connection));

    return store;
  }
}
