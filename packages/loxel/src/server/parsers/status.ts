import type { FileStatus, StatusInfo } from "@/api/git-models";

/**
 * Parse git status --porcelain=v2 --branch output.
 */
export function parseStatusOutput(output: string): StatusInfo {
  const lines = output.trim().split("\n");
  const staged: FileStatus[] = [];
  const unstaged: FileStatus[] = [];
  const untracked: string[] = [];
  const conflicted: FileStatus[] = [];

  let branch: string | null = null;
  let commit = "";
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  for (const line of lines) {
    if (line.startsWith("# branch.oid ")) {
      commit = line.slice("# branch.oid ".length);
    } else if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length);
      branch = head === "(detached)" ? null : head;
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length);
    } else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/# branch\.ab \+(\d+) -(\d+)/);
      if (match) {
        ahead = parseInt(match[1] ?? "0", 10);
        behind = parseInt(match[2] ?? "0", 10);
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      // Ordinary or rename/copy entry
      const entry = parseOrdinaryEntry(line);
      if (entry) {
        if (entry.staged) staged.push(entry.staged);
        if (entry.unstaged) unstaged.push(entry.unstaged);
      }
    } else if (line.startsWith("u ")) {
      // Unmerged entry
      const entry = parseUnmergedEntry(line);
      if (entry) conflicted.push(entry);
    } else if (line.startsWith("? ")) {
      // Untracked file
      untracked.push(line.slice(2));
    }
  }

  return { branch, commit, upstream, ahead, behind, staged, unstaged, untracked, conflicted };
}

/**
 * Parse an ordinary (1) or rename/copy (2) entry from porcelain v2.
 * Format:
 *   1 XY sub mH mI mW hH hI path
 *   2 XY sub mH mI mW hH hI Xscore path\torigPath
 */
function parseOrdinaryEntry(
  line: string,
): { staged: FileStatus | null; unstaged: FileStatus | null } | null {
  const parts = line.split(" ");
  if (parts.length < 9) return null;

  const xy = parts[1];
  if (!xy || xy.length < 2) return null;

  const x = xy.charAt(0); // staged status
  const y = xy.charAt(1); // unstaged status

  const isRename = line.startsWith("2 ");
  let path: string;
  let oldPath: string | undefined;

  if (isRename) {
    // Format: 2 XY sub mH mI mW hH hI Xscore path\torigPath
    // parts[8] is Xscore (e.g., "R100"), path starts at parts[9]
    const pathStr = parts.slice(9).join(" ");
    const tabIndex = pathStr.indexOf("\t");
    if (tabIndex !== -1) {
      path = pathStr.slice(0, tabIndex);
      oldPath = pathStr.slice(tabIndex + 1);
    } else {
      path = pathStr;
    }
  } else {
    path = parts.slice(8).join(" ");
  }

  const result: { staged: FileStatus | null; unstaged: FileStatus | null } = {
    staged: null,
    unstaged: null,
  };

  if (x !== ".") {
    result.staged = { path, oldPath, status: mapStatusChar(x) };
  }
  if (y !== ".") {
    result.unstaged = { path, status: mapStatusChar(y) };
  }

  return result;
}

/**
 * Parse an unmerged (u) entry from porcelain v2.
 */
function parseUnmergedEntry(line: string): FileStatus | null {
  const parts = line.split(" ");
  if (parts.length < 11) return null;

  const path = parts.slice(10).join(" ");
  return { path, status: "U" };
}

/**
 * Map git status character to our FileStatus status.
 */
function mapStatusChar(char: string): FileStatus["status"] {
  switch (char) {
    case "A":
      return "A";
    case "M":
      return "M";
    case "D":
      return "D";
    case "R":
      return "R";
    case "C":
      return "C";
    case "U":
      return "U";
    default:
      return "M";
  }
}
