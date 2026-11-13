/**
 * Which mermaid sources last failed to render, so their blocks keep showing their source
 * (code-block-source.ts). The preview renderer (mermaid-preview.ts) records each result by source
 * text, as Crepe gives it no block identity, and editors are told when a source's result changes.
 * Bounded like the diagram cache; entries are only source strings.
 */

const FAILED_LIMIT = 200;
const failed = new Set<string>();
const listeners = new Set<() => void>();

/** Whether `source`'s last render failed. A source not rendered yet has not failed. */
export function mermaidRenderFailed(source: string): boolean {
  return failed.has(source);
}

/** Records the result of rendering `source`, telling listeners when it changed. */
export function recordMermaidRender(source: string, ok: boolean): void {
  const changed = ok ? failed.delete(source) : !failed.has(source);
  if (!ok) {
    failed.delete(source); // re-insert as the most recent
    failed.add(source);
    if (failed.size > FAILED_LIMIT) {
      const oldest = failed.values().next();
      if (!oldest.done) failed.delete(oldest.value);
    }
  }
  if (!changed) return;
  for (const listener of listeners) listener();
}

/** Calls `listener` whenever a source's result changes; returns the unsubscribe function. */
export function onMermaidRenderResult(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
