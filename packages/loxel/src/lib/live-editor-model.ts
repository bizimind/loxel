import * as monaco from "monaco-editor";

import { isServerId, type ServerId, toServerId } from "@/api/worktree-ref";

type ModelUri = Pick<monaco.Uri, "scheme" | "authority" | "path" | "query" | "fragment">;

/** The file behind an editor tab: the server holding it and its absolute path there. */
export interface EditorFile {
  readonly server: ServerId;
  readonly path: string;
}

/** The two schemes of editor tab models: `file` for `fileSchemeLanguages`, `loxel` for the rest. */
export type EditorUriScheme = "file" | "loxel";

/**
 * A server ID as a URI authority: the ID itself, whose grammar (`toServerId`) already keeps it
 * unchanged through Monaco's printing of a URI and a server's text.
 */
export function serverAuthority(server: ServerId): string {
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
 * for files no tab has open. Git diff sides (`loxel://<serverId><path>?<ref>#<view>-<side>`) and
 * compare sides (`loxel://compare/...#<panel>-<side>`) carry a fragment and are not editor files,
 * and neither is a URI that names no server, such as a `file:///` link in a server's hover text or
 * a `loxel://HEAD/` one the TypeScript bridge wrote.
 */
export function editorFile(uri: ModelUri): EditorFile | null {
  if (uri.query || uri.fragment || !uri.authority) return null;
  if (uri.scheme !== "file" && uri.scheme !== "loxel") return null;
  // Only what `serverAuthority` writes: no port, user info or uppercase, and none of the reserved
  // authorities (`head` of the servers' own `loxel:` URIs, `compare` of compare panels), which
  // name no server.
  if (!isServerId(uri.authority)) return null;
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
