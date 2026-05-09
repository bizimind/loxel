// ---------------------------------------------------------------------------
// Per-session stderr throttle (token bucket)
//
// A chatty LSP (e.g. terraform-ls's workspace-walker spew) can evict useful
// entries from the shared ring buffer and chew disk on the rotating log file.
// This token-bucket throttle caps per-session line volume: bursts up to
// `capacity` pass through instantly, then refill happens at `refillPerSec`.
// Dropped lines are counted and summarized on a timer / at dispose so the
// throttling is observable.
// ---------------------------------------------------------------------------

/**
 * Default bucket capacity — a burst of this many lines emits instantly.
 * Sized so a typical LSP initialize/indexing burst (a few hundred lines) gets
 * through, but sustained spew past the refill rate is dropped.
 */
export const STDERR_THROTTLE_CAPACITY = 200;
/**
 * Steady-state refill rate. 50 lines/sec per session is plenty for legitimate
 * diagnostic output without letting a single LSP flood the shared log pipeline
 * (which has a 5000-entry ring buffer and rotates at 5 MB on disk).
 */
export const STDERR_THROTTLE_REFILL_PER_SEC = 50;
/**
 * How often to emit a "suppressed N lines" summary while dropping. Long enough
 * not to itself spam the log; short enough that the signal isn't lost if the
 * session ends abruptly.
 */
export const STDERR_THROTTLE_FLUSH_INTERVAL_MS = 5000;

export interface StderrThrottleOptions {
  capacity: number;
  refillPerSec: number;
  flushIntervalMs: number;
  /** Called with the number of dropped lines when a summary should be emitted. */
  onSummary: (droppedCount: number) => void;
}

export interface StderrThrottle {
  /**
   * Consume one token. Returns true if the caller may emit the line, false if
   * the bucket is empty (the line should be dropped, but is counted toward the
   * next summary).
   */
  tryConsume(): boolean;
  /** Stop the summary timer and emit a final summary if anything was dropped. */
  dispose(): void;
}

export function createStderrThrottle(opts: StderrThrottleOptions): StderrThrottle {
  let tokens = opts.capacity;
  let lastRefill = Date.now();
  let dropped = 0;
  let disposed = false;

  const flushSummary = () => {
    if (dropped === 0) return;
    const count = dropped;
    dropped = 0;
    opts.onSummary(count);
  };

  const timer = setInterval(flushSummary, opts.flushIntervalMs);

  return {
    tryConsume() {
      if (disposed) return false;
      const t = Date.now();
      const elapsedMs = t - lastRefill;
      if (elapsedMs > 0) {
        tokens = Math.min(opts.capacity, tokens + (elapsedMs * opts.refillPerSec) / 1000);
        lastRefill = t;
      }
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      dropped += 1;
      return false;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      flushSummary();
    },
  };
}
