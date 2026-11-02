import path from "node:path";

import type { CSharpLspState } from "@/api/csharp-env-model";

const states = new Map<string, CSharpLspState>();
const listeners = new Map<string, Set<() => void>>();

/** What the manager last decided for a worktree; null while it has decided nothing. */
export function getCSharpLspState(wtPath: string): CSharpLspState | null {
  return states.get(path.resolve(wtPath)) ?? null;
}

/** The manager's decisions are the one source of this state, so the status never computes it. */
export function publishCSharpLspState(wtPath: string, state: CSharpLspState): void {
  const key = path.resolve(wtPath);
  if (JSON.stringify(states.get(key)) === JSON.stringify(state)) return;
  states.set(key, state);
  announceCSharpStatus(key);
}

/** Something the status shows may have changed for a worktree. */
export function announceCSharpStatus(wtPath: string): void {
  for (const listener of listeners.get(path.resolve(wtPath)) ?? []) listener();
}

/** Calls `listener` whenever a worktree's status may have changed. */
export function subscribeCSharpStatus(wtPath: string, listener: () => void): () => void {
  const key = path.resolve(wtPath);
  const forWorktree = listeners.get(key) ?? new Set();
  listeners.set(key, forWorktree);
  forWorktree.add(listener);
  return () => {
    forWorktree.delete(listener);
    if (forWorktree.size === 0 && listeners.get(key) === forWorktree) listeners.delete(key);
  };
}
