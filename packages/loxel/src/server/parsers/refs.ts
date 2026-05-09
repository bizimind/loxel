import type { BranchInfo, RefInfo, StashInfo } from "@/api/git-models";

/**
 * Parse git for-each-ref output.
 * Format: %(objectname) %(refname) %(upstream) %(upstream:track)
 */
export function parseRefsOutput(output: string, head: string): RefInfo[] {
  const lines = output.trim().split("\n").filter(Boolean);
  const refs: RefInfo[] = [];

  for (const line of lines) {
    const parts = line.split(" ");
    if (parts.length < 2) continue;

    const commit = parts[0] ?? "";
    const refname = parts[1] ?? "";
    const upstream = parts[2] || undefined;
    const track = parts.slice(3).join(" ");

    if (!commit || !refname) continue;

    // Parse ahead/behind from track info like "[ahead 2, behind 1]"
    let ahead: number | undefined;
    let behind: number | undefined;
    if (track) {
      const aheadMatch = track.match(/ahead (\d+)/);
      const behindMatch = track.match(/behind (\d+)/);
      if (aheadMatch) ahead = parseInt(aheadMatch[1] ?? "0", 10);
      if (behindMatch) behind = parseInt(behindMatch[1] ?? "0", 10);
    }

    if (refname.startsWith("refs/heads/")) {
      const name = refname.slice("refs/heads/".length);
      refs.push({
        name,
        type: "head",
        commit,
        upstream:
          upstream && upstream !== "refs/heads/" + name
            ? upstream.replace("refs/remotes/", "")
            : undefined,
        ahead,
        behind,
      });
    } else if (refname.startsWith("refs/remotes/")) {
      const fullName = refname.slice("refs/remotes/".length);
      if (fullName === "origin/HEAD") continue; // Skip symbolic ref
      const slashIndex = fullName.indexOf("/");
      refs.push({ name: fullName, type: "remote", remote: fullName.slice(0, slashIndex), commit });
    } else if (refname.startsWith("refs/tags/")) {
      refs.push({ name: refname.slice("refs/tags/".length), type: "tag", commit });
    }
  }

  // Add HEAD
  if (head) {
    refs.push({ name: "HEAD", type: "HEAD", commit: head });
  }

  return refs;
}

/**
 * Parse git branch output with tracking info.
 * Uses porcelain format for reliable parsing.
 */
export function parseBranchOutput(
  output: string,
  headBranch: string | null,
  branchTimestamps?: Map<string, string>,
): BranchInfo[] {
  const lines = output.trim().split("\n").filter(Boolean);
  const branches: BranchInfo[] = [];

  for (const line of lines) {
    // Format from for-each-ref: hash refname upstream track
    const parts = line.split(" ");
    if (parts.length < 2) continue;

    const commit = parts[0] ?? "";
    const refname = parts[1] ?? "";
    const upstream = parts[2];
    const trackParts = parts.slice(3);
    const track = trackParts.join(" ");

    if (!commit || !refname) continue;

    const name = refname.replace("refs/heads/", "");

    let ahead = 0;
    let behind = 0;
    if (track) {
      const aheadMatch = track.match(/ahead (\d+)/);
      const behindMatch = track.match(/behind (\d+)/);
      if (aheadMatch) ahead = parseInt(aheadMatch[1] ?? "0", 10);
      if (behindMatch) behind = parseInt(behindMatch[1] ?? "0", 10);
    }

    branches.push({
      name,
      commit,
      isHead: name === headBranch,
      upstream: upstream ? upstream.replace("refs/remotes/", "") : undefined,
      ahead,
      behind,
      lastUpdated: branchTimestamps?.get(name),
    });
  }

  return branches;
}

/**
 * Parse git stash list output.
 * Format: stash@{0}: WIP on main: abc1234 commit message
 */
export function parseStashOutput(output: string): StashInfo[] {
  const lines = output.trim().split("\n").filter(Boolean);
  const stashes: StashInfo[] = [];

  for (const line of lines) {
    const match = line.match(/^stash@\{(\d+)\}:\s*(.+)$/);
    if (match) {
      const indexStr = match[1] ?? "0";
      const message = match[2] ?? "";
      stashes.push({
        index: parseInt(indexStr, 10),
        message,
        commit: "", // Would need separate call to get commit
        date: "", // Would need separate call to get date
      });
    }
  }

  return stashes;
}
