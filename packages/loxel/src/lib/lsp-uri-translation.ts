import type { MonacoLspClient } from "@bizimind/monaco-lsp-client";

import type { ServerId } from "@/api/worktree-ref";

import { serverAuthority } from "./live-editor-model";

/** The message transport a `MonacoLspClient` runs on. */
export type LspTransport = ConstructorParameters<typeof MonacoLspClient>[0];

type LspMessage = Parameters<LspTransport["send"]>[0];

/** Properties whose string values are URIs in LSP 3.17's messages. */
const URI_KEYS = new Set([
  "uri",
  "targetUri",
  "oldUri",
  "newUri",
  "rootUri",
  "scopeUri",
  "baseUri",
  // `DocumentLink.target`.
  "target",
]);

/** Properties holding objects keyed by URI: `WorkspaceEdit.changes`, pull diagnostics' related documents. */
const URI_MAP_KEYS = new Set(["changes", "relatedDocuments"]);

/** Rewrites of the URIs in a language-server connection's messages, in each direction. */
export interface LspUriTranslation {
  /** A message to the server, with editor model URIs (`editorFileUri`) as the server knows them. */
  readonly toServer: <T>(message: T) => T;
  /** A message from the server, with the URIs of its files as editor model URIs. */
  readonly toClient: <T>(message: T) => T;
}

/**
 * The translation between the editor model URIs of `server`'s files and the URIs its language
 * servers know: `file://<server>/<path>` is `file:///<path>`, and `loxel://<server>/<path>` is
 * `loxel://head/<path>`, which the server bridge turns into `file:///` for the servers that get it
 * (see LANGUAGE_SERVERS.md). Server IDs never reach a server: what goes out is byte for byte what
 * the URIs without them would be.
 *
 * Only URI-valued properties are rewritten (`uri`, `targetUri`, the keys of a workspace edit's
 * `changes` and so on), wherever they are, so document text, edits' new text and hover markdown
 * pass untouched. Both directions rewrite the same properties, so opaque data a server gets back
 * (a completion item's `data`, a command's arguments) is what it sent, but for a `loxel://HEAD/`
 * coming back as `loxel://head/`, which the server bridges match in any casing. Every other URI, a library's
 * `jdt://` document or another server's file, passes as it is.
 */
export function lspUriTranslation(server: ServerId): LspUriTranslation {
  const authority = serverAuthority(server);
  const fileUris = { client: `file://${authority}/`, server: "file:///" };
  const loxelUris = { client: `loxel://${authority}/`, server: "loxel://head/" };

  function toServerUri(uri: string): string {
    for (const prefix of [fileUris, loxelUris]) {
      if (uri.startsWith(prefix.client)) return prefix.server + uri.slice(prefix.client.length);
    }
    return uri;
  }

  function toClientUri(uri: string): string {
    for (const prefix of [fileUris, loxelUris]) {
      // The TypeScript bridge writes `loxel://HEAD/`; Monaco prints authorities lowercase.
      if (uri.slice(0, prefix.server.length).toLowerCase() === prefix.server) {
        return prefix.client + uri.slice(prefix.server.length);
      }
    }
    return uri;
  }

  return {
    toServer: (message) => rewriteUris(message, toServerUri),
    toClient: (message) => rewriteUris(message, toClientUri),
  };
}

/**
 * `transport` with the URIs of every message translated for `server` (see `lspUriTranslation`):
 * those it sends as the server knows them, those it receives as editor model URIs.
 */
export function translateLspUris(transport: LspTransport, server: ServerId): LspTransport {
  const translation = lspUriTranslation(server);
  return {
    get state() {
      return transport.state;
    },
    send: (message: LspMessage) => transport.send(translation.toServer(message)),
    setListener(listener) {
      transport.setListener(listener && ((message) => listener(translation.toClient(message))));
    },
    toString: () => transport.toString(),
  };
}

/**
 * `value` with `rewrite` applied to its URI-valued properties, at any depth. Unchanged parts are
 * shared rather than copied, and `value` itself is returned when nothing changed.
 */
function rewriteUris<T>(value: T, rewrite: (uri: string) => string): T {
  // Only strings are replaced, by strings: the shape stays `T`'s.
  return rewriteValue(value, rewrite) as T;
}

function rewriteValue(value: unknown, rewrite: (uri: string) => string): unknown {
  // Plain index loops that skip primitives: semantic tokens and completion lists are long arrays.
  if (Array.isArray(value)) {
    let copy: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i];
      if (typeof item !== "object" || item === null) continue;
      const next = rewriteValue(item, rewrite);
      if (next !== item) (copy ??= [...value])[i] = next;
    }
    return copy ?? value;
  }
  if (!isRecord(value)) return value;
  let copy: Record<string, unknown> | undefined;
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const item = value[key];
    let next: unknown;
    if (typeof item === "string") {
      if (!URI_KEYS.has(key)) continue;
      next = rewrite(item);
    } else if (typeof item !== "object" || item === null) {
      continue;
    } else if (URI_MAP_KEYS.has(key) && isRecord(item)) {
      next = rewriteKeys(item, rewrite);
    } else {
      next = rewriteValue(item, rewrite);
    }
    if (next !== item) (copy ??= { ...value })[key] = next;
  }
  return copy ?? value;
}

/** A URI-keyed object with its keys rewritten, in their order, and its values as any value. */
function rewriteKeys(
  map: Record<string, unknown>,
  rewrite: (uri: string) => string,
): Record<string, unknown> {
  let changed = false;
  const entries = Object.entries(map).map(([key, item]): [string, unknown] => {
    const nextKey = rewrite(key);
    const nextItem = rewriteValue(item, rewrite);
    if (nextKey !== key || nextItem !== item) changed = true;
    return [nextKey, nextItem];
  });
  return changed ? Object.fromEntries(entries) : map;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
