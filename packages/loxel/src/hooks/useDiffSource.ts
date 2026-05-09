import { useEffect } from "react";

import { UNCOMMITTED_PREFIX, isUncommittedHash } from "@/api/git-models";
import { useCommitLookup } from "@/hooks/useCommitLookup";
import { useRepositoryStore } from "@/store/worktree-repository";
import { useWorktreeStore } from "@/store/worktrees";

/**
 * Keeps `diffSource` in the repository store in sync with `selectedCommits`.
 * Called from App.tsx so diffSource updates regardless of which panels are mounted.
 *
 * Uses both the main graph commits and the branch commits as lookup sources,
 * since the branch dropdown may select commits not present in the main graph.
 * Both sources have virtual uncommitted entries injected via `injectUncommittedCommits`
 * so that the same lookup logic works for graph selections and dropdown selections.
 */
export function useDiffSource(): void {
  const selectedCommits = useRepositoryStore((s) => s.selectedCommits);
  const setDiffSource = useRepositoryStore((s) => s.setDiffSource);
  const lookup = useCommitLookup();
  const activeWorktreePath = useWorktreeStore((s) => s.activeWorktreePath);

  // Auto-select the uncommitted entry when nothing is selected (default state)
  const selectCommit = useRepositoryStore((s) => s.selectCommit);
  useEffect(() => {
    if (selectedCommits.size === 0 && activeWorktreePath) {
      const uncommittedHash = `${UNCOMMITTED_PREFIX}${activeWorktreePath}`;
      selectCommit(uncommittedHash);
      return;
    }

    const hashes = Array.from(selectedCommits);
    const hasUncommitted = hashes.some(isUncommittedHash);

    if (selectedCommits.size === 1) {
      const hash = hashes[0]!;
      if (isUncommittedHash(hash)) {
        setDiffSource({ type: "uncommitted", worktree: hash.slice(UNCOMMITTED_PREFIX.length) });
      } else {
        setDiffSource({ type: "commit", commit: hash });
      }
    } else if (hasUncommitted) {
      const uncommittedHash = hashes.find(isUncommittedHash)!;
      const worktree = uncommittedHash.slice(UNCOMMITTED_PREFIX.length);
      const realHashes = hashes.filter((h) => !isUncommittedHash(h));
      const oldest = lookup.oldest(realHashes);

      if (oldest) {
        const base = oldest.parents[0];
        setDiffSource({ type: "uncommitted", worktree, base: base ?? oldest.hash });
      }
    } else {
      const newest = lookup.newest(hashes);
      const oldest = lookup.oldest(hashes);
      if (newest && oldest) {
        const base = oldest.parents[0];
        setDiffSource({ type: "range", range: `${base ?? ""}..${newest.hash}` });
      }
    }
  }, [selectedCommits, lookup, setDiffSource, selectCommit, activeWorktreePath]);
}
