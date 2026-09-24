import { $remark } from "@milkdown/kit/utils";
import type { Emphasis, Nodes, Parents, Root, Strong } from "mdast";
import type { Handle, Info, Options as ToMarkdownOptions, State } from "mdast-util-to-markdown";
import { defaultHandlers } from "mdast-util-to-markdown";
import { visit } from "unist-util-visit";

import type { MarkdownOutputSettings } from "@/lib/formatting-model";

/**
 * Build the remark-stringify options Milkdown should serialize with.
 *
 * Milkdown installs its own `strong`/`emphasis` handlers that prefer the marker parsed from
 * the source file (`node.marker`, stamped by preset-commonmark's remark-marker plugin) over
 * `state.options`, so the user's emphasis/strong choice would only apply to marks created in
 * the editor. Swapping those two handlers for the stock ones makes the settings authoritative.
 */
export function buildRemarkStringifyOptions(
  base: ToMarkdownOptions,
  markdownOutput: MarkdownOutputSettings,
): ToMarkdownOptions {
  return {
    ...base,
    ...markdownOutput,
    handlers: {
      ...base.handlers,
      strong: withMarkerFallbacks(defaultHandlers.strong, "strong"),
      emphasis: withMarkerFallbacks(defaultHandlers.emphasis, "emphasis"),
    },
  };
}

/**
 * Drop the source marker preset-commonmark stamps on parsed emphasis/strong nodes. The marker
 * becomes a ProseMirror mark attr, and marks with different attrs never merge, so `*foo*_bar_`
 * would stay two adjacent runs that the configured marker then fuses into `_foo__bar_`. Without
 * it every mark takes the schema default (the configured marker) and adjacent runs merge.
 */
export const remarkForgetSourceMarkers = $remark(
  "remark-forget-source-markers",
  () => () => (tree: Root) => {
    visit(tree, ["emphasis", "strong"], (node) => {
      Reflect.deleteProperty(node, "marker");
    });
  },
);

const WORD_CHAR = /[\p{L}\p{N}]/u;

type AttentionKey = "emphasis" | "strong";
type Marker = "*" | "_";

/** Markers chosen per attention node, scoped to one serialization (`State`) of one tree. */
const plans = new WeakMap<State, { planned: WeakSet<object>; markers: WeakMap<object, Marker> }>();

function isAttention(node: Nodes): node is Emphasis | Strong {
  return node.type === "emphasis" || node.type === "strong";
}

function configuredMarker(state: State, key: AttentionKey): Marker {
  return state.options[key] === "_" ? "_" : "*";
}

/**
 * Pick the marker a run can be written with, given the characters that will touch it:
 * - `_` cannot open or close emphasis inside a word in CommonMark, so prefer `*` next to a word
 *   character (Prettier does the same; the stock handler would escape the letter instead).
 * - A run written right after or before the same delimiter fuses with its neighbour
 *   (`_foo__bar_` re-parses as one run), so avoid the delimiter a neighbour already uses.
 * When no marker is safe, fall back to the configured one and let the stock handler cope.
 */
function chooseMarker(configured: Marker, before: string, after: string): Marker {
  const other: Marker = configured === "*" ? "_" : "*";
  const wordAdjacent = WORD_CHAR.test(before) || WORD_CHAR.test(after);
  const preferred: Marker[] = wordAdjacent ? ["*", "_"] : [configured, other];
  return preferred.find((marker) => before !== marker && after !== marker) ?? configured;
}

/**
 * Decide the marker of every emphasis/strong child of `parent` in one left-to-right pass, so a
 * run's `peek` (which `containerPhrasing` calls before the previous sibling is serialized, with
 * no surrounding info) reports exactly what the handler will emit. Neighbouring text contributes
 * its first/last character; an attention parent contributes its own marker on both sides.
 */
function planParent(parent: Parents, state: State): WeakMap<object, Marker> {
  let plan = plans.get(state);
  if (!plan) {
    plan = { planned: new WeakSet(), markers: new WeakMap() };
    plans.set(state, plan);
  }
  if (plan.planned.has(parent)) return plan.markers;
  plan.planned.add(parent);

  const edge = isAttention(parent) ? (plan.markers.get(parent) ?? "") : "";
  const { children } = parent;
  let before = edge;
  for (const [index, child] of children.entries()) {
    const next = children[index + 1];
    const after = next === undefined ? edge : next.type === "text" ? next.value.charAt(0) : "";
    if (isAttention(child)) {
      const marker = chooseMarker(configuredMarker(state, child.type), before, after);
      plan.markers.set(child, marker);
      before = marker;
    } else {
      before = child.type === "text" ? child.value.slice(-1) : "";
    }
  }
  return plan.markers;
}

function markerFor(node: Emphasis | Strong, parent: Parents | undefined, state: State, info: Info) {
  const planned = parent ? planParent(parent, state).get(node) : undefined;
  return (
    planned ??
    chooseMarker(configuredMarker(state, node.type), info.before.slice(-1), info.after.charAt(0))
  );
}

/** Run the stock handler with `state.options[key]` temporarily set to the planned marker. */
function withMarkerFallbacks(handler: Handle, key: AttentionKey): Handle {
  const wrapped: Handle & { peek: Handle } = (node: Emphasis | Strong, parent, state, info) => {
    const marker = markerFor(node, parent, state, info);
    const saved = state.options[key];
    state.options[key] = marker;
    try {
      return handler(node, parent, state, info);
    } finally {
      state.options[key] = saved;
    }
  };
  wrapped.peek = (node: Emphasis | Strong, parent, state, info) =>
    markerFor(node, parent, state, info);
  return wrapped;
}
