import * as monaco from "monaco-editor";

import type { CodeAction, CodeActionRegistrationOptions, Command } from "../../types";
import { capabilities } from "../../types";
import { Disposable } from "../../utils";
import { LspConnection } from "../LspConnection";
import { toMonacoLanguageSelector, toMonacoWorkspaceEdit } from "./common";
import {
  lspCodeActionKindToMonacoCodeActionKind,
  toMonacoCodeActionKind,
  toLspDiagnosticSeverity,
  toLspCodeActionTriggerKind,
} from "./common";

export class LspCodeActionFeature extends Disposable {
  constructor(private readonly _connection: LspConnection) {
    super();

    this._register(
      this._connection.capabilities.addStaticClientCapabilities({
        textDocument: {
          codeAction: {
            dynamicRegistration: true,
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: Array.from(lspCodeActionKindToMonacoCodeActionKind.keys()),
              },
            },
            isPreferredSupport: true,
            disabledSupport: true,
            dataSupport: true,
            resolveSupport: { properties: ["edit"] },
          },
        },
      }),
    );

    this._register(
      this._connection.capabilities.registerCapabilityHandler(
        capabilities.textDocumentCodeAction,
        true,
        (capability) => {
          return monaco.languages.registerCodeActionProvider(
            toMonacoLanguageSelector(
              capability.documentSelector,
              this._connection.defaultLanguageIds,
            ),
            new LspCodeActionProvider(this._connection, capability),
            // Monaco enables kind-specific commands (Organize Imports, Fix All) only for providers
            // that declare the kind; LSP kinds are Monaco kinds (`source.organizeImports.ruff`
            // counts as `source.organizeImports`).
            { providedCodeActionKinds: capability.codeActionKinds },
          );
        },
      ),
    );
  }
}

interface ExtendedCodeAction extends monaco.languages.CodeAction {
  _lspAction?: CodeAction;
}

class LspCodeActionProvider implements monaco.languages.CodeActionProvider {
  public readonly resolveCodeAction;

  constructor(
    private readonly _client: LspConnection,
    private readonly _capabilities: CodeActionRegistrationOptions,
  ) {
    if (_capabilities.resolveProvider) {
      this.resolveCodeAction = async (
        codeAction: ExtendedCodeAction,
        _token: monaco.CancellationToken,
      ): Promise<ExtendedCodeAction> => {
        if (codeAction._lspAction) {
          const resolved = await this._client.server.codeActionResolve(codeAction._lspAction);
          if (resolved.edit) {
            const edit = toMonacoWorkspaceEdit(resolved.edit, this._client);
            if (edit.rejectReason) {
              // Monaco's resolveCodeAction has no rejection surface (unlike rename), and a
              // throw becomes an uncaught error while Monaco still runs the command. Leave
              // the action with neither edit nor command so it is refused whole.
              console.warn(`[MonacoLspClient] code action refused: ${edit.rejectReason}`);
              codeAction.edit = undefined;
              codeAction.command = undefined;
              return codeAction;
            }
            codeAction.edit = edit;
          }
          if (resolved.command) {
            codeAction.command = this._client.commands.toMonacoCommand(resolved.command);
          }
        }
        return codeAction;
      };
    }
  }

  async provideCodeActions(
    model: monaco.editor.ITextModel,
    range: monaco.Range,
    context: monaco.languages.CodeActionContext,
    _token: monaco.CancellationToken,
  ): Promise<monaco.languages.CodeActionList | null> {
    if (!this._client.bridge.isSyncedModel(model)) return null;
    const translated = this._client.bridge.translate(model, range.getStartPosition());

    const result = await this._client.server.textDocumentCodeAction({
      textDocument: translated.textDocument,
      range: this._client.bridge.translateRange(model, range),
      context: {
        diagnostics: context.markers.map((marker) => ({
          range: this._client.bridge.translateRange(model, monaco.Range.lift(marker)),
          message: marker.message,
          severity: toLspDiagnosticSeverity(marker.severity),
        })),
        triggerKind: toLspCodeActionTriggerKind(context.trigger),
      },
    });

    if (!result) {
      return null;
    }

    const actions = Array.isArray(result) ? result : [result];

    return {
      actions: actions.map((action) => {
        if (isCommand(action)) {
          const monacoAction: ExtendedCodeAction = {
            title: action.title,
            command: this._client.commands.toMonacoCommand(action),
          };
          return monacoAction;
        }

        const edit = action.edit ? toMonacoWorkspaceEdit(action.edit, this._client) : undefined;
        const monacoAction: ExtendedCodeAction = {
          title: action.title,
          kind: toMonacoCodeActionKind(action.kind),
          isPreferred: action.isPreferred,
          disabled: action.disabled?.reason ?? edit?.rejectReason,
          edit,
          command: this._client.commands.toMonacoCommand(action.command),
          _lspAction: action,
        };
        return monacoAction;
      }),
      dispose: () => {},
    };
  }
}

// A bare `Command` names its command as a string; a `CodeAction` may carry a
// `command` too, but as a nested `Command` object.
function isCommand(action: Command | CodeAction): action is Command {
  return typeof action.command === "string";
}
