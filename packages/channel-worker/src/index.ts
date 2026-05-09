import { createLogger, type AppLogger } from "@bizimind/logger";

import { debugJwks } from "./auth.ts";

export { ChannelRoom } from "./channel-room.ts";

/**
 * Environment bindings for the worker.
 */
export interface Env {
  /** Durable Object namespace for channel rooms */
  CHANNEL_ROOM: DurableObjectNamespace;
  /** WorkOS Client ID for JWT verification (e.g., client_01KFZK5YEVD9K22QTC77978XXA) */
  WORKOS_CLIENT_ID: string;
  /** Axiom API token for logging */
  AXIOM_TOKEN: string;
  /** Axiom dataset name */
  AXIOM_DATASET: string;
  /** Log level (debug, info, warn, error) */
  LOG_LEVEL?: string;
}

/**
 * Create a logger instance for request handling.
 */
export function createRequestLogger(env: Env): AppLogger {
  return createLogger({
    source: "channel-worker",
    mode: "http",
    axiomToken: env.AXIOM_TOKEN,
    axiomDataset: env.AXIOM_DATASET,
    level: (env.LOG_LEVEL as "debug" | "info" | "warn" | "error") ?? "debug",
  });
}

/**
 * Derive JWKS URL from WorkOS client ID.
 */
export function getJwksUrl(clientId: string): string {
  return `https://api.workos.com/sso/jwks/${clientId}`;
}

/**
 * Derive issuer from WorkOS client ID.
 */
export function getIssuer(clientId: string): string {
  return `https://api.workos.com/user_management/${clientId}`;
}

/**
 * Handle the fetch request and return a response.
 * Extracted to allow finally block to flush logger.
 */
async function handleFetch(request: Request, env: Env, _logger: AppLogger): Promise<Response> {
  const url = new URL(request.url);

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Upgrade, Connection, Sec-WebSocket-Key, Sec-WebSocket-Version, Sec-WebSocket-Protocol",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // Health check endpoint
  if (url.pathname === "/health") {
    return new Response(JSON.stringify({ status: "ok", timestamp: Date.now() }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  // Debug endpoint to check JWKS connectivity
  if (url.pathname === "/debug/jwks") {
    const clientId = env.WORKOS_CLIENT_ID;
    const jwksUrl = getJwksUrl(clientId);
    const issuer = getIssuer(clientId);
    const result = await debugJwks(jwksUrl);

    return new Response(
      JSON.stringify({
        clientIdConfigured: !!clientId,
        clientIdPrefix: clientId ? clientId.slice(0, 15) + "..." : "NOT SET",
        jwksUrl,
        issuer,
        ...result,
      }),
      {
        status: result.success ? 200 : 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      },
    );
  }

  // WebSocket endpoint: /channel/:channelId
  const match = url.pathname.match(/^\/channel\/([^/]+)$/);
  if (!match) {
    return new Response(
      JSON.stringify({
        error: "Not found",
        message: "Use /channel/:channelId for WebSocket connections",
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      },
    );
  }

  const channelId = decodeURIComponent(match[1]!);

  // Validate channel ID
  if (!channelId || channelId.length > 128) {
    return new Response(
      JSON.stringify({
        error: "Invalid channel ID",
        message: "Channel ID must be 1-128 characters",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      },
    );
  }

  // Check for WebSocket upgrade
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response(
      JSON.stringify({
        error: "Upgrade required",
        message: "This endpoint requires a WebSocket upgrade",
      }),
      {
        status: 426,
        headers: {
          "Content-Type": "application/json",
          Upgrade: "websocket",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  // Route to Durable Object by channel ID
  // Using idFromName creates a consistent ID for the same channel
  const id = env.CHANNEL_ROOM.idFromName(channelId);
  const stub = env.CHANNEL_ROOM.get(id);

  // Forward the request to the Durable Object
  return stub.fetch(request);
}

export default {
  /**
   * Handle incoming requests.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const logger = createRequestLogger(env);

    try {
      return await handleFetch(request, env, logger);
    } finally {
      // Non-blocking flush after response
      ctx.waitUntil(logger.flush());
    }
  },
};
