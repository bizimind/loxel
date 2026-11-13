/**
 * Which mermaid sources last failed to render, so their blocks keep showing their source
 * (code-block-source.ts). The preview renderer (mermaid-preview.ts) records each result by source
 * text, as Crepe gives it no block identity, and editors are told when a source's result changes.
 * Entries are only source strings, and typing records many (most intermediate texts fail to parse),
 * so the set is bounded. Reading a source refreshes it, and editors read every mermaid block's text
 * whenever they recompute, so a failure still in a document is not the one that ages out.
 */

const FAILED_LIMIT = 2000;
const failed = new Set<string>();
const listeners = new Set<() => void>();

/** Whether `source`'s last render failed. A source not rendered yet has not failed. */
export function mermaidRenderFailed(source: string): boolean {
  if (!failed.has(source)) return false;
  failed.delete(source); // re-insert as the most recent
  failed.add(source);
  return true;
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
