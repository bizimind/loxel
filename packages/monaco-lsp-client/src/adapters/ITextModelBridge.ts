import * as monaco from "monaco-editor";

import type { Position, Range, TextDocumentIdentifier } from "../types";

export interface ITextModelBridge {
  /**
   * Whether `model` is one the client syncs to the server (its language and the
   * client's model filter match). Providers answer only for these models, so
   * read-only views the server never opened get no requests.
   */
  isSyncedModel(textModel: monaco.editor.ITextModel): boolean;

  translate(
    textModel: monaco.editor.ITextModel,
    monacoPos: monaco.Position,
  ): { textDocument: TextDocumentIdentifier; position: Position };

  translateRange(textModel: monaco.editor.ITextModel, monacoRange: monaco.Range): Range;

  translateBack(
    textDocument: TextDocumentIdentifier,
    position: Position,
  ): { textModel: monaco.editor.ITextModel; position: monaco.Position };

  translateBackRange(
    textDocument: TextDocumentIdentifier,
    range: Range,
  ): { textModel: monaco.editor.ITextModel; range: monaco.Range };
}

export function assertTargetTextModel<T extends { textModel: monaco.editor.ITextModel }>(
  input: T,
  expectedTextModel: monaco.editor.ITextModel,
): T {
  if (input.textModel !== expectedTextModel) {
    throw new Error(`Expected text model to be ${expectedTextModel}, but got ${input.textModel}`);
  }
  return input;
}
