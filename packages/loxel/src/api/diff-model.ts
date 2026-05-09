/** Unified diff for a file or set of files */
export interface DiffInfo {
  files: FileDiff[];
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
