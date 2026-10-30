export type LogLevel = "debug" | "info" | "warn" | "error";

/** A language server's name: its route (`/ws/<name>`) and log category. */
export type LspName = `${string}-lsp`;

/**
 * The fixed log categories, in the order the logs panel lists them. A language server added since
 * needs no entry: any `LspName` is a category, and the panel lists the ones its clients connect to.
 */
export const LOG_CATEGORIES = [
  "server",
  "git",
  "terminal",
  "agent",
  "files",
  "watcher",
  "detached",
  "yaml-lsp",
  "ts-lsp",
  "docker-lsp",
  "terraform-lsp",
  "python-lsp",
  "ruff-lsp",
  "mypy-lsp",
  "astro-lsp",
  "xml-lsp",
  "toml-lsp",
  "schema-service",
  "update",
  "worktrees",
  "ui",
  "search",
  "format",
  "launch-services",
  "keychain",
  "secret-store",
  "perf",
] as const;

export type LogCategory = (typeof LOG_CATEGORIES)[number] | LspName;

export function isLogCategory(value: string): value is LogCategory {
  return (LOG_CATEGORIES as readonly string[]).includes(value) || /^[a-z0-9-]+-lsp$/.test(value);
}

export interface LogEntry {
  /** Monotonic counter, unique per server lifetime. */
  id: number;
  /** ISO 8601 timestamp. */
  ts: string;
  /** Log level. */
  level: LogLevel;
  /** Log category. */
  cat: LogCategory;
  /** Human-readable message. */
  msg: string;
  /** Optional structured context (project, worktree, session ID, etc.). */
  ctx?: Record<string, unknown>;
}

/** Numeric priority for level comparisons (higher = more severe). */
export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Logger interface shared between server and frontend loggers.
 * Structurally compatible with AppLogger from the `logger` package.
 */
export interface ChildLogger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  /** Flush pending log output. No-op for child loggers (flush is a root concern). */
  flush(): Promise<void>;
  /** Create a sub-child with additional default context. */
  with(defaultCtx: Record<string, unknown>): ChildLogger;
}
