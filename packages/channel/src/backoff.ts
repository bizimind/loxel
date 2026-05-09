/**
 * Configuration for exponential backoff.
 */
export interface BackoffOptions {
  /** Base delay in milliseconds */
  baseDelay: number;
  /** Maximum delay in milliseconds */
  maxDelay: number;
  /** Maximum number of attempts before giving up */
  maxAttempts: number;
}

/**
 * Exponential backoff with jitter for reconnection logic.
 */
export class ExponentialBackoff {
  private attempt = 0;

  constructor(private readonly options: BackoffOptions) {}

  /**
   * Get the delay for the next attempt.
   * Returns null if max attempts have been exceeded.
   */
  nextDelay(): number | null {
    if (this.attempt >= this.options.maxAttempts) {
      return null;
    }

    // Exponential backoff: baseDelay * 2^attempt
    const exponentialDelay = this.options.baseDelay * Math.pow(2, this.attempt);

    // Cap at maxDelay
    const cappedDelay = Math.min(exponentialDelay, this.options.maxDelay);

    // Add 0-25% jitter to prevent thundering herd
    const jitter = cappedDelay * 0.25 * Math.random();

    this.attempt++;
    return cappedDelay + jitter;
  }

  /**
   * Get the current attempt number (0-indexed).
   */
  get currentAttempt(): number {
    return this.attempt;
  }

  /**
   * Reset the backoff state.
   */
  reset(): void {
    this.attempt = 0;
  }
}
