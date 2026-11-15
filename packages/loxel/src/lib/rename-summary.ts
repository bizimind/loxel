import { appliedRenameSummary } from "@bizimind/monaco-lsp-client";
import type * as monaco from "monaco-editor";
import { IBulkEditService } from "monaco-editor/editor/browser/services/bulkEditService.js";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";

/**
 * Makes Monaco's rename announcement ("Successfully renamed 'a' to 'b'. Summary: ...", read by
 * screen readers) tell what a language client's rename changed. The client applies a rename itself
 * and hands Monaco an empty edit, which Monaco's bulk-edit service would summarize as "Made 0 edits
 * in 0 files"; this wraps the service's `apply` to summarize the rename instead, and to announce
 * nothing for a rename that failed, which the client already reported. Every other edit goes to
 * the service. Returns a disposable that restores the service.
 */
export function installRenameSummary(): monaco.IDisposable {
  const service = StandaloneServices.get(IBulkEditService);
  const fallback = service.apply.bind(service);

  service.apply = async (edit, options) => {
    const summary = Array.isArray(edit) ? undefined : appliedRenameSummary(edit);
    if (summary === undefined) return fallback(edit, options);
    if (summary === null) return { ariaSummary: "", isApplied: false };
    return {
      ariaSummary: `Made ${summary.edits} edits in ${summary.files} files`,
      isApplied: summary.edits > 0,
    };
  };

  return {
    dispose: () => {
      service.apply = fallback;
    },
  };
}
