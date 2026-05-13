import * as monaco from "monaco-editor";

import type { CodeLensRegistrationOptions, CodeLens } from "../../types";

import { capabilities, api } from "../../types";
import { Disposable } from "../../utils";
import { assertTargetTextModel } from "../ITextModelBridge";
import { LspConnection } from "../LspConnection";
import { toMonacoLanguageSelector } from "./common";
import { toMonacoCommand } from "./common";

export class LspCodeLensFeature extends Disposable {
  private readonly _providers = new Set<LspCodeLensProvider>();

  constructor(private readonly _connection: LspConnection) {
    super();

    this._register(
      this._connection.capabilities.addStaticClientCapabilities({
        textDocument: { codeLens: { dynamicRegistration: true } },
        workspace: { codeLens: { refreshSupport: true } },
      }),
    );

    this._register(
      this._connection.connection.registerRequestHandler(
        api.client.workspaceCodeLensRefresh,
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
        capabilities.textDocumentCodeLens,
        true,
        (capability) => {
          const provider = new LspCodeLensProvider(this._connection, capability);
          this._providers.add(provider);
          const registration = monaco.languages.registerCodeLensProvider(
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

interface ExtendedCodeLens extends monaco.languages.CodeLens {
  _lspCodeLens?: CodeLens;
}

class LspCodeLensProvider implements monaco.languages.CodeLensProvider {
  private readonly _onDidChangeEmitter = new monaco.Emitter<this>();
  public readonly onDidChange = this._onDidChangeEmitter.event;

  constructor(
    private readonly _client: LspConnection,
    private readonly _capabilities: CodeLensRegistrationOptions,
  ) {}

  public refresh(): void {
    this._onDidChangeEmitter.fire(this);
  }

  async provideCodeLenses(
    model: monaco.editor.ITextModel,
    _token: monaco.CancellationToken,
  ): Promise<monaco.languages.CodeLensList | null> {
    const translated = this._client.bridge.translate(model, new monaco.Position(1, 1));

    const result = await this._client.server.textDocumentCodeLens({
      textDocument: translated.textDocument,
    });

    if (!result) {
      return null;
    }

    return {
      lenses: result.map((lens) => {
        const monacoLens: ExtendedCodeLens = {
          range: assertTargetTextModel(
            this._client.bridge.translateBackRange(translated.textDocument, lens.range),
            model,
          ).range,
          command: toMonacoCommand(lens.command),
          _lspCodeLens: lens,
        };
        return monacoLens;
      }),
      dispose: () => {},
    };
  }

  async resolveCodeLens(
    model: monaco.editor.ITextModel,
    codeLens: ExtendedCodeLens,
    _token: monaco.CancellationToken,
  ): Promise<monaco.languages.CodeLens> {
    if (!this._capabilities.resolveProvider || !codeLens._lspCodeLens) {
      return codeLens;
    }

    const resolved = await this._client.server.codeLensResolve(codeLens._lspCodeLens);

    if (resolved.command) {
      codeLens.command = {
        id: resolved.command.command,
        title: resolved.command.title,
        arguments: resolved.command.arguments,
      };
    }

    return codeLens;
  }
}
