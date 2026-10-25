import * as monaco from "monaco-editor";

import type { ApplyWorkspaceEditResult } from "../../types";
import { api } from "../../types";
import { Disposable } from "../../utils";
import { LspConnection } from "../LspConnection";
import { toMonacoWorkspaceEdit } from "./common";

/** Answers the server's `workspace/applyEdit` requests by editing open Monaco models. */
export class LspApplyEditFeature extends Disposable {
  constructor(private readonly _connection: LspConnection) {
    super();

    this._register(
      this._connection.capabilities.addStaticClientCapabilities({
        workspace: { applyEdit: true, workspaceEdit: { documentChanges: true } },
      }),
    );

    this._register(
      this._connection.connection.registerRequestHandler(
        api.client.workspaceApplyEdit,
        async (params) => ({
          ok: applyWorkspaceEdit(toMonacoWorkspaceEdit(params.edit, this._connection)),
        }),
      ),
    );
  }
}

/**
 * Applies `edit` to Monaco models, one undo stop per model. Monaco's standalone
 * editor can only edit models that exist (its own bulk-edit service refuses the
 * rest too), so an edit that targets a file with no model, or a model whose
 * version moved on since the server computed it, is refused whole before any
 * model changes.
 */
export function applyWorkspaceEdit(
  edit: monaco.languages.WorkspaceEdit & monaco.languages.Rejection,
): ApplyWorkspaceEditResult {
  if (edit.rejectReason) return { applied: false, failureReason: edit.rejectReason };

  const operationsByModel = new Map<
    monaco.editor.ITextModel,
    monaco.editor.IIdentifiedSingleEditOperation[]
  >();
  for (const resourceEdit of edit.edits) {
    if (!("textEdit" in resourceEdit)) {
      return { applied: false, failureReason: "File operations are not supported" };
    }
    const uri = resourceEdit.resource.toString(true);
    const model = monaco.editor.getModel(resourceEdit.resource);
    if (!model) return { applied: false, failureReason: `${uri} is not open in the editor` };
    if (resourceEdit.versionId !== undefined && resourceEdit.versionId !== model.getVersionId()) {
      return { applied: false, failureReason: `${uri} changed since the edit was computed` };
    }
    const operations = operationsByModel.get(model) ?? [];
    operations.push({
      range: resourceEdit.textEdit.range,
      text: resourceEdit.textEdit.text,
      forceMoveMarkers: true,
    });
    operationsByModel.set(model, operations);
  }

  for (const [model, operations] of operationsByModel) {
    if (hasOverlappingRanges(operations)) {
      const uri = model.uri.toString(true);
      return { applied: false, failureReason: `The edits to ${uri} overlap` };
    }
  }

  for (const [model, operations] of operationsByModel) {
    model.pushStackElement();
    model.pushEditOperations([], operations, () => null);
    model.pushStackElement();
  }
  return { applied: true };
}

/** Monaco throws on overlapping edits mid-way, after other models were already edited. */
function hasOverlappingRanges(operations: monaco.editor.IIdentifiedSingleEditOperation[]): boolean {
  const ranges = operations
    .map((op) => op.range)
    .toSorted((a, b) =>
      comparePositions(a.startLineNumber, a.startColumn, b.startLineNumber, b.startColumn),
    );
  return ranges.some((range, i) => {
    const previous = ranges[i - 1];
    if (!previous) return false;
    return (
      comparePositions(
        range.startLineNumber,
        range.startColumn,
        previous.endLineNumber,
        previous.endColumn,
      ) < 0
    );
  });
}

function comparePositions(lineA: number, columnA: number, lineB: number, columnB: number): number {
  return lineA === lineB ? columnA - columnB : lineA - lineB;
}
