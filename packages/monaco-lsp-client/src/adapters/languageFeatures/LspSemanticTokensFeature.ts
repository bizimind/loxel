import * as monaco from "monaco-editor";

import type { SemanticTokensRegistrationOptions } from "../../types";
import { capabilities, TokenFormat, api } from "../../types";
import type { IDisposable } from "../../utils";
import { Disposable } from "../../utils";
import { LspConnection } from "../LspConnection";
import { toMonacoLanguageSelector } from "./common";

export class LspSemanticTokensFeature extends Disposable {
  private readonly _providers = new Set<LspSemanticTokensProvider>();

  constructor(private readonly _connection: LspConnection) {
    super();

    this._register(
      this._connection.capabilities.addStaticClientCapabilities({
        textDocument: {
          semanticTokens: {
            dynamicRegistration: true,
            // Disable delta tokens. The server augments FULL responses with
            // custom JSX tokens (see ts-lsp-manager.augmentSemanticTokens);
            // delta responses would be computed by tsgo against its
            // NON-augmented token sequence, so applying them on the client
            // (which holds the augmented sequence) drifts positions and
            // produces the offset highlighting seen during live editing.
            requests: { range: true, full: { delta: false } },
            tokenTypes: [
              "namespace",
              "type",
              "class",
              "enum",
              "interface",
              "struct",
              "typeParameter",
              "parameter",
              "variable",
              "property",
              "enumMember",
              "event",
              "function",
              "method",
              "macro",
              "keyword",
              "modifier",
              "comment",
              "string",
              "number",
              "regexp",
              "operator",
              "decorator",
            ],
            tokenModifiers: [
              "declaration",
              "definition",
              "readonly",
              "static",
              "deprecated",
              "abstract",
              "async",
              "modification",
              "documentation",
              "defaultLibrary",
            ],
            formats: [TokenFormat.Relative],
            overlappingTokenSupport: false,
            multilineTokenSupport: true,
          },
        },
        workspace: { semanticTokens: { refreshSupport: true } },
      }),
    );

    this._register(
      this._connection.connection.registerRequestHandler(
        api.client.workspaceSemanticTokensRefresh,
        async () => {
          for (const provider of this._providers) {
            provider.refresh();
          }
          return { ok: null };
        },
      ),
    );

    this._register(
      this._connection.capabilities.registerCapabilityHandler(
        capabilities.textDocumentSemanticTokensFull,
        true,
        (capability) => {
          const onDidChangeEmitter = new monaco.Emitter<void>();
          const clearOnNextCall = new Set<string>();

          // Fire on every content change so Monaco refetches tokens. For
          // normal typing we let Monaco keep painting its (shifted) current
          // tokens until the new fetch resolves — that window is short and
          // avoids a visible Monarch-only flash on every keystroke. For
          // large structural edits (format-on-save) sibling features set
          // `clearOnNextCall` via `semanticTokensInvalidator`, which forces
          // the next provide() to return empty so Monaco drops its cache
          // instead of naively shifting many lines of stale tokens across
          // the format edits.
          const wireModel = (m: monaco.editor.ITextModel): IDisposable => {
            return m.onDidChangeContent(() => onDidChangeEmitter.fire());
          };
          const modelSubs = new Map<monaco.editor.ITextModel, IDisposable>();
          for (const m of monaco.editor.getModels()) modelSubs.set(m, wireModel(m));
          this._register(monaco.editor.onDidCreateModel((m) => modelSubs.set(m, wireModel(m))));
          this._register(
            monaco.editor.onWillDisposeModel((m) => {
              modelSubs.get(m)?.dispose();
              modelSubs.delete(m);
            }),
          );
          this._register({
            dispose: () => {
              for (const sub of modelSubs.values()) sub.dispose();
              modelSubs.clear();
            },
          });
          // Expose an invalidator so sibling features (notably formatting)
          // can force Monaco to drop cached tokens and re-ask immediately.
          // Firing onDidChange alone isn't enough: Monaco schedules a refetch
          // but keeps painting the previous tokens (naively shifted across
          // the just-applied edits) until the new response resolves — that's
          // the visible offset-highlight flash on format. We force the
          // provider to return null, which makes Monaco clear semantic
          // tokens and fall back to Monarch (positionally correct), then
          // fire again so the second fetch paints the real tokens.
          this._connection.semanticTokensInvalidator = {
            invalidate: (uri: string) => {
              clearOnNextCall.add(uri);
              onDidChangeEmitter.fire();
            },
          };
          const provider = new LspSemanticTokensProvider(
            this._connection,
            capability,
            onDidChangeEmitter.event,
            clearOnNextCall,
            () => onDidChangeEmitter.fire(),
          );
          this._providers.add(provider);
          const registration = monaco.languages.registerDocumentSemanticTokensProvider(
            toMonacoLanguageSelector(
              capability.documentSelector,
              this._connection.defaultLanguageIds,
            ),
            provider,
          );
          return {
            dispose: () => {
              this._providers.delete(provider);
              registration.dispose();
            },
          };
        },
      ),
    );
  }
}

class LspSemanticTokensProvider implements monaco.languages.DocumentSemanticTokensProvider {
  constructor(
    private readonly _client: LspConnection,
    private readonly _capabilities: SemanticTokensRegistrationOptions,
    public readonly onDidChange: monaco.IEvent<void>,
    private readonly _clearOnNextCall: Set<string>,
    private readonly _refire: () => void,
  ) {}

  public refresh(): void {
    this._refire();
  }

  getLegend(): monaco.languages.SemanticTokensLegend {
    return {
      tokenTypes: this._capabilities.legend.tokenTypes,
      tokenModifiers: this._capabilities.legend.tokenModifiers,
    };
  }

  releaseDocumentSemanticTokens(_resultId: string | undefined): void {
    // Monaco will call this when it's done with a result
    // We can potentially notify the server if needed
  }

  async provideDocumentSemanticTokens(
    model: monaco.editor.ITextModel,
    lastResultId: string | null,
    token: monaco.CancellationToken,
  ): Promise<monaco.languages.SemanticTokens | monaco.languages.SemanticTokensEdits | null> {
    const translated = this._client.bridge.translate(model, model.getPositionAt(0));

    // Two-phase invalidation after format/large edits: first call clears
    // Monaco's cached semantic tokens so the post-edit paint shows only
    // Monarch coloring (positionally correct), then we re-fire so the
    // follow-up call fetches the real tokens.
    if (this._clearOnNextCall.delete(translated.textDocument.uri)) {
      queueMicrotask(() => this._refire());
      return { resultId: undefined, data: new Uint32Array(0) };
    }

    // Loop inline on version-staleness: the model can move under us between
    // the request leaving and the response arriving, but Monaco's `null`
    // return means "no change" — leaving the previous (naively edit-shifted)
    // tokens painted — and firing the emitter to trigger a re-entry causes a
    // visible Monarch flash on every rapid keystroke. Instead, keep fetching
    // inline until we get a response that matches the current model version
    // (or Monaco cancels the whole thing, which is its own signal that a new
    // request is already queued).
    while (true) {
      const requestedVersion = model.getVersionId();

      // We intentionally do NOT use delta requests. Our proxy augments FULL
      // token responses with custom JSX tokens; delta responses would drift.
      const result = await this._client.server.textDocumentSemanticTokensFull({
        textDocument: translated.textDocument,
      });

      if (!result || token.isCancellationRequested || model.isDisposed()) {
        // Monaco will schedule its own refetch; returning null keeps the
        // currently painted tokens in place (no Monarch flash).
        return null;
      }

      if (model.getVersionId() !== requestedVersion) {
        // Retry inline with the current version. No onDidChange refire —
        // firing the emitter here caused Monaco to drop tokens mid-fetch
        // and produced a visible Monarch flash during rapid typing.
        continue;
      }

      return { resultId: result.resultId, data: new Uint32Array(result.data) };
    }
  }

  async provideDocumentSemanticTokensEdits?(
    model: monaco.editor.ITextModel,
    previousResultId: string,
    token: monaco.CancellationToken,
  ): Promise<monaco.languages.SemanticTokens | monaco.languages.SemanticTokensEdits | null> {
    // This method is called when Monaco wants to use delta updates
    // We can delegate to provideDocumentSemanticTokens which handles both
    return this.provideDocumentSemanticTokens(model, previousResultId, token);
  }
}
