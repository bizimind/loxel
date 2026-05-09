/**
 * Progress callback for library consumers.
 * Replaces OutputContext for programmatic use.
 */
export interface ProgressHandler {
  log(message: string): void;
  warn(message: string): void;
}

/** No-op progress handler for callers that don't need progress updates. */
export const silentProgress: ProgressHandler = { log() {}, warn() {} };
