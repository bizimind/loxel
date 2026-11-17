/**
 * Which Loxel server something lives on: the `serverId` a server sends in `server_hello` and
 * `GET /api/version` (`ServerIdentity`), never its URL, since one machine can be reached at several.
 */
export type ServerId = string & { readonly serverIdBrand: unique symbol };

/** The one way a string becomes a {@link ServerId}: a `serverId` a server sent. */
export function toServerId(id: string): ServerId {
  if (id === "" || id.includes(":")) throw new Error(`Not a server id: ${JSON.stringify(id)}`);
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
 * The string form of a ref, `<serverId>:<path>`, for a `Map` or a persisted key. A server id holds
 * no `:`, so the first one ends it.
 */
export function formatWorktreeRef(ref: WorktreeRef): string {
  return `${ref.server}:${ref.path}`;
}

/** The ref {@link formatWorktreeRef} wrote; null for a string it could not have written. */
export function parseWorktreeRef(text: string): WorktreeRef | null {
  const separator = text.indexOf(":");
  if (separator <= 0 || separator === text.length - 1) return null;
  return worktreeRef(toServerId(text.slice(0, separator)), text.slice(separator + 1));
}
