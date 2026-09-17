/** Unified diff for a file or set of files */
export interface DiffInfo {
  files: FileDiff[];
  /**
   * The old side of the diff, as a fully resolved commit SHA, or null when it
   * has none (a root commit, or an unstaged diff whose old side is the index).
   *
   * Always resolved by the server, in the repository the diff was computed in.
   * A symbolic ref like `HEAD` cannot be sent to the client, because it means
   * the project repository's HEAD in one place and a worktree's HEAD in
   * another; a SHA means the same commit everywhere.
   */
  baseRef: string | null;
}

/** Diff for a single file */
export interface FileDiff {
  oldPath: string;
  newPath: string;
  status: "added" | "deleted" | "modified" | "renamed" | "copied";
  hunks: DiffHunk[];
  isBinary: boolean;
  additions: number;
  deletions: number;
}

/** The canonical display path for a file diff (newPath for most, oldPath for deleted files) */
export function fileDiffPath(file: FileDiff): string {
  return file.newPath || file.oldPath;
}

/** A hunk in a diff */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

/** A single line in a diff */
export interface DiffLine {
  type: "normal" | "add" | "delete";
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}
