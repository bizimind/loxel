export const PACKAGE_NAME = "coding-agent";

export const STATE_ROOT = "~/.local/state/loxel/coding-agent";

export const READ_LIMITS = {
  defaultLines: 2_000,
  maxLineLength: 2_000,
  maxBytes: 50 * 1024,
} as const;

export const GLOB_LIMITS = { maxResults: 100 } as const;

export const GREP_LIMITS = { defaultHeadLimit: 100, maxEntries: 2_000 } as const;

export const BASH_LIMITS = {
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  maxPreviewLines: 2_000,
  maxPreviewBytes: 50 * 1024,
} as const;

export const TASK_OUTPUT_LIMITS = {
  defaultBlock: true,
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 600_000,
} as const;

export const WEB_LIMITS = {
  fetchTimeoutMs: 30_000,
  searchDefaultTopK: 8,
  searchMaxTopK: 20,
} as const;

export const REMINDER_DEFAULTS = {
  backgroundTaskTurns: 3,
  contextCompactedTurns: 6,
  permissionDeniedTurns: 1,
  planExitedTurns: 1,
} as const;
