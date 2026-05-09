# channel

WebSocket channel client library for peer-to-peer style communication via a Cloudflare Workers relay.

## Features

- **Bidirectional messaging** - Send targeted messages to specific peers
- **Multi-party broadcast** - Fan out messages to all connected peers
- **Binary payload support** - Send ArrayBuffer data for audio/video streaming
- **Auto-reconnection** - Exponential backoff with jitter
- **JWT authentication** - Secure channel access
- **TypeScript-first** - Full type safety with Zod validation

## Installation

```bash
bun add channel
# or
npm install channel
```

## Quick Start

```typescript
import { ChannelClient, generateChannelId } from "channel";

// Create a channel client
const client = new ChannelClient({
  url: "wss://channels.example.workers.dev",
  channelId: "room-123",
  token: "your-jwt-token",
  meta: { username: "alice" },
});

// Subscribe to events
client.on("connected", (e) => {
  console.log("Connected as:", e.clientId);
  console.log("Peers:", e.peers);
});

client.on("peer_joined", (e) => {
  console.log(`${e.peer.meta?.username} joined`);
});

client.on("message", (e) => {
  console.log(`Message from ${e.from}:`, e.payload);
});

client.on("broadcast", (e) => {
  console.log(`Broadcast from ${e.from}:`, e.payload);
});

// Connect to the channel
await client.connect();

// Send a targeted message to a specific peer
const peerId = Array.from(client.peers.keys())[0];
client.send(peerId, { type: "hello", text: "Hi there!" });

// Broadcast to all peers
client.broadcast({ type: "announcement", text: "Hello everyone!" });

// Disconnect when done
client.disconnect();
```

## API Reference

### `ChannelClient`

Main client class for channel communication.

#### Constructor Options

```typescript
interface ChannelClientOptions {
  url: string; // Worker URL (e.g., "wss://channels.example.workers.dev")
  channelId: string; // Channel ID to join
  token: string; // JWT authentication token
  meta?: Record<string, unknown>; // Metadata shared with peers (default: {})
  autoReconnect?: boolean; // Auto-reconnect on disconnect (default: true)
  maxReconnectAttempts?: number; // Max reconnect attempts (default: 10)
  reconnectBaseDelay?: number; // Base delay for backoff in ms (default: 1000)
  reconnectMaxDelay?: number; // Max delay for backoff in ms (default: 30000)
  pingInterval?: number; // Ping interval in ms (default: 30000)
  connectionTimeout?: number; // Connection timeout in ms (default: 10000)

  // Reliability options
  enableAck?: boolean; // Enable ACK tracking for delivery confirmation (default: true)
  ackTimeout?: number; // Timeout in ms to wait for ACK before retry (default: 5000)
  maxRetries?: number; // Max retry attempts for unacknowledged messages (default: 3)
  ackCheckInterval?: number; // ACK check interval in ms (default: 1000)
  maxPendingMessages?: number; // High water mark before backpressure (default: 100)
}
```

#### Methods

| Method                            | Description                                               |
| --------------------------------- | --------------------------------------------------------- |
| `connect()`                       | Connect to the channel. Returns `Promise<ConnectedEvent>` |
| `disconnect()`                    | Disconnect from the channel                               |
| `send(to, payload)`               | Send JSON message to a specific peer                      |
| `sendBinary(to, data)`            | Send binary data to a specific peer                       |
| `broadcast(payload)`              | Broadcast JSON message to all peers                       |
| `broadcastBinary(data)`           | Broadcast binary data to all peers                        |
| `sendBinaryUnreliable(to, data)`  | Send binary data without ACK tracking (fire-and-forget)   |
| `broadcastBinaryUnreliable(data)` | Broadcast binary data without ACK tracking                |
| `on(type, handler)`               | Subscribe to an event type. Returns unsubscribe function  |
| `off(type, handler)`              | Unsubscribe from an event type                            |
| `onAny(handler)`                  | Subscribe to all events                                   |

#### Properties

| Property          | Type                                            | Description                               |
| ----------------- | ----------------------------------------------- | ----------------------------------------- |
| `clientId`        | `string \| null`                                | Own client ID (assigned after connect)    |
| `peers`           | `ReadonlyMap<ClientId, PeerInfo>`               | Connected peers                           |
| `state`           | `"disconnected" \| "connecting" \| "connected"` | Connection state                          |
| `isConnected`     | `boolean`                                       | Whether currently connected               |
| `isBackpressured` | `boolean`                                       | Whether pending messages exceed threshold |

### Events

| Event            | Description                        |
| ---------------- | ---------------------------------- |
| `connected`      | Successfully joined the channel    |
| `disconnected`   | Disconnected from channel          |
| `peer_joined`    | A new peer joined the channel      |
| `peer_left`      | A peer left the channel            |
| `message`        | Received a targeted message        |
| `broadcast`      | Received a broadcast message       |
| `error`          | An error occurred                  |
| `ack`            | Message was acknowledged by server |
| `message_failed` | Message failed after max retries   |
| `backpressure`   | Pending messages threshold crossed |

```typescript
// Event types
interface ConnectedEvent {
  type: "connected";
  clientId: string;
  channelId: string;
  peers: PeerInfo[];
}

interface DisconnectedEvent {
  type: "disconnected";
  reason: "close" | "error" | "timeout";
  willReconnect: boolean;
}

interface PeerJoinedEvent {
  type: "peer_joined";
  peer: PeerInfo;
}

interface PeerLeftEvent {
  type: "peer_left";
  clientId: string;
  reason: "leave" | "disconnect" | "timeout";
}

interface MessageEvent {
  type: "message";
  from: string;
  payload: unknown;
  binary: boolean;
}

interface BroadcastEvent {
  type: "broadcast";
  from: string;
  payload: unknown;
  binary: boolean;
}

interface ErrorEvent {
  type: "error";
  code: ErrorCode;
  message: string;
  fatal: boolean;
}

interface AckEvent {
  type: "ack";
  seq: number;
}

interface MessageFailedEvent {
  type: "message_failed";
  seq: number;
  to?: string;
  payload: unknown;
  binary: boolean;
}

interface BackpressureEvent {
  type: "backpressure";
  pendingCount: number;
  action: "pause" | "resume";
}
```

### Discovery Helpers

```typescript
import { generateChannelId, parseChannelUrl, createShareableUrl } from "channel";

// Generate a random channel ID (Base58, URL-safe)
const channelId = generateChannelId(); // e.g., "7kXm9Pq2aB"

// Parse channel ID from various URL formats
parseChannelUrl("wss://example.com/channel/abc123");
// { host: "example.com", channelId: "abc123" }

parseChannelUrl("https://myapp.com/join/7kXm9Pq2");
// { host: "myapp.com", channelId: "7kXm9Pq2" }

parseChannelUrl("channel:abc123");
// { channelId: "abc123" }

// Create a shareable URL
createShareableUrl("https://myapp.com", "abc123");
// "https://myapp.com/join/abc123"
```

## Usage Examples

### Two-Party Video Call Signaling

```typescript
const client = new ChannelClient({
  url: "wss://channels.example.workers.dev",
  channelId: "call-alice-bob",
  token,
  meta: { name: "Alice" },
});

client.on("peer_joined", async (e) => {
  // Initiate WebRTC connection when peer joins
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  client.send(e.peer.clientId, { type: "offer", sdp: offer.sdp });
});

client.on("message", async (e) => {
  const msg = e.payload as { type: string; sdp?: string; candidate?: RTCIceCandidateInit };

  if (msg.type === "offer") {
    await peerConnection.setRemoteDescription({ type: "offer", sdp: msg.sdp });
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    client.send(e.from, { type: "answer", sdp: answer.sdp });
  } else if (msg.type === "answer") {
    await peerConnection.setRemoteDescription({ type: "answer", sdp: msg.sdp });
  } else if (msg.type === "ice-candidate") {
    await peerConnection.addIceCandidate(msg.candidate);
  }
});

await client.connect();
```

### Multi-Party Game Lobby

```typescript
interface GameMessage {
  type: "move" | "chat" | "ready";
  data: unknown;
}

const player = new ChannelClient({
  url: "wss://channels.example.workers.dev",
  channelId: `game-${gameId}`,
  token,
  meta: { playerId, playerName },
});

const players = new Map<string, PeerInfo>();

player.on("connected", (e) => {
  for (const peer of e.peers) {
    players.set(peer.clientId, peer);
  }
  updatePlayerList();
});

player.on("peer_joined", (e) => {
  players.set(e.peer.clientId, e.peer);
  updatePlayerList();
});

player.on("peer_left", (e) => {
  players.delete(e.clientId);
  updatePlayerList();
});

player.on("broadcast", (e) => {
  const msg = e.payload as GameMessage;
  handleGameMessage(e.from, msg);
});

await player.connect();

// Broadcast game moves
function makeMove(move: MoveData) {
  player.broadcast({ type: "move", data: move });
}
```

### Binary Audio Streaming

```typescript
const streamer = new ChannelClient({
  url: "wss://channels.example.workers.dev",
  channelId: `stream-${streamId}`,
  token,
});

streamer.on("message", (e) => {
  if (e.binary) {
    playAudioChunk(e.payload as ArrayBuffer);
  }
});

await streamer.connect();

// Stream audio to a peer
async function streamAudio(peerId: string, audioData: ArrayBuffer) {
  streamer.sendBinary(peerId, audioData);
}

// Broadcast audio to all peers
function broadcastAudio(audioData: ArrayBuffer) {
  streamer.broadcastBinary(audioData);
}
```

### Terminal Control (PTY Streaming)

For interactive terminal sessions requiring low-latency keystrokes:

```typescript
const terminal = new ChannelClient({
  url: "wss://channels.example.workers.dev",
  channelId: `terminal-${sessionId}`,
  token,

  // Fast retry for keystrokes
  ackTimeout: 500, // Retry after 500ms (not default 5s)
  ackCheckInterval: 100, // Check every 100ms (not default 1s)
  maxRetries: 2, // Fail fast
  maxPendingMessages: 50, // Earlier backpressure warning
});

// Mobile: Send keystrokes with reliability (must not be lost)
function sendKeystroke(key: string) {
  const data = new TextEncoder().encode(key);
  terminal.sendBinary(desktopPeerId, data.buffer);
}

// Desktop: Stream terminal output without ACK overhead (high-frequency, ephemeral)
function streamTerminalOutput(data: ArrayBuffer) {
  terminal.broadcastBinaryUnreliable(data);
}

// Handle backpressure from slow receiver
terminal.on("backpressure", (e) => {
  if (e.action === "pause") {
    pauseTerminalOutput();
  } else {
    resumeTerminalOutput();
  }
});

await terminal.connect();
```

## Authentication

The channel client requires a JWT token for authentication. The [channel-worker](../channel-worker) validates JWTs using RS256 via WorkOS JWKS.

### Using with WorkOS (Recommended)

If you're using ccm apps, tokens are already available:

```typescript
import { getValidToken } from "ccm/auth/tokens";

// Get a valid token (auto-refreshes if needed)
const { token } = await getValidToken(clientId);

const client = new ChannelClient({
  url: "wss://channels.example.workers.dev",
  channelId: "room-123",
  token: token, // WorkOS JWT
});
await client.connect();
```

### JWT Requirements

Tokens must be:

- Signed with **RS256** algorithm
- Verifiable via the configured JWKS endpoint
- Include required claims: `sub` (user ID), `exp` (expiration)

The worker validates tokens against WorkOS JWKS and enforces that all clients in a channel have the same `sub` claim (same-user channels).

## Error Handling

```typescript
import {
  ChannelError,
  ConnectionTimeoutError,
  AuthenticationError,
  MaxReconnectAttemptsError,
} from "channel";

client.on("error", (e) => {
  if (e.code === "auth_failed") {
    // Token expired or invalid - refresh and reconnect
    refreshTokenAndReconnect();
  } else {
    console.error(`Channel error: ${e.message}`);
  }
});

try {
  await client.connect();
} catch (err) {
  if (err instanceof AuthenticationError) {
    console.error("Authentication failed:", err.message);
  } else if (err instanceof ConnectionTimeoutError) {
    console.error("Connection timed out");
  }
}
```

## Message Reliability

The channel client includes built-in message reliability with ACK tracking, automatic retries, and backpressure signaling.

### How It Works

1. Each message is assigned a sequence number
2. Server acknowledges receipt with an ACK
3. Client retries unacknowledged messages after timeout
4. After max retries, `message_failed` event is emitted

Note: ACK is non-blocking. Messages are sent immediately and ACK tracking runs in the background. The receiver gets messages without any delay from the ACK system.

### Configuration

```typescript
const client = new ChannelClient({
  url: "wss://channels.example.workers.dev",
  channelId: "room-123",
  token,

  // Reliability settings
  enableAck: true, // Enable ACK tracking (default: true)
  ackTimeout: 5000, // Wait 5s for ACK before retry
  maxRetries: 3, // Retry up to 3 times
  ackCheckInterval: 1000, // Check for timeouts every 1s
  maxPendingMessages: 100, // Emit backpressure at 100 pending
});
```

### Fire-and-Forget Mode

For high-frequency streams where latency matters more than guaranteed delivery:

```typescript
// These skip ACK tracking entirely - no retries, no message_failed events
client.sendBinaryUnreliable(peerId, audioData);
client.broadcastBinaryUnreliable(videoFrame);
```

### Backpressure Handling

```typescript
client.on("backpressure", (e) => {
  if (e.action === "pause") {
    // Slow down sending - too many pending messages
    console.log(`${e.pendingCount} messages pending`);
  } else {
    // Safe to resume normal sending
  }
});

// Check backpressure state synchronously
if (client.isBackpressured) {
  // Buffer locally instead of sending
}
```

### Disabling ACK

For pure fire-and-forget without any tracking:

```typescript
const client = new ChannelClient({
  url: "wss://channels.example.workers.dev",
  channelId: "room-123",
  token,
  enableAck: false, // No pending tracking, no retries, no message_failed
});
```

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Type check
bun run typecheck
```
