/** Git status of a file or directory in the project explorer. */
export type ProjectFileStatus = "normal" | "modified" | "untracked" | "ignored";

/** A single entry (file or directory) returned by the project files API. */
export interface DirEntry {
  name: string;
  /** Absolute filesystem path. Canonical identifier for this entry. */
  path: string;
  isDir: boolean;
  status: ProjectFileStatus;
}
