import * as monaco from "monaco-editor";

import { type ServerId, toServerId } from "@/api/worktree-ref";

type ModelUri = Pick<monaco.Uri, "scheme" | "authority" | "path" | "query" | "fragment">;

/** The file behind an editor tab: the server holding it and its absolute path there. */
export interface EditorFile {
  readonly server: ServerId;
  readonly path: string;
}

/** The two schemes of editor tab models: `file` for `fileSchemeLanguages`, `loxel` for the rest. */
export type EditorUriScheme = "file" | "loxel";

const SERVER_AUTHORITY = /^[a-z0-9._~-]+$/;

/**
 * A server ID as a URI authority. Monaco lowercases authorities when it prints a URI, and a server
 * hands URIs back as text, so an ID must survive both unchanged: Loxel servers use lowercase UUIDs.
 */
export function serverAuthority(server: ServerId): string {
  if (!SERVER_AUTHORITY.test(server)) {
    throw new Error(`Server id ${JSON.stringify(server)} cannot be a URI authority`);
  }
  return server;
}

/**
 * The model URI of an editor tab's file: `<scheme>://<serverId><abs path>`. The authority names
 * the server and the path is the file's own, in both schemes, so the path globs language servers
 * register still match. Only the renderer sees the server; language-server connections translate
 * these URIs to and from the ones servers know (`lsp-uri-translation.ts`).
 */
export function editorFileUri(file: EditorFile, scheme: EditorUriScheme): monaco.Uri {
  return monaco.Uri.from({ scheme, authority: serverAuthority(file.server), path: file.path });
}

/**
 * The file behind an editor tab's live model URI (see `editorFileUri`), or null for any other URI.
 * Language servers' answers name the same URIs once their connection has translated them, also
 * for files no tab has open. Diff and history sides (`loxel://<ref>/<path>#<side>`, including
 * working-tree sides at `loxel://working-tree/...#new`) and compare sides
 * (`loxel://compare/...#<panel>-<side>`) carry a fragment and are not editor files, and neither is
 * a URI with no authority, such as a `file:///` link in a server's hover text.
 */
export function editorFile(uri: ModelUri): EditorFile | null {
  if (uri.query || uri.fragment || !uri.authority) return null;
  if (uri.scheme !== "file" && uri.scheme !== "loxel") return null;
  // Only what `serverAuthority` writes: no port, user info or uppercase.
  if (!SERVER_AUTHORITY.test(uri.authority)) return null;
  return { server: toServerId(uri.authority), path: uri.path };
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
 * Whether `model` is an editor tab's live model (see `editorFile`): not a peek widget's snapshot
 * of a file, which has the file's URI too. Only live models are synced to language servers, get
 * their language features or are counted as a reason to spawn one.
 */
export function isLiveEditorModel(model: { readonly uri: ModelUri }): boolean {
  return editorFile(model.uri) !== null && !previewModels.has(model);
}
