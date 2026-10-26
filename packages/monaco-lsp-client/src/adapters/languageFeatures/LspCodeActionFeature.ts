import * as monaco from "monaco-editor";

import type {
  CodeAction,
  CodeActionRegistrationOptions,
  Command,
  WorkspaceEdit,
} from "../../types";
import { capabilities } from "../../types";
import { Disposable } from "../../utils";
import { LspConnection } from "../LspConnection";
import { isLspCommand } from "../LspServerCommands";
import { toMonacoLanguageSelector } from "./common";
import {
  lspCodeActionKindToMonacoCodeActionKind,
  toMonacoCodeActionKind,
  toLspDiagnosticSeverity,
  toLspCodeActionTriggerKind,
} from "./common";

let nextApplyCommandId = 0;

export class LspCodeActionFeature extends Disposable {
  /**
   * Monaco applies a code action's `edit` with its standalone bulk-edit service, which can only
   * edit open models, so actions carry their edit to this command instead: it applies the edit
   * through the client's workspace-edit path, then runs the action's own command.
   */
  private readonly _applyCommandId = `monaco-lsp-client.applyCodeAction.${nextApplyCommandId++}`;

  constructor(private readonly _connection: LspConnection) {
    super();

    this._register(
      monaco.editor.registerCommand(
        this._applyCommandId,
        (_accessor, edit: unknown, command: unknown) => this._apply(edit, command),
      ),
    );

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
            new LspCodeActionProvider(this._connection, capability, (edit, command) =>
              this._toMonacoCommand(edit, command),
            ),
            // Monaco enables kind-specific commands (Organize Imports, Fix All) only for providers
            // that declare the kind; LSP kinds are Monaco kinds (`source.organizeImports.ruff`
            // counts as `source.organizeImports`).
            { providedCodeActionKinds: capability.codeActionKinds },
          );
        },
      ),
    );
  }

  private _toMonacoCommand(
    edit: WorkspaceEdit | undefined,
    command: Command | undefined,
  ): monaco.languages.Command | undefined {
    if (!edit) return this._connection.commands.toMonacoCommand(command);
    return { id: this._applyCommandId, title: command?.title ?? "", arguments: [edit, command] };
  }

  private async _apply(edit: unknown, command: unknown): Promise<void> {
    if (!isWorkspaceEdit(edit)) {
      throw new Error(`${this._applyCommandId} expects an LSP WorkspaceEdit argument`);
    }
    const result = await this._connection.edits.apply(edit);
    if (!result.applied || !isLspCommand(command)) return;
    if (await this._connection.commands.executeServerCommand(command)) return;
    // A client command (`editor.action.*`): run it on the editor the action was applied in, as
    // Monaco would have. `trigger` passes one argument, which is what editor actions take.
    const editor = monaco.editor.getEditors().find((e) => e.hasTextFocus() || e.hasWidgetFocus());
    if (!editor || (command.arguments?.length ?? 0) > 1) {
      console.warn(`[MonacoLspClient] code action command ${command.command} was not run`);
      return;
    }
    editor.trigger("monaco-lsp-client", command.command, command.arguments?.[0]);
  }
}

interface ExtendedCodeAction extends monaco.languages.CodeAction {
  _lspAction?: CodeAction;
  _resolved?: boolean;
}

class LspCodeActionProvider implements monaco.languages.CodeActionProvider {
  public readonly resolveCodeAction;

  constructor(
    private readonly _client: LspConnection,
    private readonly _capabilities: CodeActionRegistrationOptions,
    private readonly _toMonacoCommand: (
      edit: WorkspaceEdit | undefined,
      command: Command | undefined,
    ) => monaco.languages.Command | undefined,
  ) {
    if (_capabilities.resolveProvider) {
      // Monaco resolves an action without an `edit` (all of ours) on hover and before applying it.
      this.resolveCodeAction = async (
        codeAction: ExtendedCodeAction,
        _token: monaco.CancellationToken,
      ): Promise<ExtendedCodeAction> => {
        const action = codeAction._lspAction;
        if (!action || action.edit || codeAction._resolved) return codeAction;
        const resolved = await this._client.server.codeActionResolve(action);
        codeAction._resolved = true;
        codeAction.command = this._toMonacoCommand(
          resolved.edit,
          resolved.command ?? action.command,
        );
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

        const monacoAction: ExtendedCodeAction = {
          title: action.title,
          kind: toMonacoCodeActionKind(action.kind),
          isPreferred: action.isPreferred,
          disabled:
            action.disabled?.reason ??
            (action.edit ? this._client.edits.unsupportedReason(action.edit) : undefined),
          command: this._toMonacoCommand(action.edit, action.command),
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

function isWorkspaceEdit(value: unknown): value is WorkspaceEdit {
  return (
    typeof value === "object" &&
    value !== null &&
    ("changes" in value || "documentChanges" in value)
  );
}
