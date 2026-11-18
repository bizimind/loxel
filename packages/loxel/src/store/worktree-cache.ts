/**
 * Worktree state transition + generic per-worktree cache.
 *
 * Per-worktree state lives in worktree store instances (worktree-repository,
 * worktree-reviews, worktree-ui, worktree-tools-bar). This module handles:
 * - State cleanup on worktree switch (comments)
 * - Generic per-worktree cache (used by GraphPanel for inner dockview layouts)
 */
import type { SerializedDockview } from "dockview-react";

import { formatWorktreeRef, type ServerId, type WorktreeRef } from "@/api/worktree-ref";
import { getQueryScope } from "@/queries/use-scope";

import { useCommentStore } from "./comments";

// --- Generic per-worktree cache for component-local state ---

/** Arbitrary values per worktree (by `formatWorktreeRef`, `null` for Home), then by key. */
const worktreeCache = new Map<string | null, Map<string, unknown>>();

function activeScope(): string | null {
  const { activeWorktree } = getQueryScope();
  return activeWorktree && formatWorktreeRef(activeWorktree);
}

/** Get a cached value for the current scope. Cast at the call site. */
export function getWorktreeValue(key: string): unknown {
  return worktreeCache.get(activeScope())?.get(key);
}

/** Save a value for the current scope. */
export function setWorktreeValue(key: string, value: unknown): void {
  const scope = activeScope();
  let values = worktreeCache.get(scope);
  if (!values) {
    values = new Map();
    worktreeCache.set(scope, values);
  }
  values.set(key, value);
}

/** Get a saved inner dockview layout for the current scope. */
export function getWorktreeInnerLayout(containerId: string): SerializedDockview | undefined {
  return getWorktreeValue(containerId) as SerializedDockview | undefined;
}

/** Save an inner dockview layout for the current scope. */
export function setWorktreeInnerLayout(containerId: string, layout: SerializedDockview): void {
  setWorktreeValue(containerId, layout);
}

/**
 * Each mounted layout's own cache of the layouts it has shown, keyed by layout key: a worktree's
 * bare path, as the layout is stored under on `server`, the server that holds it.
 */
const layoutCaches = new Map<Map<string, unknown>, ServerId>();

/** Have `cache`, of layouts stored on `server`, purged with its worktrees. Returns an unregister function. */
export function registerLayoutCache(server: ServerId, cache: Map<string, unknown>): () => void {
  layoutCaches.set(cache, server);
  return () => layoutCaches.delete(cache);
}

/** Purge cached values for a worktree (worktree removal cleanup). */
export function purgeWorktreeCache(worktree: WorktreeRef): void {
  for (const [cache, server] of layoutCaches) {
    if (server === worktree.server) cache.delete(worktree.path);
  }
  worktreeCache.delete(formatWorktreeRef(worktree));
}

/**
 * Transition to a new worktree, after the active worktree has changed (worktree store hooks and
 * imperative accessors follow it on their own). Clears comment state (comments are diff-specific,
 * not persisted across scopes).
 */
export function transitionWorktreeState(): void {
  useCommentStore.getState().clearAll();
}
