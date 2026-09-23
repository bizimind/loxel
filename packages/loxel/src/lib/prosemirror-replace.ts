/**
 * Build a transaction that turns `state.doc` into `newDoc` by replacing only the
 * changed region, so the selection is mapped through the step instead of being
 * restored from an absolute offset.
 *
 * A whole-document `replaceWith(0, size, ...)` plus an absolute caret offset breaks
 * when parse(serialize(doc)) is not structurally identical to the live doc (for
 * example, empty paragraphs vanish on the markdown round trip, shifting every later
 * position by 2). Replacing only the differing span keeps positions outside it stable,
 * and ProseMirror maps the selection through the transaction for positions inside it.
 *
 * Returns null when the documents are already identical.
 */
import type { Node as ProseMirrorNode } from "@milkdown/kit/prose/model";
import { type EditorState, type Transaction, Selection } from "@milkdown/kit/prose/state";

export function createMinimalReplaceTransaction(
  state: EditorState,
  parsedDoc: ProseMirrorNode,
): Transaction | null {
  const oldDoc = state.doc;
  const newDoc = withTrailingEmptyParagraph(oldDoc, parsedDoc);
  const start = oldDoc.content.findDiffStart(newDoc.content);
  if (start === null) return null;

  const diffEnd = oldDoc.content.findDiffEnd(newDoc.content);
  // findDiffEnd is non-null whenever findDiffStart is.
  if (diffEnd === null) return null;

  let { a: endA, b: endB } = diffEnd;
  // The common prefix and suffix may overlap (e.g. inserting a repeated character);
  // clamp so the replaced ranges never start after they end.
  if (endA < start) {
    endB += start - endA;
    endA = start;
  }
  if (endB < start) {
    endA += start - endB;
    endB = start;
  }

  const tr = state.tr.replace(start, endA, newDoc.slice(start, endB));
  if (tr.doc.eq(newDoc)) return tr.setMeta("addToHistory", false);

  // `replace` fits open slices into the surrounding structure and may produce a slightly
  // different tree at block boundaries. The editor must end up exactly at `newDoc`, so fall
  // back to a whole-document replace. Mapping through that step would push the caret to the
  // end of the doc, so restore it near its previous absolute offset instead (best effort).
  const { anchor } = state.selection;
  const fallback = state.tr.replaceWith(0, oldDoc.content.size, newDoc.content);
  const pos = Math.min(anchor, fallback.doc.content.size);
  return fallback
    .setSelection(Selection.near(fallback.doc.resolve(pos)))
    .setMeta("addToHistory", false);
}

function isEmptyTextblock(node: ProseMirrorNode | null): boolean {
  return node !== null && node.isTextblock && node.content.size === 0;
}

/**
 * Milkdown's trailing plugin keeps an empty paragraph after a last block that is not a
 * paragraph/heading; the markdown parser never produces one. Without this, findDiffEnd
 * finds no common suffix and the "minimal" replace spans the whole document, dragging the
 * caret to the end. Carry the live doc's trailing empty paragraph over to the target so the
 * suffix matches (the plugin would re-append it anyway).
 */
function withTrailingEmptyParagraph(
  oldDoc: ProseMirrorNode,
  newDoc: ProseMirrorNode,
): ProseMirrorNode {
  const trailing = oldDoc.lastChild;
  if (!isEmptyTextblock(trailing) || isEmptyTextblock(newDoc.lastChild)) return newDoc;
  return newDoc.copy(newDoc.content.addToEnd(trailing!));
}
