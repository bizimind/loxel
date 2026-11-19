/**
 * Which Loxel server something lives on: the `serverId` a server sends in `server_hello` and
 * `GET /api/version` (`ServerIdentity`), never its URL, since one machine can be reached at several.
 */
export type ServerId = string & { readonly serverIdBrand: unique symbol };

/**
 * What a server ID may hold, the one grammar for every place an ID is read: lowercase letters,
 * digits and `.`, `_`, `~`, `-`. A ref's string form ends the ID at its first `:`, and editor model
 * URIs carry it as their authority, which Monaco lowercases when it prints a URI and a language
 * server hands back as text, so an ID must survive both unchanged. Loxel servers use lowercase UUIDs.
 */
const SERVER_ID_PATTERN = /^[a-z0-9._~-]+$/;

/** Whether `id` is a usable server ID (see `SERVER_ID_PATTERN`). */
export function isServerId(id: string): boolean {
  return SERVER_ID_PATTERN.test(id);
}

/**
 * The one way a string becomes a {@link ServerId}: a `serverId` a server sent, checked where it
 * arrives, so a connection naming an unusable ID fails there rather than in an editor tab.
 */
export function toServerId(id: string): ServerId {
  if (!isServerId(id)) throw new Error(`Not a server id: ${JSON.stringify(id)}`);
  return id as ServerId;
}

/**
 * A worktree on a Loxel server: the server and the worktree's absolute path there. A project is
 * named the same way, by its root's path. Paths alone collide once two servers hold the same one;
 * Home (`worktreePath: null`) belongs to the window and has no ref.
 */
export interface WorktreeRef {
  readonly server: ServerId;
  readonly path: string;
}

export function worktreeRef(server: ServerId, path: string): WorktreeRef {
  return { server, path };
}

export function sameWorktreeRef(a: WorktreeRef, b: WorktreeRef): boolean {
  return a.server === b.server && a.path === b.path;
}

/** {@link sameWorktreeRef} for optional refs (Home, or none): two nulls are the same, a null and a ref are not. */
export function sameOptionalWorktreeRef(a: WorktreeRef | null, b: WorktreeRef | null): boolean {
  return a === null || b === null ? a === b : sameWorktreeRef(a, b);
}

/** Whether `value` has a ref's shape, for data typed `unknown` such as the parts of a query key. */
export function isWorktreeRef(value: unknown): value is WorktreeRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "server" in value &&
    typeof value.server === "string" &&
    "path" in value &&
    typeof value.path === "string"
  );
}

/**
 * The string form of a ref, `<serverId>:<path>`, for a `Map`, a `Set` or a persisted key. Branded,
 * so a bare path can't stand in for one.
 */
export type WorktreeRefKey = string & { readonly worktreeRefKeyBrand: unique symbol };

/** The {@link WorktreeRefKey} of `ref`. A server id holds no `:`, so the first one ends it. */
export function formatWorktreeRef(ref: WorktreeRef): WorktreeRefKey {
  return `${ref.server}:${ref.path}` as WorktreeRefKey;
}

/** The ref {@link formatWorktreeRef} wrote; null for a string it could not have written. */
export function parseWorktreeRef(text: string): WorktreeRef | null {
  const separator = text.indexOf(":");
  if (separator <= 0 || separator === text.length - 1) return null;
  const server = text.slice(0, separator);
  // Not a server id (one holding a `/`, say): a bare path with a `:` in it.
  if (!isServerId(server)) return null;
  return worktreeRef(toServerId(server), text.slice(separator + 1));
}
