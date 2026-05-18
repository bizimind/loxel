import { useStore } from "zustand/react";
/**
 * Worktree store factory — creates per-worktree Zustand store instances.
 *
 * Each worktree gets its own store instance, keyed by the active worktree path.
 * Switching worktrees changes which instance the hooks return.
 *
 * When no worktree is active, hooks return a static no-op store with initial
 * state values. Mutations to the no-op store log a warning.
 *
 * Imperative code (store actions, event handlers) uses activeWorktreeKey.
 */
import type { StateCreator, StoreApi } from "zustand/vanilla";
import { createStore } from "zustand/vanilla";

import { frontendLog } from "@/lib/frontend-logger";

import { useWorktreeStore } from "./worktrees";

const log = frontendLog.child("worktrees");

/**
 * Module-level worktree key for imperative access (store actions, event handlers).
 * Set synchronously by switchWorktree before React re-renders.
 */
let activeWorktreeKey: string | null = null;

export function getActiveWorktreeKey(): string | null {
  return activeWorktreeKey;
}

export function setActiveWorktreeKey(key: string): void {
  activeWorktreeKey = key;
}

/** Registry of all worktree store factories for bulk operations (purge, etc.). */
const registry: Array<{ purge: (scopeKey: string) => void }> = [];

/** Purge all worktree store instances for a given worktree key (worktree removal). */
export function purgeWorktreeStores(scopeKey: string): void {
  for (const entry of registry) entry.purge(scopeKey);
}

/**
 * Creates a worktree store factory that manages per-worktree Zustand store instances.
 *
 * @param stateCreator - Zustand state creator function (same as `create((set, get) => ({...}))`)
 * @returns Hook, imperative accessor, and lifecycle methods
 */
export function createWorktreeStore<T>(stateCreator: StateCreator<T>) {
  const instances = new Map<string, StoreApi<T>>();

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

  function getStore(scopeKey: string): StoreApi<T> {
    let store = instances.get(scopeKey);
    if (!store) {
      store = createStore<T>(stateCreator);
      instances.set(scopeKey, store);
    }
    return store;
  }

  /** React hook: derives scope key from active worktree path, subscribes to correct instance. */
  function usePerWorktreeStore<R>(selector: (state: T) => R): R {
    const scopeKey = useWorktreeStore((s) => s.activeWorktreePath);
    const store = scopeKey ? getStore(scopeKey) : getNoopStore();
    return useStore(store, selector);
  }

  /** Imperative: get the current scope's store (for actions, event handlers). */
  function getCurrent(): StoreApi<T> {
    if (!activeWorktreeKey) {
      log.warn("getCurrent called with no active worktree, returning no-op store");
      return getNoopStore();
    }
    return getStore(activeWorktreeKey);
  }

  /** Delete a scope's store instance (worktree removal cleanup). */
  function purge(scopeKey: string): void {
    instances.delete(scopeKey);
  }

  registry.push({ purge });

  return { useStore: usePerWorktreeStore, getStore, getCurrent, purge };
}
