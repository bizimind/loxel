import { HOME_KEY } from "@/api/home-model";
import { localServerId } from "@/api/local-server";
import {
  formatWorktreeRef,
  parseWorktreeRef,
  type ServerId,
  type WorktreeRef,
  type WorktreeRefKey,
} from "@/api/worktree-ref";

import { useWorktreeStore } from "./worktrees";

/**
 * The layout key of Home, the layout a window shows while no worktree is active, and the key Home's
 * layout is stored under. A worktree's layout key holds a `:` (see `LayoutKey`), so this never names one.
 */
export const HOME_LAYOUT_KEY = HOME_KEY;

/**
 * Which layout a window shows, at runtime: a worktree's ref in its string form, or
 * `HOME_LAYOUT_KEY`. The same path on two servers has two layouts. Stored layouts keep the
 * worktree's bare path on the server holding it (see `layoutStorageKey`).
 */
export type LayoutKey = WorktreeRefKey | typeof HOME_LAYOUT_KEY;

/** The layout key of `worktree`'s layout; Home's for null. */
export function layoutKeyOf(worktree: WorktreeRef | null): LayoutKey {
  return worktree === null ? HOME_LAYOUT_KEY : formatWorktreeRef(worktree);
}

/** The key of the layout the window shows: the active worktree's, or Home's. */
export function activeLayoutKey(): LayoutKey {
  return layoutKeyOf(useWorktreeStore.getState().activeWorktree);
}

/** The worktree of a layout key; null for Home's. */
export function layoutWorktree(layoutKey: LayoutKey): WorktreeRef | null {
  if (layoutKey === HOME_LAYOUT_KEY) return null;
  const worktree = parseWorktreeRef(layoutKey);
  if (!worktree) throw new Error(`Not a layout key: ${JSON.stringify(layoutKey)}`);
  return worktree;
}

/**
 * The server a layout and its panels belong to: its worktree's, or the window's for Home's. A
 * layout is stored there, and its panels' bare `worktreePath` params name worktrees there.
 */
export function layoutServer(layoutKey: LayoutKey): ServerId {
  return layoutWorktree(layoutKey)?.server ?? localServerId();
}

/** The key a layout is stored under on its server (`layoutServer`): the worktree's bare path, or Home's. */
export function layoutStorageKey(layoutKey: LayoutKey): string {
  return layoutWorktree(layoutKey)?.path ?? HOME_LAYOUT_KEY;
}
