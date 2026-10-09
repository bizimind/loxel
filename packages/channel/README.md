# channel

WebSocket channel client library for peer-to-peer style communication via the [channel-worker](../channel-worker) relay. It also owns the wire protocol (`src/protocol.ts`), which channel-worker imports.

## Features

- **Targeted and broadcast messaging** — send JSON or binary payloads to one peer or all peers in a channel
- **Peer presence** — join/leave events and a live peer map with per-client metadata
- **Auto-reconnection** — exponential backoff with jitter
- **Delivery tracking** — per-message ACKs with retries, failure events, and backpressure signals
- **JWT authentication** — tokens are verified by the relay, which restricts each channel to a single user

## Installation

Workspace-only package; add it as a dependency of another package in the monorepo:

```json
"dependencies": { "@bizimind/channel": "workspace:*" }
```

## Quick Start

```typescript
import { ChannelClient } from "@bizimind/channel";

const client = new ChannelClient({
  url: "wss://channels.loxel.bizimind.io",
  channelId: "room-123",
  token: jwt,
  meta: { device: "laptop" },
});

client.on("peer_joined", (e) => console.log("joined:", e.peer.clientId, e.peer.meta));
client.on("message", (e) => console.log(`from ${e.from}:`, e.payload));
client.on("broadcast", (e) => console.log(`broadcast from ${e.from}:`, e.payload));

const { clientId, peers } = await client.connect();

client.send(peers[0].clientId, { type: "hello" });
client.broadcast({ type: "announcement" });

client.disconnect();
```

## API

Everything public is exported from `src/index.ts`; option and event types live in `src/types.ts`.

### `new ChannelClient(options)`

| Option                 | Default | Description                                                   |
| ---------------------- | ------- | ------------------------------------------------------------- |
| `url`                  | —       | Relay URL; the client connects to `<url>/channel/<channelId>` |
| `channelId`            | —       | Channel to join (1–128 chars)                                 |
| `token`                | —       | JWT sent in the `join` message                                |
| `meta`                 | `{}`    | Metadata shared with peers                                    |
| `autoReconnect`        | `true`  | Reconnect after an unexpected disconnect                      |
| `maxReconnectAttempts` | `10`    | Give up after this many attempts                              |
| `reconnectBaseDelay`   | `1000`  | Backoff base delay (ms)                                       |
| `reconnectMaxDelay`    | `30000` | Backoff cap (ms)                                              |
| `pingInterval`         | `30000` | Keep-alive ping interval (ms)                                 |
| `connectionTimeout`    | `10000` | Connect timeout (ms)                                          |
| `enableAck`            | `true`  | Track ACKs and retry unacknowledged messages                  |
| `ackTimeout`           | `5000`  | Wait before retrying an unacknowledged message (ms)           |
| `maxRetries`           | `3`     | Retries before emitting `message_failed`                      |
| `ackCheckInterval`     | `1000`  | How often pending messages are checked (ms)                   |
| `maxPendingMessages`   | `100`   | Pending count that triggers backpressure                      |

### Methods and properties

| Member                                                                    | Description                                                                                                                                                                             |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect()`                                                               | Join the channel; resolves with the `connected` event. Throws `InvalidStateError` while `connecting` or `connected`; while `reconnecting` it cancels the pending retry and connects now |
| `disconnect()`                                                            | Send `leave`, close the socket, and drop pending messages                                                                                                                               |
| `send(to, payload)` / `broadcast(payload)`                                | Send JSON to one peer / all peers; returns the sequence number                                                                                                                          |
| `sendBinary(to, data)` / `broadcastBinary(data)`                          | Same for `ArrayBuffer` payloads                                                                                                                                                         |
| `sendBinaryUnreliable(to, data)` / `broadcastBinaryUnreliable(data)`      | Fire-and-forget binary sends with no ACK tracking or retries                                                                                                                            |
| `on(type, handler)` / `off(type, handler)` / `onAny(handler)`             | Subscribe/unsubscribe; `on` and `onAny` return an unsubscribe function                                                                                                                  |
| `setToken(token)`                                                         | Replace the JWT used on the next (re)connect                                                                                                                                            |
| `clientId`, `peers`, `state`, `isConnected`, `isBackpressured`, `lastSeq` | Read-only connection state; `state` is `disconnected`, `connecting`, `connected`, or `reconnecting` (auto-reconnect pending after a drop)                                               |

### Events

`connected`, `disconnected`, `peer_joined`, `peer_left`, `message`, `broadcast`, `error`, `ack`, `message_failed`, `backpressure`. `message` and `broadcast` carry `from`, `payload`, and `binary`. `backpressure` fires with `action: "pause"` when pending messages reach `maxPendingMessages` and `action: "resume"` once they drop below 80% of it.

### Helpers

- `generateChannelId()`, `parseChannelUrl(url)`, `createShareableUrl(baseUrl, channelId)` — create random Base58 channel IDs and convert between IDs and shareable `/join/<id>` or `/channel/<id>` URLs.
- `setChannelLogger(logger)` — plug in a logger (no-op by default).
- `ChannelError` and subclasses — `connect()` rejects with a `ChannelError`; server errors are also emitted as `error` events with a `code` (for example `auth_failed`) and a `fatal` flag.
- `encodeBinaryFrame` / `decodeBinaryFrame`, `ExponentialBackoff` — protocol and backoff primitives for advanced use.

## Protocol

The envelope format, binary frame layout, error codes, and delivery guarantees shared with the relay are described in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Development

```bash
pnpm -C packages/channel run test
pnpm -C packages/channel run typecheck
```
