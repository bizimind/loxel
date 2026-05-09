import type { ErrorCode } from "./protocol.ts";

/**
 * Base error class for channel-related errors.
 */
export class ChannelError extends Error {
  override readonly name: string = "ChannelError";

  constructor(
    message: string,
    public readonly code?: ErrorCode,
  ) {
    super(message);
  }
}

/**
 * Error thrown when a connection attempt times out.
 */
export class ConnectionTimeoutError extends ChannelError {
  override readonly name: string = "ConnectionTimeoutError";

  constructor(timeoutMs: number) {
    super(`Connection timed out after ${timeoutMs}ms`);
  }
}

/**
 * Error thrown when authentication fails.
 */
export class AuthenticationError extends ChannelError {
  override readonly name: string = "AuthenticationError";

  constructor(message: string) {
    super(message, "auth_failed");
  }
}

/**
 * Error thrown when max reconnection attempts are exceeded.
 */
export class MaxReconnectAttemptsError extends ChannelError {
  override readonly name: string = "MaxReconnectAttemptsError";

  constructor(attempts: number) {
    super(`Max reconnection attempts (${attempts}) exceeded`);
  }
}

/**
 * Error thrown when an operation is attempted in an invalid state.
 */
export class InvalidStateError extends ChannelError {
  override readonly name: string = "InvalidStateError";
}
