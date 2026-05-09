import { useMemo } from "react";

import type { CommitInfo } from "@/api/git-models";

import { useAllKnownCommits } from "./useAllKnownCommits";

export interface CommitLookup {
  /** All known commits in topological order (newest first). */
  commits: CommitInfo[];
  /** O(1) lookup by hash. */
  byHash: Map<string, CommitInfo>;
  /** Find the newest commit (lowest index) among the given hashes. */
  newest: (hashes: string[]) => CommitInfo | undefined;
  /** Find the oldest commit (highest index) among the given hashes. */
  oldest: (hashes: string[]) => CommitInfo | undefined;
  /** Get the index of a commit by hash, or -1 if not found. */
  indexOf: (hash: string) => number;
}

export function useCommitLookup(): CommitLookup {
  const commits = useAllKnownCommits();

  return useMemo(() => {
    const byHash = new Map<string, CommitInfo>();
    const indexMap = new Map<string, number>();
    for (let i = 0; i < commits.length; i++) {
      const c = commits[i]!;
      byHash.set(c.hash, c);
      indexMap.set(c.hash, i);
    }

    return {
      commits,
      byHash,
      newest(hashes: string[]) {
        let best: CommitInfo | undefined;
        let bestIdx = Infinity;
        for (const h of hashes) {
          const idx = indexMap.get(h);
          if (idx !== undefined && idx < bestIdx) {
            bestIdx = idx;
            best = byHash.get(h);
          }
        }
        return best;
      },
      oldest(hashes: string[]) {
        let best: CommitInfo | undefined;
        let bestIdx = -1;
        for (const h of hashes) {
          const idx = indexMap.get(h);
          if (idx !== undefined && idx > bestIdx) {
            bestIdx = idx;
            best = byHash.get(h);
          }
        }
        return best;
      },
      indexOf(hash: string) {
        return indexMap.get(hash) ?? -1;
      },
    };
  }, [commits]);
}
