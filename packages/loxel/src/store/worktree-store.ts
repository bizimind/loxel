/**
 * Worktree store factory — creates per-worktree Zustand store instances.
 *
 * Each worktree gets its own store instance, keyed by its `WorktreeRef` (in its string form), so
 * the same path on two servers gets two. Switching worktrees changes which instance the hooks
 * return.
 *
 * When no worktree is active, hooks return a static no-op store with initial
 * state values. Mutations to the no-op store log a warning.
 *
 * Hooks and imperative code (store actions, event handlers) both resolve the instance from the
 * active worktree of the query scope (`useQueryScope` / `getQueryScope`), so they always agree on
 * it.
 */

import { useStore } from "zustand/react";
import type { StateCreator, StoreApi } from "zustand/vanilla";
import { createStore } from "zustand/vanilla";

import { formatWorktreeRef, type WorktreeRef } from "@/api/worktree-ref";
import { frontendLog } from "@/lib/frontend-logger";
import { getQueryScope, useQueryScope } from "@/queries/use-scope";

const log = frontendLog.child("worktrees");

/** Registry of all worktree store factories for bulk operations (purge, etc.). */
const registry: Array<{ purge: (worktree: WorktreeRef) => void }> = [];

/** Purge all worktree store instances of a worktree (worktree removal). */
export function purgeWorktreeStores(worktree: WorktreeRef): void {
  for (const entry of registry) entry.purge(worktree);
}

/**
 * Creates a worktree store factory that manages per-worktree Zustand store instances.
 *
 * @param stateCreator - Zustand state creator function (same as `create((set, get) => ({...}))`)
 * @returns Hook, imperative accessor, and lifecycle methods
 */
export function createWorktreeStore<T>(stateCreator: StateCreator<T>) {
  /** By `formatWorktreeRef`. */
  const instances = new Map<string, StoreApi<T>>();
  /** Home's own instance, for what is queued for its editor area (`getStore(null)`). */
  let homeStore: StoreApi<T> | null = null;

  /** Static no-op store returned when no worktree is active. Logs on mutation. */
  let noopStore: StoreApi<T> | null = null;
  function getNoopStore(): StoreApi<T> {
    if (!noopStore) {
      const real = createStore<T>(stateCreator);
      noopStore = new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === "setState") {
            return (...args: Parameters<StoreApi<T>["setState"]>) => {
              log.warn("setState called on no-op worktree store (no active worktree)");
              return target.setState(...args);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    }
    return noopStore;
  }

  /** The instance of `worktree`, created on first use; null is Home's, a real one. */
  function getStore(worktree: WorktreeRef | null): StoreApi<T> {
    if (worktree === null) {
      homeStore ??= createStore<T>(stateCreator);
      return homeStore;
    }
    const key = formatWorktreeRef(worktree);
    let store = instances.get(key);
    if (!store) {
      store = createStore<T>(stateCreator);
      instances.set(key, store);
    }
    return store;
  }

  /** React hook: subscribes to the active worktree's instance, the no-op store with none. */
  function usePerWorktreeStore<R>(selector: (state: T) => R): R {
    const { activeWorktree } = useQueryScope();
    const store = activeWorktree ? getStore(activeWorktree) : getNoopStore();
    return useStore(store, selector);
  }

  /** Imperative: get the current scope's store (for actions, event handlers). */
  function getCurrent(): StoreApi<T> {
    const { activeWorktree } = getQueryScope();
    if (!activeWorktree) {
      log.warn("getCurrent called with no active worktree, returning no-op store");
      return getNoopStore();
    }
    return getStore(activeWorktree);
  }

  /** Delete a worktree's store instance (worktree removal cleanup). */
  function purge(worktree: WorktreeRef): void {
    instances.delete(formatWorktreeRef(worktree));
  }

  registry.push({ purge });

  return { useStore: usePerWorktreeStore, getStore, getCurrent, purge };
}
