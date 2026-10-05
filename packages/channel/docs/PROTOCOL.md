# Channel protocol

Wire protocol between `ChannelClient` and the [channel-worker](../../channel-worker) relay. The canonical definitions are in [`src/protocol.ts`](../src/protocol.ts); the worker imports them directly, so a protocol change is a change to both sides (pushes touching `src/protocol.ts` on `main` also redeploy the worker).

## Model

- A channel is identified by a 1–128 character ID. The relay routes each channel ID to one Durable Object (`ChannelRoom`), which holds every socket in that channel.
- Channels are user-scoped: the first client to join records its JWT `sub` claim as the channel owner (persisted in Durable Object storage), and later joins with a different `sub` are rejected. This lets one user link their own devices without channel ACLs or invites.
- The relay assigns each connection a 16-character client ID and always stamps `from` itself, so clients cannot spoof senders.

## Connection flow

1. Client opens a WebSocket to `/channel/<channelId>`.
2. Client sends `join` with the channel ID, JWT, optional `meta`, and optional `lastSeq` (last received sequence number, for resumption).
3. Relay verifies the JWT (RS256 via JWKS), checks the channel ID matches the URL, and enforces the channel owner.
4. Relay replies `joined` with the assigned `clientId` and the current peers, then sends `peer_joined` to the other peers.
5. On `leave` or socket close, the relay sends `peer_left` (reason `leave`, `disconnect`, or `timeout`) to the remaining peers.

## JSON envelopes

Every JSON frame is `{ type, ts, seq?, payload, to?, from? }`, where `ts` is a millisecond timestamp.

| Type          | Direction      | Purpose                                                           |
| ------------- | -------------- | ----------------------------------------------------------------- |
| `join`        | client → relay | Authenticate and join (`channelId`, `token`, `meta?`, `lastSeq?`) |
| `leave`       | client → relay | Leave the channel                                                 |
| `message`     | both           | Targeted message (`to` on send, `from` on delivery)               |
| `broadcast`   | both           | Message to every other peer                                       |
| `ping`/`pong` | both           | Keep-alive; the client pings, the relay answers `pong`            |
| `joined`      | relay → client | Join confirmed: `clientId`, `channelId`, `peers`                  |
| `peer_joined` | relay → client | Another client joined (`clientId`, `meta`)                        |
| `peer_left`   | relay → client | Another client left (`clientId`, `reason`)                        |
| `ack`         | relay → client | Relay accepted the data message with `payload.seq`                |
| `error`       | relay → client | `code`, `message`, `fatal`; fatal errors close the socket         |

Example join:

```json
{
  "type": "join",
  "ts": 1706000000000,
  "payload": { "channelId": "room-123", "token": "eyJ...", "meta": { "device": "laptop" } }
}
```

## Binary frames

Binary data messages use a 37-byte header followed by the payload:

| Offset | Size | Field                                             |
| ------ | ---- | ------------------------------------------------- |
| 0      | 1    | Flags (bit 0: binary, bit 1: broadcast)           |
| 1      | 4    | Sequence number (uint32 BE; `0` = no ACK)         |
| 5      | 16   | From client ID (null-padded; set by the relay)    |
| 21     | 16   | To client ID (null-padded; ignored for broadcast) |
| 37     | N    | Payload                                           |

## Error codes

| Code                | Meaning                                                     |
| ------------------- | ----------------------------------------------------------- |
| `invalid_message`   | Malformed JSON, unknown type, not joined, or bad payload    |
| `channel_not_found` | `join` channel ID does not match the URL                    |
| `peer_not_found`    | Target client is not in the channel                         |
| `rate_limited`      | Sender exceeded the data-message rate limit                 |
| `auth_failed`       | JWT invalid/expired, or the channel belongs to another user |
| `internal_error`    | Relay failure                                               |

## Delivery

- Data messages (`message`, `broadcast`, binary frames) carry a per-sender, positive, increasing `seq`. The relay ACKs each one after relaying it. A `seq` at or below the last one seen from that sender is treated as a retry: it is ACKed again but not relayed.
- The client keeps unACKed messages pending, retries them after `ackTimeout`, and emits `message_failed` after `maxRetries`. Binary frames with `seq` 0 (the `*Unreliable` methods) skip ACKs entirely.
- The relay rate-limits data messages per client with a token bucket (100 messages/s, burst of 200); control messages are not limited.
- The relay keeps the last 100 sequenced messages per recipient client ID and replays those newer than `lastSeq` when a `join` includes it.
