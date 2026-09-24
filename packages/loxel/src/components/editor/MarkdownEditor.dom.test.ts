/**
 * Regression tests for programmatic content replacement in the markdown editor.
 * Mounts a real Crepe editor under happy-dom and checks that applying content
 * (own save echo, external disk change) keeps the caret where the user left it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Crepe } from "@milkdown/crepe";
import { editorViewCtx, remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import { undo } from "@milkdown/kit/prose/history";
import { TextSelection } from "@milkdown/kit/prose/state";

import {
  applyBodyToEditor,
  serializeBody,
  setSourceBaseline,
  toEditorBody,
} from "./MarkdownEditor";

let root: HTMLDivElement;
let crepe: Crepe;

beforeEach(async () => {
  root = document.createElement("div");
  document.body.appendChild(root);
  crepe = new Crepe({ root, defaultValue: "hello\n\nworld\n" });
  // Mirror the component's stringify config so canonical forms match production.
  crepe.editor.config((ctx) => {
    ctx.set(remarkStringifyOptionsCtx, {
      ...ctx.get(remarkStringifyOptionsCtx),
      bullet: "-",
      rule: "-",
    });
  });
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

/** Wait past @milkdown/plugin-listener's 200ms debounce. */
function settleListener(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 300);
  });
}

describe("listener sync after programmatic replace", () => {
  test("a user edit restoring the pre-replace doc is still reported", async () => {
    // Own editor so a markdownUpdated listener can be registered before create().
    const el = document.createElement("div");
    document.body.appendChild(el);
    const editor = new Crepe({ root: el, defaultValue: "hello\n\nworld\n" });
    const updates: string[] = [];
    editor.on((api) => {
      api.markdownUpdated((_ctx, markdown) => {
        updates.push(markdown);
      });
    });
    await editor.create();
    try {
      // External change applied programmatically (excluded from history/listener).
      expect(applyBodyToEditor(editor, "hello\n\nworld\n\nagent line\n")).not.toBeNull();
      await settleListener();
      // The resync transaction surfaces exactly the applied content (echo guard territory).
      expect(updates).toEqual(["hello\n\nworld\n\nagent line\n"]);

      // User deletes the agent line in one normal transaction → doc equals the pre-replace doc.
      editor.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { doc } = view.state;
        const last = doc.lastChild!;
        view.dispatch(view.state.tr.delete(doc.content.size - last.nodeSize, doc.content.size));
      });
      await settleListener();
      expect(updates).toEqual(["hello\n\nworld\n\nagent line\n", "hello\n\nworld\n"]);

      // Undo still skips the programmatic replace: it undoes the deletion only.
      const undone = editor.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        return undo(view.state, view.dispatch);
      });
      expect(undone).toBe(true);
      expect(editor.getMarkdown()).toBe("hello\n\nworld\n\nagent line\n");
      const undoneAgain = editor.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        return undo(view.state, view.dispatch);
      });
      expect(undoneAgain).toBe(false);
    } finally {
      await editor.destroy();
      el.remove();
    }
  });
});

describe("toEditorBody", () => {
  test("keeps the source bytes of markdown the editor represents unchanged", () => {
    expect(toEditorBody(crepe, "# Title\n\n* one\n* two\n")).toBe("# Title\n\n* one\n* two\n");
    expect(toEditorBody(crepe, "Title\n=====\n\nbody\n")).toBe("Title\n=====\n\nbody\n");
    expect(toEditorBody(crepe, "1) one\n2) two\n")).toBe("1) one\n2) two\n");
  });

  test("collapses trailing newlines", () => {
    expect(toEditorBody(crepe, "hello\n\n\n")).toBe("hello\n");
  });

  test("is a fixed point of the live document", () => {
    const live = serializeBody(crepe);
    expect(toEditorBody(crepe, live)).toBe(live);
    expect(serializeBody(crepe)).toBe(live); // does not touch the editor
  });
});

/** Replace the text of the first textblock whose content is `from` with `to`, as a user edit. */
function editText(from: string, to: string): void {
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    let found = false;
    view.state.doc.descendants((node, pos) => {
      if (found || !node.isTextblock || node.textContent !== from) return !found;
      found = true;
      view.dispatch(view.state.tr.insertText(to, pos + 1, pos + 1 + from.length));
      return false;
    });
    expect(found).toBe(true);
  });
}

/** Delete the first top-level block whose text is `text`, as a user edit. */
function deleteBlock(text: string): void {
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    let target: { from: number; to: number } | null = null;
    view.state.doc.forEach((node, offset) => {
      if (!target && node.textContent === text)
        target = { from: offset, to: offset + node.nodeSize };
    });
    expect(target).not.toBeNull();
    const { from, to } = target!;
    view.dispatch(view.state.tr.delete(from, to));
  });
}

describe("serializeBody source preservation", () => {
  const source = [
    "Title",
    "=====",
    "",
    "* one",
    "* two",
    "",
    "Some *emphasis* and __strong__ text.",
    "",
    "",
    "",
    "last paragraph",
    "",
  ].join("\n");

  beforeEach(() => {
    applyBodyToEditor(crepe, source);
  });

  test("a freshly loaded non-canonical file serializes to its source bytes", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    // Ends with a list, so the trailing plugin appends an empty paragraph on load.
    const loaded = "Intro\n-----\n\n1) first\n2) second\n\n* a\n* b\n";
    const editor = new Crepe({ root: el, defaultValue: loaded });
    try {
      await editor.create();
      expect(editor.getMarkdown()).not.toBe(loaded); // the serializer alone would rewrite it
      setSourceBaseline(editor, loaded);
      expect(serializeBody(editor)).toBe(loaded);
    } finally {
      await editor.destroy();
      el.remove();
    }
  });

  test("an untouched document serializes to its source bytes", () => {
    expect(serializeBody(crepe)).toBe(source);
  });

  test("editing one block leaves every other block byte-identical", () => {
    editText("last paragraph", "last paragraph, edited");
    expect(serializeBody(crepe)).toBe(source.replace("last paragraph", "last paragraph, edited"));
  });

  test("an edited block and its separators use the serializer form", () => {
    editText("two", "two, edited");
    // The list is rewritten (`-` bullets); the setext heading and the rest keep their bytes.
    expect(serializeBody(crepe)).toBe(
      "Title\n=====\n\n- one\n- two, edited\n\nSome *emphasis* and __strong__ text.\n\n\n\nlast paragraph\n",
    );
  });

  test("undoing an edit restores the source bytes", () => {
    editText("one", "one, edited");
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      expect(undo(view.state, view.dispatch)).toBe(true);
    });
    expect(serializeBody(crepe)).toBe(source);
  });

  test("deleting a block keeps its neighbours", () => {
    deleteBlock("Some emphasis and strong text.");
    expect(serializeBody(crepe)).toBe("Title\n=====\n\n* one\n* two\n\nlast paragraph\n");
  });

  test("link reference definitions between untouched blocks are kept", () => {
    const withRefs = "See [the docs][docs].\n\n[docs]: https://example.com\n\nlast paragraph\n";
    applyBodyToEditor(crepe, withRefs);
    expect(serializeBody(crepe)).toBe(withRefs);
    editText("last paragraph", "last paragraph, edited");
    expect(serializeBody(crepe)).toBe(withRefs.replace("last paragraph", "last paragraph, edited"));
  });

  test("falls back to the serializer form when preserved bytes would change meaning", () => {
    // Deleting the paragraph makes the two source lists adjacent; kept verbatim they would
    // merge into one list, so the output must not be the naive concatenation.
    applyBodyToEditor(crepe, "* a\n\nbetween\n\n* b\n");
    deleteBlock("between");
    const output = serializeBody(crepe);
    expect(output).not.toBe("* a\n\n* b\n");
    expect(toEditorBody(crepe, output)).toBe(output);
    crepe.editor.action((ctx) => {
      // Still two separate lists after a round trip.
      const lists = [] as string[];
      ctx.get(editorViewCtx).state.doc.forEach((node) => lists.push(node.type.name));
      expect(lists.filter((name) => name === "bullet_list")).toHaveLength(2);
    });
  });

  test("an own echo of the preserved body is a no-op", () => {
    editText("last paragraph", "last paragraph, edited");
    expect(applyBodyToEditor(crepe, serializeBody(crepe))).toBeNull();
  });

  test("an external change only rewrites the blocks it touched", () => {
    const external = source.replace("last paragraph", "last paragraph\n\n+ appended by an agent");
    applyBodyToEditor(crepe, external);
    expect(serializeBody(crepe)).toBe(external);
  });
});

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

  test("external edit above the caret in a list-terminated doc keeps the caret", () => {
    // The trailing plugin appends an empty paragraph after the list; the parser never
    // produces one, so a naive diff would span the whole document.
    applyBodyToEditor(crepe, "# Title\n\n- one\n- two\n");
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      expect(view.state.doc.lastChild?.content.size).toBe(0);
      // <h1>Title</h1>(7) <ul><li><p>o|ne
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 7 + 3 + 1)));
    });
    expect(caretContext()).toBe("o");

    const applied = applyBodyToEditor(crepe, "# Changed title\n\n- one\n- two\n");
    expect(applied).toBe("# Changed title\n\n- one\n- two\n");
    expect(caretContext()).toBe("o");
    crepe.editor.action((ctx) => {
      expect(ctx.get(editorViewCtx).state.selection.$from.parent.textContent).toBe("one");
    });
  });

  test("a marker-only change on disk keeps the caret and adopts the new bytes", () => {
    applyBodyToEditor(crepe, "# Notes\n\n- one\n- two\n");
    const before = crepe.editor.action((ctx) => ctx.get(editorViewCtx).state.selection.from);
    const reformatted = toEditorBody(crepe, "# Notes\n\n* one\n* two\n");
    applyBodyToEditor(crepe, reformatted);
    expect(serializeBody(crepe)).toBe("# Notes\n\n* one\n* two\n");
    const after = crepe.editor.action((ctx) => ctx.get(editorViewCtx).state.selection.from);
    expect(after).toBe(before);
  });

  test("external append after an empty heading does not duplicate the heading", () => {
    applyBodyToEditor(crepe, "hello\n\n##\n");
    const applied = applyBodyToEditor(crepe, "hello\n\n##\n\nfrom agent\n");
    expect(applied).toBe("hello\n\n##\n\nfrom agent\n");
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
