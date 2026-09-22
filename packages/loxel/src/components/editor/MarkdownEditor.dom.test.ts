/**
 * Regression tests for programmatic content replacement in the markdown editor.
 * Mounts a real Crepe editor under happy-dom and checks that applying content
 * (own save echo, external disk change) keeps the caret where the user left it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { undo } from "@milkdown/kit/prose/history";
import { TextSelection } from "@milkdown/kit/prose/state";

import { applyBodyToEditor } from "./MarkdownEditor";

let root: HTMLDivElement;
let crepe: Crepe;

beforeEach(async () => {
  root = document.createElement("div");
  document.body.appendChild(root);
  crepe = new Crepe({ root, defaultValue: "hello\n\nworld\n" });
  await crepe.create();
});

afterEach(async () => {
  await crepe.destroy();
  root.remove();
});

/** Insert an empty paragraph at the top of the doc (vanishes on markdown round trip)
 *  and put the caret inside "world" after "wor". */
function setupEmptyParagraphBeforeCaret(): number {
  return crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    const empty = state.schema.nodes.paragraph!.create();
    view.dispatch(state.tr.insert(0, empty));
    // doc: <p></p>(2) <p>hello</p>(7) <p>wor|ld</p>
    const pos = 2 + 7 + 1 + 3;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
    return pos;
  });
}

function caretContext(): string {
  return crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { $from } = view.state.selection;
    return $from.parent.textContent.slice(0, $from.parentOffset);
  });
}

describe("applyBodyToEditor", () => {
  test("own echo with identical markdown leaves the doc and caret untouched", () => {
    const pos = setupEmptyParagraphBeforeCaret();
    const docBefore = crepe.editor.action((ctx) => ctx.get(editorViewCtx).state.doc);

    // Serialized markdown drops the empty paragraph, so a naive whole-doc replace
    // would shift every position after it by 2 and push the caret into "ld"/next block.
    expect(applyBodyToEditor(crepe, crepe.getMarkdown())).toBeNull();

    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      expect(view.state.doc.eq(docBefore)).toBe(true);
      expect(view.state.selection.from).toBe(pos);
    });
    expect(caretContext()).toBe("wor");
  });

  test("external append keeps the caret in the same text", () => {
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      // <p>hello</p>(7) <p>wor|ld</p>
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 7 + 1 + 3)));
    });

    const applied = applyBodyToEditor(crepe, "hello\n\nworld\n\nappended by agent\n");
    expect(applied).toBe("hello\n\nworld\n\nappended by agent\n");
    expect(caretContext()).toBe("wor");
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      expect(view.state.selection.from).toBe(11);
    });
  });

  test("external edit before the caret keeps the caret in the same text", () => {
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 7 + 1 + 3)));
    });

    applyBodyToEditor(crepe, "hello there, this is longer\n\nworld\n");
    expect(caretContext()).toBe("wor");
  });

  test("programmatic replace is excluded from undo history", () => {
    const applied = applyBodyToEditor(crepe, "hello\n\nworld\n\nmore\n");
    expect(applied).not.toBeNull();
    // Undo is a no-op: nothing was recorded in history for the programmatic step.
    const undone = crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      return undo(view.state, view.dispatch);
    });
    expect(undone).toBe(false);
    expect(crepe.getMarkdown()).toBe("hello\n\nworld\n\nmore\n");

    // Control: a regular edit is undoable.
    const undoneUserEdit = crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.insertText("X", 1));
      return undo(view.state, view.dispatch);
    });
    expect(undoneUserEdit).toBe(true);
  });
});
