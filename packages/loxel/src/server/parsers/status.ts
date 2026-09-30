import type { FileStatus, StatusInfo } from "@/api/git-models";

/**
 * Parse `git status --porcelain=v2 --branch -z` output.
 *
 * `-z` is required, not cosmetic: without it git C-quotes any path containing a double quote,
 * a control character or a non-ASCII byte (`"\303\274.txt"`), and the quoted form matches
 * nothing on disk. With `-z` every record is NUL-terminated and paths are verbatim; a rename
 * or copy record is followed by one extra NUL-terminated field holding the original path.
 */
export function parseStatusOutput(output: string): StatusInfo {
  const records = output.split("\0");
  const staged: FileStatus[] = [];
  const unstaged: FileStatus[] = [];
  const untracked: string[] = [];
  const conflicted: FileStatus[] = [];

  let branch: string | null = null;
  let commit = "";
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.startsWith("# branch.oid ")) {
      commit = record.slice("# branch.oid ".length);
    } else if (record.startsWith("# branch.head ")) {
      const head = record.slice("# branch.head ".length);
      branch = head === "(detached)" ? null : head;
    } else if (record.startsWith("# branch.upstream ")) {
      upstream = record.slice("# branch.upstream ".length);
    } else if (record.startsWith("# branch.ab ")) {
      const match = record.match(/# branch\.ab \+(\d+) -(\d+)/);
      if (match) {
        ahead = parseInt(match[1] ?? "0", 10);
        behind = parseInt(match[2] ?? "0", 10);
      }
    } else if (record.startsWith("1 ")) {
      addOrdinaryEntry(record, 8, undefined, staged, unstaged);
    } else if (record.startsWith("2 ")) {
      // The original path is the next NUL-terminated field; consume it.
      i++;
      addOrdinaryEntry(record, 9, records[i], staged, unstaged);
    } else if (record.startsWith("u ")) {
      const path = fieldsFrom(record, 10);
      if (path) conflicted.push({ path, status: "U" });
    } else if (record.startsWith("? ")) {
      untracked.push(record.slice(2));
    }
  }

  return { branch, commit, upstream, ahead, behind, staged, unstaged, untracked, conflicted };
}

/**
 * The path of a record: everything after its first `fixedFields` space-separated fields.
 * Paths may contain spaces, so the remainder is taken verbatim rather than split.
 */
function fieldsFrom(record: string, fixedFields: number): string | null {
  let index = 0;
  for (let n = 0; n < fixedFields; n++) {
    index = record.indexOf(" ", index);
    if (index === -1) return null;
    index++;
  }
  return record.slice(index) || null;
}

/**
 * Add an ordinary (`1`) or rename/copy (`2`) record.
 *
 *   1 XY sub mH mI mW hH hI path
 *   2 XY sub mH mI mW hH hI Xscore path   (followed by origPath as its own -z field)
 */
function addOrdinaryEntry(
  record: string,
  fixedFields: number,
  oldPath: string | undefined,
  staged: FileStatus[],
  unstaged: FileStatus[],
): void {
  const xy = record.slice(2, 4);
  const path = fieldsFrom(record, fixedFields);
  if (xy.length < 2 || !path) return;

  const x = xy.charAt(0); // staged status
  const y = xy.charAt(1); // unstaged status
  if (x !== ".") staged.push({ path, oldPath: oldPath || undefined, status: mapStatusChar(x) });
  if (y !== ".") unstaged.push({ path, status: mapStatusChar(y) });
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
