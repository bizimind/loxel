/**
 * Shift+Enter in the markdown editor must write a plain newline (issue #489: it wrote CommonMark's
 * trailing-backslash hard break) and the result must reload to the same document. Mounts a real
 * Crepe editor under happy-dom and drives Shift+Enter through the keymap.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { Crepe } from "@milkdown/crepe";
import { editorViewCtx, parserCtx, remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import { DOMParser } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";

import { serializeBody, setSourceBaseline } from "./MarkdownEditor";
import { installSoftLineBreaks } from "./soft-line-break";

const mounted: { crepe: Crepe; root: HTMLDivElement }[] = [];

afterEach(async () => {
  for (const { crepe, root } of mounted.splice(0)) {
    await crepe.destroy();
    root.remove();
  }
});

/** Mount an editor configured like MarkdownEditor, with `source` as its baseline. */
async function mount(source: string): Promise<Crepe> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const crepe = new Crepe({ root, defaultValue: source });
  installSoftLineBreaks(crepe.editor);
  crepe.editor.config((ctx) => {
    ctx.set(remarkStringifyOptionsCtx, {
      ...ctx.get(remarkStringifyOptionsCtx),
      bullet: "-",
      rule: "-",
    });
  });
  await crepe.create();
  setSourceBaseline(crepe, source);
  mounted.push({ crepe, root });
  return crepe;
}

/** Put the caret right after the first occurrence of `marker` in the doc's text. */
function placeCaretAfter(crepe: Crepe, marker: string): void {
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    let caret: number | undefined;
    view.state.doc.descendants((node, pos) => {
      if (caret !== undefined || !node.isText) return;
      const index = node.text?.indexOf(marker) ?? -1;
      if (index >= 0) caret = pos + index + marker.length;
    });
    if (caret === undefined) throw new Error(`marker not found: ${marker}`);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, caret)));
  });
}

function pressShiftEnter(crepe: Crepe): void {
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const event = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true });
    view.someProp("handleKeyDown", (handler) => handler(view, event));
  });
}

/** Serialize, then parse and serialize again as a reload of the saved file would. */
function saveAndReload(crepe: Crepe): { saved: string; reloaded: string } {
  const saved = serializeBody(crepe);
  const reloaded = crepe.editor.action((ctx) => {
    const doc = ctx.get(parserCtx)(saved);
    const view = ctx.get(editorViewCtx);
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content));
    return serializeBody(crepe);
  });
  return { saved, reloaded };
}

function docString(crepe: Crepe): string {
  return crepe.editor.action((ctx) => ctx.get(editorViewCtx).state.doc.toString());
}

describe("Shift+Enter", () => {
  test("writes a single newline, not a backslash hard break, and reloads unchanged", async () => {
    const crepe = await mount("helloworld\n");
    placeCaretAfter(crepe, "hello");
    pressShiftEnter(crepe);

    const { saved, reloaded } = saveAndReload(crepe);
    expect(saved).toBe("hello\nworld\n");
    expect(reloaded).toBe(saved);
    expect(docString(crepe)).toBe('doc(paragraph("hello", hardbreak, "world"))');
  });

  test("renders the newline as a line break", async () => {
    const crepe = await mount("hello\nworld\n");
    const br = crepe.editor.action((ctx) =>
      ctx.get(editorViewCtx).dom.querySelector('br[data-type="hardbreak"]'),
    );
    expect(br?.getAttribute("data-is-inline")).toBe("true");
  });

  test("leaves no whitespace or entities around the newline when typed next to a space", async () => {
    const crepe = await mount("- one two\n\nthree four\n");
    placeCaretAfter(crepe, "one ");
    pressShiftEnter(crepe);
    placeCaretAfter(crepe, "three");
    pressShiftEnter(crepe);

    const { saved, reloaded } = saveAndReload(crepe);
    expect(saved).toBe("- one\n  two\n\nthree\nfour\n");
    expect(reloaded).toBe(saved);
  });

  test("keeps encoded whitespace at the edges of the edited paragraph", async () => {
    const crepe = await mount("&#x20;leading split here\n");
    placeCaretAfter(crepe, "split");
    pressShiftEnter(crepe);

    const { saved, reloaded } = saveAndReload(crepe);
    expect(saved).toBe("&#x20;leading split\nhere\n");
    expect(reloaded).toBe(saved);
  });

  test("escapes block syntax that starts the new line", async () => {
    const crepe = await mount("a- b\n");
    placeCaretAfter(crepe, "a");
    pressShiftEnter(crepe);

    const { saved, reloaded } = saveAndReload(crepe);
    expect(saved).toBe("a\n\\- b\n");
    expect(reloaded).toBe(saved);
  });

  test("twice in a row starts a new paragraph", async () => {
    const crepe = await mount("hello\n");
    placeCaretAfter(crepe, "hello");
    pressShiftEnter(crepe);
    pressShiftEnter(crepe);

    expect(docString(crepe)).toBe('doc(paragraph("hello"), paragraph)');
  });

  test("does not insert a break inside a table cell", async () => {
    const source = "| a | b |\n| - | - |\n| c | d |\n";
    const crepe = await mount(source);
    placeCaretAfter(crepe, "c");
    pressShiftEnter(crepe);

    expect(docString(crepe)).not.toContain("hardbreak");
  });
});

describe("documents that would not reload as shown", () => {
  test("a trailing space typed at the end of a block is kept as a plain space", async () => {
    const crepe = await mount("hello\n");
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.insertText(" ", 6));
    });
    expect(serializeBody(crepe)).toBe("hello \n");
  });

  test("bolding across a soft break keeps it a newline", async () => {
    const crepe = await mount("foo\nbar\n");
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { strong } = view.state.schema.marks;
      if (!strong) throw new Error("no strong mark");
      view.dispatch(view.state.tr.addMark(1, view.state.doc.content.size - 1, strong.create()));
    });
    expect(serializeBody(crepe)).toBe("**foo**\n**bar**\n");
  });

  test("a second press mid-paragraph splits the paragraph without losing text", async () => {
    const crepe = await mount("hello\nworld\n");
    placeCaretAfter(crepe, "wo");
    pressShiftEnter(crepe);
    pressShiftEnter(crepe);
    expect(docString(crepe)).toBe('doc(paragraph("hello", hardbreak, "wo"), paragraph("rld"))');
  });

  test("an empty line between breaks takes the hard form instead of splitting the paragraph", async () => {
    const crepe = await mount("a\nx\nb\n");
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.delete(3, 4)); // the "x"
    });
    const { saved, reloaded } = saveAndReload(crepe);
    expect(saved).toBe("a\n\\\nb\n");
    expect(reloaded).toBe(saved);
  });

  test("a break at the start of a paragraph keeps the rest of the file byte-identical", async () => {
    const crepe = await mount("* a\n\nhello\n\n* b\n");
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      let start = 0;
      view.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === "hello") start = pos;
      });
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start)));
    });
    pressShiftEnter(crepe);
    expect(serializeBody(crepe)).toBe("* a\n\n\\\nhello\n\n* b\n");
  });

  test("an empty line before inline HTML leaves no stray backslash", async () => {
    const crepe = await mount("<span>x</span> tail\n");
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    });
    pressShiftEnter(crepe);
    expect(docString(crepe)).toContain("hardbreak");

    const { saved, reloaded } = saveAndReload(crepe);
    expect(saved).toBe("<span>x</span> tail\n");
    expect(reloaded).toBe(saved);
  });

  test("breaks at the end of a paragraph are not written", async () => {
    const crepe = await mount("a\nx\ny\n\nnext\n");
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.delete(5, 6)); // the "y"
      view.dispatch(view.state.tr.delete(3, 4)); // the "x"
    });
    expect(docString(crepe)).toBe('doc(paragraph("a", hardbreak, hardbreak), paragraph("next"))');
    expect(serializeBody(crepe)).toBe("a\n\nnext\n");
  });

  test("does nothing in a heading", async () => {
    const crepe = await mount("### heading\n");
    placeCaretAfter(crepe, "head");
    pressShiftEnter(crepe);
    expect(serializeBody(crepe)).toBe("### heading\n");
  });

  test("a rendered soft break parses back from the DOM as a soft break", async () => {
    const crepe = await mount("hello\nworld\n");
    const reparsed = crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      return DOMParser.fromSchema(view.state.schema).parse(view.dom);
    });
    let isInline: unknown;
    reparsed.descendants((node) => {
      if (node.type.name === "hardbreak") isInline = node.attrs.isInline;
    });
    expect(isInline).toBe(true);
  });
});

describe("existing line breaks", () => {
  for (const [kind, source] of [
    ["hard", "line one\\\nline two\n"],
    ["soft", "line one\nline two\n"],
  ] as const) {
    test(`Shift+Enter after an existing ${kind} break adds a break instead of splitting`, async () => {
      const crepe = await mount(source);
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        // Caret at the start of "line two", right after the existing break.
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 10)));
      });
      pressShiftEnter(crepe);
      expect(docString(crepe)).toBe('doc(paragraph("line one", hardbreak, hardbreak, "line two"))');
    });
  }

  test("Shift+Enter after a break in a setext heading does nothing", async () => {
    const crepe = await mount("setext\nheading\n===\n");
    placeCaretAfter(crepe, "setext");
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { from } = view.state.selection;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from + 1)));
    });
    pressShiftEnter(crepe);
    expect(docString(crepe)).toBe('doc(heading("setext", hardbreak, "heading"))');
  });

  test("whitespace typed at the start of a line after a hard break is kept", async () => {
    const crepe = await mount("a\\\nb\n");
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.insertText("   ", 3));
    });
    const { saved, reloaded } = saveAndReload(crepe);
    expect(saved).toBe("a\\\n&#x20;  b\n");
    expect(reloaded).toBe(saved);
  });

  test("keep their form in an edited block and leave untouched blocks byte-identical", async () => {
    const source = "* bullet\n\nhard\\\nbreak and soft\nbreak  \nspaces\n";
    const crepe = await mount(source);
    placeCaretAfter(crepe, "and");
    pressShiftEnter(crepe);

    // The edited paragraph is canonicalized: the two-space hard break takes the backslash form.
    expect(serializeBody(crepe)).toBe("* bullet\n\nhard\\\nbreak and\nsoft\nbreak\\\nspaces\n");
  });

  test("an unedited document serializes to its source", async () => {
    const source = "hard\\\nbreak and soft\nbreak\n";
    const crepe = await mount(source);
    expect(serializeBody(crepe)).toBe(source);
  });
});
