/**
 * Log severity levels.
 */
export type LogLevel = "error" | "warn" | "info" | "debug";

/**
 * Log source identifiers for different packages/services.
 */
export type LogSource =
  | "ccm"
  | "ccm-daemon"
  | "ccm-mobile"
  | "coding-agent"
  | "channel-worker"
  | "convex"
  | "channel"
  | "remote-terminal"
  | "remote-claude"
  | "remote-coding-agent"
  | "wt";

/**
 * Serialized error structure for logging.
 * Includes error chain via recursive `cause` property.
 */
export interface SerializedError {
  /** Error class name (e.g., "TypeError", "CliError") */
  name: string;
  /** Error message */
  message: string;
  /** Additional enumerable properties (excluding stack) */
  props?: Record<string, unknown>;
  /** Recursive cause chain - same structure applied to each cause */
  cause?: SerializedError;
}

/**
 * Standard log entry structure sent to Axiom.
 */
export interface LogEntry {
  /** Log message */
  message: string;
  /** Severity level */
  level: LogLevel;
  /** Source package/service identifier */
  source: LogSource;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Serialized error (if applicable) */
  error?: SerializedError;
  /** Additional context attributes */
  context?: Record<string, unknown>;
}

/**
 * Logger transport mode.
 * - "http": Logs sent to Axiom via HTTP transport (requires axiomToken and axiomDataset)
 * - "console": Logs written to console (for CF Workers, Convex where console is auto-forwarded)
 */
export type LoggerMode = "http" | "console";

/**
 * Logger configuration options.
 */
export interface LoggerConfig {
  /** Source identifier for this logger instance */
  source: LogSource;
  /** Transport mode - either "http" (Axiom) or "console" */
  mode: LoggerMode;
  /** Axiom API token (required when mode is "http") */
  axiomToken?: string;
  /** Axiom dataset name (required when mode is "http") */
  axiomDataset?: string;
  /** Minimum log level to emit (default: "debug") */
  level?: LogLevel;
}
