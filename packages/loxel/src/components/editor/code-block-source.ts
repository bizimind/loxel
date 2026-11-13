/**
 * Which code block's source the user is editing, for previews that replace their block's source
 * (mermaid diagrams, see mermaid-preview.css).
 *
 * The state is derived from the caret: the code block holding a text selection is marked with
 * {@link EDITING_CLASS}, once a transaction has put the selection there (typing, a click, the
 * arrow keys, undo, search navigation, the preview's Edit button) or has created or changed the
 * block around it (the ```mermaid input rule, a block-type menu). Programmatic placements never
 * open a source: the initial selection, the caret the editor places when a file opens
 * ({@link keepSourcesClosed}), and disk changes applied outside history. So a file opens showing
 * its diagrams, wherever its first and last blocks are. A caret such a placement leaves in a
 * mermaid block could not be typed with, as the source it sits in is not displayed, so it moves to
 * the nearest textblock outside code blocks. A node selection (the block handle) is not editing. Leaving the block, or its preview's Hide button, which moves the caret out, unmarks it.
 * The mark is a node decoration, so it lives on the block's node view and survives CodeMirror being
 * torn down off-screen; a recreated editor starts unmarked, and its restored caret marks the block
 * it lands in.
 */
import type { Node } from "@milkdown/kit/prose/model";
import {
  type EditorState,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type Transaction,
} from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

/** Class on the node view (`.milkdown-code-block`) of the code block being edited. */
export const EDITING_CLASS = "loxel-code-block-editing";

const CODE_BLOCK = "code_block";

const sourceKey = new PluginKey<number | null>("loxel-code-block-source");

/** The start position of the code block holding a text selection's head, or null. */
function codeBlockAt(selection: Selection): number | null {
  if (!(selection instanceof TextSelection)) return null;
  const { $head } = selection;
  return $head.parent.type.name === CODE_BLOCK ? $head.before() : null;
}

function isMermaid(node: Node): boolean {
  const language: unknown = node.attrs.language;
  return typeof language === "string" && language.toLowerCase() === "mermaid";
}

/** The nearest text position from `from` in direction `dir` that is not inside a code block. */
function outsideCodeBlocks(doc: Node, from: number, dir: 1 | -1): Selection | null {
  let found = TextSelection.findFrom(doc.resolve(from), dir, true);
  while (found && found.$head.parent.type.name === CODE_BLOCK) {
    const next = dir > 0 ? found.$head.after() : found.$head.before();
    found = TextSelection.findFrom(doc.resolve(next), dir, true);
  }
  return found;
}

/**
 * Moves a caret out of a mermaid block it sits in unmarked (placed there programmatically), to the
 * nearest textblock after it, or else before it, outside code blocks: the caret placed at the end
 * of a file that ends in a diagram lands in the trailing paragraph. An empty block never hides its
 * source, so its caret stays. A block whose text fails to parse is still rendering when a file
 * opens, so it counts as hidden then.
 */
function releaseCaret(state: EditorState): Transaction | null {
  const block = codeBlockAt(state.selection);
  if (block === null || !state.selection.empty || sourceKey.getState(state) !== null) return null;
  const node = state.doc.nodeAt(block);
  if (!node || !isMermaid(node) || node.textContent.trim() === "") return null;
  const target =
    outsideCodeBlocks(state.doc, block + node.nodeSize, 1) ??
    outsideCodeBlocks(state.doc, block, -1);
  return target ? keepSourcesClosed(state.tr.setSelection(target)) : null;
}

/** Marks a transaction that places the caret for the user, so it opens no source. */
export function keepSourcesClosed(tr: Transaction): Transaction {
  return tr.setMeta(sourceKey, true);
}

/** Whether `tr` created or changed the node at `pos` (a position in `tr.doc`). */
function changesNodeAt(tr: Transaction, pos: number): boolean {
  const end = pos + (tr.doc.nodeAt(pos)?.nodeSize ?? 0);
  return tr.mapping.maps.some((map, index) => {
    const later = tr.mapping.slice(index + 1);
    let changed = false;
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      if (later.map(newStart, -1) < end && later.map(newEnd, 1) > pos) changed = true;
    });
    return changed;
  });
}

function editingDecorations(state: EditorState): DecorationSet {
  const pos = sourceKey.getState(state);
  const node = pos === null || pos === undefined ? null : state.doc.nodeAt(pos);
  if (pos === null || pos === undefined || !node) return DecorationSet.empty;
  return DecorationSet.create(state.doc, [
    Decoration.node(pos, pos + node.nodeSize, { class: EDITING_CLASS }),
  ]);
}

/**
 * Whether the code block at `pos` shows its preview in place of its source by mermaid-preview.css.
 * A source hidden by Crepe's own preview toggle (its `hidden` class, still used by diff blocks)
 * stays hidden with the caret in it, so it does not count.
 */
function isSourceHidden(view: EditorView, pos: number): boolean {
  const dom = view.nodeDOM(pos);
  const host = dom instanceof HTMLElement ? dom.querySelector(".codemirror-host") : null;
  return (
    host instanceof HTMLElement && !host.classList.contains("hidden") && !host.checkVisibility()
  );
}

const ARROWS: Record<string, { dir: 1 | -1; edge: "up" | "down" | "left" | "right" }> = {
  ArrowUp: { dir: -1, edge: "up" },
  ArrowDown: { dir: 1, edge: "down" },
  ArrowLeft: { dir: -1, edge: "left" },
  ArrowRight: { dir: 1, edge: "right" },
};

/** Right-to-left scripts, where Left and Right do not map to backward and forward. */
const RTL_TEXT = /[\u0590-\u08ac]/;

/**
 * The browser cannot move the caret into a source that is not displayed, so an arrow key at the
 * edge of a textblock steps into a neighboring code block with a hidden source explicitly: at the
 * start of its text going forward, at the end going back. The neighbor is the next selection
 * ProseMirror itself would reach, so an atom block in between (a rule) is selected first.
 */
function enterHiddenSource(view: EditorView, event: KeyboardEvent): boolean {
  const arrow = ARROWS[event.key];
  if (!arrow || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
  const { selection, doc } = view.state;
  if (view.composing || !(selection instanceof TextSelection) || !selection.empty) return false;
  const { $head } = selection;
  if ($head.depth === 0) return false;
  const horizontal = arrow.edge === "left" || arrow.edge === "right";
  if (horizontal && RTL_TEXT.test($head.parent.textContent)) return false;
  const beyond = doc.resolve(arrow.dir > 0 ? $head.after() : $head.before());
  const next = Selection.findFrom(beyond, arrow.dir);
  const blockPos = next ? codeBlockAt(next) : null;
  if (!next || blockPos === null || !isSourceHidden(view, blockPos)) return false;
  // Measured last: it reads the layout.
  if (!view.endOfTextblock(arrow.edge)) return false;
  const block = next.$head.parent;
  const target = arrow.dir > 0 ? blockPos + 1 : blockPos + 1 + block.content.size;
  // No `scrollIntoView`: ProseMirror would scroll to an edge of the node view, which has no content
  // DOM; focusing CodeMirror brings the caret into view.
  view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, target)));
  return true;
}

export const codeBlockSourcePlugin = $prose(
  () =>
    new Plugin<number | null>({
      key: sourceKey,
      state: {
        init: () => null,
        apply(tr, prev, _old, state) {
          const block = codeBlockAt(state.selection);
          if (block === null) return null;
          if (prev !== null && tr.mapping.map(prev) === block) return block;
          const programmatic =
            tr.getMeta(sourceKey) === true || tr.getMeta("addToHistory") === false;
          if (programmatic) return null;
          return tr.selectionSet || changesNodeAt(tr, block) ? block : null;
        },
      },
      appendTransaction: (_trs, _old, state) => releaseCaret(state),
      // The initial selection comes with no transaction, so its caret is released once mounted.
      view: (view) => {
        queueMicrotask(() => {
          const tr = view.isDestroyed ? null : releaseCaret(view.state);
          if (tr) view.dispatch(tr);
        });
        return {};
      },
      props: { decorations: editingDecorations, handleKeyDown: enterHiddenSource },
    }),
);

/** The code block node and its start position for a code block node view element. */
function codeBlockOf(view: EditorView, codeBlock: Element): { node: Node; pos: number } | null {
  if (!view.dom.contains(codeBlock)) return null;
  // The node view has no content DOM, so its offset 0 maps to the start of the block's text.
  const $start = view.state.doc.resolve(view.posAtDOM(codeBlock, 0));
  if ($start.parent.type.name !== CODE_BLOCK) return null;
  return { node: $start.parent, pos: $start.before() };
}

/** Shows the block's source with the caret at its start, and focuses it. */
export function editCodeBlockSource(view: EditorView, codeBlock: Element): void {
  const block = codeBlockOf(view, codeBlock);
  if (!block) return;
  const selection = TextSelection.create(view.state.doc, block.pos + 1);
  view.dispatch(view.state.tr.setSelection(selection));
  view.focus();
}

/**
 * Hides the block's source by moving the caret to the nearest textblock after it (or else before
 * it) that is not a code block, so the caret never lands in another diagram's source. With none,
 * an empty paragraph is added after the block for it.
 */
export function hideCodeBlockSource(view: EditorView, codeBlock: Element): void {
  const block = codeBlockOf(view, codeBlock);
  if (!block) return;
  const { doc } = view.state;
  const after = block.pos + block.node.nodeSize;
  const target = outsideCodeBlocks(doc, after, 1) ?? outsideCodeBlocks(doc, block.pos, -1);
  const { tr } = view.state;
  if (target) tr.setSelection(target);
  else {
    tr.insert(after, view.state.schema.nodes.paragraph!.create());
    tr.setSelection(TextSelection.create(tr.doc, after + 1));
  }
  view.dispatch(tr);
  view.focus();
}
