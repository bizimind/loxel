/**
 * Worktree state transition + generic per-worktree cache.
 *
 * Per-worktree state lives in worktree store instances (worktree-repository,
 * worktree-reviews, worktree-ui, worktree-tools-bar). This module handles:
 * - Worktree key transition on worktree switch (+ comment cleanup)
 * - Generic per-worktree cache (used by GraphPanel for inner dockview layouts)
 */
import type { SerializedDockview } from "dockview-react";

import { useCommentStore } from "./comments";
import { getActiveWorktreeKey, setActiveWorktreeKey } from "./worktree-store";

// --- Generic per-worktree cache for component-local state ---

/** Arbitrary worktree values keyed by `${scopeKey}::${key}`. */
const worktreeCache = new Map<string, unknown>();

/** Get a cached value for the current scope. Cast at the call site. */
export function getWorktreeValue(key: string): unknown {
  return worktreeCache.get(`${getActiveWorktreeKey()}::${key}`);
}

/** Save a value for the current scope. */
export function setWorktreeValue(key: string, value: unknown): void {
  worktreeCache.set(`${getActiveWorktreeKey()}::${key}`, value);
}

/** Get a saved inner dockview layout for the current scope. */
export function getWorktreeInnerLayout(containerId: string): SerializedDockview | undefined {
  return getWorktreeValue(containerId) as SerializedDockview | undefined;
}

/** Save an inner dockview layout for the current scope. */
export function setWorktreeInnerLayout(containerId: string, layout: SerializedDockview): void {
  setWorktreeValue(containerId, layout);
}

/** Purge cached values for a worktree (worktree removal cleanup). */
export function purgeWorktreeCache(scopeKey: string): void {
  const prefix = `${scopeKey}::`;
  for (const key of worktreeCache.keys()) {
    if (key.startsWith(prefix)) worktreeCache.delete(key);
  }
}

/**
 * Transition to a new worktree. Sets the worktree key so all worktree store
 * hooks and imperative accessors resolve to the correct instance.
 * Clears comment state (comments are diff-specific, not persisted across scopes).
 */
export function transitionWorktreeState(_oldKey: string | null, newKey: string): void {
  setActiveWorktreeKey(newKey);
  useCommentStore.getState().clearAll();
}
