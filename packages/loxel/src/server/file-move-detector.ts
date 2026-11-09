import { lstat } from "node:fs/promises";
import { join } from "node:path";

import type { FileMoveSource } from "@/api/ws-protocol";

/** Most file identities remembered per tree; the least recently read are forgotten first. */
const MAX_TRACKED = 1_000;
/** Most paths stat'ed per pass while looking for where a vanished file went. */
const MAX_CANDIDATE_STATS = 200;
/** How long a vanished file can still be matched, for moves whose two events land in different passes. */
const VANISHED_TTL_MS = 2_000;
/** Watcher events arriving this soon after a Loxel file operation are attributed to it. */
const OPERATION_GRACE_MS = 1_000;
/** Concurrent stats while re-checking tracked files. */
const STAT_CONCURRENCY = 32;

export interface DetectedMove {
  /** Relative, `/`-separated paths in the tree. */
  from: string;
  to: string;
  source: FileMoveSource;
}

interface VanishedFile {
  identity: string;
  /** Ancestor directories that changed in the pass the file vanished in: moved-directory roots. */
  changedAncestors: string[];
  at: number;
}

interface PathInfo {
  identity: string;
  isDirectory: boolean;
}

type RecordMove = (from: string, to: string, identity: string) => void;

/**
 * Recognizes renames and moves of files open in editors by their filesystem identity (device,
 * inode and birth time), which survives a rename or a move within one volume but not a
 * copy-and-delete. Symlinks are not followed, so a link to a moved file is never mistaken for it.
 *
 * Only tracked files are considered: the tree's owner tracks a file when an editor reads or
 * writes it. Each pass stats the tracked files it touched, and only when one of them vanished
 * does it stat the pass's other changed paths (capped) to find where it went, so a large
 * directory move costs one stat per affected open file plus a bounded search.
 */
export class FileMoveDetector {
  /** Relative path → identity, in least-recently-tracked order. */
  private identities = new Map<string, string>();
  private vanished = new Map<string, VanishedFile>();
  private operationsInFlight = 0;
  private lastOperationEnd = Number.NEGATIVE_INFINITY;

  constructor(
    private root: string,
    private now: () => number = Date.now,
  ) {}

  /** Remember a file's identity (after an editor read or wrote it). Missing files are ignored. */
  async track(relPath: string): Promise<void> {
    const info = await this.pathInfo(relPath);
    if (!info || info.isDirectory) return;
    this.remember(relPath, info.identity);
    this.vanished.delete(relPath);
  }

  /**
   * Mark a Loxel file operation as running; see `isOperationActive`. Call the returned function
   * when it ends.
   */
  beginOperation(): () => void {
    this.operationsInFlight++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.operationsInFlight--;
      this.lastOperationEnd = this.now();
    };
  }

  /**
   * Whether a Loxel file operation is running or just ended. The owner samples this when watcher
   * events arrive, which can be well before the pass that runs `detect` on them.
   */
  isOperationActive(): boolean {
    return this.operationsInFlight > 0 || this.now() - this.lastOperationEnd < OPERATION_GRACE_MS;
  }

  /** Find moves among the paths one watcher pass reported as changed. */
  async detect(changedPaths: Iterable<string>, source: FileMoveSource): Promise<DetectedMove[]> {
    const changed = new Set(changedPaths);
    const now = this.now();
    for (const [path, file] of this.vanished) {
      if (now - file.at > VANISHED_TTL_MS) this.vanished.delete(path);
    }
    if (changed.size === 0) return [];

    const replaced = await this.recheckTouchedFiles(changed, now);
    if (this.vanished.size === 0) return [];

    const moves: DetectedMove[] = [];
    const record: RecordMove = (from, to, identity) => {
      moves.push({ from, to, source });
      this.vanished.delete(from);
      this.remember(to, identity);
    };
    // Renamed onto another tracked file (`mv a b` with both open): b now has a's identity.
    for (const [path, identity] of replaced) {
      const from = this.vanishedWithIdentity(identity);
      if (from !== undefined) record(from, path, identity);
    }
    await this.findNewLocations(changed, record);
    return moves;
  }

  /**
   * Stat the tracked files whose path or an ancestor changed. Vanished ones move to `vanished`;
   * the ones now holding a different file are returned with their new identity.
   */
  private async recheckTouchedFiles(
    changed: Set<string>,
    now: number,
  ): Promise<Map<string, string>> {
    const touched: Array<{ path: string; identity: string; changedAncestors: string[] }> = [];
    for (const [path, identity] of this.identities) {
      const changedAncestors = ancestors(path).filter((dir) => changed.has(dir));
      if (changed.has(path) || changedAncestors.length > 0) {
        touched.push({ path, identity, changedAncestors });
      }
    }

    const replaced = new Map<string, string>();
    for (let i = 0; i < touched.length; i += STAT_CONCURRENCY) {
      const batch = touched.slice(i, i + STAT_CONCURRENCY);
      const infos = await Promise.all(batch.map(({ path }) => this.pathInfo(path)));
      for (const [j, { path, identity, changedAncestors }] of batch.entries()) {
        const info = infos[j];
        if (info && !info.isDirectory) {
          // A different file under the same name: an atomic save, or another file renamed over
          // it. Track the newcomer either way.
          if (info.identity !== identity) {
            this.identities.set(path, info.identity);
            replaced.set(path, info.identity);
          }
          continue;
        }
        this.identities.delete(path);
        this.vanished.set(path, { identity, changedAncestors, at: now });
      }
    }
    return replaced;
  }

  /** Look for the vanished files among the pass's other changed paths, within the stat budget. */
  private async findNewLocations(changed: Set<string>, record: RecordMove): Promise<void> {
    let budget = MAX_CANDIDATE_STATS;
    for (const path of changed) {
      if (this.vanished.size === 0 || budget <= 0) break;
      if (this.vanished.has(path) || this.identities.has(path)) continue;
      budget--;
      const info = await this.pathInfo(path);
      if (!info) continue;

      if (!info.isDirectory) {
        const from = this.vanishedWithIdentity(info.identity);
        if (from !== undefined) record(from, path, info.identity);
        continue;
      }

      // A directory appeared: a vanished file under a vanished directory may have moved with it.
      for (const [from, file] of [...this.vanished]) {
        for (const dir of file.changedAncestors) {
          if (budget <= 0) break;
          budget--;
          const candidate = path + from.slice(dir.length);
          const candidateInfo = await this.pathInfo(candidate);
          if (candidateInfo?.identity !== file.identity) continue;
          record(from, candidate, file.identity);
          break;
        }
      }
    }
  }

  private vanishedWithIdentity(identity: string): string | undefined {
    for (const [path, file] of this.vanished) {
      if (file.identity === identity) return path;
    }
    return undefined;
  }

  private remember(relPath: string, identity: string): void {
    this.identities.delete(relPath);
    this.identities.set(relPath, identity);
    if (this.identities.size <= MAX_TRACKED) return;
    const oldest = this.identities.keys().next().value;
    if (oldest !== undefined) this.identities.delete(oldest);
  }

  private async pathInfo(relPath: string): Promise<PathInfo | null> {
    try {
      const stats = await lstat(join(this.root, relPath), { bigint: true });
      return {
        identity: `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`,
        isDirectory: stats.isDirectory(),
      };
    } catch {
      return null;
    }
  }
}

/** `a/b/c.ts` → `["a", "a/b"]`. */
function ancestors(relPath: string): string[] {
  const parts = relPath.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}
