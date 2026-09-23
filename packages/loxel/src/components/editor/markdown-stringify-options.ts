import { $remark } from "@milkdown/kit/utils";
import type { Root } from "mdast";
import type { Handle, Options as ToMarkdownOptions } from "mdast-util-to-markdown";
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

/**
 * Pick a marker the stock handler can emit safely, then let it serialize with that marker:
 * - `_` cannot open or close emphasis inside a word in CommonMark, so the stock handlers escape
 *   the adjacent letters as numeric character references (`a*b*c` → `&#x61;_&#x62;_&#x63;`),
 *   which Prettier never heals. Mirror Prettier: use `*` when a word character touches the run.
 * - Two runs written back to back with the same marker fuse (`_foo__bar_` re-parses as one run),
 *   so switch to the other marker when the neighbour already uses the configured one.
 */
function withMarkerFallbacks(handler: Handle, key: "emphasis" | "strong"): Handle {
  const wrapped: Handle & { peek?: Handle } = (node, parent, state, info) => {
    const configured = state.options[key] ?? "*";
    const before = info.before.slice(-1);
    const after = info.after.charAt(0);
    let marker = configured;
    if (WORD_CHAR.test(before) || WORD_CHAR.test(after)) marker = "*";
    else if (before === configured || after === configured) marker = configured === "*" ? "_" : "*";
    if (marker === state.options[key]) return handler(node, parent, state, info);
    const saved = state.options[key];
    state.options[key] = marker;
    try {
      return handler(node, parent, state, info);
    } finally {
      state.options[key] = saved;
    }
  };
  if (hasPeek(handler)) wrapped.peek = handler.peek;
  return wrapped;
}

/** Stock handlers carry a `peek` used to escape neighbouring text; the `Handle` type omits it. */
function hasPeek(handler: Handle): handler is Handle & { peek: Handle } {
  return "peek" in handler && typeof handler.peek === "function";
}
