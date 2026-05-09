import type { CommitInfo, RefInfo } from "@/api/git-models";

const NULL_CHAR = "\x00";

/**
 * Parse git log output in custom format.
 * Format: %H%x00%P%x00%s%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%D
 * Each commit separated by newline.
 */
export function parseLogOutput(output: string): CommitInfo[] {
  const lines = output.trim().split("\n").filter(Boolean);
  const commits: CommitInfo[] = [];

  for (const line of lines) {
    const parts = line.split(NULL_CHAR);
    if (parts.length < 10) continue;

    const hash = parts[0] ?? "";
    const parentStr = parts[1] ?? "";
    const message = parts[2] ?? "";
    const author = parts[3] ?? "";
    const authorEmail = parts[4] ?? "";
    const authorDate = parts[5] ?? "";
    const committer = parts[6] ?? "";
    const committerEmail = parts[7] ?? "";
    const committerDate = parts[8] ?? "";
    const refStr = parts[9] ?? "";

    if (!hash) continue;

    const parents = parentStr ? parentStr.split(" ").filter(Boolean) : [];
    const refs = refStr ? parseRefDecoration(refStr, hash) : [];

    commits.push({
      hash,
      shortHash: hash.slice(0, 7),
      parents,
      message,
      author,
      authorEmail,
      authorDate,
      committer,
      committerEmail,
      committerDate,
      refs,
    });
  }

  return commits;
}

/**
 * Parse the ref decoration string from git log %D.
 * Example: "HEAD -> main, origin/main, tag: v1.0.0"
 */
function parseRefDecoration(refStr: string, commit: string): RefInfo[] {
  if (!refStr.trim()) return [];

  const refs: RefInfo[] = [];
  const parts = refStr.split(", ");

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Handle "HEAD -> branchname"
    if (trimmed.startsWith("HEAD -> ")) {
      refs.push({ name: "HEAD", type: "HEAD", commit });
      const branchName = trimmed.slice("HEAD -> ".length);
      refs.push({ name: branchName, type: "head", commit });
    } else if (trimmed === "HEAD") {
      refs.push({ name: "HEAD", type: "HEAD", commit });
    } else if (trimmed.startsWith("tag: ")) {
      refs.push({ name: trimmed.slice(5), type: "tag", commit });
    } else if (trimmed.includes("/")) {
      // Remote branch like origin/main
      const slashIndex = trimmed.indexOf("/");
      refs.push({ name: trimmed, type: "remote", remote: trimmed.slice(0, slashIndex), commit });
    } else {
      // Local branch
      refs.push({ name: trimmed, type: "head", commit });
    }
  }

  return refs;
}

/**
 * The git log format string to use when fetching commits.
 */
export const LOG_FORMAT = "%H%x00%P%x00%s%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%D";
