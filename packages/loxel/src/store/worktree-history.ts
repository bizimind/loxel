/**
 * Worktree back/forward navigation, like a browser's history, global across all projects.
 *
 * Every change of the active worktree — sidebar click, shortcut, command, opening a file in
 * another worktree — pushes the previous worktree onto the back stack and clears the forward
 * stack. Going back pops the back stack and pushes the current worktree onto the forward stack;
 * going forward does the reverse. Worktrees that no longer exist are skipped.
 *
 * Kept in memory per window. Entries are validated when popped, not when worktrees are removed:
 * if a popped worktree disappears before its layout loads, the store's fallback switch is recorded
 * as an ordinary navigation (clearing the forward stack) and the popped entry is gone.
 */

import { useProjectStore } from "./projects";
import { useWorktreeStore } from "./worktrees";

/** Back/forward stacks are capped; the oldest entries are dropped. */
const MAX_ENTRIES = 50;

export class WorktreeHistory {
  private back: string[] = [];
  private forward: string[] = [];

  /** Record a navigation away from `previous` that wasn't made by back/forward. */
  record(previous: string): void {
    if (this.back.at(-1) !== previous) this.back.push(previous);
    if (this.back.length > MAX_ENTRIES) this.back.shift();
    this.forward = [];
  }

  /** Pop the most recent valid back entry, pushing `current` onto the forward stack. */
  goBack(current: string | null, isValid: (path: string) => boolean): string | null {
    return this.step(this.back, this.forward, current, isValid);
  }

  /** Pop the most recent valid forward entry, pushing `current` onto the back stack. */
  goForward(current: string | null, isValid: (path: string) => boolean): string | null {
    return this.step(this.forward, this.back, current, isValid);
  }

  private step(
    from: string[],
    to: string[],
    current: string | null,
    isValid: (path: string) => boolean,
  ): string | null {
    for (let target = from.pop(); target !== undefined; target = from.pop()) {
      if (target === current || !isValid(target)) continue;
      if (current) to.push(current);
      if (to.length > MAX_ENTRIES) to.shift();
      return target;
    }
    return null;
  }
}

const history = new WorktreeHistory();
/** Set while back/forward switch worktrees, so the switch isn't recorded as a new navigation. */
let navigatingHistory = false;

useWorktreeStore.subscribe(
  (s) => s.activeWorktreePath,
  (path, previous) => {
    if (navigatingHistory || !previous || previous === path) return;
    history.record(previous);
  },
);

/** Whether `path` is still a worktree (or project root) that can be switched to. */
function isSwitchable(path: string): boolean {
  if (useProjectStore.getState().projects.some((p) => p.path === path)) return true;
  return Object.values(useWorktreeStore.getState().byProject).some((ps) =>
    ps.worktrees.some((wt) => wt.path === path && !wt.pending),
  );
}

function navigateTo(target: string | null): void {
  if (!target) return;
  navigatingHistory = true;
  try {
    // switchWorktree sets the active path synchronously, before its first await.
    void useWorktreeStore.getState().switchWorktree(target);
  } finally {
    navigatingHistory = false;
  }
}

export function goBackWorktree(): void {
  const current = useWorktreeStore.getState().activeWorktreePath;
  navigateTo(history.goBack(current, isSwitchable));
}

export function goForwardWorktree(): void {
  const current = useWorktreeStore.getState().activeWorktreePath;
  navigateTo(history.goForward(current, isSwitchable));
}
