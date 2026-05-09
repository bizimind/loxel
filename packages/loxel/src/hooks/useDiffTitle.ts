import { useMemo } from "react";

import { isUncommittedHash } from "@/api/git-models";
import { useCommitLookup } from "@/hooks/useCommitLookup";
import { useBranchCommitsQuery, useStatusQuery } from "@/queries/use-repo-queries";
import { useRepositoryStore } from "@/store/worktree-repository";

/**
 * Computes a human-readable title for the diff panel based on selected commits.
 *
 * - Local changes only → "Local changes"
 * - Single commit → "<shortHash> changes"
 * - All branch changes → "<branch> changes"
 * - Contiguous range → "<oldest>...<newest>"
 * - Contiguous range + local → "<oldest>...local"
 * - Sporadic selection → "Selected changes"
 */
export function useDiffTitle(): string {
  const selectedCommits = useRepositoryStore((s) => s.selectedCommits);
  const lookup = useCommitLookup();
  const { data: branchData } = useBranchCommitsQuery();
  const { data: status } = useStatusQuery();
  const branchName = status?.branch ?? null;

  return useMemo(() => {
    if (selectedCommits.size === 0) return "Diff";

    const hashes = Array.from(selectedCommits);
    const hasUncommitted = hashes.some(isUncommittedHash);
    const realHashes = hashes.filter((h) => !isUncommittedHash(h));

    // Local changes only
    if (selectedCommits.size === 1 && hasUncommitted) {
      return "Local changes";
    }

    // Single commit
    if (selectedCommits.size === 1 && !hasUncommitted) {
      const commit = lookup.byHash.get(hashes[0]!);
      return commit ? `${commit.shortHash} changes` : "Diff";
    }

    // Check if all branch commits are selected
    const dropdownCommits = branchData?.commits ?? [];
    if (dropdownCommits.length > 0) {
      const dropdownHashes = new Set(dropdownCommits.map((c) => c.hash));
      const allBranchSelected = dropdownCommits.every((c) => selectedCommits.has(c.hash));
      const nothingExtra = realHashes.every((h) => dropdownHashes.has(h));
      if (allBranchSelected && nothingExtra) {
        return branchName ? `${branchName} changes` : "All branch changes";
      }
    }

    // Check if selection is a contiguous range in allKnownCommits
    const indices = realHashes
      .map((h) => lookup.indexOf(h))
      .filter((i) => i !== -1)
      .sort((a, b) => a - b);

    const isContiguous =
      indices.length > 0 && indices.length === indices[indices.length - 1]! - indices[0]! + 1;

    if (isContiguous && indices.length >= 2) {
      const newest = lookup.commits[indices[0]!];
      const oldest = lookup.commits[indices[indices.length - 1]!];
      if (newest && oldest) {
        const suffix = hasUncommitted ? "local" : newest.shortHash;
        return `${oldest.shortHash}...${suffix}`;
      }
    }

    // Contiguous single commit + local
    if (realHashes.length === 1 && hasUncommitted) {
      const commit = lookup.byHash.get(realHashes[0]!);
      return commit ? `${commit.shortHash}...local` : "Selected changes";
    }

    return "Selected changes";
  }, [selectedCommits, lookup, branchData, branchName]);
}
