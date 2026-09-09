import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const STATE_FILENAME = ".wt-state.json";
const LOCK_FILENAME = ".wt-state.lock";
/** Max time (ms) to wait for the lock before giving up. */
const LOCK_TIMEOUT_MS = 10_000;
/** A lock file older than this (ms) is considered stale and can be broken. */
const LOCK_STALE_MS = 30_000;
/** Interval (ms) between lock-acquisition retries. */
const LOCK_RETRY_INTERVAL_MS = 50;

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
 *
 * Mutating operations (`allocateIndex`, `freeIndex`) acquire an exclusive file
 * lock (`.wt-state.lock`) to prevent concurrent `wt add` / `wt remove` from
 * allocating duplicate port indices.
 */
export class StateManager {
  private statePath: string;
  private lockPath: string;
  private state: State | null = null;

  constructor(rootDir: string) {
    this.statePath = join(rootDir, STATE_FILENAME);
    this.lockPath = join(rootDir, LOCK_FILENAME);
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
   * Acquire an exclusive file lock. Retries with backoff until `LOCK_TIMEOUT_MS`.
   * Breaks stale locks older than `LOCK_STALE_MS`.
   */
  private async acquireLock(): Promise<void> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        // O_CREAT | O_EXCL: atomic create-if-not-exists
        writeFileSync(this.lockPath, String(process.pid), { flag: "wx" });
        return;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

        // Lock file exists — check staleness
        try {
          const stat = await Bun.file(this.lockPath).stat();
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            // Stale lock — remove and retry immediately
            try {
              unlinkSync(this.lockPath);
            } catch {
              // ignore
            }
            continue;
          }
        } catch {
          // Lock file disappeared between check and stat — retry
          continue;
        }

        await Bun.sleep(LOCK_RETRY_INTERVAL_MS);
      }
    }

    throw new Error(
      `Timed out waiting for state lock (${this.lockPath}). ` +
        "Another wt process may be running. " +
        `Delete the lock file manually if this persists.`,
    );
  }

  /** Release the file lock. */
  private releaseLock(): void {
    try {
      unlinkSync(this.lockPath);
    } catch {
      // ignore — lock may already be cleaned up
    }
  }

  /**
   * Run a callback under the exclusive file lock.
   * Invalidates cached state before and after so the read is fresh.
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireLock();
    // Invalidate cached state so we read the latest from disk
    this.state = null;
    try {
      return await fn();
    } finally {
      this.state = null;
      this.releaseLock();
    }
  }

  /**
   * Allocate a new index for a worktree.
   * Reuses the lowest available index from removed worktrees.
   * Acquires a file lock to prevent concurrent duplicate allocations.
   *
   * @throws Error if worktree already exists
   */
  async allocateIndex(worktreeName: string): Promise<number> {
    return this.withLock(async () => {
      const state = await this.load();

      if (worktreeName in state.worktrees) {
        throw new Error(`Worktree '${worktreeName}' already exists in state`);
      }

      // Find the lowest available index
      const newIndex = findNextAvailableIndex(Object.values(state.worktrees));

      state.worktrees[worktreeName] = newIndex;
      await this.save();

      return newIndex;
    });
  }

  /**
   * Remove a worktree from state, freeing its index for reuse.
   * Acquires a file lock to prevent concurrent modification.
   *
   * @throws Error if worktree doesn't exist
   */
  async freeIndex(worktreeName: string): Promise<number> {
    return this.withLock(async () => {
      const state = await this.load();

      const index = state.worktrees[worktreeName];
      if (index === undefined) {
        throw new Error(`Worktree '${worktreeName}' not found in state`);
      }

      delete state.worktrees[worktreeName];
      await this.save();

      return index;
    });
  }

  /**
   * Check if a worktree is tracked in state.
   */
  async hasWorktree(worktreeName: string): Promise<boolean> {
    const state = await this.load();
    return worktreeName in state.worktrees;
  }
}
