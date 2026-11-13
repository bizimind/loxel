/**
 * Code block previews for Crepe's CodeMirror feature: picks a preview renderer by the block's
 * language. Previews are view-only; they never change the block's text.
 */
import type { CodeBlockConfig } from "@milkdown/kit/component/code-block";

import { renderDiffPreview } from "@/components/editor/diff-block-preview";
import { renderMermaidPreview } from "@/components/editor/mermaid-preview";

/**
 * Returns the preview (an HTML string or element, sanitized by the panel), `null` for no preview
 * panel, or `undefined` after arranging to call `applyPreview` later.
 */
export type RenderPreview = CodeBlockConfig["renderPreview"];
export type PreviewValue = Exclude<ReturnType<RenderPreview>, void>;

/** Preview renderers by lowercase fence language (a Map, so `constructor` or `__proto__` fences miss). */
const previewRenderers = new Map<string, RenderPreview>([
  ["diff", renderDiffPreview],
  ["mermaid", renderMermaidPreview],
  ["patch", renderDiffPreview],
]);

/** Crepe `renderPreview`: languages without a renderer get no preview panel. */
export const renderCodeBlockPreview: RenderPreview = (language, content, applyPreview) => {
  const renderer = previewRenderers.get(language.toLowerCase());
  if (!renderer) return null;
  return renderer(language, content, applyPreview);
};
