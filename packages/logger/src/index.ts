import { Axiom } from "@axiomhq/js";
import { Logger, AxiomJSTransport, ConsoleTransport, type LogEvent } from "@axiomhq/logging";

import { serializeError } from "./formatters/error-serializer.ts";
import { sanitizeContext } from "./formatters/sanitizer.ts";
import type { LoggerConfig, LoggerMode, LogLevel, LogSource, SerializedError } from "./types.ts";

export type { LogLevel, LoggerMode, LogSource, SerializedError, LoggerConfig };
export { serializeError } from "./formatters/error-serializer.ts";
export { sanitizeValue, sanitizeContext } from "./formatters/sanitizer.ts";

/** Map our log levels to @axiomhq/logging levels */
const LOG_LEVEL_MAP: Record<LogLevel, "debug" | "info" | "warn" | "error"> = {
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error",
};

/**
 * Custom formatter that:
 * - Adds source field
 * - Serializes errors in the expected format
 * - Sanitizes context for sensitive data
 */
function createFormatter(source: LogSource) {
  return (event: LogEvent): LogEvent => {
    const fields = { ...event.fields };

    // Add source to all log entries
    fields.source = source;

    // Process error field if present
    if (fields.error !== undefined) {
      const serialized = serializeError(fields.error);
      if (serialized) {
        fields.error = serialized;
      } else {
        delete fields.error;
      }
    }

    // Sanitize all fields
    const sanitized = sanitizeContext(fields);

    return { ...event, fields: sanitized ?? {} };
  };
}

/**
 * Wrapped logger interface with our typed methods.
 */
export interface AppLogger {
  /** Log a debug message */
  debug(message: string, context?: Record<string, unknown>): void;
  /** Log an info message */
  info(message: string, context?: Record<string, unknown>): void;
  /** Log a warning message */
  warn(message: string, context?: Record<string, unknown>): void;
  /** Log an error message */
  error(message: string, context?: Record<string, unknown>): void;
  /** Flush pending logs (call before process exit) */
  flush(): Promise<void>;
  /** Create a child logger with additional context */
  with(context: Record<string, unknown>): AppLogger;
}

/**
 * Create a wrapped logger with consistent context.
 */
function wrapLogger(logger: Logger, baseContext: Record<string, unknown> = {}): AppLogger {
  const log = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    context?: Record<string, unknown>,
  ) => {
    const mergedContext = { ...baseContext, ...context };
    logger[level](message, mergedContext);
  };

  return {
    debug: (message, context) => log("debug", message, context),
    info: (message, context) => log("info", message, context),
    warn: (message, context) => log("warn", message, context),
    error: (message, context) => log("error", message, context),
    flush: () => logger.flush(),
    with: (context) => wrapLogger(logger, { ...baseContext, ...context }),
  };
}

/**
 * Create a logger instance.
 *
 * @example
 * ```typescript
 * // HTTP mode - logs sent to Axiom via HTTP
 * const logger = createLogger({
 *   source: 'ccm-daemon',
 *   mode: 'http',
 *   axiomToken: process.env.AXIOM_TOKEN,
 *   axiomDataset: process.env.AXIOM_DATASET,
 * });
 *
 * // Console mode - logs written to console (for CF Workers, Convex)
 * const logger = createLogger({
 *   source: 'channel-worker',
 *   mode: 'console',
 * });
 *
 * logger.info('Started', { port: 7432 });
 * await logger.flush();
 * ```
 */
export function createLogger(config: LoggerConfig): AppLogger {
  const { source, mode, axiomToken, axiomDataset, level = "debug" } = config;

  if (mode === "console") {
    const consoleTransport = new ConsoleTransport({
      logLevel: LOG_LEVEL_MAP[level],
      prettyPrint: process.env.NODE_ENV !== "production",
    });

    const logger = new Logger({
      transports: [consoleTransport],
      formatters: [createFormatter(source)],
    });
    return wrapLogger(logger);
  }

  // mode === "http"
  if (!axiomToken || !axiomDataset) {
    throw new Error("axiomToken and axiomDataset are required when mode is 'http'");
  }

  const axiom = new Axiom({ token: axiomToken });
  const axiomTransport = new AxiomJSTransport({
    axiom,
    dataset: axiomDataset,
    logLevel: LOG_LEVEL_MAP[level],
  });

  const logger = new Logger({
    transports: [axiomTransport],
    formatters: [createFormatter(source)],
  });
  return wrapLogger(logger);
}

/**
 * Create a no-op logger that discards all log messages.
 * Useful for CLI commands that don't need logging.
 */
export function createNoopLogger(): AppLogger {
  const noop = () => {};
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    flush: async () => {},
    with: () => createNoopLogger(),
  };
}
