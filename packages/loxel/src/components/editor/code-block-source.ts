/**
 * Whether a mermaid block shows its source or only its diagram: one decision, made here from the
 * editor state and read by the preview CSS (mermaid-preview.css), the arrow keys and the caret.
 *
 * A block hides its source ({@link hidesSource}) when it has text and that text's last render did
 * not fail (mermaid-render-results.ts; a render still pending counts as a diagram, so a file opens
 * showing diagrams, and a block whose diagram fails expands once its error arrives). It is
 * collapsed ({@link COLLAPSED_CLASS}) when it hides its source and is not open.
 *
 * A code block is open while it holds a text selection that a transaction put there (typing, a
 * click, the arrow keys, undo, search navigation, the preview's Edit button) or that sits in a
 * block the transaction created or changed (the ```mermaid input rule, a block-type menu). Open
 * does not depend on the render result, so a parse error while typing never collapses the block.
 * Programmatic placements open nothing: the initial selection, the caret the editor places when a
 * file opens ({@link keepSourcesClosed}), and disk changes applied outside history. A caret such a
 * placement leaves in a collapsed block could not type into its hidden source, so it moves to the
 * nearest textblock outside code blocks. A node selection (the block handle) is not editing.
 *
 * The classes are node decorations, so they live on the block's node view and survive CodeMirror's
 * off-screen teardown; a recreated editor opens nothing, and its restored caret opens the block it
 * lands in.
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

import {
  mermaidRenderFailed,
  onMermaidRenderResult,
} from "@/components/editor/mermaid-render-results";

/** Class on the node view (`.milkdown-code-block`) of every mermaid block. */
export const MERMAID_BLOCK_CLASS = "loxel-mermaid-block";
/** Class on the node view of a mermaid block showing only its diagram. */
export const COLLAPSED_CLASS = "loxel-code-block-collapsed";

const CODE_BLOCK = "code_block";

interface SourceState {
  /** The start position of the open code block, or null. */
  open: number | null;
  decorations: DecorationSet;
}

type SourceMeta = "keep-closed" | "rendered";

const sourceKey = new PluginKey<SourceState>("loxel-code-block-source");

function isMermaid(node: Node): boolean {
  const language: unknown = node.attrs.language;
  return typeof language === "string" && language.toLowerCase() === "mermaid";
}

/** Whether a mermaid block shows its diagram in place of its source when it is not open. */
function hidesSource(node: Node): boolean {
  if (node.type.name !== CODE_BLOCK || !isMermaid(node)) return false;
  const text = node.textContent;
  return text.trim() !== "" && !mermaidRenderFailed(text);
}

/** The start position of the code block holding a text selection's head, or null. */
function codeBlockAt(selection: Selection): number | null {
  if (!(selection instanceof TextSelection)) return null;
  const { $head } = selection;
  return $head.parent.type.name === CODE_BLOCK ? $head.before() : null;
}

/** Marks a transaction that places the caret for the user, so it opens no source. */
export function keepSourcesClosed(tr: Transaction): Transaction {
  return tr.setMeta(sourceKey, "keep-closed" satisfies SourceMeta);
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

/** The open code block after `tr`. */
function openBlock(tr: Transaction, prev: number | null, state: EditorState): number | null {
  const block = codeBlockAt(state.selection);
  if (block === null) return null;
  if (prev !== null && tr.mapping.map(prev) === block) return block;
  const programmatic =
    tr.getMeta(sourceKey) === "keep-closed" || tr.getMeta("addToHistory") === false;
  if (programmatic) return null;
  return tr.selectionSet || changesNodeAt(tr, block) ? block : null;
}

function blockDecorations(doc: Node, open: number | null): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== CODE_BLOCK) return !node.isTextblock;
    if (!isMermaid(node)) return false;
    const collapsed = pos !== open && hidesSource(node);
    const className = collapsed ? `${MERMAID_BLOCK_CLASS} ${COLLAPSED_CLASS}` : MERMAID_BLOCK_CLASS;
    decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: className }));
    return false;
  });
  return DecorationSet.create(doc, decorations);
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
 * Moves a caret out of a collapsed block it sits in (placed there programmatically), to the
 * nearest textblock after it, or else before it, outside code blocks: the caret placed at the end
 * of a file that ends in a diagram lands in the trailing paragraph.
 */
function releaseCaret(state: EditorState): Transaction | null {
  const block = codeBlockAt(state.selection);
  if (block === null || !state.selection.empty || sourceKey.getState(state)?.open !== null) {
    return null;
  }
  const node = state.doc.nodeAt(block);
  if (!node || !hidesSource(node)) return null;
  const target =
    outsideCodeBlocks(state.doc, block + node.nodeSize, 1) ??
    outsideCodeBlocks(state.doc, block, -1);
  return target ? keepSourcesClosed(state.tr.setSelection(target)) : null;
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
 * edge of a textblock steps into a neighboring collapsed block explicitly: at the start of its text
 * going forward, at the end going back. The neighbor is the next selection ProseMirror itself would
 * reach, so an atom block in between (a rule) is selected first.
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
  if (!next || blockPos === null || !hidesSource(next.$head.parent)) return false;
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
    new Plugin<SourceState>({
      key: sourceKey,
      state: {
        init: (_config, state) => ({ open: null, decorations: blockDecorations(state.doc, null) }),
        apply(tr, prev, _old, state) {
          const open = openBlock(tr, prev.open, state);
          const rendered = tr.getMeta(sourceKey) === "rendered";
          if (!tr.docChanged && !rendered && open === prev.open) return prev;
          return { open, decorations: blockDecorations(state.doc, open) };
        },
      },
      appendTransaction: (_trs, _old, state) => releaseCaret(state),
      view: (view) => {
        // The initial selection comes with no transaction, so its caret is released once mounted.
        queueMicrotask(() => {
          const tr = view.isDestroyed ? null : releaseCaret(view.state);
          if (tr) view.dispatch(tr);
        });
        const unsubscribe = onMermaidRenderResult(() => {
          if (!view.isDestroyed) {
            view.dispatch(view.state.tr.setMeta(sourceKey, "rendered" satisfies SourceMeta));
          }
        });
        return { destroy: unsubscribe };
      },
      props: {
        decorations: (state) => sourceKey.getState(state)?.decorations,
        handleKeyDown: enterHiddenSource,
      },
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
