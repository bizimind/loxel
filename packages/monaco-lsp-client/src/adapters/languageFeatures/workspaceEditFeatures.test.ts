import { beforeEach, describe, expect, mock, test } from "bun:test";

import type * as monaco from "monaco-editor";

import { fakeMonaco, fakeMonacoModule } from "../../testing/fake-monaco";
import type { ApplyWorkspaceEditResult, CodeAction, Command, WorkspaceEdit } from "../../types";
import { capabilities } from "../../types";
import type { IDisposable } from "../../utils";
import type { ILspCapabilitiesRegistry } from "../LspCapabilitiesRegistry";
import type { LspConnection } from "../LspConnection";

mock.module("monaco-editor", () => fakeMonacoModule);

const { LspRenameFeature } = await import("./LspRenameFeature");
const { LspCodeActionFeature } = await import("./LspCodeActionFeature");
const { LspApplyEditFeature } = await import("./LspApplyEditFeature");

const renameEdit: WorkspaceEdit = { changes: { "file:///w/b.py": [] } };
const model = { uri: { toString: () => "file:///w/a.py" } } as unknown as monaco.editor.ITextModel;
const cancellation = (cancelled = false) =>
  ({ isCancellationRequested: cancelled }) as monaco.CancellationToken;

/** A connection whose server answers `server` and whose workspace edits resolve to `result`. */
function setup(server: Record<string, unknown>, result: ApplyWorkspaceEditResult) {
  const applied: WorkspaceEdit[] = [];
  const executed: Command[] = [];
  const handlers = new Map<unknown, (options: unknown) => IDisposable>();
  const registry = {
    addStaticClientCapabilities: () => ({ dispose: () => {} }),
    registerCapabilityHandler: (capability: unknown, _static: boolean, handler: never) => {
      handlers.set(capability, handler);
      return { dispose: () => {} };
    },
  } as unknown as ILspCapabilitiesRegistry;
  const connection = {
    server,
    capabilities: registry,
    bridge: {
      isSyncedModel: () => true,
      translate: (m: monaco.editor.ITextModel) => ({
        textDocument: { uri: m.uri.toString() },
        position: { line: 0, character: 0 },
      }),
      translateRange: () => ({ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }),
    },
    edits: {
      apply: async (edit: WorkspaceEdit) => {
        applied.push(edit);
        return result;
      },
      unsupportedReason: (edit: WorkspaceEdit) =>
        edit.documentChanges ? "File operations are not supported" : undefined,
    },
    commands: {
      toMonacoCommand: (command: Command | undefined) =>
        command && { id: command.command, title: command.title, arguments: command.arguments },
      executeServerCommand: async (command: Command) => {
        if (!command.command.startsWith("server.")) return false;
        executed.push(command);
        return true;
      },
    },
  } as unknown as LspConnection;
  const register = (capability: unknown, options: unknown) => handlers.get(capability)?.(options);
  return { connection, applied, executed, register };
}

describe("LspRenameFeature", () => {
  beforeEach(() => fakeMonaco.reset());

  function renameProvider(result: ApplyWorkspaceEditResult) {
    const ctx = setup({ textDocumentRename: async () => renameEdit }, result);
    const feature = new LspRenameFeature(ctx.connection);
    ctx.register(capabilities.textDocumentRename, { documentSelector: null });
    const provider = fakeMonaco.providers.get("Rename") as monaco.languages.RenameProvider;
    return { ...ctx, feature, provider };
  }

  test("applies the server's edit itself and hands Monaco an empty edit", async () => {
    const { provider, applied } = renameProvider({ applied: true });
    const position = { lineNumber: 1, column: 1 } as monaco.Position;
    const result = await provider.provideRenameEdits(model, position, "y", cancellation());
    expect(result).toEqual({ edits: [] });
    expect(applied).toEqual([renameEdit]);
  });

  test("leaves reporting a failure to the applier, and Monaco tries no other provider", async () => {
    const { provider } = renameProvider({ applied: false, failureReason: "outside" });
    const position = { lineNumber: 1, column: 1 } as monaco.Position;
    const result = await provider.provideRenameEdits(model, position, "y", cancellation());
    expect(result).toEqual({ edits: [] });
  });

  test("applies nothing once Monaco cancelled the rename", async () => {
    const { provider, applied } = renameProvider({ applied: true });
    const position = { lineNumber: 1, column: 1 } as monaco.Position;
    const result = await provider.provideRenameEdits(model, position, "y", cancellation(true));
    expect(result).toBeNull();
    expect(applied).toEqual([]);
  });
});

describe("LspCodeActionFeature", () => {
  beforeEach(() => fakeMonaco.reset());

  const serverCommand: Command = { title: "Organize", command: "server.organize" };

  function codeActions(
    actions: CodeAction[],
    result: ApplyWorkspaceEditResult,
    resolved?: CodeAction,
  ) {
    let resolves = 0;
    const ctx = setup(
      {
        textDocumentCodeAction: async () => actions,
        codeActionResolve: async () => {
          resolves++;
          return resolved;
        },
      },
      result,
    );
    const feature = new LspCodeActionFeature(ctx.connection, { diagnosticsForMarkers: () => [] });
    ctx.register(capabilities.textDocumentCodeAction, {
      documentSelector: null,
      resolveProvider: resolved !== undefined,
    });
    const provider = fakeMonaco.providers.get("CodeAction") as monaco.languages.CodeActionProvider;
    const list = async () => {
      const range = { getStartPosition: () => ({ lineNumber: 1, column: 1 }) } as monaco.Range;
      const context = { markers: [], trigger: 1 } as unknown as monaco.languages.CodeActionContext;
      const listed = await provider.provideCodeActions(model, range, context, cancellation());
      return listed?.actions ?? [];
    };
    const run = async (command: monaco.languages.Command | undefined) => {
      const handler = command && fakeMonaco.commands.get(command.id);
      if (!handler) throw new Error(`command ${command?.id} not registered`);
      await handler(undefined, ...(command.arguments ?? []));
    };
    return { ...ctx, feature, provider, list, run, resolves: () => resolves };
  }

  test("carries an action's edit to a command that applies it, then runs the action's command", async () => {
    const edit: WorkspaceEdit = { changes: { "file:///w/b.py": [] } };
    const { list, run, applied, executed } = codeActions(
      [{ title: "Fix", edit, command: serverCommand }],
      { applied: true },
    );

    const [action] = await list();
    expect(action?.edit).toBeUndefined();
    expect(action?.disabled).toBeUndefined();
    await run(action?.command);

    expect(applied).toEqual([edit]);
    expect(executed).toEqual([serverCommand]);
  });

  test("runs a client command on the focused editor after the edit", async () => {
    const triggered: unknown[][] = [];
    fakeMonaco.editors.push({
      hasTextFocus: () => true,
      hasWidgetFocus: () => false,
      trigger: (...args: unknown[]) => triggered.push(args),
    } as unknown as monaco.editor.ICodeEditor);
    const clientCommand: Command = { title: "Rename", command: "editor.action.rename" };
    const { list, run, applied } = codeActions(
      [{ title: "Extract", edit: { changes: {} }, command: clientCommand }],
      { applied: true },
    );

    const [action] = await list();
    await run(action?.command);

    expect(applied).toHaveLength(1);
    expect(triggered).toEqual([["monaco-lsp-client", "editor.action.rename", undefined]]);
  });

  test("does not run the action's command when its edit was not applied", async () => {
    const edit: WorkspaceEdit = { changes: {} };
    const { list, run, executed } = codeActions([{ title: "Fix", edit, command: serverCommand }], {
      applied: false,
      failureReason: "stale",
    });
    const [action] = await list();
    await run(action?.command);
    expect(executed).toEqual([]);
  });

  test("disables an action whose edit cannot be applied at all", async () => {
    const edit: WorkspaceEdit = { documentChanges: [{ kind: "create", uri: "file:///w/new.py" }] };
    const { list } = codeActions([{ title: "Create", edit }], { applied: true });
    const [action] = await list();
    expect(action?.disabled).toBe("File operations are not supported");
  });

  test("resolves an action's edit once and applies it through the command", async () => {
    const edit: WorkspaceEdit = { changes: { "file:///w/b.py": [] } };
    const { list, provider, run, applied, resolves } = codeActions(
      [{ title: "Import", data: 1 }],
      { applied: true },
      { title: "Import", edit },
    );
    const [action] = await list();
    if (!action || !provider.resolveCodeAction) throw new Error("no resolvable action");

    await provider.resolveCodeAction(action, cancellation());
    await provider.resolveCodeAction(action, cancellation());
    await run(action.command);

    expect(resolves()).toBe(1);
    expect(applied).toEqual([edit]);
  });
});

describe("LspApplyEditFeature", () => {
  test("answers workspace/applyEdit with the workspace-edit path's result", async () => {
    const ctx = setup({}, { applied: false, failureReason: "outside" });
    let handler: ((params: { edit: WorkspaceEdit }) => Promise<unknown>) | undefined;
    const connection = ctx.connection as unknown as { connection: unknown };
    connection.connection = {
      registerRequestHandler: (_type: unknown, h: typeof handler) => {
        handler = h;
        return { dispose: () => {} };
      },
    };
    const feature = new LspApplyEditFeature(ctx.connection);

    const answer = await handler?.({ edit: renameEdit });

    expect(answer).toEqual({ ok: { applied: false, failureReason: "outside" } });
    expect(ctx.applied).toEqual([renameEdit]);
    feature.dispose();
  });
});
