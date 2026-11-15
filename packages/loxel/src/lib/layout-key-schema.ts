/**
 * Shared schema for dockview layout storage keys in the server `stores` table.
 *
 * Two namespaces:
 * - `layout:session:<windowId>:<scope>:<worktreePath>` — per-window live writes.
 * - `layout:canonical:<scope>:<worktreePath>` — last-closed-window snapshot.
 *
 * Importable by both the browser renderer (PersistedLayoutComponent) and the
 * Bun server (store-db) — keep this file dependency-free so it stays
 * context-neutral.
 */

export const LAYOUT_SESSION_PREFIX = "layout:session:";
export const LAYOUT_CANONICAL_PREFIX = "layout:canonical:";

export function layoutSessionKey(windowId: string, scope: string, worktreeKey: string): string {
  return `${LAYOUT_SESSION_PREFIX}${windowId}:${scope}:${worktreeKey}`;
}

export function layoutCanonicalKey(scope: string, worktreeKey: string): string {
  return `${LAYOUT_CANONICAL_PREFIX}${scope}:${worktreeKey}`;
}

/**
 * Extract the `<scope>:<worktreePath>` suffix from a session key, or null if
 * the input doesn't match the session-key shape. Used by the server when
 * promoting session rows to canonical without re-parsing the windowId.
 */
export function layoutSessionSuffix(sessionKey: string): string | null {
  if (!sessionKey.startsWith(LAYOUT_SESSION_PREFIX)) return null;
  const rest = sessionKey.slice(LAYOUT_SESSION_PREFIX.length);
  const colonIdx = rest.indexOf(":");
  if (colonIdx < 0) return null;
  return rest.slice(colonIdx + 1);
}

/**
 * The worktree path a layout row belongs to, or null for any other key. A scope and a window ID
 * never hold a colon; the path may.
 */
export function layoutKeyWorktree(key: string): string | null {
  let suffix: string | null = null;
  if (key.startsWith(LAYOUT_CANONICAL_PREFIX)) suffix = key.slice(LAYOUT_CANONICAL_PREFIX.length);
  else suffix = layoutSessionSuffix(key);
  if (suffix === null) return null;
  const colonIdx = suffix.indexOf(":");
  return colonIdx < 0 ? null : suffix.slice(colonIdx + 1);
}

export function layoutCanonicalKeyFromSuffix(suffix: string): string {
  return `${LAYOUT_CANONICAL_PREFIX}${suffix}`;
}
