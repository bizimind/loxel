/**
 * Mermaid blocks show their diagram alone until the caret is in their source: which blocks
 * code-block-source.ts collapses, what the preview CSS then shows, the toolbar's Edit and Hide,
 * the arrow keys, undo, where programmatic carets go, and that none of it changes the saved
 * markdown. Mermaid is mocked; happy-dom has no layout but applies the stylesheet.
 *
 * The module mocks below (mermaid, and a pass-through DOMPurify) last for the whole process, so this
 * file relies on the package's test script running each file isolated (`--parallel`).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { Crepe as CrepeEditor } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { undo } from "@milkdown/kit/prose/history";
import { NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

/** happy-dom never reports intersections; code blocks only mount once they are visible. */
class ImmediateIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element): void {
    const entry = { target, isIntersecting: true };
    queueMicrotask(() => this.callback([entry as IntersectionObserverEntry], this as never));
  }
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.IntersectionObserver = ImmediateIntersectionObserver as never;

/** Text ending in a dangling arrow fails to parse. */
const isBroken = (source: string) => source.trimEnd().endsWith("-->");

void mock.module("mermaid", () => ({
  default: {
    initialize: () => {},
    render: (id: string, source: string) =>
      isBroken(source)
        ? Promise.reject(new Error("Parse error"))
        : Promise.resolve({ svg: `<svg id="${id}" viewBox="0 0 100 50"></svg>` }),
  },
}));

/**
 * happy-dom's parser drops the first element of the markup DOMPurify sanitizes (the preview's
 * `.loxel-mermaid` root, which the toolbar's delegation looks for), so the panel's sanitizer passes
 * markup through here. Sanitizing is covered by code-block-preview.dom.test.ts.
 */
const passThrough = (dirty: string | Node) =>
  typeof dirty === "string" ? dirty : dirty instanceof Element ? dirty.outerHTML : "";
const purify = Object.assign(() => purify, { sanitize: passThrough, addHook: () => {} });
void mock.module("dompurify", () => ({ default: purify }));

const { Crepe } = await import("@milkdown/crepe");
const { renderCodeBlockPreview } = await import("./code-block-preview");
const { COLLAPSED_CLASS, codeBlockSourcePlugin, keepSourcesClosed } =
  await import("./code-block-source");
const { attachMermaidPreviewControls } = await import("./mermaid-preview-controls");
const { recordMermaidRender } = await import("./mermaid-render-results");
const { serializeBody, setSourceBaseline } = await import("./MarkdownEditor");

const previewCss = await Bun.file(
  new URL("../../styles/mermaid-preview.css", import.meta.url),
).text();

const SOURCE = [
  "```mermaid",
  "graph TD",
  "  A --> B",
  "```",
  "",
  "```mermaid",
  "graph LR",
  "  C --> D",
  "```",
  "",
  "Between",
  "",
  "```diff",
  "-old",
  "+new",
  "```",
  "",
  "```mermaid",
  "graph TD",
  "  A -->",
  "```",
  "",
  "```mermaid",
  "```",
  "",
  "End",
  "",
  "---",
  "",
  "```mermaid",
  "graph TD",
  "  E --> F",
  "```",
  "",
].join("\n");

/** Each code block's index: two diagrams, a diff, a broken diagram, an empty one, a last diagram. */
const DIFF = 2;
const BROKEN = 3;
const EMPTY = 4;
const LAST = 5;
/** Which blocks show only their diagram while none is open. */
const AT_REST = [1, 1, 0, 0, 0, 1];
const openOnly = (index: number) => AT_REST.map((value, i) => (i === index ? 0 : value));

let root: HTMLDivElement;
let crepe: CrepeEditor;
let view: EditorView;
let detach: () => void;
let style: HTMLStyleElement;
/** What the blocks went through while the document opened. */
let seen: { emptyCollapsed: boolean; emptyPanel: boolean };

/** Resolves once `condition` holds, checked whenever the editor's DOM (or `target`) changes. */
function whenDom(condition: () => boolean, target: Node = root): Promise<void> {
  return new Promise((resolve) => {
    if (condition()) {
      resolve();
      return;
    }
    const observer = new MutationObserver(() => {
      if (!condition()) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(target, { subtree: true, childList: true, attributes: true });
  });
}

const blocks = () => [...root.querySelectorAll<HTMLElement>(".milkdown-code-block")];
const block = (index: number) => blocks()[index]!;
const isShown = (el: Element | null) => el !== null && getComputedStyle(el).display !== "none";
const sourceShown = (index: number) => isShown(block(index).querySelector(".codemirror-host"));
const collapsed = (): number[] =>
  blocks().map((el) => (el.classList.contains(COLLAPSED_CLASS) ? 1 : 0));
const action = (index: number, name: string) =>
  block(index).querySelector<HTMLButtonElement>(`[data-mermaid-action="${name}"]`)!;
const caretText = () => view.state.selection.$head.parent.textContent;

/** The document position of the start of the `index`th code block's text. */
function codeStart(index: number): number {
  return view.posAtDOM(block(index), 0);
}

/** The end of the `index`th code block's text. */
function codeEnd(index: number): number {
  return codeStart(index) + view.state.doc.resolve(codeStart(index)).parent.content.size;
}

/** The start of the paragraph whose text is `text`. */
function paragraphStart(text: string): number {
  let found = -1;
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === "paragraph" && node.textContent === text) found = pos + 1;
  });
  if (found < 0) throw new Error(`No paragraph "${text}"`);
  return found;
}

function select(pos: number): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
}

function pressKey(key: string): boolean {
  const event = new KeyboardEvent("keydown", { key });
  return view.someProp("handleKeyDown", (handler) => handler(view, event)) ?? false;
}

beforeEach(async () => {
  style = document.createElement("style");
  style.textContent = previewCss;
  document.head.append(style);
  root = document.createElement("div");
  document.body.append(root);
  seen = { emptyCollapsed: false, emptyPanel: false };
  const watch = new MutationObserver(() => {
    const empty = blocks()[EMPTY];
    if (empty?.classList.contains(COLLAPSED_CLASS)) seen.emptyCollapsed = true;
    if (empty?.querySelector(".preview-panel")) seen.emptyPanel = true;
  });
  watch.observe(root, { subtree: true, childList: true, attributes: true });
  crepe = new Crepe({
    root,
    defaultValue: SOURCE,
    features: { [Crepe.Feature.Latex]: false },
    featureConfigs: { [Crepe.Feature.CodeMirror]: { renderPreview: renderCodeBlockPreview } },
  });
  crepe.editor.use(codeBlockSourcePlugin);
  await crepe.create();
  view = crepe.editor.action((ctx) => ctx.get(editorViewCtx));
  detach = attachMermaidPreviewControls(
    root,
    () => {},
    () => view,
  );
  await whenDom(
    () =>
      root.querySelectorAll(".loxel-mermaid").length === 3 &&
      root.querySelector(".loxel-mermaid-error") !== null &&
      !block(BROKEN).classList.contains(COLLAPSED_CLASS),
  );
  watch.disconnect();
});

afterEach(async () => {
  detach();
  await crepe.destroy();
  root.remove();
  style.remove();
});

describe("mermaid source visibility", () => {
  test("a loaded document shows its diagrams alone", () => {
    expect(collapsed()).toEqual(AT_REST);
    expect([0, 1, LAST].map(sourceShown)).toEqual([false, false, false]);
    expect(isShown(block(0).querySelector(".tools"))).toBe(false);
    expect(isShown(block(0).querySelector(".preview-label"))).toBe(false);
    expect(isShown(action(0, "edit"))).toBe(true);
    expect(isShown(action(0, "hide"))).toBe(false);
    // ProseMirror starts the selection in the first block, where it could not type.
    expect(caretText()).toBe("Between");
  });

  test("a broken diagram starts as a diagram, then shows its source and error", async () => {
    // Results are kept per source text, so a text no other test rendered.
    const broken = `graph TD\n  Fresh${crypto.randomUUID().slice(0, 8)} -->`;
    const { tr } = view.state;
    tr.insertText(broken, codeStart(1), codeEnd(1)).setMeta("addToHistory", false);
    view.dispatch(tr);
    expect(collapsed()[1]).toBe(1);
    await whenDom(() => block(1).querySelector(".loxel-mermaid-error") !== null);
    expect(collapsed()[1]).toBe(0);
    expect(sourceShown(1)).toBe(true);
    expect(isShown(block(1).querySelector(".preview-toggle-button"))).toBe(false);
  });

  test("a diagram known to be broken shows its source from the start", () => {
    // Every editor after the first opens with the broken block's failure already known.
    expect(block(BROKEN).querySelector(".loxel-mermaid-error")?.textContent).toContain(
      "Parse error",
    );
    expect(sourceShown(BROKEN)).toBe(true);
    expect(isShown(action(BROKEN, "edit"))).toBe(false);
  });

  test("a block collapsed over an error still offers Edit", () => {
    // Its text's failure cleared elsewhere (the same text rendering in another block).
    const text = view.state.doc.resolve(codeStart(BROKEN)).parent.textContent;
    recordMermaidRender(text, true);
    expect(collapsed()[BROKEN]).toBe(1);
    expect(isShown(action(BROKEN, "edit"))).toBe(true);
    action(BROKEN, "edit").click();
    expect(collapsed()[BROKEN]).toBe(0);
    expect(sourceShown(BROKEN)).toBe(true);
  });

  test("the open block's failure does not age out while others are recorded", () => {
    select(codeStart(BROKEN) + 1);
    for (let i = 0; i < 2500; i++) recordMermaidRender(`elsewhere ${i} -->`, false);
    select(paragraphStart("End"));
    expect(collapsed()).toEqual(AT_REST);
    expect(sourceShown(BROKEN)).toBe(true);
  });

  test("a document of one diagram releases its initial caret to the trailing paragraph", async () => {
    const other = document.createElement("div");
    document.body.append(other);
    const single = new Crepe({
      root: other,
      defaultValue: "```mermaid\ngraph TD\n  S --> T\n```\n",
      features: { [Crepe.Feature.Latex]: false },
      featureConfigs: { [Crepe.Feature.CodeMirror]: { renderPreview: renderCodeBlockPreview } },
    });
    single.editor.use(codeBlockSourcePlugin);
    try {
      await single.create();
      const singleView = single.editor.action((ctx) => ctx.get(editorViewCtx));
      await whenDom(() => singleView.state.selection.$head.parent.type.name === "paragraph", other);
      expect(singleView.state.doc.childCount).toBe(2);
    } finally {
      await single.destroy();
      other.remove();
    }
  });

  test("an empty block shows its source from the start, with no preview", () => {
    expect(seen.emptyCollapsed).toBe(false);
    expect(seen.emptyPanel).toBe(false);
    expect(sourceShown(EMPTY)).toBe(true);
  });

  test("the caret placed at the end of a file ending in a diagram opens no source", () => {
    const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, codeEnd(LAST)));
    view.dispatch(keepSourcesClosed(tr));
    expect(collapsed()).toEqual(AT_REST);
    // The caret moves to the trailing paragraph after the diagram, where typing shows.
    const { $head } = view.state.selection;
    expect($head.parent.type.name).toBe("paragraph");
    expect($head.pos).toBeGreaterThan(codeEnd(LAST));
  });

  test("a caret placed in an empty block stays, as its source shows", () => {
    const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, codeStart(EMPTY)));
    view.dispatch(keepSourcesClosed(tr));
    expect(view.state.selection.from).toBe(codeStart(EMPTY));
  });

  test("a disk change applied outside history opens no source", () => {
    const tr = view.state.tr.insertText("x", codeEnd(LAST));
    tr.setSelection(TextSelection.create(tr.doc, codeEnd(1))).setMeta("addToHistory", false);
    view.dispatch(tr);
    expect(collapsed()).toEqual(AT_REST);
    expect(caretText()).toBe("Between");
  });

  test("selecting a whole block, as the block handle does, opens no source", () => {
    // With a real DOM selection, CodeMirror synchronizes focus even without a text edit.
    view.focus();
    for (const index of [0, 1, LAST, 0]) {
      const selection = NodeSelection.create(view.state.doc, codeStart(index) - 1);
      view.dispatch(view.state.tr.setSelection(selection));
      expect(view.state.selection.eq(selection)).toBe(true);
      expect(collapsed()).toEqual(AT_REST);
      expect(sourceShown(index)).toBe(false);
      expect(block(index).querySelector(".codemirror-host")?.contains(document.activeElement)).toBe(
        false,
      );
      expect(view.hasFocus()).toBe(true);
    }

    // Editing still moves from a whole-node selection into its source.
    action(0, "edit").click();
    expect(view.state.selection).toBeInstanceOf(TextSelection);
    expect(collapsed()).toEqual(openOnly(0));
    expect(sourceShown(0)).toBe(true);

    const wholeBlock = NodeSelection.create(view.state.doc, codeStart(0) - 1);
    view.dispatch(view.state.tr.setSelection(wholeBlock));
    expect(view.state.selection.eq(wholeBlock)).toBe(true);
    expect(collapsed()).toEqual(AT_REST);
    select(codeStart(0) + 2);
    expect(collapsed()).toEqual(openOnly(0));
  });

  test("Edit shows the source with the caret at its start; Hide moves the caret out", () => {
    action(1, "edit").click();
    expect(collapsed()).toEqual(openOnly(1));
    expect(view.state.selection.from).toBe(codeStart(1));
    expect(sourceShown(1)).toBe(true);
    expect(isShown(action(1, "edit"))).toBe(false);
    expect(isShown(action(1, "hide"))).toBe(true);

    action(1, "hide").click();
    expect(collapsed()).toEqual(AT_REST);
    expect(caretText()).toBe("Between");
  });

  test("Hide skips the code blocks that follow, so no other source opens", () => {
    action(0, "edit").click();
    action(0, "hide").click();
    expect(collapsed()).toEqual(AT_REST);
    expect(caretText()).toBe("Between");
  });

  test("the source stays open while the caret is in it and closes when it leaves", () => {
    select(codeStart(0) + 3);
    view.dispatch(view.state.tr.insertText("x"));
    // A transaction that leaves the selection alone keeps the block open.
    view.dispatch(view.state.tr.setMeta("probe", true));
    expect(collapsed()).toEqual(openOnly(0));
    select(codeStart(1) + 1);
    expect(collapsed()).toEqual(openOnly(1));
    expect(sourceShown(0)).toBe(false);
  });

  test("a parse error while typing neither collapses the block nor moves the caret", async () => {
    select(codeEnd(0));
    view.dispatch(view.state.tr.insertText("\n  B -->"));
    const caret = view.state.selection.from;
    await whenDom(() => block(0).querySelector(".loxel-mermaid-error") !== null);
    expect(collapsed()).toEqual(openOnly(0));
    expect(view.state.selection.from).toBe(caret);
    // Left broken, it keeps showing its source.
    select(paragraphStart("Between"));
    expect(sourceShown(0)).toBe(true);
  });

  test("a block typed as ```mermaid shows its source while it is written and rendered", async () => {
    const start = paragraphStart("Between");
    const typed = view.state.tr.insertText("```mermaid", start, start + "Between".length);
    const end = start + "```mermaid".length;
    view.dispatch(typed.setSelection(TextSelection.create(typed.doc, end)));
    const typeSpace = () => view.state.tr.insertText(" ", end, end);
    const handled = view.someProp("handleTextInput", (handler) =>
      handler(view, end, end, " ", typeSpace),
    );
    expect(handled).toBe(true);
    const { $head } = view.state.selection;
    expect($head.parent.type.name).toBe("code_block");
    expect($head.parent.attrs.language).toBe("mermaid");
    // Its CodeMirror mounts once the block is seen.
    await whenDom(() => block(2).querySelector(".codemirror-host") !== null);
    expect(sourceShown(2)).toBe(true);

    view.dispatch(view.state.tr.insertText("graph TD\n  X --> Y"));
    await whenDom(() => block(2).querySelector(".loxel-mermaid") !== null);
    expect(sourceShown(2)).toBe(true);
    select(paragraphStart("End"));
    expect(sourceShown(2)).toBe(false);
  });

  test("undo reopens the block it changes", () => {
    select(codeStart(1) + 1);
    view.dispatch(view.state.tr.insertText("x"));
    select(paragraphStart("End"));
    expect(sourceShown(1)).toBe(false);
    undo(view.state, view.dispatch);
    expect(collapsed()).toEqual(openOnly(1));
    expect(sourceShown(1)).toBe(true);
  });

  test("an arrow key steps into a hidden source and leaves a shown one to the browser", () => {
    select(paragraphStart("Between"));
    expect(pressKey("ArrowLeft")).toBe(true);
    expect(view.state.selection.from).toBe(codeEnd(1));
    expect(collapsed()).toEqual(openOnly(1));

    // "End" follows the empty block, whose source shows.
    select(paragraphStart("End"));
    expect(pressKey("ArrowLeft")).toBe(false);
  });

  test("an arrow key selects a rule between the caret and a diagram first", () => {
    select(paragraphStart("End") + "End".length);
    expect(pressKey("ArrowRight")).toBe(false);
    expect(collapsed()).toEqual(AT_REST);
  });

  test("an arrow key leaves a diff block alone, even with its source hidden by Crepe", () => {
    block(DIFF).querySelector<HTMLButtonElement>(".preview-toggle-button")!.click();
    select(paragraphStart("Between") + "Between".length);
    expect(pressKey("ArrowRight")).toBe(false);
    expect(caretText()).toBe("Between");
  });

  test("editing and hiding sources leaves untouched fences byte-identical", () => {
    setSourceBaseline(crepe, SOURCE);
    action(0, "edit").click();
    action(0, "hide").click();
    action(1, "edit").click();
    expect(serializeBody(crepe)).toBe(SOURCE);
  });
});
