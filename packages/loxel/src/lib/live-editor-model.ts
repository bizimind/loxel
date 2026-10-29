import type * as monaco from "monaco-editor";

type ModelUri = Pick<monaco.Uri, "scheme" | "authority" | "path" | "query" | "fragment">;

/**
 * The absolute path of the file behind an editor tab's live model URI, or null for any other URI.
 * Editor tabs use `file://<abs path>` or `loxel://HEAD/<abs path>` with no query or fragment, as
 * `CodeEditorPanel` builds them; language servers answer with the same URIs, or with `file://` ones
 * for files no tab has open (see LANGUAGE_SERVERS.md). Diff and history sides
 * (`loxel://<ref>/<path>#<side>`, including working-tree diffs at `loxel://HEAD/...#new`) and
 * compare sides (`loxel://compare/...#<panel>-<side>`) are not editor files.
 */
export function editorFilePath(uri: ModelUri): string | null {
  if (uri.query || uri.fragment) return null;
  const isEditorScheme =
    uri.scheme === "file" || (uri.scheme === "loxel" && uri.authority.toLowerCase() === "head");
  return isEditorScheme ? uri.path : null;
}

/** Read-only snapshots of files shown in peek widgets (see `peek-text-models.ts`). */
const previewModels = new WeakSet<object>();

/** Marks `model` as a peek widget's read-only snapshot of a file, which is never live. */
export function markPreviewModel(model: object): void {
  previewModels.add(model);
}

/** Whether `model` is a peek widget's read-only snapshot of a file (see `markPreviewModel`). */
export function isPreviewModel(model: object): boolean {
  return previewModels.has(model);
}

/**
 * Whether `model` is an editor tab's live model (see `editorFilePath`): not a peek widget's
 * snapshot of a file, which has the file's URI too. Only live models are synced to language
 * servers, get their language features or are counted as a reason to spawn one.
 */
export function isLiveEditorModel(model: { readonly uri: ModelUri }): boolean {
  return editorFilePath(model.uri) !== null && !previewModels.has(model);
}
