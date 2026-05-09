# channel-worker

Cloudflare Worker for WebSocket channel relay, enabling peer-to-peer style communication between clients.

## Features

- **Durable Objects** - Each channel is a persistent Durable Object instance
- **WebSocket Hibernation** - Cost-efficient idle connection handling
- **JWKS/RS256 Authentication** - Secure JWT verification via WorkOS or any OIDC provider
- **Same-User Channels** - All clients in a channel must have the same `sub` claim (user ID)
- **Binary & JSON** - Support for both message formats
- **Automatic routing** - Channel ID maps to consistent DO instance

## Architecture

```
Device A (user-123) ─────┐
                         │
Device B (user-123) ─────┼──── Worker ──── Durable Object (channel-xyz)
                         │                        │
Device C (user-123) ─────┘                        ├── sessions Map
                                                  ├── clientSockets Map
                                                  └── message routing

Device D (user-456) ───── rejected (different user)
```

Channels are **user-scoped**: all clients must have the same JWT `sub` claim. This allows a single user to communicate between their different devices, but prevents different users from joining the same channel.

## Configuration

### Environment Variables (Required)

| Variable           | Description           | Example                             |
| ------------------ | --------------------- | ----------------------------------- |
| `WORKOS_CLIENT_ID` | Your WorkOS Client ID | `client_01KFZK5YEVD9K22QTC77978XXA` |

The JWKS URL and issuer are automatically derived from the client ID:

- JWKS URL: `https://api.workos.com/sso/jwks/<client_id>`
- Issuer: `https://api.workos.com/user_management/<client_id>`

### Finding Your WorkOS Client ID

1. Log into [WorkOS Dashboard](https://dashboard.workos.com)
2. Go to **Configuration** → **API Keys**
3. Copy your **Client ID** (starts with `client_`)

### Local Development

Create `.dev.vars` in the `packages/channel-worker` directory:

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your WorkOS Client ID
```

`.dev.vars` contents:

```
WORKOS_CLIENT_ID=client_01KFZK5YEVD9K22QTC77978XXA
```

This file is automatically loaded by `wrangler dev` and is gitignored.

### Production (CI/GitHub Actions)

Add this GitHub repository secret:

| Secret             | Value                               |
| ------------------ | ----------------------------------- |
| `WORKOS_CLIENT_ID` | `client_01KFZK5YEVD9K22QTC77978XXA` |

The deploy workflow automatically sets this as a Cloudflare Worker secret.

### Manual Deployment

```bash
# Set secret manually
wrangler secret put WORKOS_CLIENT_ID
# Enter: client_01KFZK5YEVD9K22QTC77978XXA

# Deploy
wrangler deploy
```

## Deployment

### Prerequisites

1. [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
2. Cloudflare account with Workers and Durable Objects enabled
3. WorkOS account (or any OIDC provider with JWKS endpoint)

### Setup

```bash
# Install dependencies
bun install

# Configure local secrets (see Configuration section)
cp .dev.vars.example .dev.vars
# Edit .dev.vars

# Deploy (secrets set via CI or manually)
wrangler deploy
```

## API

### Endpoints

| Endpoint              | Method          | Description                                                 |
| --------------------- | --------------- | ----------------------------------------------------------- |
| `/health`             | GET             | Health check, returns `{ status: "ok", timestamp: number }` |
| `/channel/:channelId` | GET (WebSocket) | WebSocket connection for channel                            |

### WebSocket Protocol

#### Connection Flow

1. Client connects to `/channel/:channelId`
2. Client sends `join` message with JWT token
3. Server validates token via JWKS and checks `sub` claim
4. If another user owns the channel, connection is rejected
5. Server sends `joined` response
6. Server notifies existing peers with `peer_joined`

#### Message Types

**Client → Server:**

| Type        | Description                          |
| ----------- | ------------------------------------ |
| `join`      | Join channel with token and metadata |
| `leave`     | Leave channel                        |
| `message`   | Send targeted message to peer        |
| `broadcast` | Send message to all peers            |
| `pong`      | Respond to ping                      |

**Server → Client:**

| Type          | Description                                      |
| ------------- | ------------------------------------------------ |
| `joined`      | Join confirmed, includes client ID and peer list |
| `peer_joined` | New peer joined                                  |
| `peer_left`   | Peer disconnected                                |
| `message`     | Targeted message from peer                       |
| `broadcast`   | Broadcast message from peer                      |
| `error`       | Error occurred                                   |
| `ping`        | Keep-alive ping                                  |

#### Join Message

```json
{
  "type": "join",
  "ts": 1706000000000,
  "payload": {
    "channelId": "room-123",
    "token": "eyJhbGciOiJSUzI1NiIs...",
    "meta": { "device": "iPhone" }
  }
}
```

#### Joined Response

```json
{
  "type": "joined",
  "ts": 1706000000000,
  "payload": {
    "clientId": "abc123def456",
    "channelId": "room-123",
    "peers": [{ "clientId": "xyz789", "meta": { "device": "MacBook" }, "joinedAt": 1705999000000 }]
  }
}
```

#### Targeted Message

```json
{ "type": "message", "ts": 1706000000000, "to": "xyz789", "payload": { "text": "Hello!" } }
```

#### Broadcast Message

```json
{ "type": "broadcast", "ts": 1706000000000, "payload": { "text": "Hello all devices!" } }
```

### Binary Messages

Binary messages use a 37-byte header followed by payload:

| Offset | Size | Field                                             |
| ------ | ---- | ------------------------------------------------- |
| 0      | 1    | Flags (bit 0: binary, bit 1: broadcast)           |
| 1      | 4    | Sequence number (uint32 BE)                       |
| 5      | 16   | From client ID (null-padded)                      |
| 21     | 16   | To client ID (null-padded, ignored for broadcast) |
| 37     | N    | Payload                                           |

### Error Codes

| Code                | Description                                       |
| ------------------- | ------------------------------------------------- |
| `invalid_message`   | Malformed or unknown message                      |
| `channel_not_found` | Channel mismatch                                  |
| `peer_not_found`    | Target peer not in channel                        |
| `rate_limited`      | Too many requests                                 |
| `auth_failed`       | JWT validation failed or different user's channel |
| `internal_error`    | Server error                                      |

## JWT Token Requirements

Tokens must be:

- Signed with **RS256** algorithm (WorkOS default)
- Include `kid` header (key ID for JWKS lookup)
- Verifiable via the configured JWKS endpoint

Required claims:

| Claim | Description                                           |
| ----- | ----------------------------------------------------- |
| `sub` | Subject (user ID) - all clients in channel must match |
| `exp` | Expiration time                                       |

Optional claims:

| Claim | Description                                   |
| ----- | --------------------------------------------- |
| `iss` | Issuer (validated if `ISSUER` env var is set) |
| `nbf` | Not before time                               |
| `iat` | Issued at time                                |

### Same-User Channel Enforcement

The first client to join a channel sets the channel's owner (based on `sub` claim). All subsequent clients must have the same `sub` claim. This enables:

- **Device sync**: User can communicate between their phone, laptop, tablet
- **Privacy**: Other users cannot join your channels
- **Simplicity**: No need for channel ACLs or invite systems

## Development

```bash
# Install dependencies
bun install

# Configure local secrets
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your WorkOS values

# Run locally
wrangler dev

# Type check
bun run typecheck

# Deploy
wrangler deploy
```

### Local Development

When running locally with `wrangler dev`:

1. Ensure `.dev.vars` is configured with valid `JWKS_URL` and `ISSUER`
2. Connect to `ws://localhost:8787/channel/:channelId`
3. JWT tokens must be valid WorkOS tokens

### Testing with wscat

```bash
# Connect to local worker (no installation needed)
bunx wscat -c ws://localhost:8787/channel/test-room

# Send join message with valid JWT
{"type":"join","ts":1706000000000,"payload":{"channelId":"test-room","token":"<valid-jwt>","meta":{"device":"test"}}}
```

Note: You'll need a valid JWT from your auth system. For testing, you can generate tokens from your WorkOS integration.

## Pricing Considerations

- **Durable Objects**: Billed per request and duration
- **WebSocket Hibernation**: Reduces costs for idle connections
- **Bandwidth**: Outbound data transfer charges apply
- **JWKS Fetch**: One external fetch per 5 minutes (cached)

See [Cloudflare Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/) for details.
