/**
 * Mermaid blocks show their diagram alone until the caret is in their source: which block is
 * marked as being edited (code-block-source.ts), what the preview CSS then shows, the toolbar's
 * Edit and Hide, the arrow keys, undo, and that none of it changes the saved markdown. Mermaid is
 * mocked; happy-dom has no layout but applies the stylesheet.
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

void mock.module("mermaid", () => ({
  default: {
    initialize: () => {},
    render: (id: string, source: string) =>
      source.includes("-->\n") || source.endsWith("-->")
        ? Promise.reject(new Error("Parse error"))
        : Promise.resolve({ svg: `<svg id="${id}" viewBox="0 0 100 50"></svg>` }),
  },
}));

/**
 * happy-dom's parser drops the first element of the markup DOMPurify sanitizes (the preview's
 * `.loxel-mermaid` root), so the panel's sanitizer passes markup through here. Sanitizing is
 * covered by code-block-preview.dom.test.ts.
 */
const passThrough = (dirty: string | Node) =>
  typeof dirty === "string" ? dirty : dirty instanceof Element ? dirty.outerHTML : "";
const purify = Object.assign(() => purify, { sanitize: passThrough, addHook: () => {} });
void mock.module("dompurify", () => ({ default: purify }));

const { Crepe } = await import("@milkdown/crepe");
const { PREVIEW_LOADING_HTML, renderCodeBlockPreview } = await import("./code-block-preview");
const { EDITING_CLASS, codeBlockSourcePlugin, keepSourcesClosed } =
  await import("./code-block-source");
const { attachMermaidPreviewControls } = await import("./mermaid-preview-controls");
const { serializeBody, setSourceBaseline } = await import("./MarkdownEditor");

// happy-dom drops a rule whose selector spans lines, as the formatter writes long ones.
const previewCss = (
  await Bun.file(new URL("../../styles/mermaid-preview.css", import.meta.url)).text()
).replaceAll(/\s+/g, " ");

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

/** Each block's index in the document: a diagram, a diagram, an error, an empty block, a diagram. */
const ERROR = 2;
const EMPTY = 3;
const LAST = 4;
const NONE_EDITING = [0, 0, 0, 0, 0];
const editingOnly = (index: number) => NONE_EDITING.map((_, i) => (i === index ? 1 : 0));

let root: HTMLDivElement;
let crepe: CrepeEditor;
let view: EditorView;
let detach: () => void;
let style: HTMLStyleElement;
/** Whether the loading placeholder showed while the document opened. */
let sawLoading: boolean;

/** Resolves once `condition` holds, checked whenever the editor's DOM changes. */
function whenDom(condition: () => boolean): Promise<void> {
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
    observer.observe(root, { subtree: true, childList: true, attributes: true });
  });
}

const blocks = () => [...root.querySelectorAll<HTMLElement>(".milkdown-code-block")];
const block = (index: number) => blocks()[index]!;
const isShown = (el: Element | null) => el !== null && getComputedStyle(el).display !== "none";
const sourceShown = (index: number) => isShown(block(index).querySelector(".codemirror-host"));
const editing = (): number[] =>
  blocks().map((el) => (el.classList.contains(EDITING_CLASS) ? 1 : 0));
const action = (index: number, name: string) =>
  block(index).querySelector<HTMLButtonElement>(`[data-mermaid-action="${name}"]`)!;

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
  sawLoading = false;
  const loading = new MutationObserver(() => {
    if (root.querySelector(".loxel-code-preview-loading")) sawLoading = true;
  });
  loading.observe(root, { subtree: true, childList: true });
  crepe = new Crepe({
    root,
    defaultValue: SOURCE,
    features: { [Crepe.Feature.Latex]: false },
    featureConfigs: {
      [Crepe.Feature.CodeMirror]: {
        renderPreview: renderCodeBlockPreview,
        previewLoading: PREVIEW_LOADING_HTML,
      },
    },
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
      root.querySelector(".loxel-code-preview-loading") === null,
  );
  loading.disconnect();
});

afterEach(async () => {
  detach();
  await crepe.destroy();
  root.remove();
  style.remove();
});

describe("mermaid source visibility", () => {
  test("a loaded document shows diagrams alone, and its initial caret leaves the first", () => {
    // ProseMirror starts the selection in the first block; it cannot type in a hidden source.
    expect(view.state.selection.$head.parent.textContent).toBe("Between");
    expect(editing()).toEqual(NONE_EDITING);
    expect(sourceShown(0)).toBe(false);
    expect(sourceShown(1)).toBe(false);
    expect(isShown(block(0).querySelector(".tools"))).toBe(false);
    expect(isShown(block(0).querySelector(".preview-label"))).toBe(false);
    expect(isShown(action(0, "edit"))).toBe(true);
    expect(isShown(action(0, "hide"))).toBe(false);
  });

  test("the caret placed at the end of a file ending in a diagram opens no source", () => {
    const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, codeEnd(LAST)));
    view.dispatch(keepSourcesClosed(tr));
    expect(editing()).toEqual(NONE_EDITING);
    expect(sourceShown(LAST)).toBe(false);
    // The caret moves to the trailing paragraph after the diagram, where typing shows.
    const { $head } = view.state.selection;
    expect($head.parent.type.name).toBe("paragraph");
    expect($head.pos).toBeGreaterThan(codeEnd(LAST));
  });

  test("a caret placed in an empty mermaid block stays, as its source shows", () => {
    const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, codeStart(EMPTY)));
    view.dispatch(keepSourcesClosed(tr));
    expect(view.state.selection.from).toBe(codeStart(EMPTY));
  });

  test("a disk change applied outside history opens no source", () => {
    const tr = view.state.tr.insertText("x", codeEnd(LAST));
    tr.setSelection(TextSelection.create(tr.doc, codeEnd(1))).setMeta("addToHistory", false);
    view.dispatch(tr);
    expect(editing()).toEqual(NONE_EDITING);
    expect(view.state.selection.$head.parent.textContent).toBe("Between");
  });

  test("selecting a whole block, as the block handle does, opens no source", () => {
    view.dispatch(
      view.state.tr.setSelection(NodeSelection.create(view.state.doc, codeStart(0) - 1)),
    );
    expect(editing()).toEqual(NONE_EDITING);
    expect(sourceShown(0)).toBe(false);
  });

  test("a diagram with a syntax error and an empty block keep their source", () => {
    // happy-dom's `:has()` matches descendants that are not there, so these check the markup the
    // collapse rule keys on (a rendered diagram or the loading placeholder) instead of styles.
    const keyed = ".loxel-mermaid, .loxel-code-preview-loading";
    expect(block(ERROR).querySelector(".loxel-mermaid-error")?.textContent).toContain(
      "Parse error",
    );
    expect(block(ERROR).querySelector(keyed)).toBeNull();
    expect(block(EMPTY).querySelector(".preview-panel")).toBeNull();
  });

  test("blocks show the loading placeholder the source stays hidden behind until they render", () => {
    expect(sawLoading).toBe(true);
    expect(root.querySelector(".loxel-code-preview-loading")).toBeNull();
  });

  test("Edit shows the source with the caret at its start; Hide moves the caret out", () => {
    action(1, "edit").click();
    expect(editing()).toEqual(editingOnly(1));
    expect(view.state.selection.from).toBe(codeStart(1));
    expect(sourceShown(1)).toBe(true);
    expect(isShown(action(1, "edit"))).toBe(false);
    expect(isShown(action(1, "hide"))).toBe(true);

    action(1, "hide").click();
    expect(editing()).toEqual(NONE_EDITING);
    expect(sourceShown(1)).toBe(false);
    expect(view.state.selection.$head.parent.textContent).toBe("Between");
  });

  test("Hide skips the code blocks that follow, so no other source opens", () => {
    action(0, "edit").click();
    action(0, "hide").click();
    expect(editing()).toEqual(NONE_EDITING);
    expect(view.state.selection.$head.parent.textContent).toBe("Between");
  });

  test("the source stays open while the caret is in it and closes when it leaves", () => {
    select(codeStart(0) + 3);
    expect(sourceShown(0)).toBe(true);
    view.dispatch(view.state.tr.insertText("x"));
    expect(editing()).toEqual(editingOnly(0));
    // A transaction that leaves the selection alone keeps the block open.
    view.dispatch(view.state.tr.setMeta("probe", true));
    expect(editing()).toEqual(editingOnly(0));
    select(codeStart(1) + 1);
    expect(editing()).toEqual(editingOnly(1));
    expect(sourceShown(0)).toBe(false);
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
    expect(editing()).toEqual([0, 0, 1, 0, 0, 0]);
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
    expect(editing()).toEqual(editingOnly(1));
    expect(sourceShown(1)).toBe(true);
  });

  test("an arrow key steps into a hidden source and leaves a shown one to the browser", () => {
    select(paragraphStart("Between"));
    expect(pressKey("ArrowLeft")).toBe(true);
    expect(view.state.selection.from).toBe(codeEnd(1));
    expect(editing()).toEqual(editingOnly(1));

    // "End" follows the empty block, whose source shows.
    select(paragraphStart("End"));
    expect(pressKey("ArrowLeft")).toBe(false);
  });

  test("an arrow key leaves a source hidden by Crepe's own preview toggle alone", () => {
    // The toggle (still on diff blocks) hides the source with a class the mark cannot override.
    block(1).querySelector(".codemirror-host")!.classList.add("hidden");
    select(paragraphStart("Between"));
    expect(pressKey("ArrowLeft")).toBe(false);
    expect(editing()).toEqual(NONE_EDITING);
  });

  test("an arrow key selects a rule between the caret and a diagram first", () => {
    select(paragraphStart("End") + "End".length);
    expect(pressKey("ArrowRight")).toBe(false);
    expect(editing()).toEqual(NONE_EDITING);
  });

  test("editing and hiding sources leaves untouched fences byte-identical", () => {
    setSourceBaseline(crepe, SOURCE);
    action(0, "edit").click();
    action(0, "hide").click();
    action(1, "edit").click();
    expect(serializeBody(crepe)).toBe(SOURCE);
  });
});
