/**
 * Logger interface for channel library.
 * Consumers can inject their own logger implementation.
 */
export interface ChannelLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/**
 * No-op logger (default when no logger is set).
 */
const noopLogger: ChannelLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Global logger instance for the channel library.
 */
let logger: ChannelLogger = noopLogger;

/**
 * Set the logger for the channel library.
 * Call this before creating ChannelClient instances.
 *
 * @example
 * ```typescript
 * import { setChannelLogger } from 'channel';
 * import { createLogger } from 'logger';
 *
 * // Use your own logger implementation
 * const myLogger = createLogger({ source: 'channel' });
 * setChannelLogger(myLogger);
 *
 * // Or create a simple console logger
 * setChannelLogger({
 *   debug: (msg, ctx) => console.debug(msg, ctx),
 *   info: (msg, ctx) => console.info(msg, ctx),
 *   warn: (msg, ctx) => console.warn(msg, ctx),
 *   error: (msg, ctx) => console.error(msg, ctx),
 * });
 * ```
 */
export function setChannelLogger(newLogger: ChannelLogger): void {
  logger = newLogger;
}

/**
 * Get the current logger instance.
 * Used internally by channel library components.
 */
export function getLogger(): ChannelLogger {
  return logger;
}
