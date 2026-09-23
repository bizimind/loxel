import type { Options as ToMarkdownOptions } from "mdast-util-to-markdown";
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
      strong: defaultHandlers.strong,
      emphasis: defaultHandlers.emphasis,
    },
  };
}
