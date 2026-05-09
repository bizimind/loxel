/**
 * Result types for each command.
 * These define the JSON output schema.
 */

export interface ListResult {
  worktrees: Array<{ name: string; path: string; branch: string; portOffset: number }>;
}

export interface OpenResult {
  name: string;
  path: string;
  editor: string;
}

export interface InitResult {
  rootDir: string;
  configPath: string;
  editor: string | null;
  baseBranch: string;
  worktreesDir: string;
  converted: boolean;
  githubUrl: string | null;
}

export interface ViewResult {
  name: string;
  path: string;
  branch: string;
  head: string;
  portOffset: number;
  synced: boolean;
  env: Record<string, string>;
}

export interface ErrorResult {
  error: string;
}

export interface AbortedResult {
  aborted: true;
  reason?: string;
}
