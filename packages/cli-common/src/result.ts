/**
 * Command result type that encapsulates data, formatting, and exit code.
 * All command actions should return this type.
 */
export interface CommandResult<T> {
  /** The result data (used for JSON output) */
  data: T;
  /** Format the result for human-readable output */
  format(): string;
  /** Exit code (default: 0) */
  exitCode: number;
}

/**
 * Create a command result with data and formatter.
 */
export function createResult<T>(
  data: T,
  format: (data: T) => string,
  exitCode: number = 0,
): CommandResult<T> {
  return { data, format: () => format(data), exitCode };
}

/**
 * Error result data structure for JSON output.
 */
export interface ErrorData {
  error: true;
  message: string;
}

/**
 * Create an error result with exit code 1.
 * Data includes { error: true, message } for JSON output.
 */
export function errorResult(message: string, exitCode: number = 1): CommandResult<ErrorData> {
  return { data: { error: true, message }, format: () => `Error: ${message}`, exitCode };
}

/**
 * Helper to wrap unknown errors with context.
 */
export function wrapError(context: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`${context}: ${message}`);
}
