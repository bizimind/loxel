import * as monaco from "monaco-editor";

import type { SemanticTokensRegistrationOptions } from "../../types";
import { capabilities, TokenFormat, api } from "../../types";
import type { IDisposable } from "../../utils";
import { Disposable } from "../../utils";
import { LspConnection } from "../LspConnection";
import { toMonacoLanguageSelector } from "./common";

/**
 * What the app's theme has rules for. Monaco paints a token type with no rule in the default
 * foreground, hiding its TextMate color, and matches modifiers against rules as a dotted path in
 * legend order, so a modifier no rule names (`variable.declaration.readonly`) stops the match.
 * Without this, a server's legend reaches Monaco as is.
 */
export interface SemanticTokenStyling {
  /** Token types with a rule of their own. Tokens of any other type keep their TextMate color. */
  types: ReadonlySet<string>;
  /** Modifiers that rules name. Any other modifier is dropped from tokens before they are matched. */
  modifiers: ReadonlySet<string>;
}

export class LspSemanticTokensFeature extends Disposable {
  private readonly _providers = new Set<LspSemanticTokensProvider>();

  constructor(
    private readonly _connection: LspConnection,
    private readonly _styling?: SemanticTokenStyling,
  ) {
    super();

    this._register(
      this._connection.capabilities.addStaticClientCapabilities({
        textDocument: {
          semanticTokens: {
            dynamicRegistration: true,
            // Delta requests are not made: `provideDocumentSemanticTokensEdits` asks for all tokens.
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
            this._styling,
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

export class LspSemanticTokensProvider implements monaco.languages.DocumentSemanticTokensProvider {
  private readonly _legend: monaco.languages.SemanticTokensLegend;
  /** Bits of the modifiers `SemanticTokenStyling` keeps, undefined to keep them all. */
  private readonly _modifierMask: number | undefined;

  constructor(
    private readonly _client: LspConnection,
    private readonly _capabilities: SemanticTokensRegistrationOptions,
    public readonly onDidChange: monaco.IEvent<void>,
    private readonly _clearOnNextCall: Set<string>,
    private readonly _refire: () => void,
    styling?: SemanticTokenStyling,
  ) {
    const { tokenTypes, tokenModifiers } = this._capabilities.legend;
    // Monaco leaves a token whose type is blank in the legend unstyled. Indexes stay stable, so
    // token data needs no rewriting for it.
    this._legend = {
      tokenTypes: styling
        ? tokenTypes.map((type) => (styling.types.has(type) ? type : ""))
        : tokenTypes,
      tokenModifiers,
    };
    this._modifierMask =
      styling &&
      tokenModifiers.reduce(
        (mask, modifier, index) => (styling.modifiers.has(modifier) ? mask | (1 << index) : mask),
        0,
      );
  }

  public refresh(): void {
    this._refire();
  }

  getLegend(): monaco.languages.SemanticTokensLegend {
    return this._legend;
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
    if (!this._client.bridge.isSyncedModel(model)) return null;
    const translated = this._client.bridge.translate(model, model.getPositionAt(0));

    // Two-phase invalidation after format/large edits: first call clears
    // Monaco's cached semantic tokens so the post-edit paint shows only
    // Monarch coloring (positionally correct), then we re-fire so the
    // follow-up call fetches the real tokens.
    if (this._clearOnNextCall.delete(translated.textDocument.uri)) {
      queueMicrotask(() => this._refire());
      return { resultId: undefined, data: new Uint32Array(0) };
    }

    // Tokens describe the content the request was made for. Monaco keeps the edits made while the
    // request is out, shifts the answer's tokens across them and asks again, so the answer must
    // not be swapped for a newer one: Monaco would shift that across the same edits a second time
    // and paint tokens off their text, past line ends ("Invalid Semantic Tokens Data").
    const result = await this._client.server.textDocumentSemanticTokensFull({
      textDocument: translated.textDocument,
    });

    if (!result || token.isCancellationRequested || model.isDisposed()) return null;

    const mask = this._modifierMask;
    // Each token is five integers, the last of them its modifier bits.
    const data = new Uint32Array(
      mask === undefined
        ? result.data
        : result.data.map((value, index) => (index % 5 === 4 ? value & mask : value)),
    );
    return { resultId: result.resultId, data };
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
