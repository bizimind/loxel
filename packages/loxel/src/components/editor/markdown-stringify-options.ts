import type { Options as ToMarkdownOptions } from "mdast-util-to-markdown";

import type { MarkdownOutputSettings } from "@/lib/formatting-model";

/**
 * Build the remark-stringify options Milkdown should serialize with: its defaults (including
 * its own handlers) plus the user's block-level markers from Settings > Editor > Markdown Output.
 */
export function buildRemarkStringifyOptions(
  base: ToMarkdownOptions,
  markdownOutput: MarkdownOutputSettings,
): ToMarkdownOptions {
  return { ...base, ...markdownOutput };
}
