import { type Editor, remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import {
  hardbreakAttr,
  hardbreakClearMarkPlugin,
  hardbreakFilterNodes,
  hardbreakSchema,
} from "@milkdown/kit/preset/commonmark";
import type { Node } from "@milkdown/kit/prose/model";
import { type Command, Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import { AddMarkStep, ReplaceStep, canSplit } from "@milkdown/kit/prose/transform";
import { $prose, $useKeymap } from "@milkdown/kit/utils";
import type { Nodes, Parents, Text } from "mdast";

/**
 * Shift+Enter writes a single newline instead of CommonMark's backslash hard break.
 *
 * Milkdown models both kinds of line break as a `hardbreak` node. `isInline: true` is a soft
 * break (a plain newline inside a paragraph, which Milkdown's remark-line-break plugin parses
 * from the source) and serializes to a `"\n"` text node; `isInline: false` is a hard break (`\`
 * or two trailing spaces in the source) and serializes to `\`+newline. Milkdown's own Shift+Enter
 * inserts the hard form, so a typed line break showed up in the file as a trailing backslash.
 *
 * Soft breaks are also rendered as `<br>` rather than Milkdown's default space, so a newline in
 * the file reads as a line break in the editor, as in Obsidian or GitHub comments.
 */
function insertSoftBreak(ctx: Ctx): Command {
  return (state, dispatch) => {
    const { selection } = state;
    if (!(selection instanceof TextSelection)) return false;
    const hardbreak = hardbreakSchema.type(ctx);
    const { $from, $to } = selection;

    // A second press right after a break splits the paragraph there (in a list item, into two
    // paragraphs of that item).
    if (selection.empty && $from.nodeBefore?.type === hardbreak) {
      const tr = state.tr.delete($from.pos - 1, $from.pos);
      if (!canSplit(tr.doc, $from.pos - 1)) return false;
      dispatch?.(tr.split($from.pos - 1).scrollIntoView());
      return true;
    }

    // Spaces next to a line break are not saved (see prepareText), so remove them here too
    // and keep the editor showing what the file will hold.
    const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
    const textAfter = $to.parent.textBetween(
      $to.parentOffset,
      $to.parent.content.size,
      undefined,
      "￼",
    );
    const from = $from.pos - (/[\t ]*$/.exec(textBefore)?.[0].length ?? 0);
    const to = $to.pos + (/^[\t ]*/.exec(textAfter)?.[0].length ?? 0);

    // The "hardbreak" meta opts into Milkdown's filter (no breaks in tables, code blocks, or
    // headings) and mark clearing.
    const tr = state.tr
      .setMeta("hardbreak", true)
      .replaceWith(from, to, hardbreak.create({ isInline: true }));
    dispatch?.(tr.setSelection(TextSelection.create(tr.doc, from + 1)).scrollIntoView());
    return true;
  };
}

const softBreakKeymap = $useKeymap("softBreakKeymap", {
  InsertSoftBreak: {
    shortcuts: "Shift-Enter",
    // Above the default 50 so it runs before Milkdown's hardbreak keymap.
    priority: 100,
    command: insertSoftBreak,
  },
});

/**
 * Milkdown's hardbreakClearMarkPlugin with the break's attrs kept: the original passes no attrs to
 * setNodeMarkup, which turns a soft break into a hard one whenever a mark is applied across it.
 */
const clearBreakMarksPlugin = $prose((ctx) => {
  const hardbreak = hardbreakSchema.type(ctx);
  return new Plugin({
    key: new PluginKey("LOXEL_HARDBREAK_MARKS"),
    appendTransaction: (trs, _oldState, newState) => {
      const [first] = trs;
      const [step] = first?.steps ?? [];
      const tr = newState.tr;
      if (first?.getMeta("hardbreak") && step instanceof ReplaceStep) {
        const node = newState.doc.nodeAt(step.from);
        if (node?.type === hardbreak) tr.setNodeMarkup(step.from, undefined, node.attrs, []);
      } else if (step instanceof AddMarkStep) {
        newState.doc.nodesBetween(step.from, step.to, (node, pos) => {
          if (node.type === hardbreak) tr.setNodeMarkup(pos, undefined, node.attrs, []);
        });
      }
      return tr.docChanged ? tr : undefined;
    },
  });
});

/** The text node Milkdown serializes a soft break to. */
function isSoftBreak(node: Nodes | undefined): boolean {
  return node?.type === "text" && node.value === "\n";
}

function isLineBreak(node: Nodes | undefined): boolean {
  return node?.type === "break" || isSoftBreak(node);
}

function isBlank(node: Nodes): boolean {
  return node.type === "text" && /^[\t ]*$/.test(node.value);
}

/**
 * Prepare a text node for remark-stringify so line breaks reload to the same document. Whitespace
 * next to a line break does not render, and remark would write trailing spaces as-is (two reload
 * as a hard break), so it is dropped. A soft break that would leave an empty line, which reads
 * back as a paragraph boundary, takes the hard form. Returns the text value to serialize, or the
 * final output for a soft break.
 */
function prepareText(node: Text, parent: Parents | undefined): { output: string } | string {
  const siblings: Nodes[] = parent?.children ?? [];
  const index = siblings.indexOf(node);
  const isBlock = parent?.type === "paragraph" || parent?.type === "heading";

  if (isSoftBreak(node)) {
    // Breaks at the end of a block do not render and cannot be written as a newline.
    if (isBlock && siblings.slice(index + 1).every((n) => isBlank(n) || isSoftBreak(n)))
      return { output: "" };
    const previous = siblings.slice(0, index).findLast((n) => !isBlank(n));
    if (!(previous ? isLineBreak(previous) : isBlock)) return node.value;
    // remark turns a newline before inline HTML into a space (so the HTML cannot start an HTML
    // block), which would leave the hard form's `\` as literal text; drop the break instead.
    const next = siblings.slice(index + 1).find((n) => !isBlank(n));
    return { output: next?.type === "html" ? "" : "\\\n" };
  }

  let { value } = node;
  if (isLineBreak(siblings[index - 1])) value = value.replace(/^[\t ]+/, "");
  if (isSoftBreak(siblings[index + 1])) value = value.replace(/[\t ]+$/, "");
  return value;
}

/** Install soft line breaks on a Milkdown editor before `create()`. */
export function installSoftLineBreaks(editor: Editor): void {
  editor.config((ctx) => {
    ctx.update(hardbreakSchema.key, (prev) => (schemaCtx) => {
      const base = prev(schemaCtx);
      return {
        ...base,
        // Listed first so a rendered soft break parses back with isInline intact.
        parseDOM: [
          { tag: 'br[data-is-inline="true"]', getAttrs: () => ({ isInline: true }) },
          ...(base.parseDOM ?? []),
        ],
        toDOM: (node: Node) => ["br", schemaCtx.get(hardbreakAttr.key)(node)],
      };
    });
    ctx.update(hardbreakFilterNodes.key, (nodes) => [...nodes, "heading"]);
    ctx.update(remarkStringifyOptionsCtx, (prev) => {
      const baseText = prev.handlers?.text;
      return {
        ...prev,
        handlers: {
          ...prev.handlers,
          text: (node: Text, parent, state, info) => {
            const prepared = prepareText(node, parent);
            if (typeof prepared !== "string") return prepared.output;
            if (!baseText) return state.safe(prepared, info);
            return baseText({ ...node, value: prepared }, parent, state, info);
          },
        },
      };
    });
  });
  // Removing a plugin before create() is synchronous: it only drops it from the editor's store.
  void editor.remove(hardbreakClearMarkPlugin);
  editor.use([softBreakKeymap, clearBreakMarksPlugin].flat());
}
