/**
 * Tells which of a project's worktrees a `worktrees` event removed. That event also fires for
 * config and metadata changes and for a worktree being added or moved, and a move leaves the old
 * path empty just as a removal does, so neither a missing directory nor a shorter list is enough.
 * What tells them apart is the worktree's admin directory under `<common dir>/worktrees/`: it
 * stays through `git worktree move` and goes away when the worktree is unregistered.
 */
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { listManagedWorktrees } from "@bizimind/wt/lib";

export interface WorktreeListChanges {
  /** Worktrees no longer registered and no longer on disk. */
  removed: string[];
  moved: Array<{ from: string; to: string }>;
  /** Removed and added again at the same path between two reads, as `wt rm x && wt add x` can be. */
  replaced: string[];
}

/** A worktree's admin directory, and which one of that name it is. */
interface AdminDir {
  path: string;
  identity: string | null;
}

async function readAdminDirIdentity(adminDir: string): Promise<string | null> {
  try {
    const { dev, ino, birthtimeMs } = await stat(adminDir);
    return `${dev}:${ino}:${birthtimeMs}`;
  } catch {
    return null;
  }
}

/** A worktree's admin directory, from the `.git` file in its checkout. */
async function readAdminDir(wtPath: string): Promise<AdminDir | null> {
  try {
    const gitFile = await Bun.file(join(wtPath, ".git")).text();
    const gitDir = /^gitdir:\s*(.+?)\s*$/m.exec(gitFile)?.[1];
    if (!gitDir) return null;
    const adminDir = resolve(wtPath, gitDir);
    return { path: adminDir, identity: await readAdminDirIdentity(adminDir) };
  } catch {
    return null;
  }
}

/** Where git has the worktree of `adminDir` now, or null once it is unregistered. */
async function readRegisteredPath(adminDir: string): Promise<string | null> {
  try {
    const gitFilePath = await Bun.file(join(adminDir, "gitdir")).text();
    return dirname(resolve(adminDir, gitFilePath.trim()));
  } catch {
    return null;
  }
}

export class RegisteredWorktrees {
  /** Each registered worktree's admin directory, when known. */
  private known = new Map<string, AdminDir | null>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly projectPath: string) {}

  /**
   * Read the list again and report what changed since the last call; the first call only records.
   * `alsoCheck` adds worktrees the caller knows of that may not have been seen listed. Calls run
   * in order, so an older read cannot overwrite a newer one. Throws, keeping what it knew, when
   * the list cannot be read.
   */
  refresh(alsoCheck: Iterable<string> = []): Promise<WorktreeListChanges> {
    const result = this.queue.then(() => this.readChanges(alsoCheck));
    this.queue = result.catch(() => {});
    return result;
  }

  private async readChanges(alsoCheck: Iterable<string>): Promise<WorktreeListChanges> {
    const listed = await listManagedWorktrees(this.projectPath);
    const next = new Map<string, AdminDir | null>();
    await Promise.all(
      listed.map(async ({ path }) => {
        next.set(path, (await readAdminDir(path)) ?? this.known.get(path) ?? null);
      }),
    );

    const changes: WorktreeListChanges = { removed: [], moved: [], replaced: [] };
    const previous = new Map(this.known);
    for (const path of alsoCheck) if (!previous.has(path)) previous.set(path, null);
    for (const [path, adminDir] of previous) {
      const listedAdminDir = next.get(path);
      if (listedAdminDir) {
        const before = adminDir?.identity;
        if (before && listedAdminDir.identity && before !== listedAdminDir.identity) {
          changes.replaced.push(path);
        }
      }
      if (next.has(path)) continue;
      const registeredAt = adminDir ? await readRegisteredPath(adminDir.path) : null;
      if (registeredAt) {
        // Still registered, even if somewhere the managed list leaves out.
        next.set(registeredAt, adminDir);
        if (registeredAt !== path) changes.moved.push({ from: path, to: registeredAt });
      } else if (!existsSync(path)) {
        changes.removed.push(path);
      }
    }
    this.known = next;
    return changes;
  }
}
