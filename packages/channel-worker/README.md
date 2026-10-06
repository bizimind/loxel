# channel-worker

Cloudflare Worker that relays WebSocket [channel](../channel) traffic between clients, enabling peer-to-peer style communication between one user's devices. Deployed at `channels.loxel.bizimind.io`.

## Features

- **Durable Objects** — each channel ID maps to one `ChannelRoom` Durable Object that holds its sockets
- **WebSocket Hibernation** — idle connections do not keep the Durable Object running
- **WorkOS JWT authentication** — RS256 verification against the WorkOS JWKS for the configured client ID
- **Same-user channels** — every client in a channel must share the JWT `sub` claim of the first client that joined
- **JSON and binary relay** — targeted and broadcast messages with ACKs, duplicate suppression, and per-client rate limiting

The wire protocol (message types, binary frame layout, error codes, delivery rules) is shared with the client library and documented in [channel/docs/PROTOCOL.md](../channel/docs/PROTOCOL.md).

## Endpoints

| Endpoint              | Method          | Description                                                          |
| --------------------- | --------------- | -------------------------------------------------------------------- |
| `/health`             | GET             | Health check, returns `{ status: "ok", timestamp: number }`          |
| `/debug/jwks`         | GET             | Reports the derived JWKS URL/issuer and whether the JWKS fetch works |
| `/channel/:channelId` | GET (WebSocket) | Channel connection (channel ID 1–128 characters)                     |

## Configuration

| Name               | Kind                  | Description                                             |
| ------------------ | --------------------- | ------------------------------------------------------- |
| `WORKOS_CLIENT_ID` | secret                | WorkOS client ID (`client_...`)                         |
| `AXIOM_TOKEN`      | secret                | Axiom API token used by [`@bizimind/logger`](../logger) |
| `AXIOM_DATASET`    | var (`wrangler.toml`) | Axiom dataset (default `loxel`)                         |
| `LOG_LEVEL`        | var (`wrangler.toml`) | `debug`, `info`, `warn`, or `error` (default `debug`)   |

Both secrets are required, including in `.dev.vars` for local development (every request fails without `AXIOM_TOKEN` because the Axiom logger cannot be created). The JWKS URL (`https://api.workos.com/sso/jwks/<client_id>`) and issuer (`https://api.workos.com/user_management/<client_id>`) are derived from `WORKOS_CLIENT_ID`. Tokens must be RS256-signed, carry `sub` and `exp`, and match that issuer (5 s clock tolerance). JWKS responses are cached in memory for an hour.

## Development

```bash
cp packages/channel-worker/.dev.vars.example packages/channel-worker/.dev.vars   # then fill in the values
pnpm -C packages/channel-worker run dev         # wrangler dev on ws://localhost:8787
pnpm -C packages/channel-worker run typecheck
```

`.dev.vars` is loaded by `wrangler dev` and gitignored. To poke the relay manually, connect with `bunx wscat -c ws://localhost:8787/channel/test-room` and send a `join` envelope containing a valid WorkOS JWT.

## Deployment

Pushes to `main` that touch `packages/channel-worker/**` or `packages/channel/src/protocol.ts` run the `release-channel-worker.yml` workflow, which sets the `WORKOS_CLIENT_ID` (repository variable) and `AXIOM_TOKEN` (repository secret) Worker secrets and runs `wrangler deploy`. To deploy manually:

```bash
cd packages/channel-worker
pnpm exec wrangler secret put WORKOS_CLIENT_ID
pnpm exec wrangler secret put AXIOM_TOKEN
pnpm run deploy
```
