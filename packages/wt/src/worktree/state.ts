import { join } from "node:path";

import { z } from "zod";

const STATE_FILENAME = ".wt-state.json";

/**
 * Schema for the state file.
 */
const StateSchema = z.object({
  /** Map of worktree name to its assigned port offset index */
  worktrees: z.record(z.string(), z.number().int().nonnegative()),
});

type State = z.infer<typeof StateSchema>;

/**
 * Find the lowest available index that isn't in the given set of used indices.
 * Pure function for testing.
 */
export function findNextAvailableIndex(usedIndices: number[]): number {
  const set = new Set(usedIndices);
  let index = 0;
  while (set.has(index)) index++;
  return index;
}

/**
 * State manager for tracking worktree port offset indices.
 * Persists to .wt-state.json in the root directory.
 */
export class StateManager {
  private statePath: string;
  private state: State | null = null;

  constructor(rootDir: string) {
    this.statePath = join(rootDir, STATE_FILENAME);
  }

  /**
   * Load state from disk. Creates empty state if file doesn't exist.
   */
  private async load(): Promise<State> {
    if (this.state) {
      return this.state;
    }

    const file = Bun.file(this.statePath);

    if (!(await file.exists())) {
      this.state = { worktrees: {} };
      return this.state;
    }

    let content: string;
    try {
      content = await file.text();
    } catch (err) {
      throw new Error(`Failed to read state file ${this.statePath}: ${err}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(`Invalid JSON in state file ${this.statePath}: ${err}`);
    }

    const result = StateSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Invalid state file ${this.statePath}: ${result.error.message}`);
    }

    this.state = result.data;
    return this.state;
  }

  /**
   * Save state to disk.
   */
  private async save(): Promise<void> {
    if (!this.state) {
      throw new Error("Cannot save state before loading");
    }

    try {
      await Bun.write(this.statePath, JSON.stringify(this.state, null, 2) + "\n");
    } catch (err) {
      throw new Error(`Failed to write state file ${this.statePath}: ${err}`);
    }
  }

  /**
   * Get the port offset index for a worktree.
   * Returns undefined if worktree is not tracked.
   */
  async getIndex(worktreeName: string): Promise<number | undefined> {
    const state = await this.load();
    return state.worktrees[worktreeName];
  }

  /**
   * Get all tracked worktrees and their indices.
   */
  async getAll(): Promise<Record<string, number>> {
    const state = await this.load();
    return { ...state.worktrees };
  }

  /**
   * Allocate a new index for a worktree.
   * Reuses the lowest available index from removed worktrees.
   *
   * @throws Error if worktree already exists
   */
  async allocateIndex(worktreeName: string): Promise<number> {
    const state = await this.load();

    if (worktreeName in state.worktrees) {
      throw new Error(`Worktree '${worktreeName}' already exists in state`);
    }

    // Find the lowest available index
    const newIndex = findNextAvailableIndex(Object.values(state.worktrees));

    state.worktrees[worktreeName] = newIndex;
    await this.save();

    return newIndex;
  }

  /**
   * Remove a worktree from state, freeing its index for reuse.
   *
   * @throws Error if worktree doesn't exist
   */
  async freeIndex(worktreeName: string): Promise<number> {
    const state = await this.load();

    const index = state.worktrees[worktreeName];
    if (index === undefined) {
      throw new Error(`Worktree '${worktreeName}' not found in state`);
    }

    delete state.worktrees[worktreeName];
    await this.save();

    return index;
  }

  /**
   * Check if a worktree is tracked in state.
   */
  async hasWorktree(worktreeName: string): Promise<boolean> {
    const state = await this.load();
    return worktreeName in state.worktrees;
  }
}
