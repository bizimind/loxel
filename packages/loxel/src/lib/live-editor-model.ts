import type * as monaco from "monaco-editor";

type ModelUri = Pick<monaco.Uri, "scheme" | "authority" | "fragment">;

/**
 * Whether `model` is an editor tab's live model: `file://<abs path>` or `loxel://HEAD/<abs path>`
 * with no fragment, as `CodeEditorPanel` builds them. Diff and history sides
 * (`loxel://<ref>/<path>#<side>`, including working-tree diffs at `loxel://HEAD/...#new`) and
 * compare sides (`loxel://compare/...#<panel>-<side>`) are not, so they are never synced to
 * language servers or counted as a reason to spawn one.
 */
export function isLiveEditorModel(model: { readonly uri: ModelUri }): boolean {
  const { scheme, authority, fragment } = model.uri;
  if (fragment) return false;
  return scheme === "file" || (scheme === "loxel" && authority === "HEAD");
}
