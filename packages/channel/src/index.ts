// Client
export { ChannelClient } from "./client.ts";

// Logger (opt-in)
export { setChannelLogger, type ChannelLogger } from "./logger.ts";

// Discovery utilities
export {
  generateChannelId,
  parseChannelUrl,
  createShareableUrl,
  type ParsedChannelUrl,
} from "./discovery.ts";

// Errors
export {
  ChannelError,
  ConnectionTimeoutError,
  AuthenticationError,
  MaxReconnectAttemptsError,
  InvalidStateError,
} from "./errors.ts";

// Types
export type {
  ChannelClientOptions,
  ResolvedChannelClientOptions,
  ConnectionState,
  ChannelEvent,
  ConnectedEvent,
  DisconnectedEvent,
  PeerJoinedEvent,
  PeerLeftEvent,
  MessageEvent,
  BroadcastEvent,
  ErrorEvent,
  EventHandler,
  AnyEventHandler,
} from "./types.ts";

// Protocol types (for advanced use cases)
export type {
  ChannelId,
  ClientId,
  PeerInfo,
  ErrorCode,
  EnvelopeType,
  BinaryFrame,
} from "./protocol.ts";

// Protocol utilities and schemas (for advanced use cases)
export {
  encodeBinaryFrame,
  decodeBinaryFrame,
  BINARY_HEADER_SIZE,
  JoinPayloadSchema,
} from "./protocol.ts";

// Backoff (for advanced use cases)
export { ExponentialBackoff, type BackoffOptions } from "./backoff.ts";
