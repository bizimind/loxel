/**
 * Tells which of a project's worktrees a `worktrees` event removed. That event also fires for
 * config and metadata changes and for a worktree being added or moved, and a move leaves the old
 * path empty just as a removal does, so neither a missing directory nor a shorter list is enough.
 * What tells them apart is the worktree's admin directory under `<common dir>/worktrees/`: it
 * stays through `git worktree move` and goes away when the worktree is unregistered.
 *
 * Ending terminals and deleting what is stored for a worktree cannot be undone, while a missed
 * removal only leaves a shell running until the server stops. So a worktree counts as removed only
 * on positive evidence, and anything this cannot tell counts as nothing having happened.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { listManagedWorktrees } from "@bizimind/wt/lib";

export interface WorktreeListChanges {
  /** Worktrees git has unregistered and whose directory is gone. */
  removed: string[];
  moved: Array<{ from: string; to: string }>;
}

/** A worktree's admin directory, from the `.git` file in its checkout; null when unreadable. */
async function readAdminDir(wtPath: string): Promise<string | null> {
  try {
    const gitFile = await readFile(join(wtPath, ".git"), "utf8");
    const gitDir = /^gitdir:\s*(.+?)\s*$/m.exec(gitFile)?.[1];
    return gitDir ? resolve(wtPath, gitDir) : null;
  } catch {
    return null;
  }
}

/** What git has on record for the worktree of `adminDir`; null when that cannot be read. */
async function readRegistration(
  adminDir: string,
): Promise<{ registered: true; path: string } | { registered: false } | null> {
  try {
    const gitFilePath = await readFile(join(adminDir, "gitdir"), "utf8");
    return { registered: true, path: dirname(resolve(adminDir, gitFilePath.trim())) };
  } catch (err) {
    return err instanceof Error && "code" in err && err.code === "ENOENT"
      ? { registered: false }
      : null;
  }
}

export class RegisteredWorktrees {
  /** Each worktree seen, with its admin directory if it could be read. */
  private known = new Map<string, string | null>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly projectPath: string) {}

  /**
   * Read the list again and report what changed since the last call; the first call only records.
   * Calls run in order, so an older read cannot overwrite a newer one. Throws, keeping what it
   * knew, when the list cannot be read.
   */
  refresh(): Promise<WorktreeListChanges> {
    const result = this.queue.then(() => this.readChanges());
    this.queue = result.catch(() => {});
    return result;
  }

  private async readChanges(): Promise<WorktreeListChanges> {
    const listed = await listManagedWorktrees(this.projectPath);
    const next = new Map<string, string | null>();
    await Promise.all(
      listed.map(async ({ path }) => {
        next.set(path, (await readAdminDir(path)) ?? this.known.get(path) ?? null);
      }),
    );

    const changes: WorktreeListChanges = { removed: [], moved: [] };
    for (const [path, adminDir] of this.known) {
      if (next.has(path) || !adminDir) continue;
      const registration = await readRegistration(adminDir);
      if (registration?.registered === false) {
        if (!existsSync(path)) changes.removed.push(path);
      } else if (registration && registration.path !== path) {
        next.set(registration.path, adminDir);
        changes.moved.push({ from: path, to: registration.path });
      } else {
        // Still registered there, or unreadable for now: look again on the next event.
        next.set(path, adminDir);
      }
    }
    this.known = next;
    return changes;
  }
}
