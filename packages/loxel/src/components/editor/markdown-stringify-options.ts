import type { Handle, Options as ToMarkdownOptions } from "mdast-util-to-markdown";
import { defaultHandlers } from "mdast-util-to-markdown";

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
      strong: withIntraWordFallback(defaultHandlers.strong, "strong"),
      emphasis: withIntraWordFallback(defaultHandlers.emphasis, "emphasis"),
    },
  };
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * `_` cannot open or close emphasis inside a word in CommonMark, so the stock handlers escape
 * the adjacent letters as numeric character references (`a*b*c` → `&#x61;_&#x62;_&#x63;`),
 * which Prettier never heals. Mirror Prettier instead: use `*` whenever a word character
 * touches either side of the run, and the configured marker otherwise.
 */
function withIntraWordFallback(handler: Handle, key: "emphasis" | "strong"): Handle {
  const wrapped: Handle & { peek?: Handle } = (node, parent, state, info) => {
    const touchesWord =
      WORD_CHAR.test(info.before.slice(-1)) || WORD_CHAR.test(info.after.charAt(0));
    if (!touchesWord || state.options[key] === "*") return handler(node, parent, state, info);
    const configured = state.options[key];
    state.options[key] = "*";
    try {
      return handler(node, parent, state, info);
    } finally {
      state.options[key] = configured;
    }
  };
  if (hasPeek(handler)) wrapped.peek = handler.peek;
  return wrapped;
}

/** Stock handlers carry a `peek` used to escape neighbouring text; the `Handle` type omits it. */
function hasPeek(handler: Handle): handler is Handle & { peek: Handle } {
  return "peek" in handler && typeof handler.peek === "function";
}
